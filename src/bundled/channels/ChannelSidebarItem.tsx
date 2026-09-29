import { UserStatusDisplay } from "../../features/user-status/StatusDisplay";
import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { channelIcon } from "../../features/channels/channel-icon";
import { ChannelActivityPopover } from "./ChannelActivityPopover";
import { ChannelSidebarRow } from "./ChannelSidebarRow";
import { DmTypingBadge } from "./DmTypingBadge";
import { usePresenceStatus } from "../../features/presence/react";
import { UnreadBadge } from "./UnreadBadge";
import styles from "./Channels.module.css";

const noSessions: readonly ChannelSummary[] = [];

// Own the connected row inside the memo boundary. Selecting another channel
// must not rebuild every unchanged row's controls and subscriptions.
export const ChannelSidebarItem = memo(function ChannelSidebarItem({
  channel,
  profile,
  session,
  working,
  selected,
  collapsed,
  onToggle,
  draft,
  draftSelected,
  sessions = noSessions,
  onSelect,
  onNewSession,
  onOpenThread,
  onHideDm,
  menuEnabled,
  sectionKey,
  onOpenMenu,
  menuOpen = false,
  menuAnchor,
  menuContent,
  onCloseMenu,
  onMenuClosed,
  menuFinalFocus,
}: {
  channel: ChannelSummary;
  profile?: Profile | undefined;
  session: RelaySession;
  working: boolean;
  selected: string | undefined;
  collapsed: boolean;
  onToggle: (key: string, open: boolean) => void;
  draft: boolean;
  draftSelected: boolean;
  sessions: readonly ChannelSummary[] | undefined;
  onSelect: (id: string) => void;
  onNewSession: (id: string) => void;
  onOpenThread: (channelId: string, rootId: string) => void;
  onHideDm?: (id: string) => void;
  menuEnabled?: boolean;
  sectionKey?: string | undefined;
  onOpenMenu?: (
    channel: ChannelSummary,
    sectionKey: string,
    anchor?: HTMLElement,
  ) => void;
  menuOpen?: boolean;
  menuAnchor?: HTMLElement | undefined;
  /** Only the open row receives content, so closed rows keep equal props. */
  menuContent?: ReactNode;
  onCloseMenu?: () => void;
  onMenuClosed?: (channelId: string) => void;
  menuFinalFocus?: (channelId: string) => HTMLElement | false;
}) {
  const peer =
    channel.channelType === "dm" && channel.participants?.length === 1
      ? channel.participants[0]
      : undefined;
  const presence = usePresenceStatus(peer ? session.presence : undefined, peer);
  // Keep the closing row's items through the popup's exit transition.
  const lastMenuContent = useRef<ReactNode>(undefined);
  useLayoutEffect(() => {
    if (menuContent !== undefined) lastMenuContent.current = menuContent;
  }, [menuContent]);
  const Icon =
    channel.channelType === "dm" ? ChatCircleIcon : channelIcon(channel);
  const row = (
    <ChannelSidebarRow
      channel={channel}
      dmVisualSpacing={channel.channelType === "dm"}
      icon={
        channel.channelType === "dm" ? (
          <DmTypingBadge session={session} channelId={channel.id}>
            {channel.participants?.length === 1 ? (
              <span className={styles.dmAvatar} data-dm-identity="">
                <AgentAvatar
                  session={session}
                  agentPubkey={peer}
                  channelId={channel.id}
                  src={
                    profile?.picture
                      ? session.media(profile.picture, "small")
                      : undefined
                  }
                  alt=""
                  fallback={channel.name}
                  size="fill"
                  shape={profile?.isAgent ? "squircle" : "circle"}
                  statusBadge={presence === "unknown" ? undefined : presence}
                />
              </span>
            ) : (channel.participants?.length ?? 0) > 1 ? (
              <span
                className={styles.dmCount}
                data-dm-identity=""
                data-dm-participant-count=""
                title={`${channel.participants?.length} other participants`}
                aria-hidden="true"
              >
                {channel.participants?.length}
              </span>
            ) : (
              <Icon size={16} />
            )}
          </DmTypingBadge>
        ) : (
          <Icon size={16} />
        )
      }
      nameAccessory={
        channel.channelType === "dm" &&
        channel.participants?.length === 1 && (
          <UserStatusDisplay
            session={session}
            userId={channel.participants[0] ?? ""}
            compact
            focusable={false}
          />
        )
      }
      badge={
        <span className={styles.indicatorStack} data-channel-indicators="">
          <span className={styles.indicatorLayer}>
            <UnreadBadge
              session={session}
              channelId={channel.id}
              dm={channel.channelType === "dm"}
            />
          </span>
          {working && (
            <span
              className={styles.working}
              data-channel-working=""
              data-indicator-layer="working"
              role="img"
              aria-label="Agent working"
              title="Agent working in this channel"
            />
          )}
        </span>
      }
      wrapSelect={(trigger) => {
        const activity = (
          <ChannelActivityPopover
            session={session}
            channelId={channel.id}
            channelName={channel.name}
            onOpenThread={(item) => onOpenThread(item.channelId, item.rootId)}
            trigger={trigger}
          />
        );
        // Keep popup semantics on separate DOM nodes: activity owns the button,
        // the context menu wraps only its select surface, not the child sessions.
        return menuEnabled ? (
          <ContextMenuTrigger
            render={<div />}
            onKeyDown={(event) => {
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                if (sectionKey)
                  onOpenMenu?.(channel, sectionKey, event.currentTarget);
              }
            }}
          >
            {activity}
          </ContextMenuTrigger>
        ) : (
          activity
        );
      }}
      selected={selected}
      presenceDescription={
        presence === "unknown" ? undefined : `Presence: ${presence}`
      }
      collapsed={collapsed}
      onToggle={(open) => onToggle(`session-children:${channel.id}`, open)}
      draft={draft}
      draftSelected={draftSelected}
      sessions={sessions}
      childContent={(child) => (
        <UnreadBadge
          session={session}
          channelId={child.id}
          label={child.name}
        />
      )}
      onPrepare={(id) => session.channels.prepare?.(id)}
      onSelect={onSelect}
      onNewSession={onNewSession}
      {...(onHideDm ? { onHideDm } : {})}
    />
  );
  if (!menuEnabled) return row;
  return (
    <ContextMenuRoot
      open={menuOpen}
      onOpenChange={(open) => {
        if (open) {
          if (sectionKey) onOpenMenu?.(channel, sectionKey);
        } else if (menuOpen) onCloseMenu?.();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          lastMenuContent.current = undefined;
          onMenuClosed?.(channel.id);
        }
      }}
    >
      {row}
      <MenuPopup
        aria-label={`Actions for ${channel.name}`}
        anchor={menuOpen ? menuAnchor : undefined}
        finalFocus={() => menuFinalFocus?.(channel.id) ?? false}
      >
        {menuContent ?? lastMenuContent.current}
      </MenuPopup>
    </ContextMenuRoot>
  );
});
