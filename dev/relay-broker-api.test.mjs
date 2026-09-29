import { createConsola } from "consola";
import { logSocketFrame } from "../src/features/developer/traffic.ts";
import { getLogger, setLogLevel } from "../src/features/developer/logging.ts";
import { brokerSocket, openBrokerSocket } from "../tests/broker-socket.mjs";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createRelayReader } from "../src/features/relay/reader.ts";
import { createServer, get } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  nip44,
  generateSecretKey,
} from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { createOutbox, PublishRejected } from "../src/features/relay/outbox.ts";
import { createRelaySession } from "../src/features/relay/session.ts";
import { feedbackEvent } from "../src/features/relay/product-feedback.ts";
import { archiveRequestTemplate } from "../src/features/relay/identity-archive-protocol.ts";

// Only wall time is controlled. Real timers/performance.now still exercise HTTP admission.
let wallClock;
beforeEach(() => {
  wallClock = 1700000000999;
  vi.spyOn(Date, "now").mockImplementation(() => wallClock);
});
afterEach(() => vi.restoreAllMocks());

// Real browser HTTP -> production broker. Ephemeral key; upstream I/O is entirely local.
async function harness(respond, capabilities = {}, relayUrl = fixtureRelayUrl) {
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const event = finalizeEvent(
    { kind: 9, content: "fixture", created_at: 1700000000, tags: [["h", "c"]] },
    key,
  );
  const calls = [];
  const socket = brokerSocket();
  let live;
  let handler;
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    relayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    socketFactory: socket.factory,
    authority: async () => ({ relayAuthor: viewer, ...capabilities }),
    upstreamFetch: async (url, init) => {
      const upstreamUrl = String(url);
      const authorization = new Headers(init?.headers).get("Authorization");
      const auth = authorization
        ? JSON.parse(Buffer.from(authorization.slice(6), "base64").toString())
        : undefined;
      if (
        upstreamUrl === fixtureRelayUrl ||
        upstreamUrl === `${fixtureRelayUrl}/api/join-policy`
      )
        expect(auth).toBeUndefined();
      else expect(auth).toBeDefined();
      if (auth) {
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.created_at).toBe(Math.floor(Date.now() / 1000));
      }
      const call = {
        url: upstreamUrl,
        body: init?.body ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
        headers: init?.headers,
        auth,
        at: performance.now(),
      };
      calls.push(call);
      return respond(call, calls.length, event);
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb) {
        handler = cb;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    event,
    calls,
    publications: socket.publications,
    async start() {
      live = await openBrokerSocket(await connectBrokerTransport(base));
    },
    get(route, signal) {
      return fetch(`${base}/api/relay/${route}`, { signal });
    },
    post(route, body, signal, priority) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(live ? { "X-Buzz-Live-ID": live.identity() } : {}),
          ...(priority ? { "X-Buzz-Read-Priority": priority } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    },
    async close() {
      live?.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const filters = [{ kinds: [0], limit: 1 }];
const success = (call) =>
  Response.json(
    call.url.endsWith("/events")
      ? { accepted: true, event_id: call.body.id }
      : [],
  );

test("production transport obtains scoped broker harness log proofs for aliases and canonical origins", async () => {
  const h = await harness(success);
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const pubkey = "ab".repeat(32);
  const relayUrl = "wss://primary.example";
  const id = `${pubkey}-${createHash("sha256").update(relayUrl).digest("hex")}`;
  const nonce = "12345678-1234-1234-1234-123456789abc";
  const target = { id, pubkey, relayUrl };
  try {
    for (const community of ["primary", fixtureRelayUrl]) {
      const transport = await connectBrokerTransport(
        h.base,
        undefined,
        community,
      );
      expect(transport.authorizeAgentLog).toBeTypeOf("function");
      const signature = await transport.authorizeAgentLog(target, nonce);
      const digest = createHash("sha256")
        .update(`buzz-app:harness-log:v1:${id}:${pubkey}:${relayUrl}:${nonce}`)
        .digest();
      expect(
        schnorr.verify(
          Buffer.from(signature, "hex"),
          digest,
          Buffer.from(viewer, "hex"),
        ),
      ).toBe(true);
      await expect(
        transport.authorizeAgentLog(
          { ...target, relayUrl: "wss://secondary.example" },
          nonce,
        ),
      ).rejects.toThrow("Log authorization unavailable");
    }
    const other = await connectBrokerTransport(h.base, undefined, "secondary");
    await expect(other.authorizeAgentLog(target, nonce)).rejects.toThrow(
      "Log authorization unavailable",
    );
  } finally {
    await h.close();
  }
});

test("harness log proof signs only exact scoped community and agent inputs", async () => {
  const h = await harness(success);
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const pubkey = "ab".repeat(32);
  const relayUrl = "wss://primary.example";
  const id = `${pubkey}-${createHash("sha256").update(relayUrl).digest("hex")}`;
  const nonce = "12345678-1234-1234-1234-123456789abc";
  const target = { id, pubkey, relayUrl, nonce };
  try {
    const registered = await h.post("register", { url: fixtureRelayUrl });
    expect(registered.status).toBe(200);
    const route = "primary/agent-log-proof";
    expect((await h.post("agent-log-proof", target)).status).toBe(400);
    for (const invalid of [
      { ...target, id: `${"f".repeat(64)}-${id.slice(65)}` },
      { ...target, pubkey: viewer },
      { ...target, relayUrl: "wss://secondary.example" },
      { ...target, relayUrl: "file:///private" },
      { ...target, nonce: "invalid" },
      { ...target, extra: true },
    ])
      expect((await h.post(route, invalid)).status).toBe(400);
    const result = await h.post(route, target);
    expect(result.status).toBe(200);
    const { signature } = await result.json();
    const digest = createHash("sha256")
      .update(`buzz-app:harness-log:v1:${id}:${pubkey}:${relayUrl}:${nonce}`)
      .digest();
    expect(
      schnorr.verify(
        Buffer.from(signature, "hex"),
        digest,
        Buffer.from(viewer, "hex"),
      ),
    ).toBe(true);
    expect(
      schnorr.verify(
        Buffer.from(signature, "hex"),
        createHash("sha256")
          .update(
            `buzz-app:harness-log:v1:${id}:${pubkey}:wss://secondary.example:${nonce}`,
          )
          .digest(),
        Buffer.from(viewer, "hex"),
      ),
    ).toBe(false);
  } finally {
    await h.close();
  }
});

test("saved icon discovery survives join-policy failure without changing join discovery", async () => {
  const icon = "https://images.example/icon@2x.png";
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl) return Response.json({ icon });
    if (call.url === `${fixtureRelayUrl}/api/join-policy`)
      return new Response("unavailable", { status: 503 });
    return new Response(null, { status: 404 });
  });
  try {
    const iconResponse = await h.get("icon-info");
    expect(iconResponse.status).toBe(200);
    expect(await iconResponse.json()).toEqual({ icon });
    expect(h.calls.map(({ url }) => url)).toEqual([fixtureRelayUrl]);

    const joinResponse = await h.get("info");
    const joinBody = await joinResponse.json();
    expect([joinResponse.status, joinBody]).toEqual([
      503,
      { error: "Could not load join policy" },
    ]);
    expect(h.calls.map(({ url }) => url)).toEqual([
      fixtureRelayUrl,
      fixtureRelayUrl,
      `${fixtureRelayUrl}/api/join-policy`,
    ]);
  } finally {
    await h.close();
  }
});

test("GIF capability discovery does not depend on join-policy availability", async () => {
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl)
      return Response.json({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      });
    if (call.url === `${fixtureRelayUrl}/api/join-policy`)
      return new Response("unavailable", { status: 503 });
    return new Response(null, { status: 404 });
  });
  try {
    const response = await h.get("gif-info");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supported_extensions: ["buzz-gif"],
      gif: { provider: "klipy", search: "/gifs/search" },
    });
    expect(h.calls.map(({ url }) => url)).toEqual([fixtureRelayUrl]);
  } finally {
    await h.close();
  }
});

test("GIF discovery retries unsupported relays and caches confirmed support", async () => {
  let supported = false;
  const descriptor = {
    supported_extensions: ["buzz-gif"],
    gif: { provider: "klipy", search: "/gifs/search" },
  };
  const h = await harness(() => Response.json(supported ? descriptor : {}));
  try {
    expect(await (await h.get("gif-info")).json()).toEqual({});
    supported = true;
    expect(await (await h.get("gif-info")).json()).toEqual(descriptor);
    expect(await (await h.get("gif-info")).json()).toEqual(descriptor);
    expect(h.calls.map(({ url }) => url)).toEqual([
      fixtureRelayUrl,
      fixtureRelayUrl,
    ]);
  } finally {
    await h.close();
  }
});

test("GIF search follows the relay-advertised KLIPY path with signed, bounded input", async () => {
  const responseBody = {
    result: true,
    data: { data: [{ id: 1, type: "gif", slug: "hello" }] },
  };
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl)
      return Response.json({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      });
    if (call.url === `${fixtureRelayUrl}/gifs/search`)
      return Response.json(responseBody);
    return new Response(null, { status: 404 });
  });
  try {
    const body = {
      customer_id: "fixture-customer",
      locale: "en-US",
      query: "hello",
    };
    const response = await h.post("gifs", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(responseBody);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]).toMatchObject({
      url: fixtureRelayUrl,
      body: undefined,
      auth: undefined,
    });
    expect(h.calls[1]).toMatchObject({
      url: `${fixtureRelayUrl}/gifs/search`,
      body,
    });
    expect(h.calls[1].auth.tags).toEqual(
      expect.arrayContaining([
        ["u", `${fixtureRelayUrl}/gifs/search`],
        ["method", "POST"],
        [
          "payload",
          createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        ],
      ]),
    );

    const rejected = await h.post("gifs", { ...body, query: "x".repeat(101) });
    expect(rejected.status).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("media proxy returns generic files as neutralized authenticated downloads", async () => {
  const bytes = Buffer.from("%PDF-1.7\nfixture pdf\n");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/file.pdf`);
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file.pdf`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes active content as downloads", async () => {
  const activeTypes = [
    "text/html",
    "image/svg+xml",
    "image/svg+xml; charset=utf-8",
    "IMAGE/SVG+XML",
  ];
  for (const contentType of activeTypes) {
    const bytes = Buffer.from(`<script>${contentType}</script>`);
    const h = await harness(
      () =>
        new Response(bytes, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(bytes.length),
          },
        }),
    );
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await h.close();
    }
  }
});

test("media proxy neutralizes comma-joined content types as downloads", async () => {
  const bytes = Buffer.from("fake png then svg");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png, image/svg+xml",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy strips smuggled inline content type parameters", async () => {
  const bytes = Buffer.from("fake png then svg");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png;x, image/svg+xml",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes missing or empty content types as downloads", async () => {
  for (const headers of [{}, { "Content-Type": "" }]) {
    const bytes = Buffer.from("unknown bytes");
    const h = await harness(
      () =>
        new Response(bytes, {
          headers: { ...headers, "Content-Length": String(bytes.length) },
        }),
    );
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await h.close();
    }
  }
});

test("media proxy keeps raster images inline with exact bytes", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/pixel.png`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test.each([
  ["application/zip", 100],
  ["image/png", 50],
  ["image/gif", 10],
  ["video/mp4", 500],
])(
  "media proxy rejects %s above its %i MiB declared budget",
  async (type, mib) => {
    let cancelled = false;
    const h = await harness(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "Content-Type": type,
              "Content-Length": String(mib * 1024 * 1024 + 1),
            },
          },
        ),
    );
    try {
      const response = await fetch(
        `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file`)}`,
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "Media budget exceeded" });
      expect(cancelled).toBe(true);
    } finally {
      await h.close();
    }
  },
);

test("unknown-length media is metered, cancelled on overflow and leaves the broker usable", async () => {
  let cancelled = false;
  let oversized = true;
  const chunk = new Uint8Array(1024 * 1024);
  const h = await harness(() =>
    oversized
      ? new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "image/gif" } },
        )
      : new Response("ok", { headers: { "Content-Type": "text/plain" } }),
  );
  try {
    // Either the initial read or the body must fail: an over-budget stream must
    // never complete successfully after headers have already reached the client.
    await expect(
      (async () => {
        const response = await h.get("media?url=/media/file.gif");
        await response.arrayBuffer();
      })(),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    oversized = false;
    const next = await h.get("media?url=/media/file.txt");
    expect(next.headers.get("content-disposition")).toBe("attachment");
    expect(await next.text()).toBe("ok");
  } finally {
    await h.close();
  }
});

test("media deadline cancels the response pipeline after headers", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let cancelled = false;
  const h = await harness(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "video/mp4" } },
      ),
  );
  try {
    const response = await h.get("media?url=/media/clip.mp4");
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    deadline.abort();
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(cancelled).toBe(true));
  } finally {
    await h.close();
  }
});

test("media proxy streams authenticated video ranges and preserves seek headers", async () => {
  const bytes = Buffer.from("video-range");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/clip.mp4`);
    expect(call.headers.Range).toBe("bytes=100-");
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Type": 'video/mp4; codecs="avc1.42E01E"',
        "Content-Length": String(bytes.length),
        "Content-Range": "bytes 100-110/1000",
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/clip.mp4`)}`,
      { headers: { Range: "bytes=100-" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 100-110/1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy streams authenticated audio ranges and preserves seek headers", async () => {
  const bytes = Buffer.from("audio-range");
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/media/audio.mp3`);
    expect(call.headers.Range).toBe("bytes=100-");
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Type": "Audio/MPEG; charset=utf-8",
        "Content-Length": String(bytes.length),
        "Content-Range": "bytes 100-110/1000",
        "Accept-Ranges": "bytes",
      },
    });
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/audio.mp3`)}`,
      { headers: { Range: "bytes=100-" } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-range")).toBe("bytes 100-110/1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("media proxy rejects oversized non-range audio", async () => {
  const h = await harness(
    () =>
      new Response("too large", {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(20 * 1024 * 1024 + 1),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/audio.mp3`)}`,
    );
    expect(response.status).toBe(413);
  } finally {
    await h.close();
  }
});

test("media proxy neutralizes non-media content types as downloads", async () => {
  const bytes = Buffer.from("plain");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": String(bytes.length),
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/file.txt`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("media proxy strips smuggled audio content type parameters", async () => {
  const bytes = Buffer.from("fake audio then svg");
  const h = await harness(
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "audio/mpeg;x, image/svg+xml",
          "Content-Length": String(bytes.length),
          "Accept-Ranges": "bytes",
        },
      }),
  );
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/audio.mp3`)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await h.close();
  }
});

test("an upstream video stream error closes only that response, not the broker", async () => {
  const h = await harness(() => {
    let controller;
    const body = new ReadableStream({
      start(value) {
        controller = value;
        value.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    queueMicrotask(() =>
      controller.error(new DOMException("timed out", "TimeoutError")),
    );
    return new Response(body, {
      status: 206,
      headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-2/10" },
    });
  });
  try {
    await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/clip.mp4`)}`,
      { headers: { Range: "bytes=0-" } },
    )
      .then((response) => response.arrayBuffer())
      .catch(() => {});
    const session = await fetch(`${h.base}/api/relay/session`);
    expect(session.status).toBe(200);
    // The HTTP base lets the workflows page display `/hooks/{workflow_id}` addresses.
    expect(await session.json()).toMatchObject({
      relayUrl: fixtureRelayUrl,
      relayHttpUrl: fixtureRelayUrl,
    });
  } finally {
    await h.close();
  }
});

test("media proxy rejects malformed ranges before upstream I/O", async () => {
  const h = await harness(() => {
    throw new Error("unexpected upstream call");
  });
  try {
    const response = await fetch(
      `${h.base}/api/relay/media?url=${encodeURIComponent(`${fixtureRelayUrl}/media/clip.mp4`)}`,
      { headers: { Range: "items=0-1" } },
    );
    expect(response.status).toBe(416);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("upstream quota survives browser recreation, gates reads/profile and leaves other communities independent", async () => {
  const h = await harness((call, count, event) =>
    count === 1
      ? Response.json(
          {
            error: "rate-limited: quota exceeded; retry in 0s",
            secret: "not forwarded",
          },
          { status: 429 },
        )
      : success(call, count, event),
  );
  try {
    const first = await connectBrokerTransport(h.base);
    await expect(first.query(filters)).rejects.toMatchObject({
      kind: "unavailable",
      status: 429,
      retryAfterMs: 1000,
    });
    const replacement = await connectBrokerTransport(h.base);
    await expect(replacement.query(filters)).rejects.toMatchObject({
      kind: "unavailable",
      status: 429,
      retryAfterMs: expect.any(Number),
    });
    await expect(
      replacement.writer.publish(h.event, new AbortController().signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    const profile = await h.post("profile", { name: "Fixture", picture: "" });
    expect(profile.status).toBe(429);
    expect(await profile.json()).toMatchObject({ paused: true, sent: false });
    expect(h.calls).toHaveLength(1);
    const independent = await connectBrokerTransport(
      h.base,
      undefined,
      "secondary",
    );
    await independent.query(filters);
    expect(h.calls).toHaveLength(2);
    await delay(1050);
    expect(
      (await h.post("profile", { name: "Fixture", picture: "" })).status,
    ).toBe(200);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].body.kind).toBe(0);
    expect(h.calls[2].at - h.calls[0].at).toBeGreaterThanOrEqual(1000);
  } finally {
    await h.close();
  }
});

test("foreground profile publication starts while background I/O is outstanding; cancellation does not replay", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    if (call.url.endsWith("/query")) await held;
    return success(call, count, event);
  });
  const cancel = new AbortController();
  try {
    const background = h.post("query", filters, cancel.signal, "background");
    const rejection = expect(background).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const write = await h.post("profile", { name: "Fixture", picture: "" });
    expect(write.status).toBe(200);
    await write.text();
    cancel.abort();
    await rejection;
    release();
    expect(h.calls.map((c) => c.url.split("/").at(-1))).toEqual([
      "query",
      "events",
    ]);
  } finally {
    release();
    cancel.abort();
    await h.close();
  }
});

test("local capacity is explicitly unsent, not relay quota; unknown upstream publication is never resent", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    await held;
    return success(call, count, event);
  });
  const controllers = [];
  try {
    const requests = Array.from({ length: 6 }, () => {
      const controller = new AbortController();
      controllers.push(controller);
      return h.post("query", filters, controller.signal);
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(6));
    const refused = await h.post("profile", { name: "Fixture", picture: "" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "Query concurrency limit",
      sent: false,
    });
    release();
    await Promise.all(
      requests.map(async (response) => (await response).text()),
    );
    expect(h.calls).toHaveLength(6);
    const transport = await connectBrokerTransport(h.base);
    // Generic upstream 503 is not proof of non-delivery (separate fixture below).
    await transport.query(filters);
    expect(h.calls).toHaveLength(7); // Local capacity did not introduce a relay cooldown.
  } finally {
    release();
    for (const c of controllers) c.abort();
    await h.close();
  }
  const uncertain = await harness(
    () => new Response("private upstream detail", { status: 503 }),
  );
  try {
    const response = await uncertain.post("profile", {
      name: "Fixture",
      picture: "",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("sent");
    expect(uncertain.calls).toHaveLength(1);
    await delay(550);
    expect(uncertain.calls).toHaveLength(1);
  } finally {
    await uncertain.close();
  }
}, 10000);

// Reader-to-host priority propagation control contributed by Brain.
test("reader and transport start foreground work without waiting for background completion", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    if (call.body?.[0]?.limit === 2) await held;
    return success(call, count, event);
  });
  let reader;
  try {
    const t = await connectBrokerTransport(h.base);
    reader = createRelayReader(t);
    await reader.reader.read([{ kinds: [0], limit: 1 }]);
    const background = reader.reader.read([{ kinds: [0], limit: 2 }], {
      priority: "background",
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    await reader.reader.read([{ kinds: [0], limit: 3 }], {
      priority: "foreground",
    });
    expect(h.calls.map((c) => c.body[0].limit)).toEqual([1, 2, 3]);
    release();
    await background;
  } finally {
    release();
    reader?.dispose();
    await h.close();
  }
});

test("each request mints fresh auth at dispatch after wall time advances", async () => {
  const h = await harness(success);
  try {
    await (await h.post("query", filters)).text();
    wallClock += 61000;
    const response = await h.post("query", [{ kinds: [0], limit: 2 }]);
    expect(response.status).toBe(200);
    await response.text();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].auth.created_at - h.calls[0].auth.created_at).toBe(61);
  } finally {
    await h.close();
  }
});

test("reaction sign and publish preserve kind 7 and reject malformed targets before upstream I/O", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      ...h.event,
      kind: 7,
      content: ":party:",
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64)],
        ["emoji", "party", "https://a.test/party.png"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(7);
    expect(event.tags).toEqual(template.tags);
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toEqual(JSON.parse(JSON.stringify(event)));
    for (const length of [62, 63, 64]) {
      const content = `:${"a".repeat(length)}:`;
      const signed = await h.post("sign", { ...template, content });
      expect(signed.status).toBe(200);
      const boundaryEvent = await signed.json();
      expect(boundaryEvent.content).toBe(content);
      expect((await h.post("publish", boundaryEvent)).status).toBe(200);
    }
    expect(h.publications).toHaveLength(4);
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [],
        [["e", "bad"]],
        [["e", "a".repeat(64), "", "reply"]],
        [
          ["e", "a".repeat(64)],
          ["e", "b".repeat(64)],
        ],
      ]) {
        expect(
          (await h.post(route, { ...event, tags: [["h", "c"], ...tags] }))
            .status,
        ).toBe(400);
      }
      expect(
        (await h.post(route, { ...event, content: "x".repeat(65) })).status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: `:${"a".repeat(65)}:` }))
          .status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: ` ${"x".repeat(64)}` }))
          .status,
      ).toBe(400);
    }
    expect(h.publications).toHaveLength(4);
  } finally {
    await h.close();
  }
});

test("both real sign and publish routes admit direct and nested replies but reject arbitrary references before upstream I/O", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      ...h.event,
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64), "", "reply"],
        ["p", "b".repeat(64)],
      ],
    };
    const signed = await h.post("sign", template);
    expect(signed.status).toBe(200);
    const event = await signed.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toEqual(template.tags);
    expect(h.publications).toHaveLength(0);
    const published = await h.post("publish", event);
    expect(published.status).toBe(200);
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toEqual(JSON.parse(JSON.stringify(event)));
    const root = ["e", "c".repeat(64), "", "root"];
    const reply = ["e", "d".repeat(64), "", "reply"];
    const nestedSigned = await h.post("sign", {
      ...template,
      tags: [["h", "c"], root, reply],
    });
    expect(nestedSigned.status).toBe(200);
    const nested = await nestedSigned.json();
    expect(verifyEvent(nested)).toBe(true);
    expect(nested.tags).toEqual([["h", "c"], root, reply]);
    expect((await h.post("publish", nested)).status).toBe(200);
    expect(h.publications[1]).toEqual(JSON.parse(JSON.stringify(nested)));
    for (const route of ["sign", "publish"]) {
      for (const references of [
        [reply, root],
        [root, ["e", root[1], "", "reply"]],
        [root, reply, reply],
        [[...root, "extra"], reply],
        [["e", "C".repeat(64), "", "root"], reply],
        [["e", root[1], "relay", "root"], reply],
        [["e", "a".repeat(64)]],
        [["e", "a".repeat(64), "", "root"]],
        [["e", "invalid", "", "reply"]],
        [
          ["e", "a".repeat(64), "", "reply"],
          ["e", "b".repeat(64), "", "reply"],
        ],
      ]) {
        const rejected = await h.post(route, {
          ...event,
          tags: [["h", "c"], ...references],
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({ error: "Message rejected" });
      }
    }
    expect(h.publications).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("held optional snapshot body leaves ordinary broker capacity free and start credit untouched", async () => {
  let release;
  const h = await harness((call) => {
    if (call.body?.[0]?.kinds?.includes(20001))
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              controller.enqueue(new TextEncoder().encode("[]"));
              controller.close();
            };
          },
        }),
      );
    return Response.json([]);
  });
  const presence = [{ kinds: [20001], authors: [h.event.pubkey], limit: 1 }];
  try {
    const snapshot = h.post("presence-snapshot", presence);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const duplicate = await h.post("presence-snapshot", presence);
    expect(duplicate.status).toBe(204);
    expect((await h.post("query", filters)).status).toBe(200);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].at - h.calls[0].at).toBeLessThan(400);
    release();
    release = undefined;
    expect(await (await snapshot).json()).toEqual([]);
    expect(
      (await h.post("presence-snapshot", [{ ...presence[0], authors: [] }]))
        .status,
    ).toBe(400);
    expect(
      (
        await h.post("presence-snapshot", [
          { ...presence[0], authors: Array(257).fill(h.event.pubkey) },
        ])
      ).status,
    ).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    release?.();
    await h.close();
  }
});

test("presence snapshot progresses while an ordinary response body is held", async () => {
  let release;
  const h = await harness((call) => {
    if (call.body?.[0]?.kinds?.includes(20001)) return Response.json([]);
    return new Response(
      new ReadableStream({
        start(controller) {
          release = () => {
            controller.enqueue(new TextEncoder().encode("[]"));
            controller.close();
          };
        },
      }),
    );
  });
  let ordinary;
  try {
    ordinary = h.post("query", filters, undefined, "background");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const snapshot = await h.post("presence-snapshot", [
      { kinds: [20001], authors: [h.event.pubkey], limit: 1 },
    ]);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual([]);
    expect(h.calls).toHaveLength(2);
    const missing = await h.post("stream-presence", {
      streamId: "0".repeat(32),
      status: "online",
    });
    expect(await missing.json()).toEqual({ accepted: null });
  } finally {
    release?.();
    await ordinary;
    await h.close();
  }
});
test.each([undefined, "22222222-2222-4222-8222-222222222222"])(
  "real outbox creates, invites and sends without Sessions support (parent: %s)",
  async (parent) => {
    const h = await harness(
      (call) =>
        Response.json(
          call.url.endsWith("/events")
            ? { accepted: true, event_id: call.body.id }
            : [],
        ),
      { channelCreation: true },
    );
    let owner;
    let traffic;
    try {
      const transport = await connectBrokerTransport(h.base);
      traffic = await openBrokerSocket(transport);
      expect(transport.writer.kinds).toContain(9007);
      expect(transport.writer.kinds).not.toContain(9050);
      owner = createOutbox(transport.viewer, transport.writer, {
        load: () => [],
        save: () => {},
      });
      const id = "11111111-1111-4111-8111-111111111111";
      const creationId = owner.outbox.send({
        kind: 9007,
        content: "",
        tags: [
          ["h", id],
          ["name", "Work"],
          ["visibility", "private"],
          ["channel_type", "stream"],
          [
            "about",
            `Buzz session (buzz.sessions/v1)${parent ? `\nparent:${parent}` : ""}`,
          ],
        ],
      });
      await vi.waitFor(() =>
        expect(
          owner.local.snapshot().find((row) => row.event.id === creationId)
            ?.delivery,
        ).toBe("accepted"),
      );
      const temporaryCreationId = owner.outbox.send({
        kind: 9007,
        content: "",
        tags: [
          ["h", "33333333-3333-4333-8333-333333333333"],
          ["name", "Standup"],
          ["visibility", "open"],
          ["channel_type", "stream"],
          ["ttl", "604800"],
        ],
      });
      await vi.waitFor(() =>
        expect(
          owner.local
            .snapshot()
            .find((row) => row.event.id === temporaryCreationId)?.delivery,
        ).toBe("accepted"),
      );
      const invitationId = owner.outbox.send({
        kind: 9000,
        content: "",
        tags: [
          ["h", id],
          ["p", "a".repeat(64)],
        ],
      });
      await vi.waitFor(() =>
        expect(
          owner.local.snapshot().find((row) => row.event.id === invitationId)
            ?.delivery,
        ).toBe("accepted"),
      );
      const messageId = owner.outbox.send({
        kind: 9,
        content: "Hello",
        tags: [
          ["h", id],
          ["p", "a".repeat(64)],
        ],
      });
      await vi.waitFor(() =>
        expect(
          owner.local.snapshot().find((row) => row.event.id === messageId)
            ?.delivery,
        ).toBe("accepted"),
      );
      expect(h.publications.map((event) => event.kind)).toEqual([
        9007, 9007, 9000, 9,
      ]);
      const denied = await h.post("sign", {
        kind: 9050,
        created_at: 1700000000,
        content: JSON.stringify({ action: "create", title: "Work" }),
        tags: [["h", id]],
      });
      expect(denied.status).toBe(400);
    } finally {
      owner?.dispose();
      traffic?.dispose();
      await h.close();
    }
  },
);

test.each(["sign", "publish"])(
  "%s rejects truncated channel creation tags as a client error",
  async (route) => {
    const h = await harness(success, { channelCreation: true });
    try {
      const required = [
        ["h", "11111111-1111-4111-8111-111111111111"],
        ["name", "Work"],
        ["visibility", "open"],
        ["channel_type", "stream"],
      ];
      for (let length = 0; length < required.length; length++) {
        const response = await h.post(route, {
          kind: 9007,
          created_at: 1700000000,
          content: "",
          tags: required.slice(0, length),
        });
        expect(response.status).toBe(400);
      }
    } finally {
      await h.close();
    }
  },
);

test("member addition works without channel creation, while role elevation remains rejected", async () => {
  const h = await harness(success);
  let traffic;
  let owner;
  try {
    const transport = await connectBrokerTransport(h.base);
    traffic = await openBrokerSocket(transport);
    expect(transport.writer.kinds).toContain(9000);
    expect(transport.writer.kinds).not.toContain(9007);
    owner = createOutbox(transport.viewer, transport.writer, {
      load: () => [],
      save: () => {},
    });
    const tags = [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["p", "a".repeat(64)],
    ];
    const id = owner.outbox.send({ kind: 9000, content: "", tags });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === id)?.delivery,
      ).toBe("accepted"),
    );
    expect(h.publications).toHaveLength(1);
    for (const role of ["owner", "admin", "member"]) {
      const denied = await h.post("sign", {
        kind: 9000,
        content: "",
        created_at: 1700000000,
        tags: [...tags, ["role", role]],
      });
      expect(denied.status).toBe(400);
    }
  } finally {
    owner?.dispose();
    traffic?.dispose();
    await h.close();
  }
});

test("agent removal publishes only one member's exact 9001 through the outbox", async () => {
  const h = await harness(success);
  let traffic;
  let owner;
  try {
    const transport = await connectBrokerTransport(h.base);
    traffic = await openBrokerSocket(transport);
    expect(transport.writer.kinds).toContain(9001);
    owner = createOutbox(transport.viewer, transport.writer, {
      load: () => [],
      save: () => {},
    });
    const tags = [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["p", "a".repeat(64)],
    ];
    const id = owner.outbox.send({ kind: 9001, content: "", tags });
    await vi.waitFor(() =>
      expect(
        owner.local.snapshot().find((row) => row.event.id === id)?.delivery,
      ).toBe("accepted"),
    );
    expect(h.publications.map((event) => event.kind)).toEqual([9001]);
    const clientId = ["client-id", "22222222-2222-4222-8222-222222222222"];
    for (const invalid of [
      [...tags, clientId, ["reason", "x"]],
      [tags[0], clientId],
      [tags[0], ["p", "A".repeat(64)], clientId],
      [["h", "not-a-channel"], tags[1], clientId],
    ]) {
      const denied = await h.post("sign", {
        kind: 9001,
        content: "",
        created_at: 1700000000,
        tags: invalid,
      });
      expect(denied.status).toBe(400);
    }
    const content = await h.post("sign", {
      kind: 9001,
      content: "reason",
      created_at: 1700000000,
      tags: [...tags, clientId],
    });
    expect(content.status).toBe(400);
  } finally {
    owner?.dispose();
    traffic?.dispose();
    await h.close();
  }
});

test("edit capability signs and publishes canonical replacements, rejecting malformed edits locally", async () => {
  const h = await harness(success);
  try {
    await h.start();
    expect((await (await h.get("session")).json()).writeKinds).toContain(40003);
    const template = {
      ...h.event,
      kind: 40003,
      content: "corrected **message**",
      tags: [
        ["h", "c"],
        ["e", h.event.id],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject({
      kind: 40003,
      content: template.content,
      tags: template.tags,
      pubkey: h.event.pubkey,
    });
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toEqual([JSON.parse(JSON.stringify(event))]);
    // Preserve older clients' metadata as well as current upload descriptors.
    for (const imeta of [
      [
        "imeta",
        "url https://example.com/image.png",
        "m image/png",
        "dim 320x200",
      ],
      [
        "imeta",
        `url ${fixtureRelayUrl}/media/${"a".repeat(64)}.pdf`,
        "m application/pdf",
        "size 3",
        `x ${"a".repeat(64)}`,
        "filename report.pdf",
      ],
    ]) {
      const caption = { ...template, tags: [...template.tags, imeta] };
      const signed = await h.post("sign", caption);
      expect(signed.status).toBe(200);
      const replacement = await signed.json();
      expect(verifyEvent(replacement)).toBe(true);
      expect(replacement.tags).toEqual(caption.tags);
      expect((await h.post("publish", replacement)).status).toBe(200);
      expect(h.publications.at(-1)).toEqual(
        JSON.parse(JSON.stringify(replacement)),
      );
    }
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [["h", "c"]],
        [
          ["h", "c"],
          ["e", "bad"],
        ],
        [
          ["h", "c"],
          ["e", h.event.id, "", "reply"],
        ],
        [...event.tags, ["e", "a".repeat(64)]],
        [...event.tags, ["p", "a".repeat(64)]],
        [...event.tags, ["imeta", 42]],
      ])
        expect((await h.post(route, { ...event, tags })).status).toBe(400);
      expect((await h.post(route, { ...event, content: " " })).status).toBe(
        400,
      );
      expect(
        (await h.post(route, { ...event, content: "x".repeat(32001) })).status,
      ).toBe(400);
    }
    expect(h.publications).toHaveLength(3);
  } finally {
    await h.close();
  }
});

test("report capability signs and publishes NIP-56 message reports, rejecting other shapes locally", async () => {
  const h = await harness(success);
  try {
    await h.start();
    expect((await (await h.get("session")).json()).writeKinds).toContain(1984);
    const template = {
      kind: 1984,
      content: "",
      created_at: h.event.created_at,
      tags: [
        ["p", h.event.pubkey],
        ["e", h.event.id, "spam"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject({ kind: 1984, tags: template.tags });
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toEqual([JSON.parse(JSON.stringify(event))]);
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [["e", h.event.id, "spam"]],
        [
          ["p", h.event.pubkey],
          ["e", h.event.id, "rude"],
        ],
        [
          ["p", h.event.pubkey],
          ["e", "bad", "spam"],
        ],
        [...template.tags, ["h", "c"]],
      ])
        expect((await h.post(route, { ...event, tags })).status).toBe(400);
      expect(
        (await h.post(route, { ...event, content: " padded " })).status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: "x".repeat(32001) })).status,
      ).toBe(400);
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("message/reaction deletions pass real signing and publication without admitting workflow or arbitrary deletion shapes", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    const template = {
      kind: 5,
      content: "",
      created_at: h.event.created_at,
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64)],
        ["k", "7"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(5);
    expect((await h.post("publish", event)).status).toBe(200);
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [
          ["h", "c"],
          ["e", "invalid"],
          ["k", "7"],
        ],
        [
          ["h", "c"],
          ["e", "a".repeat(64)],
          ["k", "30030"],
        ],
        [...template.tags, ["a", `30620:${h.event.pubkey}:workflow`]],
        [...template.tags, ["h", "other"]],
        [
          ["h", "c"],
          ["k", "7"],
        ],
      ])
        expect((await h.post(route, { ...event, tags })).status).toBe(400);
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("direct-message transport signs only bounded participants and binds the returned channel to its receipt", async () => {
  const channelId = "11111111-1111-4111-8111-111111111111";
  const h = await harness((call) =>
    Response.json({
      accepted: true,
      event_id: call.body.id,
      message: `response:${JSON.stringify({ channel_id: channelId })}`,
    }),
  );
  try {
    const transport = await connectBrokerTransport(h.base);
    const recipients = ["a".repeat(64), "b".repeat(64)];
    await expect(
      transport.openDirectMessage(recipients, new AbortController().signal),
    ).resolves.toBe(channelId);
    const event = h.calls[0].body;
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(41010);
    expect(event.pubkey).toBe(h.event.pubkey);
    expect(event.content).toBe("");
    expect(event.tags.filter(([tag]) => tag === "p")).toEqual(
      recipients.map((key) => ["p", key]),
    );
    await transport.openDirectMessage(recipients, new AbortController().signal);
    expect(h.calls[1].body.id).not.toBe(event.id);
    for (const pubkeys of [
      [],
      [h.event.pubkey],
      [recipients[0], recipients[0]],
      Array(9).fill(recipients[0]),
      ["invalid"],
    ]) {
      expect((await h.post("direct-message", { pubkeys })).status).toBe(400);
    }
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test.each([
  {
    accepted: false,
    message: 'response:{"channel_id":"11111111-1111-4111-8111-111111111111"}',
  },
  {
    accepted: true,
    event_id: "wrong",
    message: 'response:{"channel_id":"11111111-1111-4111-8111-111111111111"}',
  },
  { accepted: true, message: 'response:{"channel_id":"not-a-channel"}' },
])("direct-message rejects an invalid command receipt: %j", async (receipt) => {
  const h = await harness((call) =>
    Response.json({ event_id: call.body.id, ...receipt }),
  );
  try {
    const response = await h.post("direct-message", {
      pubkeys: ["a".repeat(64)],
    });
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("channelId");
  } finally {
    await h.close();
  }
});

test("status signing and publication preserve scoped replacements and explicit clears", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    for (const input of [
      {
        content: "Working remotely",
        tags: [
          ["d", "general"],
          ["emoji", ":party:"],
          ["expiration", "1700086400"],
        ],
      },
      { content: "", tags: [["d", "general"]] },
    ]) {
      const response = await h.post("sign", {
        kind: 30315,
        created_at: 1700000000,
        ...input,
      });
      expect(response.status).toBe(200);
      const event = await response.json();
      expect(verifyEvent(event)).toBe(true);
      expect(event).toMatchObject({ kind: 30315, ...input });
      expect((await h.post("channel-lifecycle-sign", event)).status).toBe(400);
      expect((await h.post("channel-lifecycle-publish", event)).status).toBe(
        400,
      );
      expect((await h.post("publish", event)).status).toBe(200);
      expect(h.publications.at(-1)).toEqual(JSON.parse(JSON.stringify(event)));
    }
    for (const tags of [
      [["d", "music"]],
      [
        ["d", "general"],
        ["h", "private"],
      ],
    ]) {
      expect(
        (
          await h.post("sign", {
            kind: 30315,
            created_at: 1700000000,
            content: "x",
            tags,
          })
        ).status,
      ).toBe(400);
    }
    const future = {
      kind: 30315,
      created_at: Math.floor(Date.now() / 1000) + 3600,
      content: "Future",
      tags: [["d", "general"]],
    };
    expect((await h.post("sign", future)).status).toBe(400);
    const secret = new Uint8Array(32);
    secret[31] = 7;
    expect(
      (await h.post("publish", finalizeEvent(future, secret))).status,
    ).toBe(400);
    expect(h.publications).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("custom emoji sets sign and publish only as one canonical own coordinate", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    await h.start();
    expect((await (await h.get("session")).json()).writeKinds).toContain(30030);
    const template = {
      kind: 30030,
      created_at: 1700000000,
      content: "",
      tags: [
        ["d", "buzz:custom-emoji"],
        ["emoji", "party", "https://relay.test/media/party.png"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject(template);
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications.at(-1)).toEqual(JSON.parse(JSON.stringify(event)));
    for (const tags of [
      [["d", "other"]],
      [
        ["d", "buzz:custom-emoji"],
        ["emoji", "Party", "https://relay.test/p.png"],
      ],
      [
        ["d", "buzz:custom-emoji"],
        ["emoji", "party", "https://relay.test/a.png"],
        ["emoji", "party", "https://relay.test/b.png"],
      ],
      [
        ["d", "buzz:custom-emoji"],
        ["h", "channel"],
      ],
    ])
      expect((await h.post("sign", { ...template, tags })).status).toBe(400);
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("memory reads use captured relay and owner, not submitted identity/filter authority, through HTTP host and transport", async () => {
  const owner = new Uint8Array(32);
  owner[31] = 7;
  const viewer = getPublicKey(owner),
    agent = generateSecretKey(),
    author = getPublicKey(agent);
  const key = nip44.v2.utils.getConversationKey(agent, viewer);
  const memory = finalizeEvent(
    {
      kind: 30174,
      created_at: 1,
      tags: [
        ["p", viewer],
        [
          "d",
          createHmac("sha256", key)
            .update("agent-memory/v1/d-tag\0mem/test")
            .digest("hex"),
        ],
      ],
      content: nip44.v2.encrypt(
        JSON.stringify({ slug: "mem/test", value: "private" }),
        key,
      ),
    },
    agent,
  );
  let forbidden = false;
  const h = await harness((call) => {
    expect(call.url).toBe(`${fixtureRelayUrl}/query`);
    expect(call.body).toEqual([
      { kinds: [30174], authors: [author], "#p": [viewer], limit: 256 },
    ]);
    expect(call.auth.pubkey).toBe(viewer);
    return forbidden
      ? new Response("denied", { status: 403 })
      : Response.json([memory]);
  });
  try {
    const transport = await connectBrokerTransport(
      h.base,
      undefined,
      fixtureRelayUrl,
    );
    expect(transport.readAgentMemories).toBeDefined();
    const listing = await transport.readAgentMemories(
      author,
      new AbortController().signal,
    );
    expect(listing).toEqual({
      entries: [
        { slug: "mem/test", body: "private", eventId: memory.id, createdAt: 1 },
      ],
      partial: false,
    });
    const scoped = `${encodeURIComponent(fixtureRelayUrl)}/agent-memories`;
    for (const body of [
      { agent: viewer },
      { agent: author, owner: viewer },
      { agent: author, kinds: [9] },
    ]) {
      expect((await h.post(scoped, body)).status).toBe(400);
    }
    expect((await h.post("agent-memories", { agent: author })).status).toBe(
      400,
    );
    expect(h.calls).toHaveLength(1);
    forbidden = true;
    await expect(
      transport.readAgentMemories(author, new AbortController().signal),
    ).rejects.toMatchObject({ name: "MemoryDenied" });
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("broker advertises, signs and publishes bounded edits through the real HTTP contract", async () => {
  const h = await harness(() => new Response("[]"));
  try {
    await h.start();
    const session = await (await h.get("session")).json();
    expect(session.writeKinds).toContain(40003);
    const template = {
      kind: 40003,
      content: "corrected text",
      created_at: 1700000000,
      tags: [
        ["h", "c"],
        ["e", h.event.id],
        ["client-id", "edit-test"],
      ],
    };
    const signed = await h.post("sign", template);
    expect(signed.status).toBe(200);
    const event = await signed.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(h.event.pubkey);
    const published = await h.post("publish", event);
    expect(published.status).toBe(200);
    expect(h.publications.some((item) => item.id === event.id)).toBe(true);
    for (const route of ["sign", "publish"]) {
      const rejected = await h.post(route, {
        ...event,
        tags: [...event.tags, ["p", "b".repeat(64)]],
      });
      expect(rejected.status).toBe(400);
    }
  } finally {
    await h.close();
  }
});

// Owner/admin community commands: community-bound, bounded before upstream I/O.
async function communityAdmin(respond) {
  const h = await harness(respond);
  const registered = await fetch(`${h.base}/api/relay/register`, {
    method: "POST",
    headers: { Origin: h.base },
    body: JSON.stringify({ url: fixtureRelayUrl }),
  });
  const { id } = await registered.json();
  return {
    h,
    post: (route, body) => h.post(`${encodeURIComponent(id)}/${route}`, body),
  };
}

test("invite claim forwards relay-shaped codes and names exact refusals", async () => {
  let refusal;
  const { h, post } = await communityAdmin((call) =>
    !call.url.endsWith("/api/invites/claim")
      ? new Response(null, { status: 404 })
      : refusal
        ? Response.json({ error: refusal }, { status: 403 })
        : Response.json({ status: "joined" }),
  );
  try {
    for (const code of ["v2.mvQwZTr9C31MUkGj_-", "eyJjIjoxfQ.bWFj"]) {
      const response = await post("claim", { code });
      expect(response.status).toBe(200);
      expect(h.calls.at(-1)).toMatchObject({
        url: `${fixtureRelayUrl}/api/invites/claim`,
        body: { code },
      });
    }
    const calls = h.calls.length;
    for (const code of ["", "a b", "a/b", "x".repeat(257)])
      expect((await post("claim", { code })).status).toBe(400);
    expect(h.calls).toHaveLength(calls);
    for (const error of [
      "invite_exhausted",
      "invite_expired",
      "invite_invalid",
      "database said: secret detail",
    ]) {
      refusal = error;
      const response = await post("claim", { code: "v2.abc" });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(
        error.startsWith("invite_") ? error : "Relay request failed (403)",
      );
    }
  } finally {
    await h.close();
  }
});

test("invite mint forwards only bounded ttl/max_uses and returns the relay invite", async () => {
  const minted = {
    code: "abc",
    expires_at: 1700003600,
    max_uses: 1,
    uses_remaining: 1,
    url: "https://primary.example/invite/abc",
  };
  const { h, post } = await communityAdmin((call) =>
    call.url.endsWith("/api/invites")
      ? Response.json(minted)
      : new Response(null, { status: 404 }),
  );
  try {
    const response = await post("invite", {
      ttl_secs: 3600,
      max_uses: 1,
      extra: "dropped",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(minted);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      url: `${fixtureRelayUrl}/api/invites`,
      body: { ttl_secs: 3600, max_uses: 1 },
    });
    expect(h.calls[0].auth.tags).toContainEqual([
      "u",
      `${fixtureRelayUrl}/api/invites`,
    ]);
    const unlimited = await post("invite", { ttl_secs: 2592000 });
    expect(unlimited.status).toBe(200);
    expect(h.calls[1].body).toEqual({ ttl_secs: 2592000, max_uses: null });

    for (const body of [
      {},
      { ttl_secs: 59 },
      { ttl_secs: 2592001 },
      { ttl_secs: 3600.5 },
      { ttl_secs: "3600" },
      { ttl_secs: 3600, max_uses: 0 },
      { ttl_secs: 3600, max_uses: 10001 },
      { ttl_secs: 3600, max_uses: "1" },
      null,
    ])
      expect((await post("invite", body)).status).toBe(400);
    // Unscoped requests have no community to administer.
    expect((await h.post("invite", { ttl_secs: 3600 })).status).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("member changes sign exact NIP-43 admin kinds and reject malformed changes locally", async () => {
  const { h, post } = await communityAdmin((call) =>
    Response.json({ accepted: true, event_id: call.body.id, message: "" }),
  );
  const target = "a".repeat(64);
  try {
    for (const [change, kind, tags] of [
      [
        { action: "add", pubkey: target, role: "member" },
        9030,
        [
          ["p", target],
          ["role", "member"],
        ],
      ],
      [
        { action: "add", pubkey: target, role: "admin" },
        9030,
        [
          ["p", target],
          ["role", "admin"],
        ],
      ],
      [{ action: "remove", pubkey: target }, 9031, [["p", target]]],
      [
        { action: "role", pubkey: target, role: "admin" },
        9032,
        [
          ["p", target],
          ["role", "admin"],
        ],
      ],
    ]) {
      const response = await post("member", change);
      expect(response.status).toBe(200);
      const sent = h.calls.at(-1);
      expect(sent.url).toBe(`${fixtureRelayUrl}/events`);
      expect(verifyEvent(sent.body)).toBe(true);
      expect(sent.body).toMatchObject({
        kind,
        tags,
        content: "",
        pubkey: h.event.pubkey,
        created_at: Math.floor(Date.now() / 1000),
      });
      expect(await response.json()).toMatchObject({
        accepted: true,
        event_id: sent.body.id,
      });
    }
    for (const change of [
      { action: "role", pubkey: target, role: "owner" },
      { action: "add", pubkey: target },
      { action: "remove", pubkey: target, role: "member" },
      { action: "ban", pubkey: target },
      { action: "toString", pubkey: target, role: "member" },
      { action: "add", pubkey: "A".repeat(64), role: "member" },
      { action: "add", pubkey: "a".repeat(63), role: "member" },
      { kind: 9030, tags: [["p", target]] },
    ])
      expect((await post("member", change)).status).toBe(400);
    expect(
      (await h.post("member", { action: "remove", pubkey: target })).status,
    ).toBe(400);
    expect(h.calls).toHaveLength(4);
  } finally {
    await h.close();
  }
});

test("member change receipts must match the signed command", async () => {
  const { h, post } = await communityAdmin(() =>
    Response.json({ accepted: true, event_id: "wrong" }),
  );
  try {
    const response = await post("member", {
      action: "remove",
      pubkey: "a".repeat(64),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Member change could not be confirmed",
    });
  } finally {
    await h.close();
  }
});

test.each([
  [400, "invalid: cannot remove yourself", "invalid: cannot remove yourself"],
  [
    400,
    "invalid: cannot remove the relay owner",
    "invalid: cannot remove the relay owner",
  ],
  [
    400,
    `invalid: member not found: ${"a".repeat(64)}`,
    `invalid: member not found: ${"a".repeat(64)}`,
  ],
  [
    400,
    "invalid: actor not authorized: must be admin or owner",
    "invalid: actor not authorized: must be admin or owner",
  ],
  [
    403,
    "blocked: you are banned from this community",
    "blocked: you are banned from this community",
  ],
  [
    403,
    "only relay owners and admins can create invites",
    "only relay owners and admins can create invites",
  ],
  [
    400,
    "ttl_secs must be between 60 and 2592000",
    "ttl_secs must be between 60 and 2592000",
  ],
  [
    400,
    "invalid: database error: connection reset <script>",
    "Relay request failed (400)",
  ],
  [
    400,
    "invalid: event timestamp out of range: created_at=1",
    "Relay request failed (400)",
  ],
  [500, "error: database error: secret", "Relay request failed (500)"],
])(
  "admin refusal %i %j is surfaced only when whitelisted",
  async (status, error, shown) => {
    const { h, post } = await communityAdmin(() =>
      Response.json({ error }, { status }),
    );
    try {
      for (const [route, body] of [
        ["member", { action: "remove", pubkey: "a".repeat(64) }],
        ["invite", { ttl_secs: 3600 }],
      ]) {
        const response = await post(route, body);
        expect(response.status).toBe(status);
        expect((await response.json()).error).toBe(shown);
      }
    } finally {
      await h.close();
    }
  },
);

test("admin refusals are read through the bounded error reader", async () => {
  let pulled = 0;
  const { h, post } = await communityAdmin(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            // Would be 4 MiB if fully consumed; the valid-looking prefix must not survive.
            if (pulled > 1024) return controller.close();
            controller.enqueue(
              new TextEncoder().encode(
                pulled === 1
                  ? '{"error":"invalid: cannot remove yourself","pad":"'
                  : "x".repeat(4096),
              ),
            );
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
  );
  try {
    for (const [route, body] of [
      ["member", { action: "remove", pubkey: "a".repeat(64) }],
      ["invite", { ttl_secs: 3600 }],
    ]) {
      pulled = 0;
      const response = await post(route, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("Relay request failed (400)");
      expect(pulled).toBeLessThan(8);
    }
  } finally {
    await h.close();
  }
});

test("relay quota on admin routes stays a quota failure, not a refusal", async () => {
  const { h, post } = await communityAdmin(() =>
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 5s" },
      { status: 429 },
    ),
  );
  try {
    const response = await post("invite", { ttl_secs: 3600 });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: "rate-limited: quota exceeded; retry in 5s",
      quota: "api",
    });
    // The shared lane is paused: the next admin request is not sent upstream.
    const paused = await post("invite", { ttl_secs: 3600 });
    expect(paused.status).toBe(429);
    expect(await paused.json()).toMatchObject({ paused: true, sent: false });
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("identity archive requests use dedicated exact-shape routes behind archive authority", async () => {
  const respond = (call) =>
    Response.json(
      call.url.endsWith("/events")
        ? { accepted: true, event_id: call.body.id }
        : [],
    );
  const target = "b".repeat(64);
  const auth = ["auth", "c".repeat(64), "", "d".repeat(128)];
  const template = archiveRequestTemplate("archive", target, auth);
  const unavailable = await harness(respond);
  try {
    expect(
      (await unavailable.post("identity-archive-sign", template)).status,
    ).toBe(400);
  } finally {
    await unavailable.close();
  }
  const h = await harness(respond, {
    // The harness relay author is its viewer key; NIP-11 self must match it.
    archiveAuthority: getPublicKey(
      Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0)),
    ),
  });
  let live;
  try {
    const transport = await connectBrokerTransport(h.base);
    expect(transport.writer.kinds).not.toContain(9035);
    expect(transport.writer.kinds).not.toContain(9036);
    const invalid = [
      { ...template, kind: 9037 },
      { ...template, content: "reason" },
      { ...template, tags: [["p", target]] },
      { ...template, tags: [...template.tags, ["reason", "spam"]] },
      { ...template, tags: [["-"], ["p", target], ["p", target]] },
      { ...template, tags: [["-"], ["p", "B".repeat(64)]] },
      {
        ...template,
        tags: [["-"], ["p", target], ["auth", target, "", "d".repeat(128)]],
      },
      { ...template, tags: [["-"], ["p", target], auth.slice(0, 3)] },
    ];
    for (const event of invalid) {
      expect((await h.post("identity-archive-sign", event)).status).toBe(400);
      expect((await h.post("identity-archive-publish", event)).status).toBe(
        400,
      );
    }
    const signal = new AbortController().signal;
    expect((await h.post("sign", template)).status).toBe(400);
    const signed = await transport.identityArchive.sign(template, signal);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed).toMatchObject(template);
    expect((await h.post("publish", signed)).status).toBe(400);
    live = await openBrokerSocket(transport);
    await transport.identityArchive.publish(signed, signal);
    expect(h.publications).toHaveLength(1);
    const foreign = finalizeEvent(
      { ...template, tags: template.tags.map((tag) => [...tag]) },
      new Uint8Array(32).fill(5),
    );
    expect((await h.post("identity-archive-publish", foreign)).status).toBe(
      400,
    );
    expect(h.publications).toHaveLength(1);
  } finally {
    live?.dispose();
    await h.close();
  }
});

test("lifecycle uses dedicated shape-limited host routes, never the message writer", async () => {
  const h = await harness((call) =>
    Response.json(
      call.url.endsWith("/events")
        ? { accepted: true, event_id: call.body.id }
        : [],
    ),
  );
  let live;
  try {
    const transport = await connectBrokerTransport(h.base);
    expect(transport.writer.kinds).not.toContain(9008);
    const id = "11111111-1111-4111-8111-111111111111";
    const template = {
      kind: 9008,
      tags: [["h", id]],
      content: "",
      created_at: 1700000000,
    };
    expect((await h.post("sign", template)).status).toBe(400);
    const invalid = [
      {
        ...template,
        kind: 9002,
        tags: [
          ["h", id],
          ["name", "rename"],
        ],
      },
      {
        ...template,
        kind: 9022,
        tags: [
          ["h", id],
          ["p", transport.viewer],
        ],
      },
      { ...template, content: "extra" },
      {
        ...template,
        tags: [
          ["h", id],
          ["h", id],
        ],
      },
    ];
    for (const event of invalid) {
      expect((await h.post("channel-lifecycle-sign", event)).status).toBe(400);
      expect((await h.post("channel-lifecycle-publish", event)).status).toBe(
        400,
      );
    }
    const signal = new AbortController().signal;
    const signed = await transport.channelLifecycle.sign(template, signal);
    expect(verifyEvent(signed)).toBe(true);
    expect(signed).toMatchObject(template);
    expect((await h.post("publish", signed)).status).toBe(400);
    await expect(
      transport.channelLifecycle.publish(signed, signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    expect(h.publications).toHaveLength(0);
    live = await openBrokerSocket(transport);
    await transport.channelLifecycle.publish(signed, signal);
    expect(h.publications).toHaveLength(1);
    const foreignKey = new Uint8Array(32).fill(5);
    const foreign = finalizeEvent(
      { ...template, tags: template.tags.map((tag) => [...tag]) },
      foreignKey,
    );
    expect((await h.post("channel-lifecycle-publish", foreign)).status).toBe(
      400,
    );
    expect(h.publications).toHaveLength(1);
  } finally {
    live?.dispose();
    await h.close();
  }
});

test("product feedback signs and publishes only private bounded text/category", async () => {
  const h = await harness(success);
  try {
    await h.start();
    expect((await (await h.get("session")).json()).writeKinds).toContain(42000);
    const template = {
      ...h.event,
      kind: 42000,
      content: "This broke",
      tags: [
        ["category", "bug"],
        ["client-id", "fixture"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject({
      kind: 42000,
      content: template.content,
      tags: template.tags,
    });
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.publications).toEqual([JSON.parse(JSON.stringify(event))]);
    for (const route of ["sign", "publish"]) {
      for (const invalid of [
        { tags: [["h", "c"]] },
        {
          tags: [
            ["category", "bug"],
            ["category", "praise"],
          ],
        },
        { tags: [["category", "idea"]] },
        { tags: [null] },
        { content: " \n " },
        { content: "é".repeat(16_385) },
      ])
        expect((await h.post(route, { ...event, ...invalid })).status).toBe(
          400,
        );
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("feedback media tags pass broker signing only for tenant-local bounded descriptors", async () => {
  const h = await harness(success);
  const hash = "a".repeat(64);
  const valid = [
    "imeta",
    `url ${fixtureRelayUrl}/media/${hash}.png`,
    "m image/png",
    "size 64",
    `x ${hash}`,
    "filename capture.png",
  ];
  try {
    await h.start();
    const template = {
      ...h.event,
      kind: 42000,
      content: `Broken\n\n![capture](<${fixtureRelayUrl}/media/${hash}.png>)`,
      tags: [valid],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const signed = await response.json();
    expect((await h.post("publish", signed)).status).toBe(200);
    for (const tag of [
      valid.map((part) =>
        part.startsWith("url ")
          ? `url https://other.test/media/${hash}.png`
          : part,
      ),
      valid.map((part) => (part.startsWith("size ") ? "size NaN" : part)),
      valid.map((part) =>
        part.startsWith("filename ") ? "filename ../capture.png" : part,
      ),
      [...valid, "x duplicated"],
      valid.slice(0, -1),
    ]) {
      expect((await h.post("sign", { ...template, tags: [tag] })).status).toBe(
        400,
      );
      expect((await h.post("publish", { ...signed, tags: [tag] })).status).toBe(
        400,
      );
    }
    expect(h.publications).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("private feedback crosses the real broker and session without a readback or shared view", async () => {
  const h = await harness(success);
  let owner;
  try {
    const transport = await connectBrokerTransport(h.base);
    owner = createRelaySession(transport, {
      outboxStorage: { load: () => [], save() {} },
    });
    // The session owns its own stream; waiting on a separate subscription does
    // not establish that the publication owner's live ID has been admitted.
    await vi.waitFor(() =>
      expect(owner.session.live.snapshot().status).toBe("connected"),
    );
    const outbox = owner.session.outbox;
    expect(outbox).toBeDefined();
    await outbox.ready();
    const id = outbox.send(feedbackEvent("Controlled private text", "bug"));
    await vi.waitFor(() => {
      const result = outbox.snapshot()[0];
      if (result?.delivery === "failed")
        throw new Error(result.error ?? "failed");
      expect(result?.delivery).toBe("accepted");
    });
    expect(h.publications).toHaveLength(1);
    expect(h.publications[0]).toMatchObject({
      id,
      kind: 42000,
      content: "Controlled private text",
    });
    expect(verifyEvent(h.publications[0])).toBe(true);
    expect(h.publications[0].tags.some(([name]) => name === "h")).toBe(false);
    const feedbackReads = h.calls.filter(
      ({ body }) =>
        Array.isArray(body) && body.some(({ ids }) => ids?.includes(id)),
    );
    expect(feedbackReads).toEqual([]);
    expect(
      owner.session.observe([{ kinds: [42000], limit: 20 }]).snapshot().events,
    ).toEqual([]);
  } finally {
    owner?.dispose();
    await h.close();
  }
});

test("broker HTTP summaries respect live levels and trace excludes private filters", async () => {
  const logger = getLogger("relay-broker");
  const reporters = [...logger.options.reporters];
  const lines = [];
  logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
  const h = await harness(success);
  try {
    setLogLevel("trace");
    expect(
      (
        await h.post("query", [
          {
            kinds: [0],
            limit: 1,
            authors: ["a".repeat(64)],
            search: "private search",
          },
        ])
      ).status,
    ).toBe(200);
    expect(lines.some((line) => line.includes("POST /relay/query → 200"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('"authors":1'))).toBe(true);
    expect(lines.join(" ")).not.toContain("private search");
    expect(lines.join(" ")).not.toContain("a".repeat(64));
    lines.length = 0;
    setLogLevel("info");
    expect((await h.post("query", filters)).status).toBe(200);
    expect(lines).toHaveLength(0);
  } finally {
    await h.close();
    logger.setReporters(reporters);
    setLogLevel("info");
  }
});

test.each([
  [
    new DOMException("private timeout detail", "TimeoutError"),
    "TimeoutError",
    500,
  ],
  [new SyntaxError("private response body"), "SyntaxError", 500],
  [
    new TypeError("private URL", { cause: { code: "ECONNREFUSED" } }),
    "TypeError (ECONNREFUSED)",
    502,
  ],
  [
    Object.assign(new Error("private message"), {
      name: "private name",
      code: "private code",
    }),
    "Error",
    500,
  ],
])(
  "broker failure logs preserve safe categories/codes, not private exception text (%#)",
  async (error, summary, status) => {
    const logger = getLogger("relay-broker");
    const reporters = [...logger.options.reporters];
    const lines = [];
    logger.setReporters([{ log: (entry) => lines.push(entry.args.join(" ")) }]);
    setLogLevel("info");
    const h = await harness(() => {
      throw error;
    });
    try {
      expect((await h.post("query", filters)).status).toBe(status);
      expect(lines).toContain(`Request failed: POST /relay/query: ${summary}`);
      expect(lines.join(" ")).not.toContain("private");
    } finally {
      await h.close();
      logger.setReporters(reporters);
      setLogLevel("info");
    }
  },
);

test("Trace metadata uses the real Node reporter without fabricated stacks", async () => {
  const logger = getLogger("relay-broker");
  const socket = getLogger("relay-ws");
  const originals = [logger, socket].map((log) => ({
    log,
    reporters: [...log.options.reporters],
    stdout: log.options.stdout,
    stderr: log.options.stderr,
  }));
  const lines = [];
  const output = {
    write: (line) => {
      lines.push(String(line));
      return true;
    },
  };
  const fancy = createConsola({ fancy: true, stdout: output, stderr: output });
  for (const { log } of originals) {
    log.setReporters(fancy.options.reporters);
    log.options.stdout = output;
    log.options.stderr = output;
  }
  const h = await harness(success);
  try {
    lines.length = 0; // Exclude the harness startup lifecycle message.
    setLogLevel("trace");
    expect((await h.post("query", filters)).status).toBe(200);
    logSocketFrame("relay.test", "→", "[]", ["REQ", "live-1", { kinds: [9] }]);
    expect(lines.join("")).toContain("filters");
    expect(lines.join("")).toContain("query");
    expect(lines.join("")).not.toMatch(/\n\s+at |FancyReporter|formatLogObj/);
    expect(lines).toHaveLength(4); // HTTP summary + metadata, frame summary + metadata.
    expect(lines.every((line) => line.trim().split("\n").length === 1)).toBe(
      true,
    );
  } finally {
    await h.close();
    for (const { log, reporters, stdout, stderr } of originals) {
      log.setReporters(reporters);
      log.options.stdout = stdout;
      log.options.stderr = stderr;
    }
    setLogLevel("info");
  }
});

test("server-wide stats work without a default community and do not start upstream I/O", async () => {
  const h = await harness(success, {}, "");
  try {
    // Use node:http: Undici diagnostics also count the test client's own socket.
    const result = await new Promise((resolve, reject) => {
      get(`${h.base}/api/relay/stats`, (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, raw }));
      }).on("error", reject);
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.raw)).toEqual({
      queries: 0,
      errors: 0,
      media: 0,
      connects: 0,
    });
    expect(h.calls).toEqual([]);
  } finally {
    await h.close();
  }
});

test("community setup signs explicit owner intent without inventory or enrollment", async () => {
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const pubkey = "ab".repeat(32);
  const h = await harness(() => {
    throw new Error("No relay read permitted");
  });
  const route = `${encodeURIComponent(fixtureRelayUrl)}/resolve-agent-community`;
  const input = { pubkey, owner: viewer, confirmed: true };
  try {
    for (const invalid of [
      { ...input, confirmed: false },
      { ...input, owner: pubkey },
      { ...input, pubkey: viewer },
      { ...input, pubkey: "invalid" },
      { ...input, extra: true },
    ])
      expect((await h.post(route, invalid)).status).toBe(400);
    const response = await h.post(route, input);
    expect(response.status).toBe(200);
    const resolution = await response.json();
    expect(resolution).toMatchObject({
      pubkey,
      owner: viewer,
      relayUrl: fixtureRelayUrl.replace(/^https:/, "wss:"),
    });
    const { schnorr } = await import("@noble/curves/secp256k1.js");
    expect(
      schnorr.verify(
        Buffer.from(resolution.signature, "hex"),
        createHash("sha256")
          .update(`nostr:agent-community:${pubkey}:${resolution.relayUrl}`)
          .digest(),
        Buffer.from(viewer, "hex"),
      ),
    ).toBe(true);
    expect(h.calls).toHaveLength(0);
    expect(h.publications).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("details routes are narrow, require the live owner, and do not widen lifecycle/outbox", async () => {
  const h = await harness(success);
  let live;
  try {
    const transport = await connectBrokerTransport(h.base);
    const template = {
      kind: 9002,
      created_at: 1700000000,
      content: "",
      tags: [
        ["h", "11111111-1111-4111-8111-111111111111"],
        ["name", "renamed"],
        ["about", ""],
        ["visibility", "private"],
      ],
    };
    expect(transport.writer.kinds).not.toContain(9002);
    expect((await h.post("sign", template)).status).toBe(400);
    expect((await h.post("channel-lifecycle-sign", template)).status).toBe(400);
    for (const invalid of [
      { ...template, kind: 9001 },
      { ...template, content: "extra" },
      { ...template, tags: [...template.tags, ["archived", "true"]] },
      {
        ...template,
        tags: [...template.tags.slice(0, 3), ["visibility", "open"]],
      },
      { ...template, tags: [template.tags[0], ["topic", "x"]] },
      {
        ...template,
        tags: [template.tags[0], ["name", "n"], ["about", "x".repeat(1001)]],
      },
    ]) {
      for (const route of ["channel-details-sign", "channel-details-publish"])
        expect((await h.post(route, invalid)).status).toBe(400);
    }
    const signal = new AbortController().signal;
    const event = await transport.channelDetails.sign(template, signal);
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject(template);
    expect((await h.post("publish", event)).status).toBe(400);
    await expect(
      transport.channelDetails.publish(event, signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    expect(h.publications).toHaveLength(0);
    live = await openBrokerSocket(transport);
    await transport.channelDetails.publish(event, signal);
    expect(h.publications).toHaveLength(1);
    const foreign = finalizeEvent(
      structuredClone(template),
      new Uint8Array(32).fill(5),
    );
    expect((await h.post("channel-details-publish", foreign)).status).toBe(400);
    expect(h.publications).toHaveLength(1);
  } finally {
    live?.dispose();
    await h.close();
  }
});
