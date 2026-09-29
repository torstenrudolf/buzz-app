import { expect, it, vi } from "vitest";
import { createAgentLibrary, type AgentLibrary } from "./library";
import { combineInventory } from "./inventory";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, roster } from "../relay/testing";
const library: AgentLibrary = {
  definitions: [
    { id: "brain", name: "Brain" },
    { id: "other", name: "Brain" },
  ],
  identities: [
    { pubkey: "a".repeat(64), name: "Brain", definitionId: "brain" },
    { pubkey: "b".repeat(64), name: "Brain", definitionId: "brain" },
    { pubkey: "c".repeat(64), name: "Custom" },
    { pubkey: "d".repeat(64), name: "Other setup", definitionId: "unselected" },
  ],
};
it("lazy fresh reads replace, fail visibly, retry, and fence late results", async () => {
  const read = vi.fn().mockResolvedValue(library);
  const owner = createAgentLibrary(read);
  expect(read).not.toHaveBeenCalled();
  await owner.queries.refresh();
  expect(owner.queries.snapshot().identities).toHaveLength(4);
  read.mockRejectedValueOnce(new Error("private error"));
  await owner.queries.refresh();
  expect(owner.queries.snapshot().status).toBe("error");
  expect(JSON.stringify(owner.queries.snapshot())).not.toContain(
    "private error",
  );
  await owner.queries.refresh();
  expect(owner.queries.snapshot().status).toBe("ready");
  let release!: (value: AgentLibrary) => void;
  read.mockImplementationOnce(
    () =>
      new Promise<AgentLibrary>((resolve) => {
        release = resolve;
      }),
  );
  const pending = owner.queries.refresh();
  expect(owner.queries.snapshot().identities).toEqual(library.identities);
  await Promise.resolve();
  owner.clear();
  release(library);
  await pending;
  expect(owner.queries.snapshot().status).toBe("idle");
  owner.dispose();
  expect(owner.queries.snapshot().identities).toEqual([]);
});
it("actual session retains host library alongside relay reads and clears/disposes both", async () => {
  const read = vi.fn().mockResolvedValue(library);
  const query = vi.fn().mockResolvedValue([]);
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query,
    readAgentLibrary: read,
  });
  await owner.session.agentLibrary.refresh();
  expect(read).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledOnce();
  expect(owner.session.agentLibrary.snapshot().definitions).toHaveLength(2);
  await owner.clearCache();
  expect(owner.session.agentLibrary.snapshot().definitions).toEqual([]);
  await owner.session.agentLibrary.refresh();
  owner.dispose();
  expect(owner.session.agentLibrary.snapshot().status).toBe("unavailable");
});

it.each([false, true])(
  "session establishment reuses inventory with a pending read=%s and refreshes after disconnect",
  async (pendingRead) => {
    vi.useFakeTimers();
    let live!: import("../relay/live").LiveCallbacks;
    let release!: (value: AgentLibrary) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AgentLibrary>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(library);
    const viewer = keypair(),
      relay = keypair();
    const events = [
      roster(relay, "channel", [viewer.pubkey]),
      metadata(relay, "channel", "Channel"),
    ];
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      readAgentLibrary: read,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, prioritize() {}, retry() {}, dispose() {} };
      },
    });
    const stop = owner.session.agentLibrary.retain();
    try {
      const pending = owner.session.agentLibrary.refresh();
      await Promise.resolve();
      if (!pendingRead) {
        release(library);
        await pending;
      }
      live.state({ status: "connected", routes: [] });
      live.established();
      await vi.advanceTimersByTimeAsync(0);
      if (pendingRead) {
        release(library);
        await pending;
      }
      expect(read).toHaveBeenCalledTimes(1);
      expect(owner.session.agentLibrary.snapshot().status).toBe("ready");
      expect(owner.session.channels.list().channels).toHaveLength(1);
      // Signed channel access loss still removes the channel, not host-local names.
      live.receive([roster(relay, "channel", [], 1_700_000_001)]);
      expect(owner.session.channels.list().channels).toHaveLength(0);
      expect(owner.session.agentLibrary.snapshot().identities).toEqual(
        combineInventory(library, { definitions: [], identities: [] })
          .identities,
      );
      live.state({ status: "retrying", routes: [] });
      expect(owner.session.agentLibrary.snapshot().status).toBe("idle");
      live.state({ status: "connected", routes: [] });
      live.established();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect(owner.session.agentLibrary.snapshot().status).toBe("ready");
      stop();
      live.state({ status: "retrying", routes: [] });
      live.state({ status: "connected", routes: [] });
      live.established();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      release(library);
      stop();
      owner.dispose();
      vi.useRealTimers();
    }
  },
);

it("establishment retries a failed retained read without turning idle inventory into demand", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(library);
  const owner = createAgentLibrary(read);
  owner.reconnect();
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  const stop = owner.queries.retain();
  await owner.queries.refresh();
  expect(owner.queries.snapshot().status).toBe("error");
  owner.reconnect();
  await owner.queries.refresh();
  expect(read).toHaveBeenCalledTimes(2);
  expect(owner.queries.snapshot().status).toBe("ready");
  stop();
  owner.dispose();
});
