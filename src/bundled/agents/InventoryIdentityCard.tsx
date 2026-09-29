import { npubEncode } from "nostr-tools/nip19";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
  ImportSource,
} from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import type { Profile } from "../../features/relay/contracts";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard } from "./AgentCard";
import { agentSetupConfirmationAvailable } from "../../features/communities/api";
import { agentSetupUnavailableMessage } from "./LocalInventoryAction";
import { ManagedAgentActions } from "./ManagedAgentActions";
import { localHereGroup, type inventoryDecision } from "./inventory-decisions";
import { type AgentInventoryIdentity, localSetups } from "./inventory-model";

/** One complete inventory identity; source selection belongs to the enclosing inventory. */
export function InventoryIdentityCard({
  row,
  decision,
  state,
  control,
  session,
  destination,
  publicProfiles,
  edit,
  duplicate,
  remove,
  importedId,
  onUseHere,
  onImport,
  selectedSource,
  onSourceChange,
}: {
  row: AgentInventoryIdentity;
  decision: ReturnType<typeof inventoryDecision>;
  state: AgentControlState;
  control: AgentControl;
  session: RelaySession;
  destination: string;
  publicProfiles: ReadonlyMap<string, Profile>;
  edit(agent: AgentView, avatar?: string): void;
  duplicate?: ((agent: AgentView) => void) | undefined;
  remove?: ((agent: AgentView) => void) | undefined;
  importedId: string | null;
  onUseHere(pubkey: string): void;
  onImport(pubkey: string, source?: ImportSource): void;
  selectedSource: ImportSource | undefined;
  onSourceChange(source: ImportSource): void;
}) {
  const data = state.data;
  if (!data) return null;
  const avatar = row.avatar ?? publicProfiles.get(row.pubkey)?.picture;
  const tile = decision.group === localHereGroup;
  const setupAvailable = agentSetupConfirmationAvailable();
  // The app runs every saved setup, so each keeps its controls whether or not
  // its community is the one currently selected or connected.
  const setups = localSetups(row, destination);
  const selected = selectedSource;
  const source =
    row.oldBuzzSources.length === 1
      ? row.oldBuzzSources[0]
      : selected && row.oldBuzzSources.includes(selected)
        ? selected
        : undefined;
  const needsSource = !row.localIdentity && row.oldBuzzSources.length > 1;
  return (
    <AgentCard
      name={row.displayName}
      avatar={avatar}
      identities={[{ pubkey: row.pubkey, name: row.displayName }]}
      session={session}
      editable={setups}
      onEdit={setups.length ? edit : undefined}
      onDuplicate={setups.length ? duplicate : undefined}
      onDelete={setups.length ? remove : undefined}
    >
      {setups.map((agent) => (
        <ManagedAgentActions
          key={agent.id}
          agent={agent}
          state={state}
          control={control}
          imported={agent.id === importedId}
        />
      ))}
      {row.unconfiguredSetups.map((agent) => (
        <p key={agent.id} role="status" className="m-0 break-all text-body-sm">
          Earlier import needs setup: {agent.relayUrl || "No saved community"}.
          Connect to the intended community and choose Use here. It stays
          stopped.
        </p>
      ))}
      <div
        className={
          tile ? "flex min-w-0 flex-wrap items-center gap-2" : "contents"
        }
      >
        {needsSource && (
          <label className="agent-control-field">
            <span className="sr-only">Old Buzz installation</span>
            <select
              value={source ?? ""}
              disabled={state.busy || state.status !== "ready"}
              onChange={(event) => {
                const next = event.target.value as ImportSource;
                onSourceChange(next);
              }}
            >
              <option value="" disabled>
                Choose an installation
              </option>
              {row.oldBuzzSources.map((value) => (
                <option key={value} value={value}>
                  {value === "installed"
                    ? "Installed Buzz"
                    : "Development Buzz"}
                </option>
              ))}
            </select>
          </label>
        )}
        {decision.action === "import" && (
          <Button
            variant="primary"
            size="compact"
            title="Bring this agent into this app with its existing identity and key. It stays stopped in your chosen community until you start it."
            disabled={
              state.busy ||
              state.status !== "ready" ||
              data.importAvailable === false ||
              (needsSource && !source)
            }
            onClick={() => onImport(row.pubkey, source)}
          >
            Import
          </Button>
        )}
        {decision.action === "use" && (
          <>
            <Button
              size="compact"
              disabled={
                state.busy ||
                state.status !== "ready" ||
                !!decision.blocked ||
                !data.localInventoryActions ||
                !control.configureHere ||
                !setupAvailable
              }
              onClick={() => onUseHere(row.pubkey)}
            >
              Use here
            </Button>
            {decision.blocked && <p role="status">{decision.blocked}</p>}
            {!data.localInventoryActions ? (
              <p>
                Restart an updated desktop build to use local inventory actions.
              </p>
            ) : (
              !setupAvailable && <p>{agentSetupUnavailableMessage}</p>
            )}
          </>
        )}
      </div>
      {decision.action === "wait" && (
        <p role="status" className="m-0 text-body-sm text-secondary">
          {decision.blocked}
        </p>
      )}
      <details className="min-w-0 text-body-sm text-secondary">
        <summary className="cursor-pointer">Identity &amp; sources</summary>
        <div className="flex min-w-0 flex-col gap-2 pt-2">
          {[...row.knownCommunities]
            .filter((community) => community && !row.localSetups.has(community))
            .map((community) => (
              <p key={community} className="m-0 break-all">
                {community}
              </p>
            ))}
          {row.oldBuzzSources.length > 0 && (
            <p className="m-0">
              {row.oldBuzzSources
                .map((source) =>
                  source === "installed"
                    ? "Installed Buzz"
                    : "Development Buzz",
                )
                .join(" · ")}
            </p>
          )}
          <p
            className="m-0 select-all break-all text-mono-sm"
            data-public-key=""
          >
            {npubEncode(row.pubkey)}
          </p>
        </div>
      </details>
    </AgentCard>
  );
}
