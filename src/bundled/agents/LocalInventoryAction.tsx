import { useEffect, useRef, useState } from "react";
import type {
  AgentControl,
  AgentView,
  CommunityResolution,
} from "../../features/agents/control";
import { communityRequest } from "../../features/communities/api";
import { Button } from "../../shared/design-system/ui/Button";

/** Uses retained app custody, never a legacy preview or credential import. */
export function LocalInventoryAction({
  control,
  agent,
  destination,
  owner,
  disabled,
  onPending,
  onUsed,
}: {
  control: AgentControl;
  agent?: AgentView | undefined;
  destination: string;
  owner: string;
  disabled: boolean;
  onPending(pending: boolean): void;
  onUsed(): void;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      onPending(false);
    };
  }, [onPending]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <p>
        Finish setting up this older incomplete import in this community using
        its existing key. It stays stopped.
      </p>
      {destination && <p>Destination: {destination}</p>}
      {(!destination || !owner) && (
        <p>Connect to the destination community to use this identity there.</p>
      )}
      <Button
        disabled={disabled || pending || !destination || !owner}
        onClick={async () => {
          setPending(true);
          onPending(true);
          setError(null);
          try {
            if (!control.configureHere || !agent)
              throw new Error("Use here is unavailable.");
            const resolution = await communityRequest<CommunityResolution>(
              destination,
              "resolve-agent-community",
              {
                pubkey: agent.pubkey,
                owner,
                confirmed: true,
              },
            );
            if (!active.current) return;
            await control.configureHere(agent.id, resolution);
            if (active.current) onUsed();
          } catch (reason) {
            if (active.current)
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not complete this action. Refresh and try again.",
              );
          } finally {
            if (active.current) {
              setPending(false);
              onPending(false);
            }
          }
        }}
      >
        Use here
      </Button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
