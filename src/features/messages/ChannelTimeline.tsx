// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The history region must support keyboard scrolling.
import { useChannelIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import { MembershipRow } from "./MembershipRow";
import { membershipRows } from "./membership-rows";
import type { ConversationExtensions } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { MessageRow } from "./MessageRow";
import { continuesMessageGroup } from "./message-grouping";
import type { Attachment, ChannelWindow } from "../relay/contracts";
import { useRowProfiles } from "../relay/react";
import { geometryFor, geometrySignature } from "./geometry";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { useReading } from "./use-reading";
import { useMessageReveal } from "./use-message-reveal";
import type { PageNavigation } from "../navigation/service";
import { messageViewKey } from "./view-key";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { JumpToLatestButton } from "./JumpToLatestButton";

const EDGE_HEIGHT = 56;
type ReadingPosition = {
  offset: number;
  bottom: boolean;
  anchor?: { id: string; y: number };
};
function positionAt(
  element: HTMLElement,
  restoredAnchor?: string,
): ReadingPosition {
  const top = element.getBoundingClientRect().top;
  const mounted = Array.from(
    element.querySelectorAll<HTMLElement>("[data-message-id]"),
  );
  // A resize restoration keeps its chosen message even if wrapping makes its
  // paragraph taller than the viewport. Only a new gesture chooses a new anchor.
  const restored = mounted.find((row) => {
    const rect = row.getBoundingClientRect();
    return (
      row.dataset.messageId === restoredAnchor &&
      rect.bottom > top &&
      rect.top < top + element.clientHeight
    );
  });
  // Otherwise prefer a whole visible message over a partly clipped row.
  const row =
    restored ??
    mounted.find((row) => {
      const text = row.querySelector("p")?.getBoundingClientRect();
      return (
        text && text.top >= top && text.bottom <= top + element.clientHeight
      );
    }) ??
    mounted.find((row) => row.getBoundingClientRect().bottom > top);
  return {
    offset: element.scrollTop,
    bottom:
      element.scrollHeight - element.clientHeight - element.scrollTop < 80,
    ...(row?.dataset.messageId
      ? {
          anchor: {
            id: row.dataset.messageId,
            y: row.getBoundingClientRect().top - top,
          },
        }
      : {}),
  };
}
export type ChannelTimelineProps = {
  extensions?: ConversationExtensions | undefined;
  channelId: string;
  scope: string;
  viewer?: string | undefined;
  queries: RelaySession;
  /** A parent keyed by connection generation can preserve its timeline on cache promotion. */
  continuityKey?: string | undefined;
  window: ChannelWindow;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  navigation?: PageNavigation | undefined;
  onOpenThread?(
    messageId: string,
    threadRootId: string,
    intent?: "reply",
  ): void;
  onOpenMediaReview?(
    messageId: string,
    attachment: Attachment,
    seconds: number,
    hasComments?: boolean,
  ): void;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ChannelTimeline(props: ChannelTimelineProps) {
  return (
    <Timeline
      key={
        props.continuityKey
          ? JSON.stringify([props.continuityKey, props.scope, props.channelId])
          : messageViewKey(props.queries, props.scope, props.channelId)
      }
      {...props}
    />
  );
}
function Timeline({
  channelId,
  extensions,
  scope,
  viewer,
  queries,
  window,
  onOpenLink,
  canOpenLink,
  revealMessageId,
  navigation,
  onOpenThread,
  onOpenMediaReview,
}: ChannelTimelineProps) {
  const [initialPosition] = useState(() =>
    readView<ReadingPosition | null>(scope, `scroll:${channelId}`, null),
  );
  const savedPosition = useRef(initialPosition);
  const restoredAnchor = useRef<ReadingPosition["anchor"]>(undefined);
  const rows = useMemo(() => membershipRows(window.rows), [window.rows]);
  const resolveName = useChannelIdentityNames(queries, channelId);
  const profiles = useRowProfiles(queries.profiles, window.rows);
  const agentPubkeys = useKnownAgentPubkeys(queries, profiles);
  const [geometry] = useState(() => geometryFor(queries.channels));
  const signature = useMemo(
    () => geometrySignature(window.rows, profiles, resolveName),
    [window.rows, profiles, resolveName],
  );
  const [focusedMessageId, setFocusedMessageId] = useState<string>();
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const keepRowMounted = useCallback((id: string) => {
    setPinnedIds((ids) => new Set(ids).add(id));
    return () =>
      setPinnedIds((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
  }, []);
  const keptIndices = rows.flatMap((row, index) =>
    row.id === focusedMessageId || pinnedIds.has(row.id) ? [index] : [],
  );
  const scroller = useRef<HTMLElement>(null);
  const handle = useRef<VirtualizerHandle>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = size.width;
  const latest = useRef({ signature, width });
  latest.current = { signature, width };
  const initialCache = useRef<VirtualizerHandle["cache"] | undefined>(
    undefined,
  );
  const edges = useRef<{
    first?: string | undefined;
    last?: string | undefined;
    ids: ReadonlySet<string>;
  }>({ ids: new Set() });
  const intent = useRef(0);
  const measuredPosition = useRef<{
    offset: number;
    height: number;
    width: number;
    viewport: number;
  } | null>(null);
  const olderDemand = useRef(false);
  const settled = useRef(false),
    userScrolled = useRef(false),
    follow = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const recordPosition = useCallback(
    (element: HTMLElement) => {
      // A delayed membership event can replace a group's rendered representative.
      // Keep the restored event anchored through that change until reader input.
      const anchor = restoredAnchor.current;
      const renderedAnchor = anchor
        ? rows.find(
            (row) =>
              row.id === anchor.id ||
              row.membershipRows?.some((member) => member.id === anchor.id),
          )?.id
        : undefined;
      const position = positionAt(element, renderedAnchor);
      // A removed saved row cannot keep a restoration alive once a visible row
      // replaces it. A temporarily unmounted row is still pending measurement.
      if (anchor && !renderedAnchor && position.anchor)
        restoredAnchor.current = undefined;
      // A settled standalone row no longer needs correction. Membership groups
      // retain the logical anchor even when their representative is in place.
      if (
        anchor &&
        position.anchor?.id === renderedAnchor &&
        position.anchor?.y === anchor.y &&
        element.scrollHeight - element.clientHeight - element.scrollTop > 1 &&
        !rows.some((row) =>
          row.membershipRows?.some((member) => member.id === anchor.id),
        )
      )
        restoredAnchor.current = undefined;
      // Virtua can emit the restoration scroll before mounting its visible
      // range. An anchorless observation must not erase the saved reading intent.
      // A reader gesture clears restoredAnchor before recording a new position.
      if (anchor && !position.anchor) return;
      // Cold estimates can leave too little height to reach the saved row/Y.
      // A bottom clamp with that row still below its target is restoration,
      // not reader intent. Reachable positions and new gestures remain free.
      if (
        anchor &&
        position.anchor &&
        position.anchor.id === renderedAnchor &&
        position.anchor.y > anchor.y + 1 &&
        element.scrollHeight - element.clientHeight - element.scrollTop <= 1
      )
        return;
      const previous = measuredPosition.current;
      // List shrinkage can clamp scrollTop upward without reader movement. An
      // upward offset beyond that clamp is input, including later events from
      // one smooth keyboard scroll / scrollbar drag. Layout growth alone is not.
      const movedUp =
        previous &&
        element.clientWidth === previous.width &&
        element.clientHeight === previous.viewport &&
        element.scrollTop <
          previous.offset + Math.min(0, element.scrollHeight - previous.height);
      if (follow.current && !movedUp && (previous || !userScrolled.current))
        position.bottom = true;
      // Restoration can scroll before Virtua measures rows beneath the anchor,
      // briefly reaching the estimated bottom. Only reader input may follow.
      if (restoredAnchor.current) position.bottom = false;
      savedPosition.current = position;
      follow.current = position.bottom;
      measuredPosition.current = {
        offset: element.scrollTop,
        height: element.scrollHeight,
        width: element.clientWidth,
        viewport: element.clientHeight,
      };
    },
    [rows],
  );
  const updateJumpToLatest = useCallback((element: HTMLElement) => {
    const bottom =
      element.scrollHeight - element.clientHeight - element.scrollTop < 80;
    setShowJumpToLatest(!bottom);
    if (bottom) setNewMessageCount(0);
  }, []);
  const jumpToLatest = useCallback(() => {
    if (!handle.current || !rows.length) return;
    intent.current++;
    follow.current = true;
    restoredAnchor.current = undefined;
    userScrolled.current = false;
    scroller.current?.focus({ preventScroll: true });
    setShowJumpToLatest(false);
    setNewMessageCount(0);
    handle.current.scrollToIndex(rows.length - 1, {
      align: "end",
    });
  }, [rows.length]);
  const targetId =
    navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined;
  const targetIndex = rows.findIndex((row) => row.id === targetId);
  const prepareTarget = useCallback(() => {
    if (!handle.current) return;
    intent.current++;
    follow.current = false;
    restoredAnchor.current = undefined;
    settled.current = false;
    handle.current.scrollToIndex(targetIndex, { align: "center" });
  }, [targetIndex]);
  const completeTarget = useCallback(() => {
    navigation?.complete({ status: "opened" });
  }, [navigation]);
  const exactRevealed = useMessageReveal({
    scroller,
    settled,
    messageId: targetId,
    signal: navigation?.signal,
    ready: !!size.width && !!size.height && targetIndex >= 0,
    prepare: prepareTarget,
    complete: completeTarget,
  });
  useReading({ session: queries, channelId, scroller, settled });
  const prepend =
    !!edges.current.first &&
    edges.current.first !== rows[0]?.id &&
    edges.current.last === rows.at(-1)?.id;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measured = element.clientWidth;
    initialCache.current = geometry.get(
      channelId,
      latest.current.signature,
      measured,
    );
    let measuredSize = { width: 0, height: 0 };
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      if (
        next.width === measuredSize.width &&
        next.height === measuredSize.height
      )
        return;
      measuredSize = next;
      settled.current = false;
      setSize(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      olderDemand.current = false;
      settled.current = false;
      writeView(scope, `scroll:${channelId}`, savedPosition.current);
      observer.disconnect();
      if (handle.current)
        geometry.set(
          channelId,
          latest.current.signature,
          latest.current.width,
          handle.current.cache,
        );
    };
    // Initial signature only; mutations invalidate the saved cache on remount.
  }, [channelId, geometry, scope]);
  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    // Row updates include edits/reactions/replies, not only new message IDs.
    // Above-bottom reading and prepend anchoring remain Virtua's responsibility.
    const revealIndex =
      revealMessageId && revealed.current !== revealMessageId
        ? rows.findIndex(
            (row) =>
              row.id === revealMessageId ||
              row.membershipRows?.some(
                (member) => member.id === revealMessageId,
              ),
          )
        : -1;
    const previousIds = edges.current.ids;
    const arrivals = prepend
      ? 0
      : rows.filter((row) => !previousIds.has(row.id)).length;
    edges.current = {
      first: rows[0]?.id,
      last: rows.at(-1)?.id,
      ids: new Set(rows.map((row) => row.id)),
    };
    if (
      arrivals > 0 &&
      previousIds.size > 0 &&
      !follow.current &&
      (!targetId || exactRevealed.current === navigation?.signal)
    ) {
      setNewMessageCount((count) => count + arrivals);
    }
    if (
      (targetId && navigation && exactRevealed.current !== navigation.signal) ||
      !size.width ||
      !size.height ||
      !rows.length ||
      (revealIndex < 0 && settled.current && (!follow.current || prepend))
    )
      return;
    // A send supersedes saved reading intent before the first scroll event.
    // This effect also retains its height observer through late measurements.
    if (revealIndex >= 0) {
      revealed.current = revealMessageId;
      intent.current++;
      follow.current = true;
      restoredAnchor.current = undefined;
      savedPosition.current = { offset: 0, bottom: true };
      measuredPosition.current = null;
      userScrolled.current = false;
    }
    // virtua attaches its scroller in an effect; wait through the StrictMode probe.
    // A new gesture wins over restoration queued before that gesture.
    const scheduledIntent = intent.current;
    const restore =
      !settled.current && savedPosition.current && !savedPosition.current.bottom
        ? savedPosition.current
        : null;
    let observer: MutationObserver | undefined;
    const restorePosition = () => {
      if (intent.current !== scheduledIntent || !handle.current) return;
      if (restore) {
        const anchor = restore.anchor;
        const index = anchor
          ? rows.findIndex(
              (row) =>
                row.id === anchor.id ||
                row.membershipRows?.some((member) => member.id === anchor.id),
            )
          : -1;
        const row = rows[index];
        if (anchor && row) {
          restoredAnchor.current = { id: row.id, y: anchor.y };
          handle.current.scrollToIndex(index, {
            align: "start",
            offset: -anchor.y,
          });
        } else handle.current.scrollTo(restore.offset);
        follow.current = false;
      } else if (follow.current) {
        handle.current.scrollToIndex(
          revealIndex >= 0 ? revealIndex : rows.length - 1,
          { align: "end" },
        );
      }
    };
    let frame = requestAnimationFrame(() => {
      if (intent.current === scheduledIntent && handle.current) {
        // Input can move the DOM before its scroll event is delivered.
        if (!restore && scroller.current && measuredPosition.current)
          recordPosition(scroller.current);
        if (!restore && !follow.current) {
          settled.current = true;
          return;
        }
        restorePosition();
        // Width changes can measure after Virtua's imperative-scroll scheduler
        // expires. Retain the same reading anchor (or bottom intent) through
        // those late measurements, never through a new reader gesture.
        const list = scroller.current?.querySelector("ol");
        if (list) {
          // Virtua measures children in ResizeObserver and synchronously writes
          // this parent height. Observing the parent box would create skipped
          // resize notifications; watch only Virtua's committed height instead.
          let height = list.style.height;
          observer = new MutationObserver(() => {
            if (list.style.height === height) return;
            height = list.style.height;
            // Capture a native clamp while its shrink is still observable.
            // Another append can grow the list before the queued scroll event.
            if (
              !restore &&
              measuredPosition.current &&
              intent.current === scheduledIntent &&
              scroller.current
            )
              recordPosition(scroller.current);
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(restorePosition);
          });
          observer.observe(list, {
            attributes: true,
            attributeFilter: ["style"],
          });
        }
      }
      settled.current = true;
      if (scroller.current) updateJumpToLatest(scroller.current);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      // A row refresh can arrive before the first deferred measurement or
      // cancel its correction. Keep restoration until newer reader input.
      if (restore && !follow.current && intent.current === scheduledIntent) {
        // Carry the original geometry with the resolved membership identity.
        savedPosition.current =
          restore.anchor && restoredAnchor.current
            ? {
                ...restore,
                anchor: { ...restore.anchor, id: restoredAnchor.current.id },
              }
            : restore;
        settled.current = false;
      }
    };
  }, [
    rows,
    size,
    prepend,
    recordPosition,
    targetId,
    navigation,
    exactRevealed,
    updateJumpToLatest,
    revealMessageId,
  ]);
  const loadNearTop = useCallback(
    (element: HTMLElement, resume = false) => {
      olderDemand.current = false;
      if (
        !handle.current ||
        !userScrolled.current ||
        window.status !== "ready" ||
        !window.hasMore ||
        window.historyLimited ||
        window.loadingOlder ||
        window.error ||
        element.scrollTop >= Math.max(3000, element.clientHeight * 4)
      )
        return;
      // Cached does not mean blocked: disconnected windows can still page over
      // HTTP. Try ordinary demand first, retaining only a blocked cached gesture.
      // A retained gesture waits for verification, not every cached row update.
      if (resume && window.freshness === "cached") {
        olderDemand.current = true;
        return;
      }
      queries.channels.loadOlder(channelId);
      const after = queries.channels.window(channelId);
      olderDemand.current =
        window.freshness === "cached" &&
        after.status === "ready" &&
        after.hasMore &&
        !after.loadingOlder &&
        !after.historyLimited &&
        !after.error;
    },
    [window, queries, channelId],
  );
  useLayoutEffect(() => {
    if (olderDemand.current && scroller.current)
      loadNearTop(scroller.current, true);
  }, [loadNearTop]);
  const gesture = () => {
    restoredAnchor.current = undefined;
    intent.current++;
    userScrolled.current = true;
    if (scroller.current) recordPosition(scroller.current);
    // At a restored top edge, input cannot move the DOM and emits no scroll.
    if (scroller.current && scroller.current.scrollTop <= 0)
      loadNearTop(scroller.current);
  };
  return (
    <section
      ref={scroller}
      className={styles.feed}
      data-channel-timeline={channelId}
      onWheel={gesture}
      onTouchMove={gesture}
      onKeyDown={gesture}
      onPointerDown={gesture}
      onFocus={(event) => {
        setFocusedMessageId(
          event.target.closest<HTMLElement>("[data-message-id]")?.dataset
            .messageId,
        );
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocusedMessageId(undefined);
      }}
      tabIndex={0}
      aria-label="Channel message history"
      onScroll={(event) => {
        // React may receive this event before Virtua updates its handle metrics.
        const element = event.currentTarget;
        const v = handle.current;
        if (
          v &&
          settled.current &&
          element.clientWidth === size.width &&
          element.clientHeight === size.height
        ) {
          recordPosition(element);
          updateJumpToLatest(element);
        }
        loadNearTop(element);
      }}
    >
      <div className={styles.edge}>
        {window.error && <span role="alert">{window.error}</span>}
        {window.historyLimited ? (
          <span>History window limit reached</span>
        ) : window.hasMore ? (
          <Button
            type="button"
            disabled={window.loadingOlder}
            onClick={() => {
              queries.channels.loadOlder(channelId);
              const after = queries.channels.window(channelId);
              if (after.loadingOlder || after.error || after.status !== "ready")
                olderDemand.current = false;
            }}
          >
            {window.loadingOlder ? "Loading older…" : "Load older messages"}
          </Button>
        ) : null}
      </div>
      {showJumpToLatest && (
        <JumpToLatestButton
          newMessageCount={newMessageCount}
          onClick={jumpToLatest}
        />
      )}
      {width > 0 && (
        <Virtualizer
          ref={handle}
          scrollRef={scroller}
          shift={prepend}
          bufferSize={1600}
          // Reflow must not evict the focused control or a row's open report.
          keepMounted={keptIndices}
          as="ol"
          item="li"
          startMargin={EDGE_HEIGHT}
          {...(initialCache.current ? { cache: initialCache.current } : {})}
        >
          {rows.map((row, index) => {
            const day =
              index === 0
                ? true
                : new Date(
                    (rows[index - 1]?.createdAt ?? 0) * 1000,
                  ).toDateString() !==
                  new Date(row.createdAt * 1000).toDateString();
            return row.membership ? (
              <MembershipRow
                resolveName={resolveName}
                names={queries.names}
                key={row.id}
                row={row}
                profiles={profiles}
                viewer={viewer}
                media={queries.media}
                agentPubkeys={agentPubkeys}
                day={day}
              />
            ) : (
              <MessageRow
                layout={
                  continuesMessageGroup(rows[index - 1], row)
                    ? "continuation"
                    : "timeline"
                }
                session={queries}
                scope={scope}
                key={row.id}
                row={row}
                unread={queries.unread}
                extensions={extensions}
                profile={profiles.get(row.authorId)}
                participantProfiles={profiles}
                agentPubkeys={agentPubkeys}
                media={queries.media}
                onOpenLink={onOpenLink}
                canOpenLink={canOpenLink}
                onOpenThread={onOpenThread}
                {...(onOpenMediaReview ? { onOpenMediaReview } : {})}
                retry={queries.outbox?.retry}
                keepMounted={keepRowMounted}
                day={day}
              />
            );
          })}
        </Virtualizer>
      )}
      {!rows.length && !window.hasMore && (
        <p className={styles.empty}>No messages yet.</p>
      )}
    </section>
  );
}
