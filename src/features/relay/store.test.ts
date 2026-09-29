import { assert, describe, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const id = (n: number) => n.toString(16).padStart(64, "0");
function setup(maxWindows = 2, now = Date.now) {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const store = createRelaySession(scripted.transport, { maxWindows, now });
  return { ...scripted, store, queries: store.session.channels };
}

describe("channel store", () => {
  it("is unavailable without a transport and rejects bad capacity", () => {
    const store = createRelaySession(null);
    expect(store.session.channels.list().status).toBe("unavailable");
    store.session.channels.ensureList();
    store.session.channels.ensure("x");
    store.session.channels.loadOlder("x");
    expect(store.session.channels.window("x")).toMatchObject({
      status: "idle",
      rows: [],
    });
    expect(store.session.media("https://x.test/a.png")).toBeUndefined();
    expect(() => createRelaySession(null, { maxWindows: 0 })).toThrow();
  });
  it("loads the roster once, notifies list subscribers, and reports errors without losing state", async () => {
    // Roster and metadata phases have identical asOf values for this dedupe check.
    const { queries, next, pending } = setup(2, () => 1_000);
    const listener = vi.fn();
    queries.subscribeList(listener);
    queries.ensureList();
    queries.ensureList();
    expect(pending.length).toBe(1);
    expect(queries.list().status).toBe("loading");
    next().respond([
      roster(relay, "b", [viewer.pubkey]),
      metadata(relay, "b", "Beta"),
      roster(relay, "a", [alice.pubkey]),
    ]);
    await flush();
    expect(queries.list()).toMatchObject({
      status: "ready",
      channels: [{ id: "b", name: "Beta" }],
    });
    expect(listener).toHaveBeenCalledTimes(2);
    queries.ensureList();
    expect(pending.length).toBe(0);
    const failing = setup();
    failing.queries.ensureList();
    failing.next().fail(new Error("offline"));
    await flush();
    expect(failing.queries.list()).toMatchObject({
      status: "error",
      error: "offline",
    });
    failing.queries.ensureList();
    expect(failing.queries.list().status).toBe("loading");
  });
  it("replaces a channel summary when only its private visibility changes", async () => {
    const { store, queries, next } = setup();
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    const publicSummary = queries.list().channels[0];
    expect(publicSummary?.private).toBeUndefined();

    queries.refreshList?.();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      signed(relay, {
        kind: 39000,
        content: JSON.stringify({ name: "Work" }),
        created_at: 1_700_000_001,
        tags: [["d", "work"], ["name", "Work"], ["private"]],
      }),
    ]);
    await flush();
    expect(queries.list().channels[0]).not.toBe(publicSummary);
    expect(queries.list().channels[0]?.private).toBe(true);
    store.dispose();
  });
  it("pages a window by the relay cursor, prepends older rows, and fetches missing profiles once", async () => {
    const { store, queries, next, pending } = setup();
    const listener = vi.fn();
    queries.subscribeWindow("c", listener);
    queries.ensure("c");
    queries.ensure("c");
    expect(pending.length).toBe(1);
    expect(queries.window("c").status).toBe("loading");
    const newer = message(alice, "c", "newer", 20),
      older = message(alice, "c", "older", 10);
    const head = next();
    expect(head.filters[0]).toMatchObject({
      "#h": ["c"],
      top_level: true,
      include_aux: true,
      include_summaries: true,
      limit: 20,
    });
    head.respond([
      newer,
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: newer.id },
      }),
    ]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      hasMore: true,
      loadingOlder: false,
      rows: [{ id: newer.id }],
    });
    const profiles = next();
    expect(profiles.filters[0]).toMatchObject({
      kinds: [0],
      authors: [alice.pubkey],
    });
    queries.loadOlder("c");
    queries.loadOlder("c");
    expect(pending.length).toBe(1);
    expect(queries.window("c").loadingOlder).toBe(true);
    const page = next();
    expect(page.filters[0]).toMatchObject({
      until: 20,
      before_id: newer.id,
      top_level: true,
      include_aux: true,
      include_summaries: true,
      limit: 20,
    });
    // Older rows prepend; the duplicated `newer` row is deduped; alice is already pending so no second profile query.
    page.respond([
      older,
      newer,
      bounds(relay, "c", `20:${newer.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      hasMore: false,
      loadingOlder: false,
      rows: [{ id: older.id }, { id: newer.id }],
    });
    expect(pending.length).toBe(0);
    profiles.respond([profile(alice, { name: "Alice" })]);
    await flush();
    expect(store.session.profiles.snapshot().get(alice.pubkey)).toEqual({
      name: "Alice",
    });
    queries.loadOlder("c");
    expect(pending.length).toBe(0);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it("evicts the least recently ensured window beyond capacity, aborting its request and rejecting late results", async () => {
    const { queries, store, next, pending } = setup(2);
    const evicted = vi.fn();
    queries.subscribeWindow("a", evicted);
    queries.ensure("a");
    const requestA = next();
    queries.ensure("b");
    next().respond([
      bounds(relay, "b", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    queries.ensure("c");
    expect(store.retainedChannels()).toEqual(["b", "c"]);
    expect(requestA.signal?.aborted).toBe(true);
    expect(queries.window("a")).toMatchObject({ status: "idle", rows: [] });
    requestA.respond([
      message(alice, "a", "late", 1),
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(queries.window("a")).toMatchObject({ status: "idle", rows: [] });
    // Re-ensuring a still-retained window only touches recency; re-ensuring the evicted one reloads it.
    queries.ensure("b");
    expect(store.retainedChannels()).toEqual(["c", "b"]);
    queries.ensure("a");
    expect(store.retainedChannels()).toEqual(["b", "a"]);
    const lateRead = pending.at(-1);
    assert.exists(lateRead);
    expect(lateRead.filters[0]).toMatchObject({ "#h": ["a"] });
    store.dispose();
    lateRead.respond([
      bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
    ]);
    await flush();
    expect(queries.window("a").status).not.toBe("ready");
  });
  it("surfaces bounds failures as window errors and lets ensure retry", async () => {
    const { queries, next } = setup();
    queries.ensure("c");
    next().respond([message(alice, "c", "no bounds", 1)]);
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "error",
      error: expect.stringMatching(/window bounds/),
    });
    queries.ensure("c");
    expect(queries.window("c").status).toBe("loading");
    next().respond([
      bounds(relay, "c", "head", {
        has_more: true,
        next_cursor: { created_at: 1, id: id(1) },
      }),
    ]);
    await flush();
    queries.loadOlder("c");
    next().fail(new Error("relay down"));
    await flush();
    expect(queries.window("c")).toMatchObject({
      status: "ready",
      loadingOlder: false,
      error: "relay down",
      hasMore: true,
    });
  });
});

it("keeps session replies in the main timeline and observes parent changes", async () => {
  const { store, queries, next } = setup();
  const parent = "11111111-1111-4111-8111-111111111111";
  const sessionMetadata = (time: number, moved = false) =>
    signed(relay, {
      kind: 39000,
      content: "",
      created_at: time,
      tags: [
        ["d", "work"],
        ["name", "Work topic"],
        ["t", "stream"],
        ["private"],
        [
          "about",
          `Buzz session (buzz.sessions/v1)${moved ? `\nparent:${parent}` : ""}`,
        ],
      ],
    });
  queries.ensureList();
  next().respond([roster(relay, "work", [viewer.pubkey]), sessionMetadata(10)]);
  await flush();
  expect(queries.list().channels[0]).toMatchObject({
    channelType: "session",
    name: "Work topic",
  });
  queries.ensure("work");
  const request = next();
  expect(request.filters[0]).not.toHaveProperty("top_level");
  const root = message(viewer, "work", "Prompt", 20);
  const reply = message(alice, "work", "Reply", 21, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ]);
  request.respond([root, reply]);
  await flush();
  next().respond([]); // Load message overlays before exposing the conversation.
  await flush();
  expect(queries.window("work").rows.map((row) => row.content)).toEqual([
    "Prompt",
    "Reply",
  ]);
  // Drain profile lookup, then refresh the same roster with only a parent change.
  next().respond([]);
  await flush();
  queries.refreshList?.();
  next().respond([
    roster(relay, "work", [viewer.pubkey]),
    sessionMetadata(30, true),
  ]);
  await flush();
  expect(queries.list().channels[0]).toMatchObject({
    parentChannelId: parent,
    updatedAt: 30,
  });
  store.dispose();
});

it("opens an ordinary private session with existing agent replies in its main timeline", async () => {
  const { store, queries, next } = setup();
  queries.ensureList();
  next().respond([
    roster(relay, "work", [viewer.pubkey]),
    signed(relay, {
      kind: 39000,
      content: "",
      tags: [
        ["d", "work"],
        ["name", "Work"],
        ["t", "stream"],
        ["private"],
        ["about", "Buzz session (buzz.sessions/v1)"],
      ],
    }),
    profile(alice, { name: "Alice" }),
    profile(viewer, { name: "Viewer" }),
  ]);
  await flush();
  queries.ensure("work");
  const request = next();
  expect(request.filters[0]).not.toHaveProperty("top_level");
  expect(request.filters[0]).not.toHaveProperty("session_timeline");
  const root = message(viewer, "work", "Prompt", 20);
  const reply = message(alice, "work", "Answer", 21, [
    ["e", root.id, "", "reply"],
  ]);
  request.respond([reply, root]);
  await flush();
  expect(queries.window("work").rows).toEqual([]);
  next().respond([]); // Fetch message overlays before presenting the page.
  await flush();
  expect(queries.window("work").rows.map((row) => row.content)).toEqual([
    "Prompt",
    "Answer",
  ]);
  expect(queries.window("work").hasMore).toBe(true);
  next().respond([]); // Optional profile enrichment is independent of history.
  await flush();
  queries.loadOlder("work");
  const older = next();
  expect(older.filters[0]).toMatchObject({ until: 20, before_id: root.id });
  older.respond([]);
  await flush();
  expect(queries.window("work").hasMore).toBe(false);
  expect(queries.window("work").rows.map((row) => row.content)).toEqual([
    "Prompt",
    "Answer",
  ]);
  store.dispose();
});

it("projects explicit visibility and replaces description-only changes without exposing session metadata", async () => {
  const { store, queries, next } = setup();
  try {
    queries.ensureList();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work"),
    ]);
    await flush();
    expect(queries.list().channels[0]?.visibility).toBeUndefined();
    for (const [index, description] of [
      "First description",
      "Second description",
      "",
    ].entries()) {
      const old = queries.list().channels[0];
      queries.refreshList?.();
      next().respond([
        roster(relay, "work", [viewer.pubkey]),
        metadata(relay, "work", "Work", 1_700_000_001 + index, [
          ["public"],
          ["about", description],
          ["t", "stream"],
        ]),
      ]);
      await flush();
      expect(queries.list().channels[0]).not.toBe(old);
      expect(queries.list().channels[0]).toMatchObject({
        description,
        visibility: "public",
      });
    }
    queries.refreshList?.();
    next().respond([
      roster(relay, "work", [viewer.pubkey]),
      metadata(relay, "work", "Work", 1_700_000_010, [
        ["private"],
        ["about", "Buzz session (buzz.sessions/v1)"],
        ["t", "stream"],
      ]),
    ]);
    await flush();
    expect(queries.list().channels[0]?.description).toBeUndefined();
    expect(queries.list().channels[0]?.channelType).toBe("session");
  } finally {
    store.dispose();
  }
});
