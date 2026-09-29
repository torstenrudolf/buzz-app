import { createPortal } from "react-dom";
import { useIdentityNames } from "../../features/identity-names/react";
import { useEffect, useSyncExternalStore } from "react";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons/index";
import { identityTiles, identityGroups } from "./identity-tiles";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard } from "./AgentCard";

export function AgentLibrary({
  session,
  headerActions,
  managedKeys = [],
}: {
  session: RelaySession;
  headerActions: HTMLElement | null;
  managedKeys?: readonly string[];
}) {
  const resolveName = useIdentityNames(session.names);
  const library = session.agentLibrary;
  const archives = session.archives;
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  const archive = useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  const refresh = () => {
    void library.refresh();
    void archives.refresh();
  };
  useEffect(() => {
    void library.refresh();
    void archives.refresh();
  }, [library, archives]);
  const { identities, profiles } = identityTiles(
    snapshot,
    (key) => managedKeys.includes(key) || archives.state(key) === "archived",
  );
  const candidates = identities.map((identity) => identity.pubkey);
  const identityLabel = (identity: { pubkey: string; name: string }) =>
    resolveName(identity.pubkey, identity.name, candidates);
  const groups = identityGroups(snapshot.definitions, identities);
  for (const group of groups) {
    group.identities.sort(
      (a, b) =>
        identityLabel(a).localeCompare(identityLabel(b), undefined, {
          sensitivity: "base",
        }) || a.pubkey.localeCompare(b.pubkey),
    );
  }
  profiles.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  const loading = snapshot.status === "loading";
  return (
    <div className="mx-auto mt-2 max-w-6xl space-y-section-gap">
      {headerActions &&
        createPortal(
          <Button
            variant="quiet"
            size="compact"
            disabled={loading || snapshot.status === "unavailable"}
            onClick={refresh}
          >
            <ArrowsClockwiseIcon size={16} aria-hidden="true" />
            {snapshot.status === "error" ? "Retry" : "Refresh agents"}
          </Button>,
          headerActions,
        )}
      {loading && (
        <p className="text-body" role="status">
          Reading agent inventory…
        </p>
      )}
      {snapshot.status === "idle" && (
        <p className="text-body" role="status">
          Library cleared. Refresh to read it again.
        </p>
      )}
      {snapshot.status === "unavailable" && (
        <p className="text-body" role="status">
          Connect to a community to discover agent identities. The local library
          also requires a supported host.
        </p>
      )}
      {snapshot.error && (
        <p className="text-body" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.status === "ready" && (
        <>
          <section
            aria-label="Library identities"
            className="flex flex-col gap-4"
          >
            <h2 className="m-0 flex items-center gap-2 text-heading">
              Library identities
              <span className="rounded-md bg-surface-inset px-2 py-0.5 text-body-sm font-normal text-secondary">
                {identities.length}
              </span>
            </h2>
            {!identities.length && (
              <p>No visible identities in your Buzz library.</p>
            )}
            {groups.map((group) => (
              <section
                key={group.id ?? "unlinked"}
                aria-label={group.name}
                className="flex flex-col gap-3"
              >
                <h3 className="m-0 text-label text-secondary">{group.name}</h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                  {group.identities.map((identity) => (
                    <AgentCard
                      key={identity.pubkey}
                      name={identityLabel(identity)}
                      avatar={identity.avatar}
                      identities={[identity]}
                      session={session}
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>
          {!!profiles.length && (
            <section
              aria-label="Profiles without identities"
              className="flex flex-col gap-4"
            >
              <h2 className="m-0 text-heading">Profiles without identities</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {profiles.map((profile) => (
                  <AgentCard
                    key={profile.id}
                    name={profile.name}
                    avatar={profile.avatar}
                    identities={[]}
                    session={session}
                    identityLabel={identityLabel}
                  />
                ))}
              </div>
            </section>
          )}
          {archive.status !== "ready" && (
            <p className="text-body text-secondary">
              Archive visibility is unknown. Library entries remain visible;
              this does not grant channel access.
            </p>
          )}
          <p className="border-t border-primary pt-4 text-body-sm text-secondary">
            This inventory is read-only. Discovery does not prove local key
            custody, community membership or running status. Local import
            remains a separate operation and does not start an agent.
          </p>
        </>
      )}
    </div>
  );
}
