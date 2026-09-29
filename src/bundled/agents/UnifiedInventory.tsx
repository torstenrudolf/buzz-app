import { InventoryView } from "./InventoryView";
import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
  ImportSource,
} from "../../features/agents/control";
import { relayOrigin } from "../../features/communities/destination";
import { useIdentityNames } from "../../features/identity-names/react";
import type { RelaySnapshot } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";
import { inventoryIdentities, localSetups } from "./inventory-model";
import { identityTiles } from "./identity-tiles";

/** Discovery, saved metadata and execution are facts of one exact public key. */
export function UnifiedInventory({
  state,
  control,
  connection,
  edit,
  duplicate,
  remove,
  importedId,
  onUseHere,
  onImport,
}: {
  state: AgentControlState;
  control: AgentControl;
  connection: RelaySnapshot;
  edit(agent: AgentView, avatar?: string): void;
  duplicate?: ((agent: AgentView) => void) | undefined;
  remove?: ((agent: AgentView) => void) | undefined;
  importedId: string | null;
  onUseHere(pubkey: string): void;
  onImport(pubkey: string, source?: ImportSource): void;
}) {
  const { agentLibrary: library, archives, profiles } = connection.session;
  const publicProfiles = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  );
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  const resolveName = useIdentityNames(connection.session.names);
  useEffect(() => {
    if (connection.status === "ready") {
      void library.refresh();
      void archives.refresh();
    }
  }, [library, archives, connection.status]);
  const destination =
    connection.viewer && connection.scope?.endsWith(`:${connection.viewer}`)
      ? relayOrigin(connection.scope.slice(0, -(connection.viewer.length + 1)))
      : "";
  const data = state.data;
  if (!data) return null;
  const discovered = identityTiles(snapshot, () => false);
  const rows = inventoryIdentities(
    connection.status === "ready" ? discovered.identities : [],
    data,
    (_key, fallback) => fallback,
  );
  // Apply archive evidence after all discovery sources join. Keep local controls.
  for (const row of rows.values()) {
    if (archives.state(row.pubkey) === "archived" && !row.localIdentity)
      rows.delete(row.pubkey);
  }
  const candidates = [...rows.keys()];
  const displayFacts = [...rows.values()].map((row) => ({
    pubkey: row.pubkey,
    name:
      (localSetups(row, destination)[0] ?? row.unconfiguredSetups[0])?.name ??
      row.displayName,
    isAgent: true,
  }));
  for (const fact of displayFacts) {
    const row = rows.get(fact.pubkey);
    if (row)
      row.displayName = resolveName(
        fact.pubkey,
        fact.name,
        candidates,
        displayFacts,
      );
  }
  return (
    <InventoryView
      state={state}
      control={control}
      session={connection.session}
      destination={destination}
      rows={rows}
      profiles={connection.status === "ready" ? discovered.profiles : []}
      publicProfiles={publicProfiles}
      edit={edit}
      duplicate={duplicate}
      remove={remove}
      importedId={importedId}
      onUseHere={onUseHere}
      onImport={onImport}
    >
      {data.inventoryWarnings?.map((warning) => (
        <p key={warning} role="alert">
          {warning} Retry local discovery by reopening the app.
        </p>
      ))}
      {connection.status === "ready" && (
        <div className="self-start">
          <Button
            disabled={snapshot.status === "loading"}
            onClick={() => {
              void library.refresh();
              void archives.refresh();
            }}
          >
            Refresh agents
          </Button>
        </div>
      )}
      {snapshot.error && connection.status === "ready" && (
        <p role="alert">{snapshot.error}</p>
      )}
    </InventoryView>
  );
}
