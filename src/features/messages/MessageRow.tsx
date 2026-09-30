import { MessageTimestamp } from "./MessageTimestamp";
import { useChannelIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import { ReplySummary } from "./ReplySummary";
import { AgentAvatar } from "../agents/AgentAvatar";
import { usePresenceStatus } from "../presence/react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  memo,
  useId,
  useRef,
  useState,
  useEffect,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import type { UnreadCapability } from "../relay/unread";
import { MediaAttachment, type MediaPlayback } from "./MediaAttachment";
import { parseMediaTimeReply } from "./media-timecode";
import { profileTarget } from "../profiles/target";
import { MessageBody } from "../conversation/MessageBody";
import { InlineText } from "../conversation/InlineText";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { AttachmentImage } from "./AttachmentImage";
import { DeliveryNotice } from "./DeliveryNotice";
import { AudioAttachment } from "./AudioAttachment";
import { isNativeMediaSource, isProxySource } from "./attachment-source";
import { FileAttachment } from "./FileAttachment";
import { useReferenceDirectory } from "./ReferenceText";
import { MessageMarkdown } from "./MessageMarkdown";
import { safeMessageUrl } from "../relay/message-content";
import styles from "./Messages.module.css";
import { usesLargeEmojiPresentation } from "./emoji-size";
import { MessageReactionControls, MessageReactions } from "./MessageReactions";

import { MessageManagementItems } from "./MessageManagement";
import { MessageActionBar } from "./MessageActionBar";
import { FlagIcon } from "../../shared/design-system/icons";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { ReportMessageDialog } from "./ReportMessageDialog";
import { messageCopyLink, messageCopyText } from "./message-copy";

const emptySubscribe = () => () => {};
const EMPTY_CHANNEL_LIST = Object.freeze({
  status: "unavailable" as const,
  channels: Object.freeze([]),
});
const emptyChannelList = () => EMPTY_CHANNEL_LIST;

export type MessageRowProps = {
  row: ChannelMessage;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  unread?: UnreadCapability | undefined;
  extensions?: ConversationExtensions | undefined;
  profile: Profile | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  media(url: string, size?: "small"): string | undefined;
  onOpenLink(url: string): boolean;
  day: boolean;
  retry: ((id: string) => void) | undefined;
  /** Pins this row in a virtualized list; returns the release. */
  keepMounted?: ((messageId: string) => () => void) | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
    | undefined;
  onReply?: ((messageId: string) => void) | undefined;
  quickControls?: ReactNode;
  overflowItems?: ReactNode;
  layout?: "timeline" | "thread" | "continuation";
  compactAvatar?: boolean;
  mediaMode?: "inline" | "thread";
  mediaSeekTo?: number;
  mediaSeekRequest?: number;
  onMediaPlayback?: (playback: MediaPlayback) => void;
  onMediaTime?: (seconds: number) => void;
  onOpenMediaReview?: (
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
    hasComments?: boolean,
  ) => void;
};

export const MessageRow = memo(function MessageRow({
  row,
  session,
  scope,
  unread,
  extensions,
  profile,
  media,
  onOpenLink,
  canOpenLink,
  day,
  retry,
  keepMounted,
  onOpenThread,
  onReply,
  quickControls,
  overflowItems,
  participantProfiles,
  layout = "timeline",
  compactAvatar = false,
  mediaMode = "inline",
  mediaSeekTo,
  mediaSeekRequest,
  onMediaPlayback,
  onMediaTime,
  onOpenMediaReview,
  agentPubkeys,
}: MessageRowProps) {
  const resolveName = useChannelIdentityNames(session, row.channelId);
  const directory = useReferenceDirectory(session, participantProfiles);
  const threadUnread = useThreadUnread(
    row.replyCount > 0 && onOpenThread ? unread : undefined,
    row.channelId,
    row.threadRootId ?? row.id,
  );
  const channelList = useSyncExternalStore(
    session?.channels.subscribeList ?? emptySubscribe,
    session?.channels.list ?? emptyChannelList,
    session?.channels.list ?? emptyChannelList,
  );
  const cached = channelList.channels.some(
    (channel) => channel.id === row.channelId && channel.cached,
  );
  const unreadLabel =
    threadUnread?.manual === "local-only"
      ? "Thread marked unread on this device only"
      : threadUnread?.manual === "remote"
        ? "Thread marked unread"
        : (threadUnread?.observedCount ?? 0) > 0
          ? `Observed unread replies${threadUnread?.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`
          : undefined;
  const name = resolveName(
    row.authorId,
    profile?.name ?? row.authorId.slice(0, 10),
  );
  const picture = profile?.picture
    ? media(profile.picture, "small")
    : undefined;
  const target = profileTarget(row.authorId, {
    agent: !!(row.agentEnvelope || agentPubkeys?.has(row.authorId)),
  });
  const clickable = target && canOpenLink?.(target);
  const avatarShape =
    row.agentEnvelope || agentPubkeys?.has(row.authorId)
      ? "squircle"
      : "circle";
  const presence = usePresenceStatus(
    avatarShape === "squircle" ? session?.presence : undefined,
    row.authorId,
  );
  const presenceId = useId();
  const thinkingId = useId();
  const timeReply = row.diff ? undefined : parseMediaTimeReply(row.content);
  const displayRow = timeReply ? { ...row, content: timeReply.content } : row;
  const emojiOnly = usesLargeEmojiPresentation(displayRow.content, row.emoji);
  const canReact = !!(
    extensions &&
    session &&
    scope &&
    session.outbox?.supports(7) &&
    session.outbox.supports(5) &&
    (!session.channels.get ||
      channelList.channels.some((channel) => channel.id === row.channelId)) &&
    !channelList.channels.find((channel) => channel.id === row.channelId)
      ?.archived &&
    !channelList.channels.find((channel) => channel.id === row.channelId)
      ?.readOnly
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [reporting, setReporting] = useState<"open" | "sent">();
  const reportActive = reporting !== undefined;
  // The dialog, pending submit and notice live in this row; eviction loses them.
  useEffect(() => {
    const release = reportActive ? keepMounted?.(row.id) : undefined;
    // Dialog focus restoration runs in a microtask after unmount; releasing a
    // task later lets restored focus keep the row mounted instead.
    return release && (() => void setTimeout(release));
  }, [reportActive, keepMounted, row.id]);
  const report =
    !row.membership &&
    (!row.delivery || ["accepted", "seen"].includes(row.delivery))
      ? session?.messages.report
      : undefined;
  const reportItem = report && (
    <MenuItem onClick={() => setReporting("open")}>
      <MenuIcon>
        <FlagIcon />
      </MenuIcon>
      Report
    </MenuItem>
  );
  // Keep mixed attachments in sender order; only adjacent images share a strip.
  const attachmentGroups: ChannelMessage["attachments"][number][][] = [];
  for (const attachment of row.attachments) {
    if (!safeMessageUrl(attachment.url)) continue;
    const previous = attachmentGroups.at(-1);
    if (
      (attachment.kind === "image" || attachment.kind === "file") &&
      previous?.[0]?.kind === attachment.kind
    )
      previous.push(attachment);
    else attachmentGroups.push([attachment]);
  }
  const body = row.diff ? (
    <div>
      <p className="text-label-sm">{row.diff.filePath || "Diff"}</p>
      {row.diff.description && (
        <p className="text-body-sm">{row.diff.description}</p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: The raw scroll region preserves preformatted text and needs keyboard access. */}
      <pre
        className={styles.rawDiff}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The raw scroll owner must support keyboard scrolling.
        tabIndex={0}
        role="region"
        aria-label="Raw diff"
      >
        {row.content || "No diff content"}
      </pre>
      {row.diff.truncated && (
        <p className="text-body-sm">
          Diff truncated. View the full diff at the source repository.
        </p>
      )}
    </div>
  ) : (
    <MessageMarkdown
      directory={directory}
      session={session}
      scope={scope}
      row={displayRow}
      extensions={extensions}
      media={media}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      participantProfiles={participantProfiles}
      largeEmoji={emojiOnly}
    />
  );
  return (
    <div data-message-id={row.id}>
      {day && (
        <div className={styles.day}>
          <span>
            {new Date(row.createdAt * 1000).toLocaleDateString(undefined, {
              year: "numeric",
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </span>
        </div>
      )}
      <div ref={rowRef} className={styles.message} data-layout={layout}>
        {layout === "continuation" ? (
          <span className={styles.messageGutter}>
            <MessageTimestamp createdAt={row.createdAt} compact />
          </span>
        ) : clickable ? (
          <IconButton
            size={layout === "timeline" ? "default" : "sm"}
            shape="round"
            aria-label={`View ${name} profile`}
            aria-describedby={
              [
                presence !== "unknown" && presenceId,
                avatarShape === "squircle" && thinkingId,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onClick={(event) => {
              event.currentTarget.focus();
              onOpenLink(target);
            }}
            icon={
              <>
                <AgentAvatar
                  session={session}
                  agentPubkey={row.authorId}
                  channelId={row.channelId}
                  src={picture}
                  alt=""
                  thinkingDescriptionId={thinkingId}
                  fallback={name}
                  size={compactAvatar ? "small" : "fill"}
                  shape={avatarShape}
                  statusBadge={presence === "unknown" ? undefined : presence}
                />
                {presence !== "unknown" && (
                  <span className="sr-only" id={presenceId}>
                    Presence: {presence}
                  </span>
                )}
              </>
            }
          />
        ) : (
          <span className={compactAvatar ? styles.nestedAvatar : "contents"}>
            <AgentAvatar
              session={session}
              agentPubkey={row.authorId}
              channelId={row.channelId}
              src={picture}
              alt={
                presence === "unknown"
                  ? ""
                  : avatarShape === "squircle"
                    ? "Agent"
                    : `${name} avatar`
              }
              fallback={name}
              size={
                compactAvatar
                  ? "small"
                  : layout === "timeline"
                    ? "large"
                    : "default"
              }
              shape={avatarShape}
              statusBadge={presence === "unknown" ? undefined : presence}
            />
          </span>
        )}
        <div className={styles.messageBody}>
          {report && reporting === "open" && (
            <ReportMessageDialog
              report={(type, note) => report(row.id, type, note)}
              close={(submitted) =>
                setReporting(submitted ? "sent" : undefined)
              }
              finalFocus={menuTrigger}
            />
          )}
          {reporting === "sent" && (
            <ToastNotice
              tone="success"
              timeout={5000}
              title="Report submitted to community moderators"
              onDismiss={() => setReporting(undefined)}
            />
          )}
          <div className={styles.messageHeader}>
            {!row.membership && (
              <MessageActionBar
                rowRef={rowRef}
                menuTriggerRef={menuTrigger}
                messageId={row.id}
                onReply={
                  (onReply ? () => onReply(row.id) : undefined) ??
                  (onOpenThread
                    ? () =>
                        onOpenThread(
                          row.threadRootId ?? row.id,
                          row.threadRootId ?? row.id,
                          "reply",
                        )
                    : undefined)
                }
                replyDisabled={
                  !!(
                    row.delivery && !["accepted", "seen"].includes(row.delivery)
                  ) ||
                  !!channelList.channels.find(
                    (channel) => channel.id === row.channelId,
                  )?.archived ||
                  (!!session?.channels.get &&
                    !channelList.channels.some(
                      (channel) =>
                        channel.id === row.channelId && !channel.readOnly,
                    ))
                }
                link={messageCopyLink(row, scope)}
                copyText={() =>
                  messageCopyText(row, directory.profiles, directory.agents)
                }
                quickControls={
                  quickControls ??
                  (canReact && session && scope && extensions ? (
                    <MessageReactionControls
                      row={row}
                      session={session}
                      scope={scope}
                      tools={extensions.tools}
                      inline={extensions.inline}
                      disabled={
                        !!row.delivery &&
                        !["accepted", "seen"].includes(row.delivery)
                      }
                    />
                  ) : undefined)
                }
                overflowItems={
                  <>
                    {overflowItems ??
                      (session ? (
                        <MessageManagementItems row={row} session={session} />
                      ) : undefined)}
                    {reportItem}
                  </>
                }
              />
            )}
            <div
              className={layout === "continuation" ? "sr-only" : styles.byline}
            >
              <strong className={styles.author}>{name}</strong>
              {layout !== "continuation" && (
                <MessageTimestamp createdAt={row.createdAt} />
              )}
            </div>
          </div>
          {timeReply && (
            <span className={styles.mediaTimeLink}>
              {onMediaTime ? (
                <Button
                  size="sm"
                  type="button"
                  onClick={() => onMediaTime(timeReply.anchor.seconds)}
                >
                  {timeReply.label}
                </Button>
              ) : (
                <span>{timeReply.label}</span>
              )}
            </span>
          )}
          {extensions?.messages ? (
            <MessageBody registry={extensions.messages} message={row}>
              {body}
            </MessageBody>
          ) : (
            body
          )}
          <DeliveryNotice row={row} retry={retry} />
          {attachmentGroups.map((group) => {
            const images = group[0]?.kind === "image";
            const files = group[0]?.kind === "file";
            const items = group.map((attachment, index) => {
              const url = safeMessageUrl(attachment.url);
              if (!url) return null;
              const source = media(url);
              if (attachment.kind === "file")
                return (
                  <FileAttachment
                    key={url}
                    attachment={{ ...attachment, url }}
                    source={source}
                    onOpenLink={onOpenLink}
                  />
                );
              if (attachment.kind === "audio") {
                if (
                  source &&
                  (isProxySource(source) || isNativeMediaSource(source))
                )
                  return (
                    <AudioAttachment
                      key={url}
                      attachment={{ ...attachment, url }}
                      source={source}
                    />
                  );
                return (
                  <FileAttachment
                    key={url}
                    attachment={{ ...attachment, url }}
                    source={source}
                    onOpenLink={onOpenLink}
                  />
                );
              }
              if (attachment.kind === "image") {
                return (
                  <AttachmentImage
                    key={url}
                    attachment={{ ...attachment, url }}
                    url={url}
                    source={source}
                    cached={cached}
                    thumbnail
                    label={
                      group.length > 1
                        ? `Open image ${index + 1} of ${group.length}`
                        : "Open image attachment"
                    }
                    onOpenLink={onOpenLink}
                    {...(onOpenMediaReview
                      ? {
                          onOpenReview: (item, seconds) =>
                            onOpenMediaReview(
                              row.id,
                              item,
                              seconds,
                              row.replyCount > 0 ||
                                (!!row.threadRootId &&
                                  row.threadRootId !== row.id),
                            ),
                        }
                      : {})}
                  />
                );
              }
              return (
                <MediaAttachment
                  key={url}
                  attachment={{ ...attachment, url }}
                  media={media}
                  mode={mediaMode}
                  {...(attachment.kind === "video" && mediaSeekTo !== undefined
                    ? {
                        seekTo: mediaSeekTo,
                        ...(mediaSeekRequest !== undefined
                          ? { seekRequest: mediaSeekRequest }
                          : {}),
                      }
                    : {})}
                  {...(onMediaPlayback ? { onPlayback: onMediaPlayback } : {})}
                  {...(onOpenMediaReview
                    ? {
                        onOpenReview: (item, seconds) =>
                          onOpenMediaReview(
                            row.id,
                            item,
                            seconds,
                            row.replyCount > 0 ||
                              (!!row.threadRootId &&
                                row.threadRootId !== row.id),
                          ),
                      }
                    : {})}
                />
              );
            });
            return images ? (
              <div className={styles.imageGroup} key={group[0]?.url}>
                {/* biome-ignore lint/a11y/useSemanticElements: This labels related media links, not a fieldset of form controls. */}
                <div
                  className={styles.imageStrip}
                  role="group"
                  aria-label={`${group.length} ${group.length === 1 ? "image" : "images"}`}
                >
                  {items}
                </div>
                {group.length > 1 && (
                  <div className={styles.imageCount}>{group.length} images</div>
                )}
              </div>
            ) : files ? (
              <div className={styles.fileGroup} key={group[0]?.url}>
                {items}
              </div>
            ) : (
              items
            );
          })}
          {session && scope && extensions ? (
            <MessageReactions
              onFocusedRemoval={() => menuTrigger.current?.focus()}
              row={row}
              session={session}
              scope={scope}
              tools={extensions.tools}
              inline={extensions.inline}
              profiles={directory.profiles}
              disabled={
                !canReact ||
                (!!row.delivery && !["accepted", "seen"].includes(row.delivery))
              }
            />
          ) : (
            row.reactions.length > 0 && (
              <div className={`${styles.reactions} ${styles.reactionFallback}`}>
                {row.reactions.map((reaction) => (
                  <span
                    key={JSON.stringify([
                      reaction.content,
                      reaction.emoji?.url,
                    ])}
                  >
                    {extensions ? (
                      <InlineText
                        registry={extensions.inline}
                        content={{
                          text: reaction.content,
                          message: row,
                          reaction,
                        }}
                        media={media}
                      />
                    ) : (
                      reaction.content
                    )}{" "}
                    {
                      new Set(reaction.events.map((event) => event.authorId))
                        .size
                    }
                  </span>
                ))}
              </div>
            )
          )}
          {row.replyCount > 0 && onOpenThread && (
            <Button
              variant="ghost"
              size="sm"
              data-thread-summary=""
              data-first-participant-shape={
                agentPubkeys?.has(row.participants[0] ?? "")
                  ? "squircle"
                  : "circle"
              }
              type="button"
              aria-label={`View thread: ${row.replyCount} ${row.replyCount === 1 ? "reply" : "replies"}${unreadLabel ? `. ${unreadLabel}` : ""}`}
              onClick={(event) => {
                event.currentTarget.focus();
                onOpenThread(row.id, row.threadRootId ?? row.id);
              }}
            >
              <ReplySummary
                count={row.replyCount}
                participants={row.participants}
                profiles={participantProfiles}
                agentPubkeys={agentPubkeys}
                resolveName={resolveName}
                media={media}
                unreadLabel={unreadLabel}
              />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
// Subscribe only for mounted thread buttons. Evidence and reading remain session-owned;
// rendering a row must not initiate per-thread reads or acknowledge unseen replies.
function useThreadUnread(
  unread: UnreadCapability | undefined,
  channelId: string,
  rootId: string,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      unread?.subscribe({ kind: "thread", channelId, rootId }, listener) ??
      (() => {}),
    [unread, channelId, rootId],
  );
  const get = useCallback(
    () => unread?.snapshot({ kind: "thread", channelId, rootId }),
    [unread, channelId, rootId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
