/** A display-only projection of the local and owner-authored relay inventory, not proof of
 * ownership, membership, custody or running state. No prompts/configuration. */
export type AgentLibrary = Readonly<{
  definitions: readonly Readonly<{
    id: string;
    name: string;
    avatar?: string;
  }>[];
  identities: readonly Readonly<{
    pubkey: string;
    name: string;
    avatar?: string;
    definitionId?: string;
  }>[];
}>;
export type AgentLibraryReader = (signal: AbortSignal) => Promise<AgentLibrary>;
export type AgentLibrarySnapshot = AgentLibrary &
  Readonly<{
    status: "unavailable" | "idle" | "loading" | "ready" | "error";
    error?: string;
  }>;
const empty = { definitions: Object.freeze([]), identities: Object.freeze([]) };
export function createAgentLibrary(
  read: AgentLibraryReader | undefined,
  notify = (listener: () => void) => listener(),
) {
  let closed = false;
  const demands = new Set<object>();
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let snapshot: AgentLibrarySnapshot = {
    ...empty,
    status: read ? "idle" : "unavailable",
  };
  const listeners = new Set<() => void>();
  function publish(next: AgentLibrarySnapshot) {
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  function refresh(): Promise<void> {
    if (closed || !read) return Promise.resolve();
    if (pending) return pending;
    const owned = new AbortController();
    controller = owned;
    publish({ ...snapshot, status: "loading" });
    pending = Promise.resolve()
      .then(() => {
        if (closed || owned.signal.aborted)
          throw new Error("Library read cancelled");
        return read(owned.signal);
      })
      .then((library) => {
        if (!closed && !owned.signal.aborted)
          publish({ ...library, status: "ready" });
      })
      .catch(() => {
        if (!closed && !owned.signal.aborted)
          publish({
            ...snapshot,
            status: "error",
            error:
              "Could not read agent inventory. Check the community connection and local library, then retry; saved data is unchanged.",
          });
      })
      .finally(() => {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
      });
    return pending;
  }
  function clear() {
    controller?.abort();
    controller = undefined;
    pending = undefined;
    publish({ ...empty, status: closed || !read ? "unavailable" : "idle" });
  }
  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      refresh,
      retain({ refresh: refreshOnRetain = true } = {}) {
        const demand = {};
        demands.add(demand);
        if (refreshOnRetain) void refresh();
        return () => {
          demands.delete(demand);
        };
      },
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    clear,
    reconnect() {
      // Initial establishment can follow a completed activation read. A real
      // disconnect clears this snapshot; only then is fresh inventory needed.
      if (demands.size && snapshot.status !== "ready") void refresh();
    },
    dispose() {
      closed = true;
      demands.clear();
      clear();
      listeners.clear();
    },
  };
}
