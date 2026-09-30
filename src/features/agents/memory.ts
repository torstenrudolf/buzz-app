/** Owner-view NIP-AE snapshot from a purpose-bound key-owning host. */
export const MEMORY_EVENT_LIMIT = 256;
export const MEMORY_WIRE_BYTES = 2 * 1024 * 1024;
export const MEMORY_TEXT_BYTES = 1024 * 1024;
export interface MemoryEntry {
  slug: string;
  body: string;
  eventId: string;
  createdAt: number;
}
export interface MemoryListing {
  entries: readonly MemoryEntry[];
  partial: boolean;
}
export type MemoryReader = (
  agent: string,
  signal: AbortSignal,
) => Promise<MemoryListing>;
export type MemorySnapshot = Readonly<{
  status:
    | "idle"
    | "blocked"
    | "loading"
    | "ready"
    | "error"
    | "denied"
    | "unavailable";
  listing?: MemoryListing;
}>;
export function memoryAgent(agent: unknown, viewer: string): agent is string {
  return (
    typeof agent === "string" &&
    /^[0-9a-f]{64}$/.test(agent) &&
    agent !== viewer
  );
}
/** NIP-AE address grammar, shared by host evidence and renderer DTO validation. */
export function memorySlug(slug: unknown): slug is string {
  return (
    typeof slug === "string" &&
    slug.length <= 255 &&
    (slug === "core" ||
      /^mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*$/.test(slug))
  );
}
/** Bound bytes before parsing ciphertext or plaintext responses. */
export async function memoryResponseText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Memory response missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MEMORY_WIRE_BYTES)
        throw new Error("Memory response exceeds budget");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Validate the host DTO before retaining plaintext, including aggregate size. */
export function memoryListing(input: unknown): MemoryListing {
  const value = input as MemoryListing | null;
  if (
    !value ||
    typeof value.partial !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length > MEMORY_EVENT_LIMIT
  )
    throw new Error("Invalid memory listing");
  const slugs = new Set<string>();
  let bytes = 0;
  const entries = value.entries.map((entry) => {
    if (
      !entry ||
      !memorySlug(entry.slug) ||
      typeof entry.body !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.eventId) ||
      !Number.isSafeInteger(entry.createdAt) ||
      entry.createdAt < 0 ||
      slugs.has(entry.slug)
    )
      throw new Error("Invalid memory entry");
    slugs.add(entry.slug);
    const copy = {
      slug: entry.slug,
      body: entry.body,
      eventId: entry.eventId,
      createdAt: entry.createdAt,
    };
    bytes += new TextEncoder().encode(JSON.stringify(copy)).length;
    if (bytes > MEMORY_TEXT_BYTES)
      throw new Error("Memory listing exceeds budget");
    return Object.freeze(copy);
  });
  return Object.freeze({
    entries: Object.freeze(
      entries.sort((a, b) => a.slug.localeCompare(b.slug)),
    ),
    partial: value.partial,
  });
}

/** Each mounted consumer owns a view; session retirement revokes every view. */
export function createAgentMemories(
  read: MemoryReader | undefined,
  viewer: string,
  available: () => boolean,
  notify = (listener: () => void) => listener(),
) {
  const views = new Set<ReturnType<typeof open>>();
  let closed = false;
  function open(agent: string) {
    if (closed || views.size >= 4) throw new Error("Memory views unavailable");
    const eligible = memoryAgent(agent, viewer);
    let disposed = false;
    let controller: AbortController | undefined;
    let snapshot: MemorySnapshot = {
      status: read && eligible ? "idle" : "unavailable",
    };
    const listeners = new Set<() => void>();
    const publish = (next: MemorySnapshot) => {
      snapshot = Object.freeze(next);
      for (const listener of listeners) notify(listener);
    };
    const clear = () => {
      controller?.abort();
      controller = undefined;
      publish({
        status:
          disposed || closed || !read || !eligible ? "unavailable" : "idle",
      });
    };
    const view = {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async refresh() {
        if (disposed || closed || !read || !eligible || controller) return;
        if (!available()) {
          publish({ status: "blocked" });
          return;
        }
        const owned = new AbortController();
        controller = owned;
        publish({ status: "loading" });
        try {
          owned.signal.throwIfAborted();
          const signal = AbortSignal.any([
            owned.signal,
            AbortSignal.timeout(10000),
          ]);
          const listing = memoryListing(await read(agent, signal));
          signal.throwIfAborted();
          if (!owned.signal.aborted)
            publish(
              available()
                ? { status: "ready", listing }
                : { status: "blocked" },
            );
        } catch (error) {
          if (!owned.signal.aborted)
            publish({
              status:
                error instanceof Error && error.name === "MemoryDenied"
                  ? "denied"
                  : "error",
            });
        } finally {
          if (controller === owned) controller = undefined;
        }
      },
      clear,
      dispose() {
        disposed = true;
        clear();
        listeners.clear();
        views.delete(view);
      },
    };
    views.add(view);
    return view;
  }
  return {
    capability: Object.freeze({ open }),
    clear() {
      for (const view of views) view.clear();
    },
    dispose() {
      closed = true;
      for (const view of views) view.dispose();
    },
  };
}
