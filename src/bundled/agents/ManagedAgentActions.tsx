import { useEffect, useRef, useState } from "react";
import {
  agentFailureReason,
  canStopAgent,
  agentLaunchBlock,
  type AgentControl,
  type AgentControlState,
  type AgentView,
} from "../../features/agents/control";
import { LocalInventoryAction } from "./LocalInventoryAction";
import { Button } from "../../shared/design-system/ui/Button";
import { agentProcessLabel } from "./agent-edit";

export function ManagedAgentActions({
  agent,
  state,
  control,
  imported,
  destination = "",
  owner = "",
  onUseHere,
}: {
  agent: AgentView;
  state: AgentControlState;
  control: AgentControl;
  imported: boolean;
  destination?: string;
  owner?: string;
  onUseHere?: ((pubkey: string) => void) | undefined;
}) {
  const [settingUp, setSettingUp] = useState(false);
  const details = useRef<HTMLDivElement>(null);
  const [checking, setChecking] = useState(false);
  // Describes one refreshed status; any later status change supersedes it.
  const [notice, setNotice] = useState<{
    text: string;
    status: AgentView["status"];
  } | null>(null);
  // Retire on an observed transition away from the notice's status, from any
  // surface (editor, mention start), so returning to it cannot revive the notice.
  const [observed, setObserved] = useState(agent.status);
  if (observed !== agent.status) {
    setObserved(agent.status);
    if (notice && notice.status !== agent.status) setNotice(null);
  }
  useEffect(() => {
    if (imported) {
      details.current?.scrollIntoView?.({ block: "nearest" });
      details.current?.focus();
    }
  }, [imported]);
  const startBlock = agentLaunchBlock(state, agent);
  const act = (action: "start" | "stop") => {
    setNotice(null);
    void control.action(agent.id, action).catch(async (problem: unknown) => {
      setChecking(true);
      await control.refresh();
      setChecking(false);
      const refreshed = control.snapshot();
      const current = refreshed.data?.agents.find(
        (item) => item.id === agent.id,
      );
      // A recorded agent error already explains the outcome on this card.
      if (!current || current.error) return;
      if (
        action === "start"
          ? current.status === "running"
          : current.status === "stopped" && !current.enabled
      )
        return;
      const reason = agentFailureReason(problem);
      setNotice({
        status: current.status,
        text:
          refreshed.status === "ready"
            ? `The agent didn't ${action}.${reason && ` ${reason}`} Try again.`
            : `We couldn't confirm whether the agent ${action === "start" ? "started" : "stopped"}. Refresh status before trying again.`,
      });
    });
  };
  return (
    <div ref={details} tabIndex={-1} className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <p className="m-0 break-all text-body-sm text-secondary">
          {agent.relayUrl}
        </p>
        <p className="m-0 text-body-sm">
          {state.status === "error" && "Last known: "}
          {agentProcessLabel(agent)}
        </p>
      </div>
      {imported && !agent.enabled && (
        <p role="status" className="m-0 text-body-sm">
          Imported, not started.{" "}
          {agent.configured === false
            ? "Choose Use here to set up this identity in a community."
            : "Start it when you are ready."}
        </p>
      )}
      {agent.configured === false &&
        (onUseHere ? (
          <Button
            disabled={state.busy || state.status !== "ready"}
            onClick={() => onUseHere(agent.pubkey)}
          >
            Use here
          </Button>
        ) : state.data?.localInventoryActions && control.configureHere ? (
          <LocalInventoryAction
            control={control}
            agent={agent}
            destination={destination}
            owner={owner}
            disabled={state.busy || state.status !== "ready"}
            onPending={setSettingUp}
            onUsed={() => {}}
          />
        ) : (
          <p>Update the desktop app to set up this imported identity.</p>
        ))}
      {agent.startOnAppLaunch && (
        <p className="m-0 text-body-sm text-secondary">Starts with this app.</p>
      )}
      {agent.error && (
        <p role="alert" className="m-0 break-words text-body-sm">
          {agent.error}
        </p>
      )}
      {checking && <p role="status">Checking agent status…</p>}
      {!checking && notice?.status === agent.status && !agent.error && (
        <p role="alert">{notice.text}</p>
      )}
      {agent.profilePending && (
        <div className="space-y-2">
          <p role="status" className="m-0 text-body-sm">
            Settings saved. Profile publication is pending.
          </p>
          <Button
            disabled={
              state.busy || state.status !== "ready" || !control.publishProfile
            }
            onClick={() =>
              void control.publishProfile?.(agent.id).catch(() => {})
            }
          >
            Retry profile
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {(agent.status === "stopped" || agent.status === "failed") && (
          <Button
            variant="primary"
            size="compact"
            disabled={!!startBlock || settingUp}
            onClick={() => act("start")}
          >
            {agent.status === "failed" ? "Retry start" : "Start"}
          </Button>
        )}
        <Button
          size="compact"
          disabled={!canStopAgent(state, agent.id)}
          onClick={() => act("stop")}
        >
          Stop
        </Button>
      </div>
      {startBlock && agent.status !== "running" && (
        <p className="m-0 text-body-sm text-secondary">{startBlock}</p>
      )}
    </div>
  );
}
