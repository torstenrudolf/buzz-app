import { assert, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  WORKFLOW_CHANNEL_BATCH,
  WORKFLOW_DEFINITION_LIMIT,
} from "../workflows/queries";
import { tag, type RelayEvent } from "./events";
import { createRelaySession } from "./session";
import type { ChannelStoreOptions } from "./store";
import {
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
let memberships: RelayEvent[];
const names = new Map<string, { name: string; event?: RelayEvent }>();
function named(id: string) {
  const entry = names.get(id);
  assert.exists(entry);
  entry.event ??= metadata(relay, id, entry.name);
  return entry.event;
}
// Preserve real page/capacity boundaries; sign metadata lazily when requested.
beforeAll(() => {
  memberships = Array.from({ length: 1025 }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    names.set(id, { name: `Channel ${i}` });
    return roster(relay, id, [viewer.pubkey]);
  }).sort((a, b) => a.id.localeCompare(b.id));
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(options: ChannelStoreOptions = {}) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let receive!: (events: readonly RelayEvent[]) => void;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    options,
  );
  owners.push(owner);
  const channels = owner.session.channels;
  const next = async (kind: number) => {
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    const request = wire.next();
    expect(request.filters[0]?.kinds).toEqual([kind]);
    return request;
  };
  const settled = async (state = "verified") => {
    await vi.waitFor(() =>
      expect(owner.session.live.snapshot().roster.state).toBe(state),
    );
  };
  return {
    ...wire,
    ...owner,
    channels,
    next,
    settled,
    emit: (events: readonly RelayEvent[]) => receive(events),
    async rosters(count: number) {
      for (let offset = 0; offset <= count; offset += 500) {
        const request = await next(39002);
        const previous = memberships[offset - 1];
        expect(request.filters).toEqual([
          {
            kinds: [39002],
            "#p": [viewer.pubkey],
            limit: 500,
            ...(previous
              ? { until: previous.created_at, before_id: previous.id }
              : {}),
          },
        ]);
        request.respond(
          memberships.slice(offset, Math.min(offset + 500, count)),
        );
      }
    },
    async metadata(count: number) {
      const requested: string[] = [];
      for (let offset = 0; offset < count; offset += 500) {
        const request = await next(39000);
        const ids = request.filters[0]?.["#d"] ?? [];
        expect(ids).toHaveLength(Math.min(500, count - offset));
        expect(request.filters[0]?.limit).toBe(500);
        requested.push(...ids);
        request.respond(ids.map(named));
      }
      await settled();
      expect(new Set(requested).size).toBe(count);
    },
    async confirmOmitted(ids: readonly string[], events: RelayEvent[] = []) {
      const request = await next(39002);
      expect(request.filters).toEqual([
        {
          kinds: [39002],
          authors: [relay.pubkey],
          "#d": ids,
          "#p": [viewer.pubkey],
          limit: ids.length + 1,
        },
      ]);
      request.respond(events);
    },
  };
}

it("discovers and names 501 same-timestamp memberships, including a workflow on the second page", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(501);
  await h.metadata(501);
  expect(h.channels.list().coverage).toBeUndefined();
  expect(h.channels.list().channels).toHaveLength(501);
  for (const channel of h.channels.list().channels)
    expect(channel.name).toBe(tag(named(channel.id), "name"));

  const last = memberships[500];
  assert.exists(last);
  const channelId = tag(last, "d");
  assert.exists(channelId);
  const workflow = signed(viewer, {
    kind: 30620,
    tags: [
      ["h", channelId],
      ["d", "11111111-1111-4111-8111-111111111111"],
    ],
    content:
      "name: Page two\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: send\n    action: send_message\n    text: Hi\n",
  });
  const found: string[] = [];
  const ids = h.channels.list().channels.map((channel) => channel.id);
  for (let offset = 0; offset < ids.length; offset += WORKFLOW_CHANNEL_BATCH) {
    const batch = ids.slice(offset, offset + WORKFLOW_CHANNEL_BATCH);
    const view = h.session.workflows.definitions(batch);
    try {
      const done = view.refresh();
      const request = await h.next(30620);
      expect(request.filters).toEqual([
        {
          kinds: [30620],
          "#h": [...batch].sort(),
          limit: WORKFLOW_DEFINITION_LIMIT,
        },
      ]);
      request.respond(batch.includes(channelId) ? [workflow] : []);
      await done;
      found.push(...view.snapshot().data.items.map((item) => item.channelId));
    } finally {
      view.dispose();
    }
  }
  expect(found).toEqual([channelId]);
  expect(h.pending).toHaveLength(0);
});

it.each([500, 1000])(
  "requires an exhaustion read after exactly %i memberships",
  async (count) => {
    const h = setup({ now: () => 1_000 });
    h.emit([roster(relay, "omitted", [viewer.pubkey])]);
    h.channels.ensureList();
    for (let offset = 0; offset < count; offset += 500)
      (await h.next(39002)).respond(memberships.slice(offset, offset + 500));
    const exhaustion = await h.next(39002);
    expect(h.channels.list().coverage).toBe("partial");
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(true);
    expect(exhaustion.filters[0]).toMatchObject({
      until: memberships[count - 1]?.created_at,
      before_id: memberships[count - 1]?.id,
    });
    exhaustion.respond([]);
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(true);
    await h.confirmOmitted(["omitted"]);
    await h.metadata(count);
    expect(h.channels.list().coverage).toBeUndefined();
    expect(h.channels.list().channels).toHaveLength(count);
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(false);
    expect(h.pending).toHaveLength(0);
  },
);

it("confirms a scan-start membership that moved ahead of the cursor before reconciling omissions", async () => {
  const h = setup();
  const retained = message(viewer, "omitted", "Retained", 10);
  h.emit([roster(relay, "omitted", [viewer.pubkey], 1_699_999_999), retained]);
  const view = h.session.observe([{ kinds: [9], limit: 20 }]);
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  (await h.next(39002)).respond([]);
  const fresh = roster(relay, "omitted", [viewer.pubkey], 1_700_000_001);
  await h.confirmOmitted(["omitted"], [fresh]);
  for (let i = 0; i < 2; i++) {
    const request = await h.next(39000);
    request.respond(
      (request.filters[0]?.["#d"] ?? []).flatMap((id) =>
        names.has(id) ? [named(id)] : [],
      ),
    );
  }
  await h.settled();
  expect(h.channels.list().coverage).toBeUndefined();
  expect(h.channels.get?.("omitted")?.cached).toBeUndefined();
  expect(view.snapshot().events).toEqual([retained]);
  expect(
    h.channels.list().channels.some((channel) => channel.id === "omitted"),
  ).toBe(true);
});

it.each(["failure", "cancelled", "repeated full page", "repeated short page"])(
  "preserves partial grants and omitted data after later-page %s, then retries from the beginning",
  async (failure) => {
    const h = setup();
    const retained = message(viewer, "omitted", "Retained", 10);
    h.emit([roster(relay, "omitted", [viewer.pubkey]), retained]);
    const view = h.session.observe([{ kinds: [9], limit: 20 }]);
    h.channels.ensureList();
    (await h.next(39002)).respond(memberships.slice(0, 500));
    const continuation = await h.next(39002);
    expect(h.channels.list().channels).toHaveLength(501);
    expect(h.channels.list().coverage).toBe("partial");
    if (failure === "failure") continuation.fail(new Error("offline"));
    else if (failure === "cancelled")
      continuation.fail(new DOMException("Cancelled", "AbortError"));
    else
      continuation.respond(
        memberships.slice(0, failure === "repeated full page" ? 500 : 1),
      );
    await h.settled(failure === "cancelled" ? "deferred" : "error");
    expect(h.channels.list().coverage).toBe("partial");
    expect(h.channels.list().channels).toHaveLength(501);
    expect(view.snapshot().events).toEqual([retained]);
    expect(h.pending).toHaveLength(0);

    h.channels.ensureList();
    await h.rosters(501);
    await h.confirmOmitted(["omitted"]);
    await h.metadata(501);
    expect(h.channels.list().coverage).toBeUndefined();
    expect(h.channels.list().channels).toHaveLength(501);
    expect(view.snapshot().events).toEqual([]);
  },
);

it.each(["failure", "cancelled"])(
  "preserves omitted data after exact confirmation %s, then retries deliberately",
  async (failure) => {
    const h = setup();
    const retained = message(viewer, "omitted", "Retained", 10);
    h.emit([roster(relay, "omitted", [viewer.pubkey]), retained]);
    const view = h.session.observe([{ kinds: [9], limit: 20 }]);
    h.channels.ensureList();
    (await h.next(39002)).respond(memberships.slice(0, 500));
    (await h.next(39002)).respond([]);
    const confirmation = await h.next(39002);
    expect(confirmation.filters[0]).toMatchObject({
      authors: [relay.pubkey],
      "#d": ["omitted"],
      "#p": [viewer.pubkey],
      limit: 2,
    });
    if (failure === "cancelled")
      confirmation.fail(new DOMException("Cancelled", "AbortError"));
    else confirmation.fail(new Error("offline"));
    await h.settled(failure === "cancelled" ? "deferred" : "error");
    expect(h.channels.list().coverage).toBe("partial");
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(true);
    expect(view.snapshot().events).toEqual([retained]);

    h.channels.ensureList();
    const restarted = await h.next(39002);
    expect(restarted.filters[0]?.before_id).toBeUndefined();
    restarted.respond(memberships.slice(0, 500));
    (await h.next(39002)).respond([]);
    await h.confirmOmitted(["omitted"]);
    await h.metadata(500);
    expect(h.channels.list().coverage).toBeUndefined();
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(false);
    expect(view.snapshot().events).toEqual([]);
  },
);

it("confirms omitted scan-start memberships in 128-channel batches", async () => {
  const h = setup();
  const omitted = Array.from({ length: 129 }, (_, index) => `omitted-${index}`);
  h.emit(omitted.map((id) => roster(relay, id, [viewer.pubkey])));
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  (await h.next(39002)).respond([]);
  const first = await h.next(39002);
  const firstIds = first.filters[0]?.["#d"] ?? [];
  expect(first.filters[0]).toMatchObject({
    authors: [relay.pubkey],
    "#p": [viewer.pubkey],
    limit: 129,
  });
  expect(firstIds).toHaveLength(128);
  first.respond(
    firstIds.map((id) => roster(relay, id, [viewer.pubkey], 1_700_000_001)),
  );
  const second = await h.next(39002);
  const secondIds = second.filters[0]?.["#d"] ?? [];
  expect(second.filters[0]).toMatchObject({
    authors: [relay.pubkey],
    "#p": [viewer.pubkey],
    limit: 2,
  });
  expect(secondIds).toHaveLength(1);
  expect(new Set([...firstIds, ...secondIds])).toEqual(new Set(omitted));
  second.respond(
    secondIds.map((id) => roster(relay, id, [viewer.pubkey], 1_700_000_001)),
  );
  for (let i = 0; i < 2; i++) {
    const request = await h.next(39000);
    request.respond(
      (request.filters[0]?.["#d"] ?? []).flatMap((id) =>
        names.has(id) ? [named(id)] : [],
      ),
    );
  }
  await h.settled();
  expect(h.channels.list().coverage).toBeUndefined();
  expect(h.channels.list().channels).toHaveLength(629);
  expect(omitted.every((id) => h.channels.get?.(id))).toBe(true);
});

it("uses the scan-start roster versions when live grants arrive between pages", async () => {
  const h = setup();
  h.emit([
    roster(relay, "renewed", [viewer.pubkey], 10),
    roster(relay, "omitted", [viewer.pubkey], 10),
  ]);
  h.channels.ensureList();
  const first = await h.next(39002);
  h.emit([roster(relay, "renewed", [viewer.pubkey], 11)]);
  first.respond(memberships.slice(0, 500));
  const second = await h.next(39002);
  h.emit([roster(relay, "new-grant", [viewer.pubkey], 12)]);
  second.respond(memberships.slice(500, 501));
  await h.confirmOmitted(["omitted"]);
  const namesRead = await h.next(39000);
  expect(h.channels.list().channels.map((channel) => channel.id)).toEqual(
    expect.arrayContaining(["renewed", "new-grant"]),
  );
  expect(
    h.channels.list().channels.some((channel) => channel.id === "omitted"),
  ).toBe(false);
  namesRead.respond([]);
  (await h.next(39000)).respond([]);
  await h.settled();
  expect(h.channels.list().channels).toHaveLength(503);
  expect(h.channels.list().coverage).toBeUndefined();
});

it.each(["cache clear", "disposal"])(
  "fences exact omission confirmation after %s",
  async (action) => {
    const h = setup();
    h.emit([roster(relay, "omitted", [viewer.pubkey])]);
    h.channels.ensureList();
    (await h.next(39002)).respond(memberships.slice(0, 500));
    (await h.next(39002)).respond([]);
    const confirmation = await h.next(39002);
    if (action === "cache clear") await h.clearCache();
    else h.dispose();
    expect(confirmation.signal?.aborted).toBe(true);
    confirmation.respond([
      roster(relay, "omitted", [viewer.pubkey], 1_700_000_001),
    ]);
    if (action === "cache clear")
      expect(h.channels.list().coverage).toBe("partial");
  },
);

it.each(["revocation", "cache clear"])(
  "fences a later page after %s and allows a fresh scan",
  async (action) => {
    const h = setup();
    h.emit([
      roster(relay, "omitted", [viewer.pubkey], 10),
      roster(relay, "revoked", [viewer.pubkey], 10),
    ]);
    h.channels.ensureList();
    (await h.next(39002)).respond(memberships.slice(0, 500));
    const late = await h.next(39002);
    if (action === "revocation") h.emit([roster(relay, "revoked", [], 11)]);
    else await h.clearCache();
    await h.settled("deferred");
    expect(late.signal?.aborted).toBe(true);
    const snapshot = h.channels.list();
    late.respond(memberships.slice(500, 501));
    h.channels.ensureList();
    const restarted = await h.next(39002);
    expect(restarted.filters[0]?.before_id).toBeUndefined();
    expect(h.channels.list().channels).toEqual(snapshot.channels);
    expect(h.channels.list().coverage).toBe("partial");
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(true);
    restarted.respond([]);
    await h.settled();
    expect(h.channels.list().channels).toEqual([]);
  },
);

it("coalesces refresh hints during pagination into one new scan", async () => {
  const h = setup();
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  const second = await h.next(39002);
  h.channels.refreshList?.();
  h.channels.refreshList?.();
  second.respond(memberships.slice(500, 501));
  for (let i = 0; i < 2; i++) (await h.next(39000)).respond([]);
  const refresh = await h.next(39002);
  expect(refresh.filters[0]?.before_id).toBeUndefined();
  refresh.respond([]);
  await h.settled();
  expect(h.pending).toHaveLength(0);
  expect(h.channels.list().channels).toEqual([]);
});

it("keeps membership and earlier names when a later metadata batch fails, then retries missing names", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(501);
  const first = await h.next(39000);
  const initial = first.filters[0]?.["#d"];
  assert.exists(initial);
  first.respond(initial.map(named));
  const second = await h.next(39000);
  const missing = second.filters[0]?.["#d"];
  assert.exists(missing);
  second.fail(new Error("Relay read failed (403)"));
  await h.settled("error");
  expect(h.channels.list().channels).toHaveLength(501);
  expect(h.channels.list().coverage).toBeUndefined();
  expect(
    h.channels
      .list()
      .channels.filter((channel) => channel.name.startsWith("Channel ")),
  ).toHaveLength(500);
  h.channels.ensureList();
  await h.rosters(501);
  const retry = await h.next(39000);
  expect(retry.filters[0]?.["#d"]).toEqual(missing);
  retry.respond(missing.map(named));
  await h.settled();
  expect(
    h.channels
      .list()
      .channels.every((channel) => channel.name.startsWith("Channel ")),
  ).toBe(true);
});

it.each([1024, 1025])(
  "reports retention coverage truthfully for %i memberships",
  async (count) => {
    const h = setup();
    h.channels.ensureList();
    await h.rosters(count);
    await h.metadata(1024);
    expect(h.channels.list().channels).toHaveLength(1024);
    expect(h.channels.list().coverage).toBe(
      count > 1024 ? "partial" : undefined,
    );
    expect(h.pending).toHaveLength(0);
  },
);

it("does not revoke omitted channels when retained rosters exhaust capacity", async () => {
  const h = setup();
  h.emit([roster(relay, "omitted", [viewer.pubkey])]);
  h.channels.ensureList();
  await h.rosters(1024);
  await h.metadata(1023);
  expect(h.channels.list().coverage).toBe("partial");
  expect(h.channels.list().channels).toHaveLength(1024);
  expect(
    h.channels.list().channels.some((channel) => channel.id === "omitted"),
  ).toBe(true);
});

it("keeps coverage partial when exact discovery overflows during omission confirmation", async () => {
  const h = setup();
  h.emit(memberships.slice(0, 1024));
  expect(h.channels.list().channels).toHaveLength(1024);

  h.channels.ensureList();
  await h.rosters(1000);
  const confirmation = await h.next(39002);
  const omitted = memberships
    .slice(1000, 1024)
    .flatMap((event) => tag(event, "d") ?? []);
  const confirmationIds = confirmation.filters[0]?.["#d"] ?? [];
  expect(confirmation.filters[0]).toMatchObject({
    authors: [relay.pubkey],
    "#p": [viewer.pubkey],
    limit: omitted.length + 1,
  });
  expect(new Set(confirmationIds)).toEqual(new Set(omitted));

  const resolve = h.channels.resolve?.(["overflow"]);
  assert.exists(resolve);
  const exact = await h.next(39000);
  expect(exact.filters).toEqual([
    {
      kinds: [39000],
      authors: [relay.pubkey],
      "#d": ["overflow"],
      limit: 2,
    },
    {
      kinds: [39002],
      authors: [relay.pubkey],
      "#d": ["overflow"],
      "#p": [viewer.pubkey],
      limit: 2,
    },
  ]);
  exact.respond([roster(relay, "overflow", [viewer.pubkey])]);
  await resolve;
  expect(h.channels.list().coverage).toBe("partial");

  confirmation.respond([]);
  await h.metadata(1000);
  expect(h.session.live.snapshot().roster.state).toBe("verified");
  expect(h.channels.list().coverage).toBe("partial");
  expect(
    h.channels.list().channels.some((channel) => channel.id === "overflow"),
  ).toBe(false);
  expect(h.channels.get?.("overflow")).toBeUndefined();
  expect(h.pending).toHaveLength(0);
});

it("marks metadata retention overflow as partial without discarding membership", async () => {
  const h = setup();
  const member = memberships[1024];
  assert.exists(member);
  const id = tag(member, "d");
  assert.exists(id);
  h.emit([...names.keys()].filter((channelId) => channelId !== id).map(named));
  h.channels.ensureList();
  (await h.next(39002)).respond([member]);
  (await h.next(39000)).respond([named(id)]);
  await h.settled();
  expect(h.channels.list().channels).toMatchObject([
    { id, name: id.slice(0, 8) },
  ]);
  expect(h.channels.list().coverage).toBe("partial");
});

it("keeps final-page callback invalidation partial across later live traffic", async () => {
  const h = setup();
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  const final = await h.next(39002);
  let cleared: Promise<void> | undefined;
  const stop = h.channels.subscribeList(() => {
    if (h.channels.list().coverage !== undefined) return;
    stop();
    cleared = h.clearCache();
  });
  final.respond(memberships.slice(500, 501));
  await h.settled("deferred");
  expect(cleared).toBeDefined();
  await cleared;
  expect(h.channels.list().coverage).toBe("partial");
  h.emit([roster(relay, "live", [viewer.pubkey])]);
  expect(h.channels.list().coverage).toBe("partial");
  expect(h.pending).toHaveLength(0);
  h.channels.ensureList();
  (await h.next(39002)).respond([]);
  await h.settled();
  expect(h.channels.list().coverage).toBeUndefined();
});

it("keeps a retry from a cancellation notification pending until the new scan finishes", async () => {
  const h = setup();
  h.channels.ensureList();
  (await h.next(39002)).respond([]);
  await h.settled();
  const stop = h.channels.subscribeList(() => {
    if (h.channels.list().coverage !== "partial") return;
    stop();
    h.channels.refreshList?.();
  });
  h.channels.refreshList?.();
  (await h.next(39002)).fail(new DOMException("Cancelled", "AbortError"));
  const retry = await h.next(39002);
  expect(h.session.live.snapshot().roster.state).toBe("pending");
  retry.respond([]);
  await h.settled();
  expect(h.pending).toHaveLength(0);
});

it("continues into an older timestamp after a full same-timestamp page", async () => {
  const h = setup();
  const older = memberships[500];
  assert.exists(older);
  const id = tag(older, "d");
  assert.exists(id);
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  (await h.next(39002)).respond([
    roster(relay, id, [viewer.pubkey], older.created_at - 1),
  ]);
  await h.metadata(501);
  expect(h.channels.list().channels).toHaveLength(501);
  expect(h.channels.list().coverage).toBeUndefined();
});
