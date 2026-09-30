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
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${encodeURIComponent(path)}`,
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
const uploads: { bytes: Uint8Array; headers: Record<string, string> }[] = [];
let uploadResponse: () => { status?: number; body: unknown };
const cancels: string[] = [];
let hangUploads = false;
let preparedResponse: (() => { status?: number; body: unknown }) | undefined;
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
  uploads.length = 0;
  cancels.length = 0;
  hangUploads = false;
  preparedResponse = undefined;
  uploadResponse = () => ({ status: 500, body: "" });
  vi.mocked(invoke).mockImplementation(async (command, args, options) => {
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
    if (command === "relay_upload_cancel") {
      cancels.push((args as { id: string }).id);
      return null;
    }
    if (command === "relay_upload") {
      if (hangUploads) return new Promise(() => {});
      uploads.push({
        bytes: new Uint8Array(args as ArrayBuffer),
        headers: (options as { headers: Record<string, string> }).headers,
      });
      const result = (options as { headers: Record<string, string> }).headers[
        "x-buzz-preparation"
      ]
        ? (preparedResponse?.() ?? uploadResponse())
        : uploadResponse();
      return {
        status: result.status ?? 200,
        headers: {},
        body:
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body),
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
const hash = "c".repeat(64);
it("routes relay media through the authenticated native scheme only", async () => {
  const transport = await connectNativeTransport(community);
  const media = `${community}/media/${hash}.png`;
  expect(transport.media(media)).toBe(
    `buzz-media://localhost/${encodeURIComponent(media)}`,
  );
  expect(transport.media(media, "small")).toBe(
    `buzz-media://localhost/${encodeURIComponent(`${community}/media/${hash}.thumb.jpg`)}`,
  );
  expect(transport.media("https://images.test/cat.png")).toBe(
    "https://images.test/cat.png",
  );
  expect(transport.media("http://images.test/cat.png")).toBeUndefined();
});

it("publishes custom emoji sets", async () => {
  const transport = await connectNativeTransport(community);
  expect(transport.writer?.kinds).toContain(30030);
});

it("uploads exact bytes natively and validates the relay descriptor", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  uploadResponse = () => ({
    body: {
      url: `${community}/media/${hash}.png`,
      type: "image/png",
      size: 3,
      sha256: hash,
    },
  });
  const file = new File([new Uint8Array([1, 2, 3])], "a.png", {
    type: "image/png",
  });
  await expect(
    transport.uploadAttachment(file, new AbortController().signal),
  ).resolves.toEqual({
    name: "a.png",
    url: `${community}/media/${hash}.png`,
    type: "image/png",
    size: 3,
    sha256: hash,
  });
  expect(uploads).toEqual([
    {
      bytes: new Uint8Array([1, 2, 3]),
      headers: {
        "x-buzz-upload-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
        "x-buzz-community": community,
        "x-buzz-content-type": "image/png",
      },
    },
  ]);
  uploadResponse = () => ({
    body: {
      url: `https://other.test/media/${hash}.png`,
      type: "image/png",
      size: 3,
      sha256: hash,
    },
  });
  await expect(
    transport.uploadAttachment(file, new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});

it.each([
  [401, "", "denied"],
  [413, "", "size"],
  [429, "", "capacity"],
  [422, { error: "metadata forbidden" }, "metadata"],
  [415, { error: "unsupported container" }, "rejected"],
  [500, "internal error", "failed"],
])(
  "maps relay upload status %i to a user-facing failure",
  async (status, body, code) => {
    const transport = await connectNativeTransport(community);
    assert(transport.uploadAttachment);
    uploadResponse = () => ({ status, body });
    await expect(
      transport.uploadAttachment(
        new File(["x"], "a.bin"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code });
  },
);

it("settles a cancelled native upload at once and cancels it natively", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  hangUploads = true;
  const controller = new AbortController();
  const pending = transport.uploadAttachment(
    new File(["x"], "a.bin"),
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(vi.mocked(invoke).mock.calls.at(-1)?.[0]).toBe("relay_upload"),
  );
  const [, , options] = vi.mocked(invoke).mock.calls.at(-1) ?? [];
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancels).toEqual([
    (options as { headers: Record<string, string> }).headers[
      "x-buzz-upload-id"
    ],
  ]);
});

it("prepares HEIC and video in the native upload without dev-broker fetches", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  preparedResponse = () => ({
    body: {
      url: `${community}/media/${hash}.jpg`,
      type: "image/jpeg",
      size: 5,
      sha256: hash,
    },
  });
  const heic = new File(
    [new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])],
    "a.heic",
    { type: "image/heic" },
  );
  await expect(
    transport.uploadAttachment(heic, new AbortController().signal),
  ).resolves.toMatchObject({
    name: "a.jpg",
    type: "image/jpeg",
    size: 5,
  });
  expect(uploads.at(-1)?.headers).toMatchObject({
    "x-buzz-preparation": "image:mov",
    "x-buzz-community": community,
  });
  preparedResponse = () => ({
    body: {
      url: `${community}/media/${hash}.mp4`,
      type: "video/mp4",
      size: 7,
      sha256: hash,
    },
  });
  const avi = new File(
    [new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 65, 86, 73, 32])],
    "b.avi",
    { type: "video/avi" },
  );
  await expect(
    transport.uploadAttachment(avi, new AbortController().signal),
  ).resolves.toMatchObject({
    name: "b.mp4",
    type: "video/mp4",
    size: 7,
  });
  expect(uploads.at(-1)?.headers["x-buzz-preparation"]).toBe("video:avi");
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [403, { error: "no access" }, "denied"],
  [413, { error: "too large" }, "size"],
  [429, { error: "busy" }, "capacity"],
  [422, { error: "metadata forbidden" }, "metadata"],
  [415, { error: "unsupported" }, "rejected"],
  [400, { code: "io" }, "io"],
])(
  "maps prepared-upload response %i through the shared policy",
  async (status, body, code) => {
    const transport = await connectNativeTransport(community);
    assert(transport.uploadAttachment);
    preparedResponse = () => ({ status, body });
    const avi = new File(
      [new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 65, 86, 73, 32])],
      "b.avi",
      { type: "video/avi" },
    );
    await expect(
      transport.uploadAttachment(avi, new AbortController().signal),
    ).rejects.toMatchObject({ code });
  },
);

it("refuses native preparation failures and does not accept a mismatched prepared type", async () => {
  const transport = await connectNativeTransport(community);
  assert(transport.uploadAttachment);
  const heic = new File(
    [new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])],
    "a.heic",
  );
  preparedResponse = () => ({ status: 503, body: { code: "ffmpeg" } });
  await expect(
    transport.uploadAttachment(heic, new AbortController().signal),
  ).rejects.toMatchObject({ code: "ffmpeg" });
  preparedResponse = () => ({
    body: {
      url: `${community}/media/${hash}.mp4`,
      type: "video/mp4",
      size: 3,
      sha256: hash,
    },
  });
  await expect(
    transport.uploadAttachment(heic, new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});
