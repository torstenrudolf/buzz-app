import type { AgentEdit } from "./control";

export interface ModelRequest {
  id?: string | undefined;
  expectedRevision?: number | undefined;
  edit?: AgentEdit | undefined;
  host: string;
  filter: string;
  /** "test" checks the draft provider and model with one small completion. */
  action: "connect" | "refresh" | "disconnect" | "test";
  /** Blank host/filter come from write-only Agent defaults; native supplies them. */
  inheritWorkspace?: boolean;
}
export interface ModelCatalog {
  host: string;
  models: { id: string; name: string }[];
  modelOverridden: boolean;
  disconnected: boolean;
}
export interface ModelHost {
  begin(): Promise<number>;
  run(ticket: number, request: ModelRequest): Promise<ModelCatalog>;
  cancel(ticket: number): Promise<void>;
}
export interface AgentModels {
  request(request: ModelRequest, signal: AbortSignal): Promise<ModelCatalog>;
}

/** Separate lane from Save/Stop. A ticket handshake lets cancellation overtake
 * slow begin responses without launching stale auth work. No passive calls. */
export function createAgentModels(
  host: ModelHost | undefined,
): AgentModels & { dispose(): void } {
  const active = new Set<AbortController>();
  // Native admits one lookup and holds it until a cancelled one is dropped. A
  // replacement waits for that retirement instead of being refused as busy.
  const retiring = new Set<Promise<unknown>>();
  let disposed = false;
  return {
    async request(request, signal) {
      if (!host || disposed)
        throw new Error("Model connections require a rebuilt desktop app.");
      if (signal.aborted) throw new Error("Connection cancelled.");
      const local = new AbortController();
      active.add(local);
      let ticket: number | undefined;
      const cancel = () => local.abort();
      const retire = () => {
        if (ticket !== undefined) void host.cancel(ticket).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      local.signal.addEventListener("abort", retire, { once: true });
      let rejectCancelled: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancelled = () => reject(new Error("Connection cancelled."));
        local.signal.addEventListener("abort", rejectCancelled, { once: true });
      });
      const timer = setTimeout(cancel, 185_000);
      let running: Promise<ModelCatalog> | undefined;
      try {
        if (retiring.size) {
          await Promise.race([Promise.allSettled([...retiring]), cancelled]);
          if (local.signal.aborted || disposed)
            throw new Error("Connection cancelled.");
        }
        const begun = host.begin().then((value) => {
          ticket = value;
          if (local.signal.aborted || disposed) retire();
          return value;
        });
        local.signal.addEventListener(
          "abort",
          () => {
            const retired = begun
              .then((value): Promise<unknown> => running ?? host.cancel(value))
              .catch(() => {})
              .finally(() => retiring.delete(retired));
            retiring.add(retired);
          },
          { once: true },
        );
        ticket = await Promise.race([begun, cancelled]);
        if (local.signal.aborted || disposed) {
          await host.cancel(ticket);
          throw new Error("Connection cancelled.");
        }
        running = host.run(ticket, request);
        const result = await Promise.race([running, cancelled]);
        if (local.signal.aborted || disposed)
          throw new Error("Connection cancelled.");
        return result;
      } catch (error) {
        // Native supplies deliberately safe strings. Never surface arbitrary
        // Error contents from the transport or third-party dependencies.
        throw new Error(
          local.signal.aborted
            ? "Connection cancelled."
            : typeof error === "string"
              ? error
              : "Could not load models. Retry explicitly; your model entry is unchanged.",
        );
      } finally {
        clearTimeout(timer);
        if (rejectCancelled)
          local.signal.removeEventListener("abort", rejectCancelled);
        signal.removeEventListener("abort", cancel);
        local.signal.removeEventListener("abort", retire);
        active.delete(local);
        if (ticket !== undefined) void host.cancel(ticket).catch(() => {});
      }
    },
    dispose() {
      disposed = true;
      for (const request of active) request.abort();
      active.clear();
    },
  };
}
