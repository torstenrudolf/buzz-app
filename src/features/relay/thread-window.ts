import type { ReadFilter, RelayEvent } from "./events";
import { ReadError } from "./errors";
import { isObject, objectBody } from "./body";

export type ThreadCursor = Readonly<{ created_at: number; id: string }>;
export class MissingThreadBounds extends ReadError {
  constructor(readonly legacyRows = false) {
    super("invalid-response", "Relay did not serve a signed thread window");
  }
}
const invalid = () =>
  new ReadError("invalid-response", "Thread window bounds are invalid");
const hex = /^[0-9a-f]{64}$/;
export const canonicalChannel = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Same authority normalization as buzz-core::tenant::normalize_host. Never use the local broker host. */
export function threadAuthority(origin: string) {
  const url = new URL(origin);
  if (
    !["https:", "http:", "wss:", "ws:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw invalid();
  return url.host
    .toLowerCase()
    .replace(/:(80|443)$/, "")
    .replace(/\.$/, "");
}

/** NIP-CW thread-mode v1, identical to buzz-core::thread_window::Request::binding. */
export async function threadBinding(
  filter: ReadFilter,
  origin: string,
  viewer: string,
) {
  const canonical = JSON.stringify([
    "tw",
    1,
    "older",
    threadAuthority(origin),
    viewer,
    filter["#h"]?.[0],
    filter["#e"]?.[0],
    filter.limit,
    filter.depth_limit ?? 100,
    [...new Set(filter.kinds)].sort((a, b) => a - b),
    filter.until === undefined ? null : [filter.until, filter.before_id],
    filter.include_aux ?? false,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return (
    "tw:1:" +
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}

export function threadBounds(event: RelayEvent): {
  hasMore: boolean;
  cursor: ThreadCursor | null;
} {
  const body = objectBody(event.content);
  if (
    body?.version !== 1 ||
    body.direction !== "older" ||
    typeof body.has_more !== "boolean"
  )
    throw invalid();
  const next = body.next_cursor;
  if (
    next !== null &&
    (!isObject(next) ||
      !Number.isSafeInteger(next.created_at) ||
      typeof next.created_at !== "number" ||
      next.created_at < 0 ||
      // chrono 0.4's DateTime::MAX_UTC, used by the relay's Cursor::timestamp.
      next.created_at > 8_210_266_876_799 ||
      typeof next.id !== "string" ||
      !hex.test(next.id))
  )
    throw invalid();
  if (body.has_more !== (next !== null)) throw invalid();
  return { hasMore: body.has_more, cursor: next as ThreadCursor | null };
}

/** Runs on signature-verified finite results BEFORE session admission. Missing bounds
 * are distinct from invalid bounds; only the first probe may choose a clean legacy restart. */
export async function verifyThreadWindows(
  filters: readonly ReadFilter[],
  events: readonly RelayEvent[],
  origin: string | undefined,
  viewer: string,
  relayAuthor: string,
) {
  if (!filters.some((filter) => filter.thread_window === true)) return;
  if (
    !origin ||
    !hex.test(viewer) ||
    !hex.test(relayAuthor) ||
    filters.some((filter) => !filter.thread_window)
  )
    throw invalid();
  const bounds = events.filter((event) => event.kind === 39007);
  if (!bounds.length)
    throw new MissingThreadBounds(
      events.some((event) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(event.kind) &&
            event.tags.some(
              ([key, value]) => key === "h" && value === filter["#h"]?.[0],
            ) &&
            event.tags.some(
              ([key, value]) => key === "e" && value === filter["#e"]?.[0],
            ),
        ),
      ),
    );
  if (bounds.length !== filters.length) throw invalid();
  const remaining = new Set(bounds);
  for (const filter of filters) {
    const binding = await threadBinding(filter, origin, viewer);
    const bound = bounds.find((event) =>
      event.tags.some(([key, value]) => key === "d" && value === binding),
    );
    if (
      !bound ||
      !remaining.delete(bound) ||
      bound.pubkey !== relayAuthor ||
      bound.tags.length !== 3 ||
      ![
        ["d", binding],
        ["h", filter["#h"]?.[0]],
        ["e", filter["#e"]?.[0]],
      ].every(
        ([key, value]) =>
          bound.tags.filter(
            (tag) => tag.length === 2 && tag[0] === key && tag[1] === value,
          ).length === 1,
      )
    )
      throw invalid();
    const { cursor } = threadBounds(bound);
    if (
      cursor &&
      filter.until !== undefined &&
      (cursor.created_at > filter.until ||
        (cursor.created_at === filter.until &&
          cursor.id <= (filter.before_id ?? "")))
    )
      throw invalid();
  }
}
