import { selectProfiles } from "../relay/profile-selection";
import { useIdentityNames } from "../identity-names/react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { useAgentOwnerEvidence } from "./useAgentOwnerEvidence";
import type { RelaySession } from "../relay/session";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { formatPublicKey } from "../../shared/identity/public-key";

/** Mounted only for an open preview; metadata is never ownership evidence. */
export function AgentOwnerPreview({
  session,
  pubkey,
}: {
  session: RelaySession;
  pubkey: string;
}) {
  const { owner, status } = useAgentOwnerEvidence(session, pubkey);
  const selection = useMemo(
    () => selectProfiles(session.profiles, owner ? [owner] : []),
    [session.profiles, owner],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const identityName = useIdentityNames(session.names);
  useEffect(() => {
    if (owner)
      void session.profiles.ensure([owner], "background").catch(() => {});
  }, [session, owner]);
  const profile = owner ? profiles.get(owner) : undefined;
  const name = owner
    ? identityName(owner, profile?.name ?? formatPublicKey(owner) ?? "Owner")
    : undefined;
  return (
    <div className="mt-3 min-w-0 border-t border-standard pt-3">
      <div className="mb-2 text-caption text-subtle">Managed by</div>
      {owner ? (
        <>
          <div className="flex items-center gap-2">
            <Avatar
              alt=""
              fallback={name ?? "Owner"}
              src={
                profile?.picture
                  ? session.media(profile.picture, "small")
                  : undefined
              }
              size="small"
              shape="circle"
            />
            <span className="text-body-sm wrap-anywhere">
              {name}
              {owner === session.viewer ? " (you)" : ""}
            </span>
          </div>
          <div className="mt-1 text-mono-sm break-all text-subtle">
            {npubEncode(owner)}
          </div>
        </>
      ) : (
        <div className="text-body-sm text-subtle">
          {status === "loading" ? "Checking ownership…" : "Owner unavailable"}
        </div>
      )}
    </div>
  );
}
