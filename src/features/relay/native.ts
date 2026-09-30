import { invoke } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { communityDestination, relayOrigin } from "../communities/destination";
import { eventDto } from "./events";
import { workflowHost, workflowRunsPath } from "../workflows/http";
import { WORKFLOW_KINDS } from "../workflows/protocol";
import {
  memoryAgent,
  memoryListing,
  type MemoryListing,
} from "../agents/memory";
import type { AgentLibrary } from "../agents/library";
import { observerFrame } from "../agents/observer";
import {
  connectSignedTransport,
  admittedSignedWorkflowRead,
  type ReadTransport,
  type Signer,
} from "./transport";
import { PublishRejected } from "./outbox";

export const nativeWriteKinds = [
  7,
  9,
  1984,
  9000,
  9001,
  30315,
  40003,
  40100,
  42000,
  ...WORKFLOW_KINDS,
] as const;

/** Cancellation fences JS results; a dispatched native write may still complete. */
export async function nativeRelayRequest(
  community: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const bounded = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30_000),
  ]);
  bounded.throwIfAborted();
  const result = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>("relay_http", {
    community: communityDestination(community).url,
    path,
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? null : JSON.stringify(body),
  });
  // IPC cannot abort reqwest. Retain the shared admission slot until native work
  // settles (bounded by its timeout), then reject any obsolete result.
  bounded.throwIfAborted();
  return nativeResponse(result);
}

function nativeResponse(result: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): Response {
  return new Response(
    [204, 205, 304].includes(result.status) ? null : result.body,
    { status: result.status, headers: result.headers },
  );
}

export function nativeRelaySigner(community: string): Signer {
  const origin = communityDestination(community).url;
  return {
    async getPublicKey() {
      const viewer = await invoke<string | null>("identity_restore");
      if (!viewer || !/^[a-f0-9]{64}$/.test(viewer))
        throw new Error("Set up your identity first");
      return viewer;
    },
    async signEvent(event: EventTemplate) {
      const { kind, created_at, tags, content } = event;
      return eventDto(
        await invoke("relay_sign", {
          community: origin,
          event: { kind, created_at, tags, content },
        }),
      );
    },
    request(url, body, signal) {
      const target = new URL(url);
      if (target.origin !== origin || target.search || target.hash)
        throw new Error("Relay request changed community");
      return nativeRelayRequest(
        origin,
        target.pathname,
        JSON.parse(body),
        signal,
      );
    },
  };
}

export async function nativeRelayInfo(community: string, signal?: AbortSignal) {
  const response = await nativeRelayRequest(community, "/", undefined, signal);
  if (!response.ok) throw new Error("Community discovery failed");
  const info: unknown = await response.json();
  if (!info || typeof info !== "object" || Array.isArray(info))
    throw new Error("Invalid community information");
  return info as Record<string, unknown>;
}

export async function connectNativeTransport(
  community: string,
  signal?: AbortSignal,
): Promise<ReadTransport> {
  const origin = communityDestination(community).url;
  const info = await nativeRelayInfo(origin, signal);
  const author = info.self;
  if (typeof author !== "string" || !/^[a-f0-9]{64}$/.test(author))
    throw new Error("Relay did not advertise its identity");
  const transport = await connectSignedTransport(
    nativeRelaySigner(origin),
    origin,
    author,
  );
  signal?.throwIfAborted();
  const writer = transport.writer;
  if (!writer) throw new Error("Native relay writer is unavailable");
  // Capabilities describe implemented host operations, not everything this key can sign.
  return {
    ...transport,
    workflows: workflowHost(async (route, body, signal) => {
      if (route !== "workflow-runs") throw new Error("Invalid workflow read");
      workflowRunsPath(body);
      signal.throwIfAborted();
      const response = await admittedSignedWorkflowRead(
        origin,
        transport.viewer,
        async () => {
          const result = await invoke<{
            status: number;
            headers: Record<string, string>;
            body: string;
          }>("relay_workflow_runs", {
            community: origin,
            id: (body as { id: string }).id,
            cursor:
              (body as { cursor?: { before: string; beforeId: string } })
                .cursor ?? null,
          });
          return nativeResponse(result);
        },
        signal,
      );
      signal.throwIfAborted();
      return response;
    }),
    agentActivity: true,
    subscribe(callbacks) {
      let active = true;
      let observerGeneration: number | null = null;
      let observerEpoch = 0;
      let listening = false;
      const traffic = transport.subscribe?.({
        ...callbacks,
        state(snapshot) {
          const route = snapshot.routes.find((item) => item.id === "observer");
          const next =
            snapshot.status === "connected" && route?.status === "live";
          if (listening && !next) observerEpoch++;
          listening = next;
          callbacks.state(snapshot);
        },
        telemetry(event, generation) {
          if (generation !== observerGeneration || !listening) return;
          const epoch = observerEpoch;
          void invoke("relay_agent_observer", { community: origin, event })
            .then((value) => {
              if (
                active &&
                listening &&
                observerEpoch === epoch &&
                observerGeneration === generation
              )
                callbacks.observer?.(observerFrame(value), generation);
            })
            .catch(() => {
              /* Invalid encrypted telemetry is not chat traffic. */
            });
        },
      });
      if (!traffic) throw new Error("Native relay stream is unavailable");
      return {
        ...traffic,
        observe(generation) {
          observerEpoch++;
          observerGeneration = generation;
          traffic.observe?.(generation);
        },
        dispose() {
          active = false;
          observerEpoch++;
          traffic.dispose();
        },
      };
    },
    async readAgentLibrary(signal) {
      signal.throwIfAborted();
      const result = await invoke<AgentLibrary>("relay_agent_library");
      signal.throwIfAborted();
      return result;
    },
    async readAgentMemories(
      agent: string,
      signal: AbortSignal,
    ): Promise<MemoryListing> {
      if (!memoryAgent(agent, transport.viewer))
        throw new Error("Invalid memory target");
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      bounded.throwIfAborted();
      let result: unknown;
      try {
        result = await invoke<unknown>("relay_agent_memories_read", {
          community: origin,
          agent,
        });
      } catch (reason) {
        if (reason === "MemoryDenied") {
          const denied = new Error("Memory read failed");
          denied.name = "MemoryDenied";
          throw denied;
        }
        throw reason;
      }
      bounded.throwIfAborted();
      return memoryListing(result);
    },
    async authorizeAgentLog(target, nonce) {
      if (relayOrigin(target.relayUrl) !== origin)
        throw new Error("Log authorization unavailable");
      const signature = await invoke<string>("relay_agent_log_proof", {
        community: origin,
        target: { ...target, nonce },
      });
      if (!/^[0-9a-f]{128}$/.test(signature))
        throw new Error("Log authorization unavailable");
      return signature;
    },
    writer: {
      ...writer,
      kinds: nativeWriteKinds,
      async publish(event, signal) {
        // The relay rejects old events before deduplication. An explicit retry
        // can confirm the original ID, but must never silently re-date it.
        if (event.created_at < Math.floor(Date.now() / 1000) - 15 * 60) {
          const found = await transport.query(
            [
              {
                kinds: [event.kind],
                ids: [event.id],
                authors: [event.pubkey],
                limit: 1,
                consistency: "strong",
              },
            ],
            signal,
          );
          if (found.some((value) => value.id === event.id)) return "";
          throw new PublishRejected(
            "This event is too old to retry and was not found on the relay. Check the conversation before sending it again.",
          );
        }
        return (await writer.publish(event, signal)) ?? "";
      },
    },
  };
}
