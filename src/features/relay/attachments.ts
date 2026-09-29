import {
  isHeic,
  isVoiceNote,
  videoDemuxer,
  VIDEO_PREPARATION_MS,
} from "./video-preparation.ts";
import { safeAttachmentName } from "./message-content.ts";

import {
  mediaByteLimit,
  UPLOAD_MAX_BYTES,
  UPLOAD_TIMEOUT_MS,
} from "./attachment-limits.ts";
export { UPLOAD_MAX_BYTES, UPLOAD_TIMEOUT_MS };
export type UploadedAttachment = Readonly<{
  name: string;
  url: string;
  type: string;
  size: number;
  sha256: string;
}>;
export type AttachmentUpload = (
  file: File,
  signal: AbortSignal,
) => Promise<UploadedAttachment>;
export const UPLOAD_FAILURES = {
  unavailable: "Uploads are unavailable on this connection.",
  size: "File exceeds the supported limit: images 50 MiB, GIFs 10 MiB, documents 100 MiB, videos 500 MiB. The relay may enforce a lower limit.",
  image: "Image conversion failed. This HEIC/HEIF photo could not be prepared.",
  ffmpeg:
    "Media conversion requires ffmpeg on this computer. Install it, then restart the app’s dev server.",
  video:
    "Video preparation failed. This recording could not be converted to MP4.",
  capacity: "Uploads are busy. Retry this file shortly.",
  metadata:
    "This file needs metadata cleanup before it can be uploaded. Choose an exported copy without metadata, or remove it for now.",
  rejected:
    "The server could not accept this file. Its format or metadata may not be supported.",
  denied: "You don’t have permission to upload here.",
  failed: "Upload did not finish. Retry or remove this file.",
  invalid: "The server returned an invalid upload result. Retry this file.",
  cancelled: "Upload cancelled. Retry to upload this file.",
} as const;
export type UploadCode = keyof typeof UPLOAD_FAILURES;
export class UploadError extends Error {
  constructor(readonly code: UploadCode) {
    super(UPLOAD_FAILURES[code]);
  }
}
export function validateUploadResult(
  value: unknown,
  origin: string,
  size: number,
  name: string,
): UploadedAttachment {
  const v = value as Partial<UploadedAttachment> | null;
  if (
    !v ||
    typeof v.url !== "string" ||
    typeof v.type !== "string" ||
    !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(v.type) ||
    v.size !== size ||
    typeof v.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(v.sha256) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > mediaByteLimit(v.type)
  )
    throw new UploadError("invalid");
  let url: URL;
  try {
    url = new URL(v.url, origin);
  } catch {
    throw new UploadError("invalid");
  }
  if (
    url.origin !== new URL(origin).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(`^/media/${v.sha256}(?:\\.[a-z0-9]{1,8})?$`).test(url.pathname)
  )
    throw new UploadError("invalid");
  return Object.freeze({
    name,
    url: url.href,
    type: v.type.toLowerCase(),
    size,
    sha256: v.sha256,
  });
}
function attachmentMarkdown(name: string, result: UploadedAttachment) {
  const label = Array.from(name, (char) =>
    char.charCodeAt(0) < 32 ? " " : char,
  )
    .join("")
    .replace(/[\\`*_{}[\]()!<>&]/g, "\\$&");
  const image = /^(image\/(png|jpeg|gif|webp)|video\/mp4)$/.test(result.type);
  return `${image ? "!" : ""}[${label}](<${result.url}>)`;
}
/** Local preparation returns bytes; the existing upload still hashes/signs those exact bytes. */
async function prepareMedia(
  file: File,
  endpoint: string,
  signal: AbortSignal,
): Promise<File> {
  const header = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  signal.throwIfAborted();
  const voice = isVoiceNote(file.name);
  const heic = !voice && isHeic(header, file.name);
  if (voice && file.size > 128 * 1024 * 1024) throw new UploadError("size");
  if (!heic && !voice && !videoDemuxer(header)) {
    if (file.type.startsWith("video/")) throw new UploadError("video");
    return file;
  }
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(VIDEO_PREPARATION_MS),
  ]);
  const response = await fetch(`${endpoint}/prepare-media`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Attachment-Name": encodeURIComponent(file.name),
    },
    body: file,
    signal: bounded,
  });
  const type = heic ? "image/jpeg" : "video/mp4";
  if (!response.ok || response.headers.get("content-type") !== type) {
    await response.body?.cancel();
    throw new UploadError(
      response.status === 503
        ? "ffmpeg"
        : response.status === 413
          ? "size"
          : response.status === 429
            ? "capacity"
            : heic
              ? "image"
              : "video",
    );
  }
  const length = Number(response.headers.get("content-length"));
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > mediaByteLimit(type)
  ) {
    await response.body?.cancel();
    throw new UploadError("size");
  }
  // The host bounds and streams output. Blob consumption avoids JS chunk arrays
  // and lets the browser manage the prepared file's backing storage.
  const blob = await response.blob();
  bounded.throwIfAborted();
  if (blob.size !== length) throw new UploadError("invalid");
  const name = file.name.replace(/\.[^.]+$/, "") || "Attachment";
  return new File([blob], `${name}.${heic ? "jpg" : "mp4"}`, {
    type,
    lastModified: file.lastModified,
  });
}

export function brokerUpload(
  endpoint: string,
  origin: string,
): AttachmentUpload {
  return hostUpload(
    (file, signal) =>
      fetch(`${endpoint}/upload`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
        signal,
      }),
    origin,
    (file, signal) => prepareMedia(file, endpoint, signal),
  );
}

/** Shared upload policy for any host that signs and sends the exact bytes it
 * is given: limits, timeout, error mapping and descriptor validation. */
export function hostUpload(
  send: (file: File, signal: AbortSignal) => Promise<Response>,
  origin: string,
  prepare?: (file: File, signal: AbortSignal) => Promise<File>,
): AttachmentUpload {
  return async (file, signal) => {
    signal.throwIfAborted();
    if (!file.size || file.size > UPLOAD_MAX_BYTES)
      throw new UploadError("size");
    if (prepare) file = await prepare(file, signal);
    signal.throwIfAborted();
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    ]);
    const response = await send(file, bounded);
    bounded.throwIfAborted();
    if ([401, 403, 413, 429].includes(response.status)) {
      try {
        await response.body?.cancel();
      } catch {
        /* Keep the known failure. */
      }
      throw new UploadError(
        response.status === 413
          ? "size"
          : response.status === 429
            ? "capacity"
            : "denied",
      );
    }
    let text = "";
    const reader = response.body?.getReader();
    if (!reader) throw new UploadError("invalid");
    try {
      const decoder = new TextDecoder();
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) throw new UploadError("invalid");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* Do not replace a parsing failure. */
      }
    }
    if (!response.ok) {
      let code: unknown;
      try {
        code = (JSON.parse(text) as { code?: unknown } | null)?.code;
      } catch {
        /* A relay error body is `{ error }` or plain text. */
      }
      throw new UploadError(
        typeof code === "string" && Object.hasOwn(UPLOAD_FAILURES, code)
          ? (code as UploadCode)
          : // The relay's own content rejections (the broker maps these the same way).
            [400, 415, 422].includes(response.status)
            ? /metadata/i.test(text)
              ? "metadata"
              : "rejected"
            : "failed",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UploadError("invalid");
    }
    bounded.throwIfAborted();
    return validateUploadResult(body, origin, file.size, file.name);
  };
}

/** Only completed uploads enter the existing message/outbox contract. */
export function attachmentMessage(
  content: string,
  attachments: readonly UploadedAttachment[],
  origin?: string,
) {
  const tags: string[][] = [];
  const links = attachments.map((item) => {
    if (!origin || typeof item.name !== "string")
      throw new UploadError("invalid");
    const result = validateUploadResult(item, origin, item.size, item.name);
    // Relay filename metadata is a basename capped at 255 UTF-8 bytes.
    let name = "";
    let bytes = 0;
    for (const char of item.name) {
      const clean =
        !safeAttachmentName(char) || char === "/" || char === "\\" ? " " : char;
      bytes += new TextEncoder().encode(clean).length;
      if (bytes > 255) break;
      name += clean;
    }
    name = name.trim() || "File";
    tags.push([
      "imeta",
      `url ${result.url}`,
      `m ${result.type}`,
      `size ${result.size}`,
      `x ${result.sha256}`,
      `filename ${name}`,
    ]);
    return attachmentMarkdown(name, result);
  });
  return {
    content: [content.trim(), ...links].filter(Boolean).join("\n\n"),
    tags,
  };
}
