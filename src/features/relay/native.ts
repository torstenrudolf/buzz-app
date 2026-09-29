import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { communityDestination } from "../communities/destination";
import {
  audioDemuxer,
  isHeic,
  isVoiceNote,
  videoDemuxer,
} from "./video-preparation";
import {
  hostUpload,
  UploadError,
  UPLOAD_MAX_BYTES,
  validateUploadResult,
} from "./attachments";
import { eventDto } from "./events";
import { workflowHost, workflowRunsPath } from "../workflows/http";
import { WORKFLOW_KINDS } from "../workflows/protocol";
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
  30030,
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

/** Relay media through the native `buzz-media` scheme (`src-tauri/src/relay.rs`),
 * which signs each Blossom `get`, including every `Range` request. */
export function nativeMediaUrl(url: string): string {
  return convertFileSrc(url, "buzz-media");
}

/** Raw IPC bytes; native code hashes, signs and sends them to `PUT /upload`.
 * Aborting settles at once and tells native code to drop the request. */
async function nativeUpload(
  origin: string,
  file: File,
  signal: AbortSignal,
  preparation?: string,
) {
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  let abort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      invoke("relay_upload_cancel", { id }).catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const result = await Promise.race([
      invoke<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>("relay_upload", bytes, {
        headers: {
          "x-buzz-upload-id": id,
          "x-buzz-community": origin,
          "x-buzz-content-type": file.type || "application/octet-stream",
          ...(preparation ? { "x-buzz-preparation": preparation } : {}),
        },
      }),
      aborted,
    ]);
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Preparation is performed and uploaded inside the host. Converted bytes never
 * cross back into JS; only the validated relay descriptor does. */
async function nativeAttachmentUpload(
  origin: string,
  file: File,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!file.size || file.size > UPLOAD_MAX_BYTES) throw new UploadError("size");
  const header = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  signal.throwIfAborted();
  const voice = isVoiceNote(file.name);
  const heic = !voice && isHeic(header, file.name);
  if (voice && file.size > 128 * 1024 * 1024) throw new UploadError("size");
  const demuxer = voice
    ? audioDemuxer(header)
    : heic
      ? "mov"
      : videoDemuxer(header);
  if (!demuxer) {
    if (voice || file.type.startsWith("video/")) throw new UploadError("video");
    return hostUpload(
      (item, bounded) => nativeUpload(origin, item, bounded),
      origin,
    )(file, signal);
  }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
  const response = await nativeUpload(
    origin,
    file,
    bounded,
    `${heic ? "image" : voice ? "voice" : "video"}:${demuxer}`,
  );
  bounded.throwIfAborted();
  if (!response.ok) {
    let code: unknown;
    try {
      code = ((await response.json()) as { code?: unknown }).code;
    } catch {
      /* Relay errors need not be JSON. */
    }
    throw new UploadError(
      code === "ffmpeg" ||
        code === "size" ||
        code === "capacity" ||
        code === "image" ||
        code === "video"
        ? code
        : "failed",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new UploadError("invalid");
  }
  const type = heic ? "image/jpeg" : "video/mp4";
  const name = `${file.name.replace(/\.[^.]+$/, "") || "Attachment"}.${heic ? "jpg" : "mp4"}`;
  bounded.throwIfAborted();
  const size = (body as { size?: number } | null)?.size;
  if (
    typeof size !== "number" ||
    (body as { type?: string } | null)?.type !== type
  )
    throw new UploadError("invalid");
  return validateUploadResult(body, origin, size, name);
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
    upload: (file, signal) => nativeUpload(origin, file, signal),
    media: nativeMediaUrl,
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
    uploadAttachment: (file, signal) =>
      nativeAttachmentUpload(origin, file, signal),
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
