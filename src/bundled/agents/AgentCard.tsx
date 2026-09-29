import { npubEncode } from "nostr-tools/nip19";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuNote,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { DotsThreeIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import { Button } from "../../shared/design-system/ui/Button";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";
import { avatarSource } from "../../shared/avatar-source";
import { usePresenceStatus } from "../../features/presence/react";
import type { AgentLibrary } from "../../features/agents/library";
import type { AgentView } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";

export function AgentCard({
  name,
  avatar,
  identities,
  session,
  editable = [],
  onEdit,
  onDuplicate,
  onDelete,
  children,
  identityLabel = (identity) => identity.name,
}: {
  children?: ReactNode;
  identityLabel?: (identity: { pubkey: string; name: string }) => string;
  name: string;
  avatar?: string | undefined;
  identities: AgentLibrary["identities"];
  session?: RelaySession;
  editable?: AgentView[];
  onEdit?: ((agent: AgentView, avatar?: string) => void) | undefined;
  onDuplicate?: ((agent: AgentView) => void) | undefined;
  onDelete?: ((agent: AgentView) => void) | undefined;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const presence = usePresenceStatus(
    session?.presence,
    identities.length === 1 ? identities[0]?.pubkey : undefined,
  );
  const managed = editable.length === 1 ? editable[0] : undefined;
  const status = managed?.status;
  const settled =
    status === "running" ? presence === "online" : presence !== "online";
  useEffect(() => {
    const owner = session?.presence;
    if (
      !owner ||
      !status ||
      status === "waiting" ||
      status === "starting" ||
      settled
    )
      return;
    // The harness publishes presence just after native start/stop confirms,
    // so one read can race it. Re-read at the owner's gate, then resume its
    // normal cadence even if relay evidence never agrees.
    owner.refresh();
    let checks = 0;
    const timer = setInterval(() => {
      owner.refresh();
      if (++checks === 6) clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [session?.presence, status, settled]);
  const source = avatarSource(managed?.picture ?? avatar);
  const managedPicture = useAvatarPreview(
    managed?.picture ?? "",
    managed?.relayUrl,
  );
  const picture =
    managed?.picture != null
      ? managedPicture
      : source?.startsWith("data:")
        ? source
        : source
          ? session?.media(source, "small")
          : undefined;
  return (
    <article
      aria-label={`Agent ${name}`}
      className={`relative flex min-w-0 flex-col gap-4 rounded-2xl border border-primary ${children ? "p-4" : "px-4 py-8"}`}
    >
      {onEdit && (
        <div className="absolute right-2 top-2">
          <MenuRoot>
            <MenuTrigger
              ref={trigger}
              render={
                <IconButton
                  aria-label={`Actions for ${name}`}
                  size="compact"
                  icon={<DotsThreeIcon size={18} aria-hidden="true" />}
                />
              }
            />
            <MenuPopup align="end" size="wide">
              {editable.length ? (
                editable.map((agent) => (
                  <Fragment key={agent.id}>
                    <MenuItem
                      onClick={() => {
                        // The menu item unmounts; return from the dialog to the card.
                        trigger.current?.focus();
                        onEdit(agent, source);
                      }}
                    >
                      {editable.length === 1 ? (
                        "Edit"
                      ) : (
                        <ChoiceRow
                          label={`Edit ${identityLabel(agent)}`}
                          description={
                            <>
                              <span className="block break-all text-body-sm text-secondary">
                                {agent.relayUrl}
                              </span>
                              <span className="block break-all text-mono-sm text-secondary">
                                {npubEncode(agent.pubkey)}
                              </span>
                            </>
                          }
                        />
                      )}
                    </MenuItem>
                    {onDuplicate && (
                      <MenuItem
                        onClick={() => {
                          trigger.current?.focus();
                          onDuplicate(agent);
                        }}
                      >
                        {editable.length === 1
                          ? "Duplicate"
                          : `Duplicate ${identityLabel(agent)}`}
                      </MenuItem>
                    )}
                    {onDelete && (
                      <>
                        <MenuSeparator />
                        <MenuItem
                          tone="danger"
                          onClick={() => {
                            trigger.current?.focus();
                            onDelete(agent);
                          }}
                        >
                          {editable.length === 1
                            ? "Delete"
                            : `Delete ${identityLabel(agent)}`}
                        </MenuItem>
                      </>
                    )}
                  </Fragment>
                ))
              ) : (
                <>
                  <MenuItem disabled>Edit</MenuItem>
                  <MenuNote>
                    {identities.length
                      ? "Import this identity to edit in Foundation."
                      : "No linked identity to edit."}
                  </MenuNote>
                </>
              )}
            </MenuPopup>
          </MenuRoot>
        </div>
      )}
      <div
        className={
          children
            ? `flex min-w-0 items-center gap-3 ${onEdit ? "pr-6" : ""}`
            : "flex flex-col items-center gap-6 text-center"
        }
      >
        <div className={children ? "shrink-0" : "size-20 shrink-0"}>
          <AgentAvatar
            session={session}
            agentPubkey={
              identities.length === 1 ? identities[0]?.pubkey : undefined
            }
            alt={name}
            fallback={name}
            src={picture ?? null}
            size={children ? "large" : "fill"}
            shape="squircle"
            statusBadge={presence === "unknown" ? undefined : presence}
          />
        </div>
        <h3 className="m-0 min-w-0 max-w-full truncate text-label" title={name}>
          {name}
        </h3>
      </div>
      {children && (
        <div className="flex min-w-0 flex-col gap-3">{children}</div>
      )}
      {identities.length && !children ? (
        <div className="-mt-3 flex justify-center">
          <PopoverRoot>
            <PopoverTrigger
              render={
                <Button
                  variant="link"
                  size="xs"
                  aria-label={`${name}: public key`}
                >
                  <span className="text-caption text-subtle underline underline-offset-4">
                    Public key
                  </span>
                </Button>
              }
            />
            <PopoverPopup align="center">
              <PopoverTitle>{name} public key</PopoverTitle>
              <ul className="m-0 mt-3 list-none space-y-3 p-0">
                {identities.map((identity) => (
                  <li key={identity.pubkey}>
                    <p className="m-0 select-all break-all text-mono-sm text-subtle">
                      {npubEncode(identity.pubkey)}
                    </p>
                  </li>
                ))}
              </ul>
            </PopoverPopup>
          </PopoverRoot>
        </div>
      ) : !children ? (
        <p className="m-0 -mt-3 text-center text-caption text-subtle">
          No linked identity
        </p>
      ) : null}
    </article>
  );
}
