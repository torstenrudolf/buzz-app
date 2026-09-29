import { formatPublicKey } from "../../shared/identity/public-key";
import { usePresenceStatus } from "../../features/presence/react";
import { useRelayConnection } from "../../features/relay/react";
import { avatarSource } from "../../shared/avatar-source";
import { useUserStatus } from "../../features/user-status/useUserStatus";
import { useStatusEditor } from "../../features/user-status/useStatusEditor";
import { StatusEmoji } from "../../features/user-status/StatusEmoji";
import { Button } from "../../shared/design-system/ui/Button";
import { StatusEditor } from "../../features/user-status/StatusEditor";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CircleNotchIcon,
  SmileyIcon,
  CheckIcon,
  GearIcon,
  UserIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuItem,
  MenuIcon,
  MenuSeparator,
  MenuTrailing,
} from "../../shared/design-system/ui/Menu";
import type {
  AccountActionsService,
  RegisteredAccountAction,
} from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import styles from "./ProfileButton.module.css";

const noSubscription = () => () => {};
const noLiveSnapshot = () => undefined;

export function ProfileButton({
  communities,
  accountActions,
  settingsSelected,
  onSettings,
  onProfile,
}: {
  communities: Communities;
  accountActions: AccountActionsService;
  settingsSelected: boolean;
  onSettings(): void;
  /** Present only while a panel can show the viewer's own profile. */
  onProfile?: ((trigger: HTMLButtonElement) => void) | undefined;
}) {
  const {
    profile: localProfile,
    viewer,
    selected,
  } = useSyncExternalStore(communities.subscribe, communities.snapshot);
  const presence = useSyncExternalStore(
    communities.presence.subscribe,
    communities.presence.snapshot,
  );
  const connection = useRelayConnection(communities.relay);
  const session = connection.session;
  const observed = usePresenceStatus(
    selected && connection.viewer === viewer ? session?.presence : undefined,
    viewer ?? undefined,
  );
  const label = {
    online: "Online",
    away: "Away",
    offline: "Offline",
    unknown: "Status unavailable",
  }[observed];
  const [statusChange, setStatusChange] = useState<{
    target: "online" | "away" | "offline";
    session: typeof session;
    viewer: typeof viewer;
    community: typeof selected;
    failed?: boolean;
  }>();
  const currentChange =
    statusChange?.session === session &&
    statusChange?.viewer === viewer &&
    statusChange?.community === selected
      ? statusChange
      : undefined;
  const pending =
    currentChange && !currentChange.failed && observed !== currentChange.target;
  useEffect(() => {
    if (!statusChange) return;
    if (!currentChange || observed === currentChange.target)
      setStatusChange(undefined);
  }, [statusChange, currentChange, observed]);
  useEffect(() => {
    if (!statusChange || statusChange.failed) return;
    // One deadline per click; intermediate observations must not extend it.
    // This is confirmation feedback, not a publication retry or optimistic evidence.
    const timer = setTimeout(() => {
      setStatusChange((current) =>
        current === statusChange ? { ...current, failed: true } : current,
      );
    }, 15000);
    return () => clearTimeout(timer);
  }, [statusChange]);
  // The selected session owns community identity; never copy it into local defaults.
  const profiles =
    selected && connection.viewer === viewer ? session?.profiles : undefined;
  const readProfile = useCallback(
    () => (viewer ? profiles?.snapshot().get(viewer) : undefined),
    [profiles, viewer],
  );
  const communityProfile = useSyncExternalStore(
    profiles?.subscribe ?? noSubscription,
    readProfile,
    readProfile,
  );
  const live = useSyncExternalStore(
    session?.live.subscribe ?? noSubscription,
    session?.live.snapshot ?? noLiveSnapshot,
    session?.live.snapshot ?? noLiveSnapshot,
  );
  const roster = live?.roster;
  const liveStatus = live?.status;
  useEffect(() => {
    if (
      !profiles ||
      !viewer ||
      connection.status !== "ready" ||
      roster?.state !== "verified" ||
      (liveStatus !== "connected" && liveStatus !== "unavailable")
    )
      return;
    // Roster setup can cancel earlier reads, and disk hydration can hold an old
    // profile. Refresh once at this authority boundary through the same session.
    const controller = new AbortController();
    void session
      .read([{ kinds: [0], authors: [viewer], limit: 5 }], {
        priority: "background",
        fresh: true,
        signal: controller.signal,
      })
      .catch(() => {});
    return () => controller.abort();
  }, [profiles, viewer, connection.status, session, roster, liveStatus]);
  const profile = selected ? communityProfile : localProfile;
  const displayName = profile?.name.trim();
  const name =
    displayName ||
    (viewer ? formatPublicKey(viewer) : undefined) ||
    "Your profile";
  const source = avatarSource(profile?.picture);
  const picture = selected ? source && session?.media(source, "small") : source;
  const status = useUserStatus(session?.statuses, viewer ?? "");
  const statusEditor = useStatusEditor(session, viewer ?? undefined);
  const profileTrigger = useRef<HTMLButtonElement>(null);
  const openingStatus = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Settings or the profile panel takes focus once the menu has closed.
  const handoff = useRef(false);
  const actions = useSyncExternalStore(
    accountActions.subscribe,
    accountActions.snapshot,
  );
  const [selectedAction, setSelectedAction] =
    useState<RegisteredAccountAction | null>(null);
  const ActionDialog = actions.find(
    (action) => action === selectedAction,
  )?.component;
  const accountLabel = useId();
  const statusUnavailable = useId();
  const avatar = (
    <Avatar
      src={picture}
      alt=""
      fallback={name}
      fallbackContent={displayName ? undefined : <UserIcon size={19} />}
      size="fill"
      statusBadge={viewer && observed !== "unknown" ? observed : undefined}
    />
  );
  return (
    <>
      <MenuRoot
        modal={false}
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) {
            handoff.current = false;
            openingStatus.current = false;
          } else {
            statusEditor.cancelOpening();
            openingStatus.current = false;
          }
        }}
        onOpenChangeComplete={(open) => {
          // Let the menu finish its keyboard handling before handing focus to
          // the page. Other dismissals retain the shared menu's focus behavior.
          if (!open && handoff.current) {
            const main = document.getElementById("main-content");
            // A user may already be editing Settings, or the profile panel may
            // have focused itself, while the menu animates out.
            if (!main?.contains(document.activeElement)) main?.focus();
          }
        }}
      >
        <MenuTrigger
          render={
            <IconButton
              type="button"
              aria-label="Your profile"
              ref={profileTrigger}
              title={name}
              variant="avatar"
              shape="round"
              icon={
                <span
                  className={styles.triggerAvatar}
                  role="img"
                  aria-label={
                    viewer
                      ? observed === "unknown"
                        ? "Your status is unavailable"
                        : `Your status: ${label}`
                      : "Your avatar"
                  }
                >
                  {avatar}
                </span>
              }
            />
          }
        />
        <MenuPopup
          align="end"
          sideOffset={8}
          aria-labelledby={accountLabel}
          finalFocus={() => !handoff.current && !openingStatus.current}
        >
          <span id={accountLabel} className="sr-only">
            {name}
          </span>
          <div className={styles.profileHeader}>
            <span className={styles.profileAvatar}>
              {onProfile ? (
                <MenuItem
                  nativeButton
                  onClick={() => {
                    const trigger = profileTrigger.current;
                    if (!trigger) return;
                    handoff.current = true;
                    onProfile(trigger);
                  }}
                  render={
                    <IconButton
                      type="button"
                      aria-label="View your profile"
                      variant="avatar"
                      shape="round"
                      icon={avatar}
                    />
                  }
                />
              ) : (
                avatar
              )}
            </span>
            <div className={styles.profileDetails}>
              <p className="m-0 truncate text-label-sm">{name}</p>
              {viewer && (
                <MenuRoot modal={false}>
                  <span className={styles.availability} data-status={observed}>
                    <MenuTrigger
                      aria-label={`Availability: ${label}${pending ? `, updating to ${currentChange.target}` : ""}`}
                      render={
                        <Button variant="subtle" size="xs">
                          {pending && (
                            <CircleNotchIcon
                              size={12}
                              aria-hidden="true"
                              className="motion-safe:animate-spin"
                            />
                          )}
                          {label}
                          {pending && (
                            <span role="status" className="sr-only">
                              Updating to {currentChange?.target}…
                            </span>
                          )}
                        </Button>
                      }
                    />
                  </span>
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={observed === "unknown" ? "" : observed}
                      onValueChange={(value) => {
                        if (
                          value !== "online" &&
                          value !== "away" &&
                          value !== "offline"
                        )
                          return;
                        setStatusChange({
                          target: value,
                          session,
                          viewer,
                          community: selected,
                        });
                        communities.presence.setPreference(value);
                      }}
                      aria-label="Availability"
                    >
                      {(
                        [
                          ["online", "Online"],
                          ["away", "Away"],
                          ["offline", "Offline"],
                        ] as const
                      ).map(([value, name]) => (
                        <MenuRadioItem
                          key={value}
                          value={value}
                          closeOnClick={false}
                        >
                          {name}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </MenuRoot>
              )}
            </div>
          </div>
          {currentChange?.failed && (
            <p
              role="alert"
              className="mx-3 my-2 max-w-56 text-body-sm text-danger"
            >
              Could not confirm your status. Try again.
            </p>
          )}
          {presence.error && (
            <p
              role="alert"
              className="mx-3 my-2 max-w-56 text-body-sm text-danger"
            >
              {presence.error}
            </p>
          )}
          {viewer && session?.statuses && (
            <>
              <div className={styles.statusCard}>
                <MenuItem
                  aria-label={
                    status
                      ? `Set a status: ${[status.emoji, status.text].filter(Boolean).join(" ")}`
                      : "Set a status"
                  }
                  aria-describedby={
                    !session.statuses.writable ? statusUnavailable : undefined
                  }
                  closeOnClick={false}
                  disabled={statusEditor.loading || !session.statuses.writable}
                  onClick={async () => {
                    if (await statusEditor.open()) {
                      openingStatus.current = true;
                      setMenuOpen(false);
                    }
                  }}
                >
                  {status ? (
                    <>
                      <StatusEmoji session={session} value={status.emoji} />
                      <span className="min-w-0 truncate text-body-sm">
                        {status.text}
                      </span>
                    </>
                  ) : (
                    <>
                      <MenuIcon>
                        <SmileyIcon size={17} aria-hidden="true" />
                      </MenuIcon>
                      {statusEditor.loading
                        ? "Loading status…"
                        : "Set a status"}
                    </>
                  )}
                </MenuItem>
              </div>
              {!session.statuses.writable && (
                <p
                  id={statusUnavailable}
                  className="mx-3 my-2 max-w-56 text-body-sm text-muted"
                >
                  Status updates are unavailable in this community.
                </p>
              )}
              {statusEditor.error && (
                <p
                  role="alert"
                  className="mx-3 my-2 max-w-56 text-body-sm text-danger"
                >
                  {statusEditor.error}
                </p>
              )}
            </>
          )}
          {actions.map((action) => (
            <MenuItem
              key={action.key}
              onClick={() => setSelectedAction(action)}
            >
              {action.title}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            aria-current={settingsSelected ? "page" : undefined}
            onClick={() => {
              handoff.current = true;
              onSettings();
            }}
          >
            <MenuIcon>
              <GearIcon aria-hidden="true" size={17} />
            </MenuIcon>
            Settings
            {settingsSelected && (
              <MenuTrailing>
                <CheckIcon aria-hidden="true" size={14} />
              </MenuTrailing>
            )}
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      {ActionDialog && (
        <ActionDialog
          open
          onOpenChange={(open) => {
            if (!open) setSelectedAction(null);
          }}
        />
      )}
      {statusEditor.editor && session && connection.scope && (
        <StatusEditor
          session={session}
          scope={connection.scope}
          current={statusEditor.editor.current}
          close={statusEditor.close}
          finalFocus={profileTrigger}
        />
      )}
    </>
  );
}
