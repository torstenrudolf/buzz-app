import { useAgentOwnerEvidence } from "../../features/profiles/useAgentOwnerEvidence";
import { useState } from "react";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { AgentControl } from "../../features/agents/control";
import {
  useAgentControl,
  useAgentControlRefresh,
} from "../../features/agents/control-react";
import type { Navigation } from "../../features/navigation/controller";
import type { PanelProps } from "../../features/panels/service";
import {
  exactProfileAgent,
  type InstanceTarget,
} from "../../features/profiles/instance-target";
import { profileTarget } from "../../features/profiles/target";
import { Button } from "../../shared/design-system/ui/Button";
import { ProfilePanel } from "./ProfilePanel";

/** Host retains the exact target and owns replacement, close and focus restoration.
 * No native/private content mounts before exact scope and verified owner match. */
export function InstanceProfilePanel(
  props: PanelProps & {
    instance: InstanceTarget;
    relay: RelayData;
    control: AgentControl;
    navigation?: Navigation;
  },
) {
  const [attempt, retry] = useState(0);
  const connection = useRelayConnection(props.relay);
  const { instance } = props;
  const valid =
    connection.status === "ready" &&
    connection.viewer === instance.viewer &&
    connection.scope === `${instance.communityOrigin}:${instance.viewer}`;
  return valid ? (
    <InstanceDetails
      key={`${connection.scope}:${connection.generation}:${props.target}:${attempt}`}
      retry={() => retry((value) => value + 1)}
      {...props}
    />
  ) : (
    <p role="alert">Unavailable</p>
  );
}
function InstanceDetails(
  props: PanelProps & {
    retry(): void;
    instance: InstanceTarget;
    relay: RelayData;
    control: AgentControl;
    navigation?: Navigation;
  },
) {
  const connection = useRelayConnection(props.relay);
  const ownership = useAgentOwnerEvidence(
    connection.session,
    props.instance.pubkey,
  );
  useAgentControlRefresh(props.control);
  const state = useAgentControl(props.control);
  const target = profileTarget(props.instance.pubkey) ?? "";
  const agent = connection.scope
    ? exactProfileAgent(
        state.data?.agents ?? [],
        connection.scope,
        props.instance.pubkey,
        props.instance.id,
      )
    : undefined;
  const loading =
    ownership.status === "loading" ||
    state.status === "loading" ||
    state.status === "idle";
  return (
    <>
      {props.context?.canOpen(target) && (
        <Button
          size="compact"
          variant="ghost"
          onClick={() => props.context?.open(target)}
        >
          Back to profile
        </Button>
      )}
      {ownership.status === "ready" &&
      ownership.owner === connection.viewer &&
      agent ? (
        <ProfilePanel
          {...props}
          target={target}
          instanceId={agent.id}
          refreshControl={false}
        />
      ) : (
        <>
          <p role={loading ? "status" : "alert"}>
            {loading ? "Loading…" : "Unavailable"}
          </p>
          {!loading && (
            <Button
              size="compact"
              disabled={state.busy}
              onClick={() => {
                void props.control.refresh();
                props.retry();
              }}
            >
              Retry
            </Button>
          )}
        </>
      )}
    </>
  );
}
