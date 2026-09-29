import { afterEach, assert, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import { readJournal, type ReadJournal } from "./read-state-storage";
import { keypair, message, metadata, roster } from "./testing";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function setup(count = 1) {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  let journal: ReadJournal | undefined;
  let receive: (events: readonly RelayEvent[]) => void = () => {};
  let live: LiveCallbacks | undefined;
  const marker = deferred(),
    profile = deferred();
  let holdMarker = false,
    holdProfile = false;
  const row = message(peer, "other", "unread evidence", 11);
  const trace: { kind: number | undefined; ms: number }[] = [];
  const started = performance.now();
  const profileSignals: (AbortSignal | undefined)[] = [];
  const query = vi.fn(
    async (filters: readonly ReadFilter[], signal?: AbortSignal) => {
      const kind = filters[0]?.kinds?.includes(9) ? 9 : filters[0]?.kinds?.[0];
      trace.push({ kind, ms: performance.now() - started });
      if (kind === 0) profileSignals.push(signal);
      const wait =
        kind === 0 && holdProfile
          ? profile.promise
          : kind === 30078 && holdMarker
            ? marker.promise
            : undefined;
      if (wait)
        await Promise.race([
          wait,
          new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      return kind === 9 ? [row] : [];
    },
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      readState: { decode: async () => [] },
      subscribe(callbacks) {
        live = callbacks;
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateStorage: {
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
    },
  );
  owners.push(owner);
  const ids = Array.from({ length: count }, (_, i) =>
    i === 0 ? "other" : `room-${i}`,
  );
  receive(
    ids.flatMap((id) => [
      roster(relay, id, [viewer.pubkey], 10),
      metadata(relay, id, id, 10),
    ]),
  );
  return {
    ...owner,
    viewer,
    relay,
    peer,
    row,
    query,
    trace,
    profileSignals,
    ids,
    receive,
    reconnect() {
      assert(live);
      live.state({ status: "connected", routes: [] });
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
      live.established();
    },
    holdProfile() {
      holdProfile = true;
      return profile.release;
    },
    holdMarker() {
      holdMarker = true;
      return marker.release;
    },
    snapshot: () =>
      owner.session.unread.snapshot({ kind: "channel", channelId: "other" }),
  };
}

it("initial unread markers and evidence bypass held optional profiles without cancelling them", async () => {
  const h = setup();
  const release = h.holdProfile();
  let profileFinished = false;
  const profiles = h.session.profiles
    .ensure([h.peer.pubkey], "background")
    .finally(() => {
      profileFinished = true;
    });
  try {
    await h.session.unread.ensure();
    expect(h.trace.map(({ kind }) => kind)).toEqual([0, 30078, 9]);
    expect(profileFinished).toBe(false);
    expect(h.profileSignals).toHaveLength(1);
    expect(h.profileSignals[0]?.aborted).toBe(false);
    expect(h.snapshot().observedCount).toBe(1);
  } finally {
    release();
    await profiles;
  }
}, 15000);

it("evidence gets its own deadline after a failed marker read; marker errors stay visible", async () => {
  const h = setup();
  // Control the caller deadline directly instead of coupling this test to
  // Node's native timeout clock or the reader's separate job timer.
  const deadlines: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const release = h.holdMarker();
  try {
    const done = h.session.unread.ensure();
    await vi.waitFor(() =>
      expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
    );
    expect(deadlines).toHaveLength(1);
    const marker = deadlines[0];
    assert(marker);
    marker.abort(new DOMException("Marker deadline expired", "TimeoutError"));
    await done;
    expect(deadlines).toHaveLength(2);
    expect(deadlines[1]?.signal.aborted).toBe(false);
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9]);
    expect(h.snapshot()).toMatchObject({
      observedCount: 1,
      freshness: "observed",
    });
    expect(h.session.unread.sync()).toMatchObject({
      status: "error",
      completeness: "unknown",
    });
  } finally {
    timeout.mockRestore();
    release();
  }
  await h.session.unread.refresh();
  expect(h.session.unread.sync().status).toBe("reconciled");
});

it("queries all 278 membership IDs with sequential relay-legal batches and publishes each batch", async () => {
  const h = setup(278);
  const batches: string[][] = [];
  const first = message(h.peer, "other", "first", 11);
  const second = message(h.peer, "room-128", "second", 12);
  const last = message(h.peer, "room-277", "last", 13);
  const observed: (number | null)[] = [];
  h.session.unread.subscribe({ kind: "channel", channelId: "other" }, () => {
    observed.push(h.snapshot().observedCount);
  });
  h.query.mockImplementation(async (filters) => {
    const filter = filters[0];
    if (!filter?.kinds?.includes(9)) return [];
    const ids = filter["#h"] ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(128);
    expect(filter.limit).toBe(500);
    batches.push([...ids]);
    if (batches.length > 1) expect(h.snapshot().observedCount).toBe(1);
    return [first, second, last].filter((event) =>
      ids.includes(event.tags[0]?.[1] ?? ""),
    );
  });
  await h.session.unread.ensure();
  expect(batches.map((batch) => batch.length)).toEqual([128, 128, 22]);
  expect(batches.flat().sort()).toEqual([...h.ids].sort());
  expect(observed).toContain(1);
  expect(
    h.session.unread.snapshot({ kind: "channel", channelId: "room-277" })
      .observedCount,
  ).toBe(1);
  expect(h.session.channels.window("room-277").rows).toEqual([]);
});

it("a full early batch does not starve later channels, and later failure retains evidence until explicit retry", async () => {
  const h = setup(129);
  const rows = Array.from({ length: 500 }, (_, i) =>
    message(h.peer, "other", `busy ${i}`, 11 + i),
  );
  let fail = true;
  const batches: string[][] = [];
  h.query.mockImplementation(async (filters) => {
    const filter = filters[0];
    if (!filter?.kinds?.includes(9)) return [];
    const ids = filter["#h"] ?? [];
    batches.push([...ids]);
    if (ids.includes("other")) return rows;
    if (fail) throw new Error("Later chunk unavailable");
    assert(ids[0]);
    return [message(h.peer, ids[0], "quiet", 11)];
  });
  await h.session.unread.ensure();
  expect(batches).toHaveLength(2);
  expect(h.snapshot()).toMatchObject({
    observedCount: 500,
    freshness: "stale",
    error: "Later chunk unavailable",
  });
  await h.session.unread.ensure();
  expect(batches).toHaveLength(2); // No automatic retry loop.
  fail = false;
  await h.session.unread.refresh();
  expect(batches).toHaveLength(4);
  expect(h.snapshot()).toMatchObject({
    observedCount: 500,
    freshness: "observed",
  });
  expect(h.snapshot().error).toBeUndefined();
  const quiet = batches[1]?.[0];
  assert(quiet);
  expect(
    h.session.unread.snapshot({ kind: "channel", channelId: quiet })
      .observedCount,
  ).toBe(1);
});

it.each(["clear", "dispose", "revoke", "join"])(
  "late chunk cannot publish or dispatch another after %s",
  async (boundary) => {
    const h = setup(129);
    const held = deferred();
    let batches = 0;
    h.query.mockImplementation(async (filters) => {
      if (!filters[0]?.kinds?.includes(9)) return [];
      batches++;
      await held.promise;
      return [h.row];
    });
    const repair = h.session.unread.ensure();
    await vi.waitFor(() => expect(batches).toBe(1));
    if (boundary === "dispose") h.dispose();
    else if (boundary === "clear") await h.clearCache();
    else if (boundary === "join")
      h.receive([roster(h.relay, "new-room", [h.viewer.pubkey], 20)]);
    else h.receive([roster(h.relay, "other", [], 20)]);
    held.release();
    await repair;
    expect(batches).toBe(1);
    expect(h.snapshot().observedCount).toBeNull();
  },
);

it("concurrent ensure callers share the active marker/evidence work", async () => {
  const h = setup();
  const release = h.holdMarker();
  const first = h.session.unread.ensure();
  await vi.waitFor(() =>
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
  );
  let finished = false;
  const second = h.session.unread.ensure().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(finished).toBe(false);
  release();
  await Promise.all([first, second]);
  expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9]);
  expect(h.snapshot().observedCount).toBe(1);
});

it("transient startup failure recovers on live reconnect without an automatic retry loop", async () => {
  const h = setup();
  let fail = true;
  h.query.mockImplementation(async (filters) => {
    if (filters[0]?.kinds?.includes(39002))
      return [
        roster(h.relay, "other", [h.viewer.pubkey], 10),
        metadata(h.relay, "other", "other", 10),
      ];
    if (!filters[0]?.kinds?.includes(9)) return [];
    if (fail) throw new Error("Transient evidence failure");
    return [h.row];
  });
  await h.session.unread.ensure();
  expect(h.snapshot().error).toBe("Transient evidence failure");
  const count = h.query.mock.calls.length;
  await h.session.unread.ensure();
  expect(h.query).toHaveBeenCalledTimes(count);
  fail = false;
  h.reconnect();
  await vi.waitFor(() =>
    expect(h.snapshot()).toMatchObject({
      observedCount: 1,
      freshness: "observed",
    }),
  );
  expect(h.snapshot().error).toBeUndefined();
});

it("capacity failure stops batching and remains visible rather than becoming success", async () => {
  const h = setup(129);
  h.receive(
    Array.from({ length: 18 }, (_, i) =>
      message(h.peer, "other", "x".repeat(450000), i + 11),
    ),
  );
  expect(h.snapshot().observedCount).toBe(18);
  const overflow = message(h.peer, "other", "x".repeat(450000), 40);
  let batches = 0;
  h.query.mockImplementation(async (filters) => {
    if (!filters[0]?.kinds?.includes(9)) return [];
    batches++;
    return [overflow];
  });
  await h.session.unread.ensure();
  expect(batches).toBe(1);
  expect(h.snapshot()).toMatchObject({
    observedCount: null,
    freshness: "stale",
    error: "Unread observation capacity reached; refresh available",
  });
});

it.each(["clear", "dispose", "revoke"])(
  "no evidence dispatch after %s while markers are pending",
  async (boundary) => {
    const h = setup(129);
    const release = h.holdMarker();
    const repair = h.session.unread.ensure();
    await vi.waitFor(() =>
      expect(h.trace.map(({ kind }) => kind)).toEqual([30078]),
    );
    if (boundary === "dispose") h.dispose();
    else if (boundary === "clear") await h.clearCache();
    else h.receive([roster(h.relay, "other", [], 20)]);
    release();
    await repair;
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078]);
  },
);

it("a subscriber clearing cache during progressive publication stops later chunks", async () => {
  const h = setup(129);
  let cleared: Promise<void> | undefined;
  h.session.unread.subscribe({ kind: "channel", channelId: "other" }, () => {
    if (h.snapshot().observedCount === 1) cleared = h.clearCache();
  });
  await h.session.unread.ensure();
  await cleared;
  expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9]);
  expect(h.snapshot().observedCount).toBeNull();
});

it("explicit refresh bypasses optional profiles for both markers and evidence", async () => {
  const h = setup();
  await h.session.unread.ensure();
  const release = h.holdProfile();
  const profiles = h.session.profiles.ensure([h.peer.pubkey], "background");
  try {
    await h.session.unread.refresh();
    expect(h.profileSignals[0]?.aborted).toBe(false);
    expect(h.trace.map(({ kind }) => kind)).toEqual([30078, 9, 0, 30078, 9]);
  } finally {
    release();
    await profiles;
  }
}, 15000);
