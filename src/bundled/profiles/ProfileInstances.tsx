import { useEffect, useSyncExternalStore } from "react";
import styles from "./Profiles.module.css";
import { sameCommunityAgents } from "../../features/agents/choices";
import type { AgentControl } from "../../features/agents/control";
import type { PanelProps } from "../../features/panels/service";
import type { RelaySession } from "../../features/relay/session";
import { instanceTarget } from "../../features/profiles/instance-target";
import { Button } from "../../shared/design-system/ui/Button";

/** Native-managed identities only. The old library's definition links are not authority. */
export function ProfileInstances({
  control,
  context,
  session,
  canOpenPrivate = false,
  selectedId,
  pubkey,
  scope,
  communityOrigin,
  viewer,
  knownAgent,
  errorHandledByHost = false,
}: {
  control: AgentControl;
  context?: PanelProps["context"];
  session: RelaySession;
  canOpenPrivate?: boolean;
  selectedId?: string | undefined;
  pubkey: string;
  scope: string | undefined;
  communityOrigin: string | undefined;
  viewer: string | undefined;
  knownAgent: boolean;
  /** Suppress duplicate failures when the host view provides recovery for this record. */
  errorHandledByHost?: boolean;
}) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  const matches = scope
    ? sameCommunityAgents(state.data?.agents ?? [], scope).filter(
        (agent) => agent.pubkey === pubkey,
      )
    : [];
  const hasInstances = !!communityOrigin && matches.length > 0;
  useEffect(() => {
    if (hasInstances && archives.status === "idle")
      void session.archives.ensure();
  }, [session, hasInstances, archives.status]);
  useEffect(() => {
    if (communityOrigin && knownAgent && state.status === "idle")
      void control.refresh();
  }, [control, communityOrigin, knownAgent, state.status]);
  if (!communityOrigin || state.status === "unavailable") return null;
  // Suppress a duplicate only when the host can recover this exact record.
  if (
    state.status === "error" &&
    errorHandledByHost &&
    (!state.data || matches.length === 1 || !!selectedId)
  )
    return null;
  const instances = state.status === "ready" ? matches : [];
  if (!knownAgent && !instances.length) return null;
  return (
    <section aria-label="Instances" className={styles.runtime}>
      <h3 className="text-body">Instances</h3>
      {state.status === "loading" || state.status === "idle" ? (
        <p role="status">Loading managed agents…</p>
      ) : state.status === "error" ? (
        <div>
          <p role="alert">
            {errorHandledByHost
              ? "Managed agent status is unconfirmed."
              : "Could not refresh managed agents."}
          </p>
          <Button size="compact" onClick={() => void control.refresh()}>
            Retry agents
          </Button>
        </div>
      ) : !instances.length ? (
        <p>Not managed on this device.</p>
      ) : (
        <details className={styles.instancesDisclosure}>
          <summary>
            {instances.length}{" "}
            {instances.length === 1 ? "instance" : "instances"}
          </summary>
          <ul className="m-0 list-none p-0">
            {instances.map((agent) => {
              const target =
                viewer && communityOrigin
                  ? instanceTarget({
                      id: agent.id,
                      pubkey,
                      viewer,
                      communityOrigin,
                    })
                  : undefined;
              const archived =
                archives.status === "ready" &&
                archives.archived.includes(agent.pubkey);
              return (
                <li key={agent.id}>
                  {target && canOpenPrivate && context?.canOpen(target) ? (
                    <Button
                      size="compact"
                      variant="ghost"
                      aria-current={
                        selectedId === agent.id ? "true" : undefined
                      }
                      onClick={() => context.open(target)}
                    >
                      {agent.name}
                    </Button>
                  ) : (
                    agent.name
                  )}
                  {archived
                    ? " Archived"
                    : selectedId === agent.id
                      ? " Current"
                      : ""}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
