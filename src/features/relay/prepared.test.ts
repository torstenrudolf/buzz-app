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
import type { HeadPersistence, SavedHead } from "./persistence";
import { getLogger, logLevel, setLogLevel } from "../developer/logging";
import { ByteLru } from "./budget";

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const empty = (id: string) => [
  bounds(relay, id, "head", { has_more: false, next_cursor: null }),
];
const head = (id: string, content = "hello") => [
  message(alice, id, content, 20),
  ...empty(id),
];
const discovery = (ids: string[]) =>
  ids.flatMap((id) => [
    roster(relay, id, [viewer.pubkey]),
    metadata(relay, id, id),
  ]);
function memoryDisk(records: SavedHead[] = []): HeadPersistence {
  return {
    read: vi.fn(async () => records),
    write: vi.fn(async () => {}),
    retain: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    close: vi.fn(),
  };
}
function setup(options: Parameters<typeof createRelaySession>[1] = {}) {
  const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
  const store = createRelaySession(scripted.transport, {
    prepared: true,
    maxWindows: 1,
    ...options,
  });
  return { ...scripted, store, queries: store.session.channels };
}

describe("prepared channel working sets", () => {
  it("prepares heads only on intent without allocating history and reuses them after history eviction", async () => {
    const { queries, store, next, pending } = setup();
    queries.ensureList();
    next().respond(discovery(["a", "b"]));
    await flush();
    expect(pending).toHaveLength(0); // Discovery is not permission to read every head.
    queries.prepare?.("a");
    next().respond(empty("a"));
    await flush();
    queries.prepare?.("b");
    next().respond(empty("b"));
    await flush();
    expect(store.retainedChannels()).toEqual([]);
    expect(store.diagnostics().heads.entries).toBe(2);
    queries.ensure("a");
    queries.ensure("b");
    queries.ensure("a");
    expect(queries.window("a").status).toBe("ready");
    expect(store.retainedChannels()).toEqual(["a"]);
    expect(pending).toHaveLength(0);
    store.dispose();
  });
  it("discovery and repeated roster traffic never read unopened channel heads", async () => {
    const { queries, store, next, pending } = setup();
    try {
      const ids = Array.from({ length: 70 }, (_, index) => `c${index}`);
      queries.ensureList();
      next().respond(discovery(ids));
      await flush();
      expect(pending).toHaveLength(0);
      queries.refreshList?.();
      next().respond(discovery(ids));
      await flush();
      expect(pending).toHaveLength(0);
      expect(store.diagnostics().heads.entries).toBe(0);
      queries.ensure("c69");
      expect(next().filters[0]?.["#h"]).toEqual(["c69"]);
      expect(pending).toHaveLength(0);
    } finally {
      store.dispose();
    }
  });
  it("does not evict a subscribed history reader to warm another channel", async () => {
    const { queries, next, store } = setup();
    queries.ensureList();
    next().respond(discovery(["a", "b"]));
    await flush();
    queries.prepare?.("a");
    next().respond(empty("a"));
    await flush();
    const release = queries.subscribeWindow("a", () => {});
    queries.ensure("a");
    queries.prepare?.("b");
    next().respond(empty("b"));
    await flush();
    queries.prepare?.("b");
    expect(store.retainedChannels()).toEqual(["a"]);
    release();
    store.dispose();
  });
  it("hydrates only currently authorized signed records and reconciles deleted rows from a fresh response", async () => {
    const disk = memoryDisk([
      {
        channelId: "a",
        savedAt: Date.now(),
        events: head("a", "cached"),
        profiles: [profile(alice, { name: "Alice" })],
      },
      {
        channelId: "private",
        savedAt: Date.now(),
        events: head("private"),
        profiles: [],
      },
    ]);
    const { queries, next, store, pending } = setup({ persistence: disk });
    queries.ensureList();
    next().respond(discovery(["a"]));
    await flush();
    queries.ensure("a");
    await vi.waitFor(() =>
      expect(queries.window("a")).toMatchObject({
        freshness: "cached",
        rows: [{ content: "cached" }],
      }),
    );
    expect(store.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice",
    );
    expect(queries.window("private").rows).toEqual([]);
    expect(disk.retain).toHaveBeenCalledWith(["a"]); // A complete roster read is permission to drop unknown disk warmth.
    // Only selected-channel demand reads; fresh authoritative empty replaces cached rows.
    expect(pending.length).toBe(1);
    next().respond(empty("a"));
    await flush();
    expect(queries.window("a")).toMatchObject({
      freshness: "verified",
      rows: [],
      hasMore: false,
    });
    store.dispose();
  });
  it("rejects corrupt cached messages and prevents a late disk result overwriting a network head", async () => {
    let resolve!: (records: SavedHead[]) => void;
    const disk = memoryDisk();
    disk.read = () =>
      new Promise((r) => {
        resolve = r;
      });
    const { queries, next, store } = setup({ persistence: disk });
    queries.ensureList();
    next().respond(discovery(["a", "b"]));
    await flush();
    queries.ensure("a");
    next().respond(empty("a"));
    await flush();
    resolve([
      {
        channelId: "a",
        savedAt: Date.now(),
        events: head("a", "stale"),
        profiles: [],
      },
      {
        channelId: "b",
        savedAt: Date.now(),
        events: [{ ...head("b")[0], content: "tampered" }, ...empty("b")],
        profiles: [],
      },
    ]);
    await flush();
    expect(queries.window("a").rows).toEqual([]);
    expect(store.diagnostics().heads.entries).toBe(1);
    store.dispose();
  });
  it("denied cached revalidation immediately hides the cached rows", async () => {
    const disk = memoryDisk([
      { channelId: "a", savedAt: Date.now(), events: head("a"), profiles: [] },
    ]);
    const { queries, next, store } = setup({ persistence: disk });
    queries.ensureList();
    next().respond(discovery(["a"]));
    await flush();
    queries.ensure("a");
    await vi.waitFor(() => expect(queries.window("a").rows).toHaveLength(1));
    next().fail(new Error("Relay read failed (403)"));
    await flush();
    expect(queries.window("a")).toMatchObject({ status: "error", rows: [] });
    expect(store.diagnostics().heads.entries).toBe(0);
    store.dispose();
  });
  it("drops revoked windows and rejects in-flight warm results after roster refresh", async () => {
    const { queries, next, store } = setup();
    queries.ensureList();
    next().respond(discovery(["a"]));
    await flush();
    queries.prepare?.("a");
    const stale = next();
    queries.ensure("a");
    queries.refreshList?.();
    next().respond([roster(relay, "a", [], 1_700_000_001)]);
    await flush();
    stale.respond(head("a"));
    await flush();
    expect(queries.list().channels).toEqual([]);
    expect(queries.window("a").rows).toEqual([]);
    expect(store.diagnostics().heads.entries).toBe(0);
    store.dispose();
  });
  it("enforces a history budget without pretending it reached EOF or evicting the reading rows", async () => {
    const { queries, next, store } = setup({
      prepared: false,
      maxHistoryRows: 1,
    });
    queries.ensure("a");
    const first = message(alice, "a", "new", 20);
    next().respond([
      first,
      bounds(relay, "a", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: first.id },
      }),
    ]);
    await flush();
    next().respond([profile(alice, { name: "Alice" })]);
    await flush();
    queries.loadOlder("a");
    next().respond([
      message(alice, "a", "old", 10),
      bounds(relay, "a", `20:${first.id}`, {
        has_more: false,
        next_cursor: null,
      }),
    ]);
    await flush();
    expect(queries.window("a")).toMatchObject({
      historyLimited: true,
      hasMore: true,
      rows: [{ content: "new" }],
    });
    store.dispose();
  });
  it("clear rejects in-flight results and clears the persistent identity partition", async () => {
    const disk = memoryDisk();
    const { queries, next, store } = setup({ persistence: disk });
    queries.ensureList();
    next().respond(discovery(["a"]));
    await flush();
    queries.prepare?.("a");
    const stale = next();
    await store.clearCache();
    stale.respond(head("a"));
    await flush();
    expect(store.diagnostics().heads.entries).toBe(0);
    expect(disk.clear).toHaveBeenCalledOnce();
    store.dispose();
  });
});

it("byte LRU enforces both budgets and rejects a single oversize object", () => {
  const cache = new ByteLru<string>(2, 10);
  cache.set("a", "A", 4);
  cache.set("b", "B", 4);
  cache.get("a");
  cache.set("c", "C", 4);
  expect(cache.keys()).toEqual(["a", "c"]);
  expect(cache.stats().bytes).toBe(8);
  expect(cache.set("d", "D", 20)).toBe(false);
  expect(cache.keys()).toEqual(["a", "c"]);
});
it("storage failure does not block foreground reads", async () => {
  const disk = memoryDisk();
  disk.read = async () => {
    throw new Error("storage denied");
  };
  disk.write = async () => {
    throw new Error("quota");
  };
  const { queries, next, store } = setup({ persistence: disk });
  queries.ensureList();
  next().respond(discovery(["a"]));
  await flush();
  queries.ensure("a");
  next().respond(empty("a"));
  await flush();
  expect(queries.window("a").status).toBe("ready");
  store.dispose();
});
it("dispose aborts intent preparation and rejects its late completion", async () => {
  const { queries, next, store } = setup();
  queries.ensureList();
  next().respond(discovery(["a"]));
  await flush();
  queries.prepare?.("a");
  const request = next();
  store.dispose();
  expect(request.signal?.aborted).toBe(true);
  request.respond(head("a"));
  await flush();
  expect(store.diagnostics().heads.entries).toBe(0);
});
it("a revoke-and-regrant cannot let the pre-revocation response repopulate the head", async () => {
  const { queries, next, store } = setup();
  queries.ensureList();
  next().respond(discovery(["a"]));
  await flush();
  queries.prepare?.("a");
  const stale = next();
  queries.refreshList?.();
  next().respond([roster(relay, "a", [], 1_700_000_001)]);
  await flush();
  queries.refreshList?.();
  next().respond([roster(relay, "a", [viewer.pubkey], 1_700_000_002)]);
  await flush();
  stale.respond(head("a", "before revocation"));
  await flush();
  expect(store.diagnostics().heads.entries).toBe(0);
  store.dispose();
});

it("reads rosters scoped to the viewer, then metadata only for unnamed channels", async () => {
  const { queries, store, next, pending } = setup();
  queries.ensureList();
  const rosters = next();
  expect(rosters.filters).toEqual([
    { kinds: [39002], "#p": [viewer.pubkey], limit: 500 },
  ]);
  rosters.respond([
    roster(relay, "a", [viewer.pubkey]),
    roster(relay, "b", [viewer.pubkey]),
    roster(alice, "forged", [viewer.pubkey]),
  ]);
  await flush();
  const names = next();
  expect(names.filters).toEqual([
    { kinds: [39000], "#d": ["a", "b"], limit: 500 },
  ]);
  names.respond([metadata(relay, "a", "Alpha")]);
  await flush();
  expect(queries.list()).toMatchObject({
    status: "ready",
    channels: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "b" },
    ],
  });
  expect(queries.list().coverage).toBeUndefined();
  queries.prepare?.("a");
  next().respond(empty("a"));
  await flush();
  queries.prepare?.("b");
  next().respond(empty("b"));
  await flush();
  queries.refreshList?.();
  next().respond([roster(relay, "a", [viewer.pubkey])]);
  await flush();
  // Refresh re-reads every name; the refresh is also complete, so the omitted roster b is revoked.
  const nameRead = pending.at(-1);
  assert.exists(nameRead);
  expect(nameRead.filters).toEqual([
    { kinds: [39000], "#d": ["a"], limit: 500 },
  ]);
  next().respond([metadata(relay, "a", "Alpha")]);
  await flush();
  expect(queries.list().channels.map((c) => c.id)).toEqual(["a"]);
  expect(store.diagnostics().heads.entries).toBe(1);
  store.dispose();
});

it("keeps known membership and cached heads when a later roster page fails", async () => {
  const { queries, store, next } = setup();
  queries.ensureList();
  next().respond(discovery(["a"])); // Metadata answered inline; no second read.
  await flush();
  queries.prepare?.("a");
  next().respond(empty("a"));
  await flush();
  queries.refreshList?.();
  const capped = Array.from({ length: 500 }, (_, index) =>
    roster(relay, `c${index}`, [viewer.pubkey]),
  );
  next().respond(capped);
  await flush();
  const continuation = next();
  expect(continuation.filters[0]?.kinds).toEqual([39002]);
  continuation.fail(new Error("Later roster page unavailable"));
  await vi.waitFor(() => expect(queries.list().status).toBe("error"));
  expect(queries.list().channels.map((c) => c.id)).toContain("a");
  expect(queries.list().channels.length).toBe(501);
  expect(queries.list().coverage).toBe("partial");
  expect(store.diagnostics().heads.entries).toBe(1);
  store.dispose();
});

it("hides DM channels behind the NIP-29 hidden tag", async () => {
  const { queries, store, next } = setup();
  queries.ensureList();
  next().respond([roster(relay, "dm", [viewer.pubkey, alice.pubkey])]);
  await flush();
  next().respond([
    signed(relay, {
      kind: 39000,
      content: "",
      tags: [
        ["d", "dm"],
        ["name", "DM"],
        ["hidden", ""],
      ],
    }),
  ]);
  await flush();
  expect(queries.list().channels).toEqual([
    {
      id: "dm",
      name: "DM",
      description: "",
      visibility: undefined,
      hidden: true,
      members: [viewer.pubkey, alice.pubkey].sort(),
      preview: undefined,
    },
  ]);
  store.dispose();
});

it("restores an authorized disk head while optional metadata and network head are held", async () => {
  const disk = memoryDisk([
    {
      channelId: "a",
      savedAt: Date.now(),
      events: head("a", "cached"),
      profiles: [],
    },
    {
      channelId: "private",
      savedAt: Date.now(),
      events: head("private"),
      profiles: [],
    },
  ]);
  const { queries, next, store } = setup({ persistence: disk });
  try {
    queries.ensureList();
    next().respond([roster(relay, "a", [viewer.pubkey])]);
    await flush();
    const names = next();
    expect(names.filters[0]?.kinds).toEqual([39000]);
    queries.ensure("a");
    const network = next();
    await vi.waitFor(() =>
      expect(queries.window("a")).toMatchObject({
        freshness: "cached",
        rows: [{ content: "cached" }],
      }),
    );
    expect(queries.window("private").rows).toEqual([]);
    expect(network.signal?.aborted).toBe(false);
    expect(disk.read).toHaveBeenCalledOnce();
    names.fail(new Error("Optional metadata unavailable"));
    await flush();
    expect(queries.window("a").rows[0]?.content).toBe("cached");
  } finally {
    store.dispose();
  }
});

it("persists a ready head before optional profiles, enriching only after they arrive", async () => {
  const disk = memoryDisk();
  const { queries, next, store } = setup({ persistence: disk });
  try {
    queries.ensureList();
    next().respond(discovery(["a"]));
    await flush();
    queries.ensure("a");
    next().respond(head("a"));
    await flush();
    const names = next();
    expect(names.filters[0]?.kinds).toEqual([0]);
    expect(queries.window("a").status).toBe("ready");
    expect(disk.write).toHaveBeenCalledOnce();
    expect(vi.mocked(disk.write).mock.calls[0]?.[0].profiles).toEqual([]);
    names.respond([profile(alice, { name: "Alice" })]);
    await vi.waitFor(() => expect(disk.write).toHaveBeenCalledTimes(2));
    expect(vi.mocked(disk.write).mock.calls[1]?.[0].profiles).toHaveLength(1);
  } finally {
    store.dispose();
  }
});

it.each(["empty", "failure"])(
  "does not rewrite persisted heads after %s profile enrichment",
  async (outcome) => {
    const disk = memoryDisk();
    const { queries, next, store } = setup({ persistence: disk });
    try {
      queries.ensureList();
      next().respond(discovery(["a"]));
      await flush();
      queries.ensure("a");
      next().respond(head("a"));
      await flush();
      expect(disk.write).toHaveBeenCalledOnce();
      const names = next();
      if (outcome === "empty") names.respond([]);
      else names.fail(new Error("Names unavailable"));
      await flush();
      await flush();
      expect(disk.write).toHaveBeenCalledOnce();
    } finally {
      store.dispose();
    }
  },
);

it.each(["clear", "dispose", "revoke"])(
  "late profile enrichment cannot write a head after %s",
  async (boundary) => {
    const disk = memoryDisk();
    const { queries, next, store } = setup({ persistence: disk });
    try {
      queries.ensureList();
      next().respond(discovery(["a"]));
      await flush();
      queries.ensure("a");
      next().respond(head("a"));
      await flush();
      const names = next();
      expect(disk.write).toHaveBeenCalledOnce();
      if (boundary === "clear") await store.clearCache();
      else if (boundary === "dispose") store.dispose();
      else {
        queries.refreshList?.();
        next().respond([roster(relay, "a", [], 1_700_000_001)]);
        await flush();
      }
      names.respond([profile(alice, { name: "Late Alice" })]);
      await flush();
      await flush();
      expect(disk.write).toHaveBeenCalledOnce();
    } finally {
      store.dispose();
    }
  },
);

it("bounds transient preparation to one request without delaying selected-channel dispatch", async () => {
  const { queries, next, pending, store } = setup();
  try {
    queries.ensureList();
    next().respond(discovery(["a", "b", "c", "z"]));
    await flush();
    queries.prepare?.("a");
    const speculative = next();
    queries.prepare?.("b");
    queries.prepare?.("c");
    expect(pending).toHaveLength(0);
    queries.ensure("z");
    const selected = next();
    expect(selected.filters[0]?.["#h"]).toEqual(["z"]);
    selected.respond(empty("z"));
    await flush();
    expect(queries.window("z").status).toBe("ready");
    expect(speculative.signal?.aborted).toBe(false);
    speculative.respond(empty("a"));
    await flush();
    expect(pending).toHaveLength(0); // Dropped pointer hints never become a backlog.
    queries.prepare?.("b");
    expect(next().filters[0]?.["#h"]).toEqual(["b"]);
  } finally {
    store.dispose();
  }
});

it("selection shares the one speculative read and failure releases preparation capacity", async () => {
  const { queries, next, pending, store } = setup();
  try {
    queries.ensureList();
    next().respond(discovery(["a", "b"]));
    await flush();
    queries.prepare?.("a");
    const selected = next();
    queries.ensure("a");
    expect(pending).toHaveLength(0);
    selected.fail(new Error("Head unavailable"));
    await flush();
    await flush();
    expect(queries.window("a").status).toBe("error");
    queries.prepare?.("b");
    expect(next().filters[0]?.["#h"]).toEqual(["b"]);
  } finally {
    store.dispose();
  }
});

it("failed prepared head diagnostics omit response text from JSON errors", async () => {
  const logger = getLogger("relay");
  const reporters = [...logger.options.reporters];
  const previous = logLevel();
  const lines: string[] = [];
  logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
  const { queries, store, next } = setup();
  try {
    setLogLevel("debug");
    queries.ensureList();
    next().respond(discovery(["a"]));
    await flush();
    queries.ensure("a");
    let failure: unknown;
    try {
      await new Response("RESPONSE_SECRET_306").json();
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("RESPONSE_SECRET_306");
    next().fail(failure);
    await flush();
    expect(lines.join(" ")).toContain("head failed a unavailable");
    expect(lines.join(" ")).not.toContain("RESPONSE_SECRET_306");
  } finally {
    store.dispose();
    logger.setReporters(reporters);
    setLogLevel(previous);
  }
});
