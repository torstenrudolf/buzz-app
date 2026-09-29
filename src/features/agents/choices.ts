import type { AgentControl, AgentView } from "./control";
import type { AgentLibrarySnapshot, createAgentLibrary } from "./library";
import type { ChannelList } from "../relay/contracts";
import { relayOrigin } from "../communities/destination";

/** Community evidence, not process readiness or permission to grant access. */
export function sameCommunityAgents(
  agents: readonly AgentView[],
  scope: string,
) {
  const viewer = scope.slice(-64);
  if (!/^[0-9a-f]{64}$/.test(viewer)) return [];
  return agents.filter((agent) => {
    try {
      return (
        agent.configured !== false &&
        `${relayOrigin(agent.relayUrl)}:${viewer}` === scope
      );
    } catch {
      return false;
    }
  });
}

type Choice = AgentLibrarySnapshot["identities"][number] & {
  managed: boolean;
  managedName?: string;
};
type SelectionSource = boolean | "templates";
type TemplateChoices = Pick<AgentLibrarySnapshot, "status" | "error"> & {
  identities: readonly Choice[];
  complete: boolean;
  pending: boolean;
};
export type AgentChoicesSnapshot = Omit<AgentLibrarySnapshot, "identities"> & {
  identities: readonly Choice[];
  /** Templates mirror Agents, including source readiness and errors. */
  templates: TemplateChoices;
  /** Usable candidates do not imply complete evidence for automatic recipients. */
  complete: boolean;
  pending: boolean;
};

/** One read-only projection of existing sources. No directory scan, timer, runner
 * or write authority. The relay session owns its lifetime; native owns processes. */
export function createAgentChoices({
  scope,
  library,
  native,
  signal,
}: {
  scope: string;
  library: ReturnType<typeof createAgentLibrary>["queries"];
  native?: Pick<AgentControl, "snapshot" | "subscribe" | "refresh"> | undefined;
  signal: AbortSignal;
}) {
  const empty: AgentChoicesSnapshot = {
    status: "unavailable",
    templates: {
      status: "unavailable",
      identities: [],
      complete: false,
      pending: false,
    },
    definitions: [],
    identities: [],
    complete: false,
    pending: false,
  };
  let cached:
    | {
        legacy: AgentLibrarySnapshot;
        local: ReturnType<AgentControl["snapshot"]> | undefined;
        value: AgentChoicesSnapshot;
      }
    | undefined;
  const snapshot = (): AgentChoicesSnapshot => {
    if (signal.aborted) return empty;
    const legacy = library.snapshot(),
      local = native?.snapshot();
    if (cached?.legacy === legacy && cached.local === local)
      return cached.value;
    const choices = new Map<string, Choice>();
    if (legacy.status === "ready")
      for (const row of legacy.identities)
        choices.set(row.pubkey, { ...row, managed: false });
    if (local?.status === "ready")
      for (const row of sameCommunityAgents(local.data?.agents ?? [], scope)) {
        // Keep existing source names in serialized mentions; the shared name
        // resolver supplies native display labels independently.
        choices.set(row.pubkey, {
          pubkey: row.pubkey,
          name: row.name,
          ...choices.get(row.pubkey),
          ...(row.picture == null ? {} : { avatar: row.picture }),
          managed: true,
          managedName: row.name,
        });
      }
    const ready = legacy.status === "ready" || local?.status === "ready";
    const errors = [
      legacy.error,
      local?.status === "error" ? local.error : undefined,
    ].filter(Boolean);
    const templateSource =
      !local || local.status === "unavailable" ? legacy : local;
    const templates: TemplateChoices = {
      status: templateSource.status,
      identities: [...choices.values()]
        .filter((agent) => templateSource === legacy || agent.managed)
        .map((agent) => ({ ...agent, name: agent.managedName ?? agent.name })),
      complete: templateSource.status === "ready" && !templateSource.error,
      pending:
        templateSource.status === "idle" || templateSource.status === "loading",
      ...(templateSource.error ? { error: templateSource.error } : {}),
    };
    const value: AgentChoicesSnapshot = {
      templates,
      status: ready
        ? "ready"
        : errors.length
          ? "error"
          : legacy.status === "loading" || local?.status === "loading"
            ? "loading"
            : legacy.status === "idle" || local?.status === "idle"
              ? "idle"
              : "unavailable",
      pending:
        legacy.status === "idle" ||
        legacy.status === "loading" ||
        local?.status === "idle" ||
        local?.status === "loading",
      complete:
        legacy.status === "ready" &&
        !legacy.error &&
        (!local || local.status === "ready" || local.status === "unavailable"),
      definitions: legacy.status === "ready" ? legacy.definitions : [],
      identities: [...choices.values()],
      ...(errors.length ? { error: errors.join(" ") } : {}),
    };
    cached = { legacy, local, value };
    return value;
  };
  const usesLegacy = (source: SelectionSource) =>
    source === "templates"
      ? !native || native.snapshot().status === "unavailable"
      : source;
  return Object.freeze({
    snapshot,
    subscribe(listener: () => void) {
      if (signal.aborted) return () => {};
      const stopLibrary = library.subscribe(listener),
        stopNative = native?.subscribe(listener);
      const stop = () => {
        stopLibrary();
        stopNative?.();
        signal.removeEventListener("abort", retired);
      };
      const retired = () => {
        stop();
        listener();
      };
      signal.addEventListener("abort", retired, { once: true });
      return stop;
    },
    ensure(includeLegacy = true) {
      if (signal.aborted) return;
      if (includeLegacy && library.snapshot().status === "idle")
        void library.refresh();
      if (native?.snapshot().status === "idle") void native.refresh();
    },
    async refresh(source: SelectionSource = true) {
      if (signal.aborted) return;
      await Promise.all([
        usesLegacy(source) ? library.refresh() : undefined,
        native?.refresh(),
      ]);
    },
    retain() {
      if (signal.aborted) return () => {};
      // Demand survives reconnect; ensure/explicit Refresh owns reads. A fresh
      // completion mount must not replace ready evidence with loading state.
      return library.retain({ refresh: false });
    },
  });
}

/** Match the Agents page's source, retaining community and archive policy at the
 * action boundary. Never substitute old-library identities during a native error. */
export function templateAgentChoices(
  agents: AgentChoicesSnapshot,
  channels: ChannelList,
) {
  const members = new Set(
    channels.status === "ready"
      ? channels.channels.flatMap((c) => c.members ?? [])
      : [],
  );
  return agents.templates.identities.filter(
    (agent) => agent.managed || members.has(agent.pubkey),
  );
}
