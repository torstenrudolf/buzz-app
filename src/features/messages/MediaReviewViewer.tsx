import { MessageEditScope } from "./MessageEditScope";
import { useReviewSidebarMotion } from "./use-review-sidebar-motion";
import { readReviewOrigin, useReviewEntrance } from "./use-review-entrance";
import { VideoPlayer, videoTime } from "./VideoPlayer";
import { seekVideoBy } from "./use-video-gestures";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  XIcon,
  SidebarIcon,
  ChatCircleIcon,
} from "../../shared/design-system/icons/index";
import { createPortal } from "react-dom";
import type { ConversationExtensions } from "../conversation/contracts";
import type { Attachment, ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { compareMessages } from "../relay/message-order";
import { useRowProfiles } from "../relay/react";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { rejectUnhandledFileDrop } from "./use-file-drop";
import { MessageComposer } from "./MessageComposer";
import { ImageReviewStage } from "./ImageReviewStage";
import { MessageRow } from "./MessageRow";
import { parseMediaTimeReply } from "./media-timecode";
import { VideoReviewReactions } from "./VideoReviewReactions";
import styles from "./Messages.module.css";
import { useModalBoundary } from "./useModalBoundary";

type MediaReviewViewerProps = {
  attachment: Attachment;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  messageId: string;
  initialTime: number;
  hasComments?: boolean;
  restoreFocus?: RefObject<HTMLElement | null>;
  onOpenLink(url: string): boolean;
  close(): void;
};

export function MediaReviewViewer(props: MediaReviewViewerProps) {
  const { session, channelId, messageId } = props;
  const [origin] = useState(() =>
    readReviewOrigin(
      props.restoreFocus?.current ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null),
    ),
  );
  const [active, setActive] = useState(() => ({
    attachment: props.attachment,
    initialTime: props.initialTime,
    request: 0,
  }));
  const [view, setView] = useState<ThreadView>();
  const [threadError, setThreadError] = useState<string>();
  useEffect(() => {
    try {
      const owned = session.thread(channelId, messageId, { exact: true });
      setThreadError(undefined);
      setView(owned);
      void owned.refresh();
      return () => owned.dispose();
    } catch (error) {
      setThreadError(String(error));
    }
  }, [session, channelId, messageId]);
  const activeProps = {
    ...props,
    origin,
    attachment: active.attachment,
    initialTime: active.initialTime,
    selectionRequest: active.request,
    selectAttachment: (attachment: Attachment, initialTime: number) =>
      setActive((current) => ({
        attachment,
        initialTime,
        request: current.request + 1,
      })),
  };
  return (
    <ResolvedReview {...activeProps} view={view} threadError={threadError} />
  );
}

type ActiveReviewProps = MediaReviewViewerProps & {
  origin: ReturnType<typeof readReviewOrigin>;
  selectionRequest: number;
  selectAttachment(attachment: Attachment, initialTime: number): void;
};

const noThreadSubscription = () => () => {};
const noThreadSnapshot = () => undefined;

function ResolvedReview({
  view,
  threadError,
  ...props
}: ActiveReviewProps & {
  view: ThreadView | undefined;
  threadError: string | undefined;
}) {
  const snapshot = useSyncExternalStore(
    view?.subscribe ?? noThreadSubscription,
    view?.snapshot ?? noThreadSnapshot,
    view?.snapshot ?? noThreadSnapshot,
  );
  useEffect(() => {
    if (snapshot?.status === "ready" && snapshot.canLoadMore)
      void view?.loadMore();
  }, [view, snapshot?.status, snapshot?.canLoadMore]);
  if (threadError) return <ReviewShell {...props} error={threadError} />;
  if (!view || !snapshot) return <ReviewShell {...props} loading />;
  if (snapshot.error)
    return (
      <ReviewShell {...props} error={snapshot.error} retry={view.refresh} />
    );
  if (snapshot.status === "loading" || snapshot.status === "idle")
    return <ReviewShell {...props} loading />;
  if (!snapshot.root)
    return (
      <ReviewShell
        {...props}
        error="Original message unavailable."
        unavailable
        retry={view.refresh}
      />
    );
  const replies = [snapshot.target, ...snapshot.replies]
    .filter(
      (row): row is NonNullable<typeof row> =>
        !!row && row.id !== snapshot.root?.id,
    )
    .filter(
      (row, index, rows) =>
        rows.findIndex((item) => item.id === row.id) === index,
    )
    .sort(compareMessages);
  const threadRows = [snapshot.root, ...replies];
  const attachmentAvailable = threadRows.some((row) =>
    row.attachments.some((item) => item.url === props.attachment.url),
  );
  if (!attachmentAvailable)
    return (
      <ReviewShell {...props} error="Attachment unavailable." unavailable />
    );
  return (
    <ReviewShell
      {...props}
      rootId={snapshot.root.id}
      editMessages={threadRows}
      replies={replies}
      limited={snapshot.limited}
      timecodesSeekable={props.attachment.kind === "video"}
    />
  );
}

function ReviewShell({
  attachment,
  extensions,
  session,
  scope,
  channelId,
  channelName,
  initialTime,
  hasComments = false,
  origin,
  close,
  onOpenLink,
  rootId,
  replies = [],
  editMessages = [],
  limited = false,
  timecodesSeekable = false,
  loading = false,
  unavailable = false,
  error,
  retry,
  restoreFocus,
  selectAttachment,
  selectionRequest,
}: ActiveReviewProps & {
  rootId?: string;
  editMessages?: readonly ChannelMessage[];
  replies?: ReturnType<ThreadView["snapshot"]>["replies"];
  limited?: boolean;
  timecodesSeekable?: boolean;
  loading?: boolean;
  unavailable?: boolean;
  error?: string;
  retry?: () => void | Promise<void>;
}) {
  const source = session.media(attachment.url);
  const backdrop = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [commentsChoice, setCommentsOpen] = useState<boolean>();
  const [selectedImageUrl, setSelectedImageUrl] = useState(attachment.url);
  const { dismiss } = useReviewEntrance(
    frame,
    origin,
    close,
    selectionRequest === 0 && selectedImageUrl === attachment.url,
  );
  const commentsOpen =
    commentsChoice ?? (loading ? hasComments : replies.length > 0 || !!error);
  useEffect(() => {
    if (rootId && !loading)
      setCommentsOpen((choice) => choice ?? replies.length > 0);
  }, [rootId, loading, replies.length]);
  const prepareSidebarMotion = useReviewSidebarMotion(frame, commentsOpen);
  const [commentsMotion, setCommentsMotion] = useState(false);
  const [selectedComment, setSelectedComment] = useState<string>();
  const profiles = useRowProfiles(session.profiles, replies);
  const markers = timecodesSeekable
    ? replies.flatMap((row) => {
        const parsed = parseMediaTimeReply(row.content);
        if (!parsed) return [];
        const profile = profiles.get(row.authorId);
        return [
          {
            id: row.id,
            seconds: parsed.anchor.seconds,
            label: parsed.label,
            text: parsed.content,
            author: profile?.name ?? row.authorId.slice(0, 10),
            picture: profile?.picture
              ? session.media(profile.picture)
              : undefined,
          },
        ];
      })
    : [];
  const [currentTime, setCurrentTime] = useState(initialTime);
  const [includeTime, setIncludeTime] = useState(true);
  const imageAttachments = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...editMessages.flatMap((row) => row.attachments),
      attachment,
    ].filter(
      (item) =>
        item.kind === "image" && !seen.has(item.url) && !!seen.add(item.url),
    );
  }, [attachment, editMessages]);
  const [mediaFailed, setMediaFailed] = useState(false);
  // selectionRequest intentionally re-applies a seek when the same URL/time is selected again.
  useEffect(() => {
    void selectionRequest;
    setMediaFailed(false);
    setSelectedImageUrl(attachment.url);
    const seconds = Math.max(0, initialTime);
    const element = video.current;
    if (attachment.kind !== "video" || !element) {
      setCurrentTime(seconds);
      return;
    }
    const apply = () => {
      if (!video.current) return;
      video.current.currentTime = seconds;
      setCurrentTime(video.current.currentTime);
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
  }, [attachment.url, attachment.kind, initialTime, selectionRequest]);
  useModalBoundary(backdrop, frame, close, restoreFocus);
  const seek = (seconds: number) => {
    if (!video.current) return;
    const duration = video.current.duration;
    video.current.currentTime = Math.max(
      0,
      Math.min(seconds, Number.isFinite(duration) ? duration : seconds),
    );
    setCurrentTime(video.current.currentTime);
    video.current.dispatchEvent(new Event("timeupdate"));
    void video.current.play().catch(() => {});
  };
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal complements the close button and Escape shortcut.
    <div
      ref={backdrop}
      className={`${styles.mediaReviewBackdrop} ${styles.darkReviewBackdrop} dark`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget)
          dismiss(true);
      }}
    >
      <div
        className={styles.mediaReviewScrim}
        data-review-backdrop=""
        aria-hidden="true"
      />
      <section
        ref={frame}
        className={`${styles.mediaReviewViewer} dark`}
        data-color-mode="dark"
        data-review-pending={origin ? "" : undefined}
        data-video={attachment.kind === "video" || undefined}
        data-comments-motion={commentsMotion || undefined}
        data-comments-hidden={!commentsOpen || undefined}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        onKeyDown={(event) => {
          if (
            attachment.kind !== "video" ||
            event.currentTarget.hasAttribute("data-review-closing") ||
            !video.current ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            (event.key !== "ArrowLeft" &&
              event.key !== "ArrowRight" &&
              event.key !== " ")
          )
            return;
          const target = event.target;
          if (
            !(target instanceof Element) ||
            !event.currentTarget.contains(target) ||
            target.closest(
              'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="menu"], [role="listbox"], [aria-label="Media comments"], [aria-label="Playback speed"]',
            )
          )
            return;
          if (event.key === " ") {
            // Space still activates a deliberately focused control normally.
            if (
              target.closest(
                'button, a[href], [role="button"], [role="checkbox"], [role="switch"]',
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat) return;
            if (video.current.paused) void video.current.play().catch(() => {});
            else video.current.pause();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          seekVideoBy(video.current, event.key === "ArrowRight" ? 10 : -10);
        }}
        aria-label={
          attachment.kind === "video" ? "Video review" : "Image viewer"
        }
      >
        <header
          className={styles.mediaReviewHeading}
          data-review-chrome=""
          data-tauri-drag-region
        >
          <span data-tauri-drag-region>
            {attachment.kind === "video"
              ? (attachment.name ?? "Video review")
              : "Image"}
          </span>
          <IconButton
            size="compact"
            variant="subtle"
            shape="control"
            aria-label={commentsOpen ? "Hide comments" : "Show comments"}
            aria-pressed={commentsOpen}
            onClick={(event) => {
              prepareSidebarMotion(event.detail > 0);
              setCommentsMotion(event.detail > 0);
              setCommentsOpen(!commentsOpen);
            }}
            icon={<SidebarIcon size={20} />}
          />
          <IconButton
            size="compact"
            variant="subtle"
            shape="control"
            type="button"
            aria-label="Close fullscreen viewer"
            data-review-dismiss=""
            onClick={(event) => dismiss(event.detail > 0)}
            icon={<XIcon size={20} aria-hidden="true" />}
          />
        </header>
        <div className={styles.mediaReviewStage} data-review-stage="">
          {!source || unavailable || mediaFailed ? (
            <p
              className={styles.mediaReviewUnavailable}
              role={error ? "alert" : "status"}
            >
              {error ?? (loading ? "Loading media…" : "Media unavailable")}
              {retry && (
                <Button size="sm" type="button" onClick={() => void retry()}>
                  Retry
                </Button>
              )}
            </p>
          ) : attachment.kind === "video" ? (
            <VideoPlayer
              key={source}
              videoRef={video}
              source={source}
              poster={
                (selectionRequest === 0 ? origin?.poster : undefined) ??
                (attachment.previewUrl
                  ? session.media(attachment.previewUrl)
                  : undefined)
              }
              initialTime={initialTime}
              markers={markers}
              onMarker={(id) => {
                setSelectedComment(id);
                setCommentsOpen(true);
              }}
              onError={() => setMediaFailed(true)}
              onTime={setCurrentTime}
            >
              {rootId && (
                <VideoReviewReactions
                  session={session}
                  scope={scope}
                  channelId={channelId}
                  rootId={rootId}
                  videoRef={video}
                  extensions={extensions}
                />
              )}
            </VideoPlayer>
          ) : (
            <ImageReviewStage
              attachments={imageAttachments}
              selectedUrl={selectedImageUrl}
              select={setSelectedImageUrl}
              media={session.media}
              onOpenLink={onOpenLink}
            />
          )}
        </div>
        <aside
          data-review-chrome=""
          className={styles.mediaReviewConversation}
          inert={!commentsOpen}
          aria-hidden={!commentsOpen || undefined}
          aria-label="Media comments"
          onFocusCapture={() => {
            if (attachment.kind === "video") video.current?.pause();
          }}
          data-attachment-drop-zone=""
          onDragOver={rejectUnhandledFileDrop}
          onDrop={rejectUnhandledFileDrop}
        >
          <div className={styles.mediaReviewConversationContent}>
            {rootId && source ? (
              <MessageEditScope>
                <ReviewComments
                  selectedComment={selectedComment}
                  replies={replies}
                  limited={limited}
                  session={session}
                  scope={scope}
                  extensions={extensions}
                  selectAttachment={selectAttachment}
                  {...(attachment.kind === "video" && timecodesSeekable
                    ? { seek }
                    : {})}
                />
                {attachment.kind === "video" && (
                  <div className={styles.mediaReviewTimeOption}>
                    <span>{videoTime(currentTime)}</span>
                    <Checkbox
                      label="Comment at current frame"
                      checked={includeTime}
                      onCheckedChange={setIncludeTime}
                    />
                  </div>
                )}
                <MessageComposer
                  extensions={extensions}
                  session={session}
                  scope={scope}
                  channelId={channelId}
                  channelName={channelName}
                  threadRootId={rootId}
                  editMessages={editMessages}
                  {...(attachment.kind === "video" && includeTime
                    ? { mediaTimeSeconds: currentTime }
                    : {})}
                  hideMediaTimeIndicator
                />
              </MessageEditScope>
            ) : (
              <p className={styles.empty} role={error ? "alert" : "status"}>
                {error ?? "Loading comments…"}
              </p>
            )}
          </div>
        </aside>
      </section>
    </div>,
    document.body,
  );
}

function ReviewComments({
  replies,
  selectedComment,
  limited,
  session,
  scope,
  extensions,
  seek,
  selectAttachment,
}: {
  replies: ReturnType<ThreadView["snapshot"]>["replies"];
  selectedComment?: string | undefined;
  limited: boolean;
  session: RelaySession;
  scope: string;
  extensions?: ConversationExtensions | undefined;
  seek?: (seconds: number) => void;
  selectAttachment(attachment: Attachment, initialTime: number): void;
}) {
  const profiles = useRowProfiles(session.profiles, replies);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const comments = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedComment)
      comments.current
        ?.querySelector(`[data-review-comment="${selectedComment}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedComment]);
  const authors = [...new Set(replies.map((row) => row.authorId))]
    .sort()
    .join(":");
  useEffect(() => {
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors]);
  return (
    <section
      ref={comments}
      className={styles.mediaReviewThread}
      aria-label="Media comments"
    >
      <div className={styles.mediaReviewThreadHeading}>
        <strong>
          <ChatCircleIcon size={18} /> Comments
        </strong>
        <span>{replies.length}</span>
      </div>
      {replies.map((row, index) => (
        <div
          key={row.id}
          data-review-comment={row.id}
          data-selected={selectedComment === row.id || undefined}
          className={styles.mediaReviewComment}
        >
          <MessageRow
            row={row}
            extensions={extensions}
            session={session}
            scope={scope}
            profile={profiles.get(row.authorId)}
            agentPubkeys={agentPubkeys}
            media={session.media}
            onOpenLink={() => false}
            day={
              index === 0 ||
              new Date(
                (replies[index - 1]?.createdAt ?? 0) * 1000,
              ).toDateString() !== new Date(row.createdAt * 1000).toDateString()
            }
            retry={session.messages.retry}
            onOpenMediaReview={(_rowId, attachment, seconds) =>
              selectAttachment(attachment, seconds)
            }
            {...(seek ? { onMediaTime: seek } : {})}
          />
        </div>
      ))}
      {!replies.length && <p className={styles.threadNote}>No comments yet.</p>}
      {limited && (
        <p className={styles.threadNote}>Thread history limit reached.</p>
      )}
    </section>
  );
}
