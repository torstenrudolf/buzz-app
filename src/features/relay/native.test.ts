import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import {
  connectNativeTransport,
  nativeRelayRequest,
  nativeRelaySigner,
  nativeWriteKinds,
} from "./native";
import { keypair, message, signed } from "./testing";
import { createOutbox, type OutgoingEvent, PublishRejected } from "./outbox";
import { createMessages } from "./messages";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const viewer = keypair(),
  relay = keypair();
const community = "https://packaged.test";
type Request = {
  community: string;
  path: string;
  method: string;
  body: string | null;
};
let respond: (
  request: Request,
) =>
  | { status?: number; body: unknown }
  | Promise<{ status?: number; body: unknown }>;
const requests: Request[] = [];
const owners: ReturnType<typeof createOutbox>[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1700000010000);
  requests.length = 0;
  respond = () => ({ body: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Packaged connections must not call the dev broker");
    }),
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return viewer.pubkey;
    if (command === "relay_sign") {
      expect(
        Object.keys((args as { event: EventTemplate }).event).sort(),
      ).toEqual(["content", "created_at", "kind", "tags"]);
      return signed(viewer, (args as { event: EventTemplate }).event);
    }
    if (command === "relay_http") {
      const request = args as Request;
      requests.push(request);
      const result =
        request.path === "/"
          ? { body: { self: relay.pubkey } }
          : await respond(request);
      return {
        status: result.status ?? 200,
        headers: {},
        body: JSON.stringify(result.body),
      };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
});

it("requires the relay self key, never its operator contact pubkey", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: JSON.stringify({ pubkey: relay.pubkey }),
  });
  await expect(connectNativeTransport(community)).rejects.toThrow(
    "advertise its identity",
  );
});

it("reads back expired delivery with strong consistency without re-signing or publishing it", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.writer);
  const event = message(viewer, "channel", "old delivery", 1699999000);
  respond = () => ({ body: [event] });
  await transport.writer.publish(event, new AbortController().signal);
  expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual([
    {
      kinds: [9],
      ids: [event.id],
      authors: [viewer.pubkey],
      limit: 1,
      consistency: "strong",
    },
  ]);
  respond = () => ({ body: [] });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toThrow("too old to retry");
  respond = () => ({ status: 503, body: { error: "offline" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
  expect(requests.every((request) => request.path !== "/events")).toBe(true);
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "relay_sign"),
  ).toBe(false);
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("discovers the relay, verifies reads and publishes through the same native identity and destination", async () => {
  const incoming = message(viewer, "channel", "hello", 1700000000);
  respond = (r) =>
    r.path === "/query"
      ? { body: [incoming] }
      : {
          body: {
            accepted: true,
            event_id: JSON.parse(r.body ?? "{}").id,
            message: "confirmed",
          },
        };
  const transport = await connectNativeTransport(community);
  expect(transport.viewer).toBe(viewer.pubkey);
  expect(transport.relayAuthor).toBe(relay.pubkey);
  expect(
    await transport.query([{ kinds: [9], "#h": ["channel"], limit: 10 }]),
  ).toEqual([incoming]);
  assert.exists(transport.writer);
  const event = await transport.writer.sign(
    {
      kind: 9,
      content: "native send",
      tags: [["h", "channel"]],
      created_at: 1700000001,
    },
    new AbortController().signal,
  );
  expect(
    await transport.writer.publish(event, new AbortController().signal),
  ).toBe("confirmed");
  expect(requests.map((r) => [r.community, r.path])).toEqual([
    [community, "/"],
    [community, "/query"],
    [community, "/events"],
  ]);
  expect(JSON.parse(requests[2]?.body ?? "null")).toEqual(
    JSON.parse(JSON.stringify(event)),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects tampered reads and keeps refusals distinct from uncertain receipts", async () => {
  const transport = await connectNativeTransport(community);
  const event = message(viewer, "channel", "original", 1700000000);
  respond = () => ({ body: [{ ...event, content: "tampered" }] });
  await expect(transport.query([{ kinds: [9], limit: 10 }])).rejects.toThrow();
  assert.exists(transport.writer);
  respond = () => ({ status: 403, body: { error: "denied" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  respond = () => ({ body: { accepted: true, event_id: "wrong" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
});

it("a captured signer cannot send a request to a different community", async () => {
  const signer = nativeRelaySigner(community);
  expect(() =>
    signer.request?.(
      "https://other.test/events",
      "{}",
      new AbortController().signal,
    ),
  ).toThrow("changed community");
  expect(invoke).not.toHaveBeenCalled();
});

it("authenticates live traffic with the native signer and verifies incoming channel events", async () => {
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    onmessage?: (event: { data: string }) => Promise<void>;
    onclose?: () => void;
    sent: unknown[][] = [];
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    async receive(value: unknown) {
      await this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const transport = await connectNativeTransport(community);
  const receive = vi.fn();
  const traffic = transport.subscribe?.({
    receive,
    state: vi.fn(),
    established: vi.fn(),
    denied: vi.fn(),
  });
  assert.exists(traffic);
  try {
    traffic.update(["channel"]);
    const socket = sockets[0];
    assert.exists(socket);
    expect(socket.url).toBe("wss://packaged.test");
    await socket.receive(["AUTH", "nonce"]);
    const proof = socket.sent.find(
      ([kind]) => kind === "AUTH",
    )?.[1] as VerifiedEvent;
    expect(proof.pubkey).toBe(viewer.pubkey);
    expect(proof.tags).toEqual([
      ["relay", "wss://packaged.test"],
      ["challenge", "nonce"],
    ]);
    await socket.receive(["OK", proof.id, true]);
    const route = socket.sent.find(
      ([kind, , filter]) =>
        kind === "REQ" &&
        (filter as { "#h"?: string[] })["#h"]?.includes("channel"),
    );
    assert.exists(route);
    await socket.receive(["EOSE", route[1]]);
    const incoming = message(keypair(), "channel", "Live reply", 1700000002);
    await socket.receive(["EVENT", route[1], incoming]);
    expect(receive).toHaveBeenCalledWith([incoming], {
      phase: "live",
      channelId: "channel",
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "identity_export"),
    ).toBe(false);
  } finally {
    traffic.dispose();
  }
});

it("cancellation fences a late native response and prevents undispatched work", async () => {
  const gate = deferred<{ body: unknown }>();
  respond = () => gate.promise;
  const controller = new AbortController();
  const request = nativeRelayRequest(
    community,
    "/query",
    [],
    controller.signal,
  );
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  controller.abort();
  try {
    await expect(
      nativeRelayRequest(community, "/query", [], controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
  } finally {
    gate.resolve({ body: [] });
  }
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

it("cancelled native reads retain the six-request admission bound until IPC settles", async () => {
  vi.useFakeTimers();
  const transport = await connectNativeTransport(
    "https://cancelled-native.test",
  );
  const gate = deferred<{ body: unknown }>();
  let active = 0,
    maximum = 0;
  respond = async () => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      return await gate.promise;
    } finally {
      active--;
    }
  };
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const reads = controllers.map((controller) =>
    transport
      .query([{ kinds: [0], limit: 5 }], controller.signal)
      .catch((error: unknown) => error),
  );
  try {
    await vi.waitFor(() =>
      expect(requests.filter((r) => r.path === "/query")).toHaveLength(6),
    );
    for (const controller of controllers) controller.abort();
    // A further request has entered the same lane, but cannot dispatch past cancelled native work.
    const last = transport.query([{ kinds: [0], limit: 5 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.filter((r) => r.path === "/query")).toHaveLength(6);
    gate.resolve({ body: [] });
    await last;
    expect(requests.filter((r) => r.path === "/query")).toHaveLength(7);
    for (const error of await Promise.all(reads))
      expect(error).toMatchObject({ name: "AbortError" });
    expect(maximum).toBe(6);
  } finally {
    gate.resolve({ body: [] });
    await Promise.all(reads);
  }
});

it("restores uncertain native delivery and retries the exact signed event without signing it again", async () => {
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const first = await connectNativeTransport(community);
  assert.exists(first.writer);
  respond = () => {
    throw new Error("Receipt lost after dispatch");
  };
  const one = createOutbox(viewer.pubkey, first.writer, storage);
  owners.push(one);
  await one.outbox.ready();
  const id = one.outbox.send({
    kind: 9,
    content: "recover me",
    tags: [["h", "channel"]],
  });
  await vi.waitFor(() => expect(records[0]?.delivery).toBe("unknown"));
  const published = JSON.parse(
    requests.find((r) => r.path === "/events")?.body ?? "null",
  );
  one.dispose();
  vi.mocked(invoke).mockClear();
  const second = await connectNativeTransport(community);
  assert.exists(second.writer);
  respond = () => ({ body: { accepted: true, event_id: published.id } });
  const two = createOutbox(viewer.pubkey, second.writer, storage);
  owners.push(two);
  await two.outbox.ready();
  expect(two.outbox.snapshot()[0]?.delivery).toBe("unknown");
  two.outbox.retry(id);
  await vi.waitFor(() =>
    expect(two.outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
  expect(
    requests
      .filter((r) => r.path === "/events")
      .map((r) => JSON.parse(r.body ?? "null")),
  ).toEqual([published, published]);
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "relay_sign"),
  ).toBe(false);
});

it.each(["missing", "offline"])(
  "keeps expired delivery unknown after %s readback",
  async (failure) => {
    const event = message(viewer, "channel", "expired intent", 1699999000);
    let records: readonly OutgoingEvent[] = [
      { event, signed: event, delivery: "unknown" },
    ];
    const transport = await connectNativeTransport(community);
    assert.exists(transport.writer);
    respond = () =>
      failure === "missing"
        ? { body: [] }
        : { status: 503, body: { error: "offline" } };
    const owner = createOutbox(viewer.pubkey, transport.writer, {
      load: () => structuredClone(records),
      save: (next) => {
        records = structuredClone(next);
      },
    });
    owners.push(owner);
    await owner.outbox.ready();
    owner.outbox.retry(event.id);
    await vi.waitFor(() =>
      expect(records[0]?.error).toMatch(
        failure === "missing"
          ? /too old to retry/
          : /Relay request failed \(503\)/,
      ),
    );
    expect(records[0]).toMatchObject({ signed: event, delivery: "unknown" });
    expect(requests.some((request) => request.path === "/events")).toBe(false);
  },
);

it.each(["online", "tampered", "wrong-author", "empty"] as const)(
  "native presence snapshot uses bounded authenticated query and verifies authority (%s)",
  async (result) => {
    const origin = `https://presence-${result}.test`;
    const event = signed(result === "wrong-author" ? viewer : relay, {
      kind: 20001,
      created_at: 1700000010,
      tags: [["p", viewer.pubkey]],
      content: "online",
    });
    respond = () => ({
      body:
        result === "empty"
          ? []
          : [result === "tampered" ? { ...event, content: "away" } : event],
    });
    const transport = await connectNativeTransport(origin);
    const pending = transport.presenceSnapshot?.(
      [viewer.pubkey],
      new AbortController().signal,
    );
    if (result === "tampered" || result === "wrong-author")
      await expect(pending).rejects.toThrow();
    else
      expect((await pending)?.get(viewer.pubkey)).toBe(
        result === "empty" ? "offline" : "online",
      );
    expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual([
      { kinds: [20001], authors: [viewer.pubkey], limit: 1 },
    ]);
    expect(requests.at(-1)?.path).toBe("/query");
    expect(
      await transport.presenceSnapshot?.(
        [viewer.pubkey],
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(["message", "reaction"] as const)(
  "publishes native %s removal with the broker's kind-5 tags",
  async (target) => {
    const transport = await connectNativeTransport(community);
    assert.exists(transport.writer);
    const original = message(viewer, "channel", "remove me", 1700000000);
    const reaction = signed(viewer, {
      kind: 7,
      content: "👍",
      tags: [
        ["h", "channel"],
        ["e", original.id],
      ],
    });
    const chosen = target === "message" ? original : reaction;
    const owner = createOutbox(viewer.pubkey, transport.writer, {
      load: () => [],
      save: () => {},
    });
    owners.push(owner);
    await owner.outbox.ready();
    const messages = createMessages(
      owner.outbox,
      viewer.pubkey,
      (id) => [original, reaction].find((event) => event.id === id),
      () => [],
      () => {},
    );
    respond = (request) => ({
      body: {
        accepted: true,
        event_id: JSON.parse(request.body ?? "{}").id,
      },
    });
    messages.remove([chosen.id]);
    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.path === "/events"),
      ).toHaveLength(1),
    );
    const event = JSON.parse(requests.at(-1)?.body ?? "null");
    expect(event).toMatchObject({
      kind: 5,
      pubkey: viewer.pubkey,
      content: "",
    });
    expect(event.tags).toEqual([
      ["h", "channel"],
      ["e", chosen.id],
      ["k", String(chosen.kind)],
      ["client-id", expect.any(String)],
    ]);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([command, args]) =>
            command === "relay_sign" &&
            (args as { event: EventTemplate }).event.kind === 5,
        ),
    ).toBe(true);
  },
);

it("exposes workflow history over the purpose-bound native route and workflow write kinds", async () => {
  const transport = await connectNativeTransport(community);
  expect(nativeWriteKinds).toEqual(expect.arrayContaining([30620, 46020, 5]));
  expect(transport.writer?.kinds).toEqual(nativeWriteKinds);
  assert.exists(transport.workflows);
  const id = "11111111-1111-4111-8111-111111111111";
  const cursor = { before: "2026-09-29T20:00:00Z", beforeId: id };
  const runs = { runs: [], next: null };
  vi.mocked(invoke).mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_workflow_runs");
    expect(args).toEqual({ community, id, cursor });
    return { status: 200, headers: {}, body: JSON.stringify(runs) };
  });
  expect(
    await transport.workflows.runs(id, cursor, new AbortController().signal),
  ).toEqual(runs);
  await expect(
    transport.workflows.runs("../", undefined, new AbortController().signal),
  ).rejects.toThrow("Invalid workflow ID");
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.workflows.runs(id, undefined, controller.signal),
  ).rejects.toThrow();
  expect(requests).toEqual([
    { community, path: "/", method: "GET", body: null },
  ]);
});

it("workflow history surfaces bounded host refusals and fences late native results", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.workflows);
  const id = "11111111-1111-4111-8111-111111111111";
  const pending = deferred<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>();
  vi.mocked(invoke).mockImplementationOnce(() => pending.promise);
  const controller = new AbortController();
  const read = transport.workflows.runs(id, undefined, controller.signal);
  controller.abort();
  pending.resolve({
    status: 200,
    headers: {},
    body: '{"runs":[],"next":null}',
  });
  await expect(read).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 403,
    headers: {},
    body: '{"error":"denied"}',
  });
  await expect(
    transport.workflows.runs(id, undefined, new AbortController().signal),
  ).rejects.toMatchObject({ kind: "denied" });
});

it("shares workflow history admission and cooldown with signed queries", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.workflows);
  const id = "11111111-1111-4111-8111-111111111111";
  const quota = '{"error":"rate-limited: quota exceeded; retry in 60s"}';
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 429,
    headers: {},
    body: quota,
  });
  await expect(
    transport.workflows.runs(id, undefined, new AbortController().signal),
  ).rejects.toMatchObject({ status: 429 });
  const calls = vi.mocked(invoke).mock.calls.length;
  await expect(transport.query([{ kinds: [9], limit: 1 }])).rejects.toThrow(
    "paused",
  );
  expect(vi.mocked(invoke).mock.calls.length).toBe(calls);
});

it("holds the shared admission lease until a cancelled native history request settles", async () => {
  const scope = "https://packaged-admission.test";
  const transport = await connectNativeTransport(scope);
  const workflows = transport.workflows;
  assert.exists(workflows);
  const id = "11111111-1111-4111-8111-111111111111";
  const pending = Array.from({ length: 6 }, () =>
    deferred<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>(),
  );
  const historyCalls: number[] = [];
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "relay_workflow_runs") {
      const index = historyCalls.push(1) - 1;
      return (
        pending[index]?.promise ??
        Promise.reject(new Error("Unexpected history request"))
      );
    }
    if (command === "relay_http" && (args as Request).path === "/query") {
      requests.push(args as Request);
      return Promise.resolve({ status: 200, headers: {}, body: "[]" });
    }
    return Promise.reject(new Error(`Unexpected command: ${command}`));
  });
  const controllers = pending.map(() => new AbortController());
  const reads = controllers.map((controller) =>
    workflows.runs(id, undefined, controller.signal),
  );
  await vi.waitFor(() => expect(historyCalls).toHaveLength(6));
  const outcomes = reads.map((read) => expect(read).rejects.toThrow());
  for (const controller of controllers) controller.abort();
  const query = transport.query([{ kinds: [9], limit: 1 }]);
  await Promise.resolve();
  expect(requests).toHaveLength(1); // Discovery only; all six IPC requests still hold slots.
  for (const request of pending) {
    request.resolve({
      status: 200,
      headers: {},
      body: '{"runs":[],"next":null}',
    });
  }
  await Promise.all(outcomes);
  await expect(query).resolves.toEqual([]);
  expect(requests.at(-1)?.path).toBe("/query");
});

it("discards a pending observer decode after disconnect and reconnect", async () => {
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    onmessage?: (event: { data: string }) => Promise<void>;
    onclose?: () => void;
    sent: unknown[][] = [];
    constructor() {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    async receive(value: unknown) {
      await this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const decoded = deferred<unknown>();
  const dispatch = vi.mocked(invoke);
  const original = dispatch.getMockImplementation();
  let observerCalls = 0;
  dispatch.mockImplementation(async (command, args) => {
    if (command === "relay_agent_observer") {
      if (++observerCalls === 1) return decoded.promise;
      const event = (args as { event: VerifiedEvent }).event;
      return {
        id: event.id,
        agent: event.pubkey,
        createdAt: event.created_at,
        plaintext: "{}",
      };
    }
    return original?.(command, args);
  });
  const transport = await connectNativeTransport(community);
  const observer = vi.fn();
  const traffic = transport.subscribe?.({
    receive: vi.fn(),
    state: vi.fn(),
    established: vi.fn(),
    denied: vi.fn(),
    observer,
  });
  assert.exists(traffic);
  try {
    const authenticate = async (socket: Socket) => {
      await socket.receive(["AUTH", "nonce"]);
      const proof = socket.sent.find(
        ([kind]) => kind === "AUTH",
      )?.[1] as VerifiedEvent;
      await socket.receive(["OK", proof.id, true]);
    };
    traffic.observe?.(1);
    const old = sockets[0];
    assert.exists(old);
    await authenticate(old);
    const route = old.sent.find(
      ([kind, , filter]) =>
        kind === "REQ" &&
        (filter as { kinds?: number[] }).kinds?.includes(24200),
    );
    assert.exists(route);
    await old.receive(["EOSE", route[1]]);
    const frame = signed(keypair(), {
      kind: 24200,
      created_at: 1700000010,
      tags: [["p", viewer.pubkey]],
      content: "cipher",
    });
    await old.receive(["EVENT", route[1], frame]);
    expect(
      dispatch.mock.calls.some(
        ([command]) => command === "relay_agent_observer",
      ),
    ).toBe(true);
    old.onclose?.();
    vi.useRealTimers();
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    const current = sockets[1];
    assert.exists(current);
    await authenticate(current);
    const nextRoute = current.sent.find(
      ([kind, , filter]) =>
        kind === "REQ" &&
        (filter as { kinds?: number[] }).kinds?.includes(24200),
    );
    assert.exists(nextRoute);
    await current.receive(["EOSE", nextRoute[1]]);
    decoded.resolve({
      id: frame.id,
      agent: frame.pubkey,
      createdAt: frame.created_at,
      plaintext: "{}",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(observer).not.toHaveBeenCalled();
    const fresh = signed(keypair(), {
      kind: 24200,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", viewer.pubkey]],
      content: "cipher",
    });
    await current.receive(["EVENT", nextRoute[1], fresh]);
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
    expect(observer.mock.calls[0]?.[0].id).toBe(fresh.id);
  } finally {
    traffic.dispose();
  }
});

it("sorts host memory projections with the same locale collation as the broker", async () => {
  const transport = await connectNativeTransport(community);
  const agent = keypair();
  const entries = ["mem/b", "mem/b_c", "mem/b-c", "mem/b/c", "mem/bc"]
    .reverse()
    .map((slug, i) => ({
      slug,
      body: slug,
      eventId: i.toString(16).padStart(64, "0"),
      createdAt: 1,
    }));
  vi.mocked(invoke).mockResolvedValueOnce({ entries, partial: false });
  expect(
    (
      await transport.readAgentMemories?.(
        agent.pubkey,
        new AbortController().signal,
      )
    )?.entries.map((entry) => entry.slug),
  ).toEqual(["mem/b", "mem/b_c", "mem/b-c", "mem/b/c", "mem/bc"]);
});

it("exposes purpose-bound agent readers and fences obsolete observer decoding", async () => {
  const transport = await connectNativeTransport(community);
  expect(transport.agentActivity).toBe(true);
  const signal = new AbortController().signal;
  const agent = keypair();
  const dispatch = vi.mocked(invoke);
  dispatch.mockImplementationOnce(async (command) => {
    expect(command).toBe("relay_agent_library");
    return { definitions: [], identities: [] };
  });
  expect(await transport.readAgentLibrary?.(signal)).toEqual({
    definitions: [],
    identities: [],
  });
  dispatch.mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_agent_memories_read");
    expect(args).toEqual({ community, agent: agent.pubkey });
    return { entries: [], partial: true };
  });
  expect(await transport.readAgentMemories?.(agent.pubkey, signal)).toEqual({
    entries: [],
    partial: true,
  });
  await expect(
    transport.readAgentMemories?.(viewer.pubkey, signal),
  ).rejects.toThrow("Invalid memory target");
  dispatch.mockImplementationOnce(async (command, args) => {
    expect(command).toBe("relay_agent_log_proof");
    expect(args).toEqual({
      community,
      target: {
        id: "id",
        pubkey: agent.pubkey,
        relayUrl: "wss://packaged.test",
        nonce: "nonce",
      },
    });
    return "a".repeat(128);
  });
  expect(
    await transport.authorizeAgentLog?.(
      { id: "id", pubkey: agent.pubkey, relayUrl: "wss://packaged.test" },
      "nonce",
    ),
  ).toBe("a".repeat(128));
  await expect(
    transport.authorizeAgentLog?.(
      { id: "id", pubkey: agent.pubkey, relayUrl: "wss://other.test" },
      "nonce",
    ),
  ).rejects.toThrow("Log authorization unavailable");
});
