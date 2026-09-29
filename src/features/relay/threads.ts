import {
  canonicalChannel,
  MissingThreadBounds,
  threadBounds,
  type ThreadCursor,
} from "./thread-window";
import { threadReference } from "./thread-reference";
export { threadReference } from "./thread-reference";
import type { ChannelMessage } from "./contracts";
import type { EventData, ReadFilter, RelayEvent } from "./events";
import type { LocalEvents } from "./outbox";
import type { RelayReader } from "./reader";
import { byteSize } from "./budget";
import { foldMessages } from "./fold";
import { compareMessages, MessageClock } from "./message-order";
import { shareMessageRows } from "./row-identity";

const AUX = new Set([5, 7, 9005, 40003, 39005, 39006]);
const PAGE_SIZE = 50;
const INITIAL_WINDOW_SIZE = 10;
const MAX_PAGES = 10;
const MAX_EVENTS = 2000;
const MAX_BYTES = 4 * 1024 * 1024;
/** The relay's `thread_window` row allowlist excludes legacy diffs (kind 40008). */
const STRICT_WINDOW_KINDS = [9, 40002];
const contentKind = (event: EventData) =>
  [9, 40002, 40008].includes(event.kind);
const inChannel = (event: EventData, channelId: string) =>
  event.tags.some(([name, value]) => name === "h" && value === channelId);
/** Relay thread-cursor order (seconds, id); rendered order is `compareMessages`. */
const compare = (a: ThreadCursor, b: ThreadCursor) =>
  a.created_at - b.created_at || a.id.localeCompare(b.id);

export type ThreadSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  root: ChannelMessage | undefined;
  replies: readonly ChannelMessage[];
  error: string | undefined;
  /** Continuation is possible, not a claim about total thread size or exhaustion. */
  canLoadMore: boolean;
  limited: boolean;
  /** Older pages are demand-loaded; forward is the legacy bounded walk. */
  direction?: "older" | "forward";
  /** The in-flight or failed read, distinct from the traversal direction. */
  readKind?: "older" | "refresh" | undefined;
  /** Exact navigation target, folded independently of bounded thread traversal. */
  target?: ChannelMessage | undefined;
  targetStatus?: "loading" | "ready" | "unavailable" | "error" | undefined;
}>;
export type ThreadView = {
  snapshot(): ThreadSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  dispose(): void;
};

/** Session-owned evidence. Finite page cursors NEVER come from the live/local display union. */
export function createThreadView({
  channelId,
  messageId,
  relayAuthor,
  reader,
  seed,
  local,
  canAccess,
  visible,
  notify,
  exact = false,
  admit = (events) => events,
  clock = new MessageClock(),
}: {
  channelId: string;
  messageId: string;
  relayAuthor: string;
  reader: RelayReader;
  seed: RelayEvent | undefined;
  local: LocalEvents | undefined;
  canAccess(): boolean;
  visible(events: readonly RelayEvent[]): readonly RelayEvent[];
  notify(listener: () => void): void;
  exact?: boolean;
  /** The session's send clock; rendered replies raise its channel watermark. */
  clock?: MessageClock;
  /** Exact finite reads enter session reconciliation only after a complete fold. */
  admit?:
    | ((events: readonly RelayEvent[]) => readonly RelayEvent[])
    | undefined;
}) {
  let disposed = false;
  let rootId: string | undefined;
  let rootUnavailable = false;
  let targetStatus: ThreadSnapshot["targetStatus"] = exact
    ? "loading"
    : undefined;
  let remote: readonly RelayEvent[] = [];
  let staged: readonly RelayEvent[] = [];
  // Strict reads require transport-supplied binding authority. Missing scope is
  // a configuration error, not evidence of an old relay that permits fallback.
  let mode: "probe" | "older" | "legacy" = canonicalChannel.test(channelId)
    ? "probe"
    : "legacy";
  let cursor: ThreadCursor | undefined;
  let pages = 0;
  let controller: AbortController | undefined;
  let again = false;
  let snapshot: ThreadSnapshot = Object.freeze({
    status: "idle",
    root: undefined,
    replies: Object.freeze([]),
    error: undefined,
    canLoadMore: false,
    limited: false,
  });
  const listeners = new Set<() => void>();
  function related<T extends EventData>(events: readonly T[]): T[] {
    if (!rootId && !exact) return [];
    const rows = events.filter(
      (event) =>
        !AUX.has(event.kind) &&
        event.kind !== 39007 &&
        inChannel(event, channelId) &&
        (event.id === rootId ||
          (exact && event.id === messageId) ||
          (!!rootId && threadReference(event)?.rootId === rootId)),
    );
    const ids = new Set([
      ...(exact ? [messageId] : []),
      ...[...remote, ...staged, ...rows].map((event) => event.id),
    ]);
    const result = new Map(rows.map((event) => [event.id, event]));
    // Aux closure includes deletion of an auxiliary, not just direct row overlays.
    for (let hop = 0; hop < 2; hop++) {
      for (const event of events) {
        if (!AUX.has(event.kind) || result.has(event.id)) continue;
        if (
          event.tags.some(
            ([name, value]) => name === "e" && ids.has(value ?? ""),
          )
        ) {
          result.set(event.id, event);
          ids.add(event.id);
        }
      }
    }
    return [...result.values()];
  }
  function union(...batches: readonly (readonly RelayEvent[])[]) {
    return [
      ...new Map(batches.flat().map((event) => [event.id, event])).values(),
    ];
  }
  function notifyListeners() {
    for (const listener of listeners) notify(listener);
  }
  function publishStatus(patch: Partial<ThreadSnapshot>) {
    if (disposed) return;
    snapshot = Object.freeze({
      ...snapshot,
      ...patch,
      ...(exact
        ? {
            target: targetStatus === "ready" ? snapshot.target : undefined,
            targetStatus,
          }
        : {}),
    });
    notifyListeners();
  }
  function publish(patch: Partial<ThreadSnapshot> = {}) {
    if (disposed) return;
    const operations = canAccess() ? (local?.snapshot() ?? []) : [];
    const inputs = new Map(
      remote.map((event) => [event.id, event as EventData]),
    );
    for (const event of related(
      operations
        // Failed reply intent stays visible for same-event retry, just like channel
        // messages; failed edits/reactions must not change the rendered content.
        .filter((item) => item.delivery !== "failed" || contentKind(item.event))
        .map((item) => item.event),
    ))
      inputs.set(event.id, event);
    const deliveries = new Map(operations.map((item) => [item.event.id, item]));
    const rows = shareMessageRows(
      snapshot.root ? [snapshot.root, ...snapshot.replies] : snapshot.replies,
      foldMessages(
        channelId,
        relayAuthor,
        rootUnavailable && !exact ? [] : [...inputs.values()],
        {
          includeReplies: true,
        },
      ).map((row) => {
        const item = deliveries.get(row.id);
        return item
          ? Object.freeze({
              ...row,
              delivery: item.delivery,
              deliveryError: item.error,
            })
          : row;
      }),
    );
    const target =
      targetStatus === "ready"
        ? rows.find((row) => row.id === messageId)
        : undefined;
    if (targetStatus === "ready" && !target) targetStatus = "unavailable";
    const readable = rows.filter(
      (row) => !exact || row.id !== messageId || targetStatus === "ready",
    );
    const nextReplies = readable
      .filter(
        (row) =>
          row.id !== rootId && (!rootUnavailable || row.id === messageId),
      )
      .sort(compareMessages);
    for (const row of nextReplies)
      clock.observe(channelId, row.createdAtMs ?? row.createdAt * 1000);
    const replies =
      snapshot.replies.length === nextReplies.length &&
      snapshot.replies.every((row, index) => row === nextReplies[index])
        ? snapshot.replies
        : Object.freeze(nextReplies);
    snapshot = Object.freeze({
      ...snapshot,
      ...patch,
      root: !rootUnavailable
        ? readable.find((row) => row.id === rootId)
        : undefined,
      replies,
      ...(exact ? { target, targetStatus } : {}),
    });
    notifyListeners();
  }
  function retain(events: readonly RelayEvent[], commit = true) {
    if (events.length > MAX_EVENTS || byteSize(events) > MAX_BYTES) {
      // Never silently evict a deletion/ancestor then display resurrected content.
      controller?.abort();
      remote = [];
      staged = [];
      rootId = undefined;
      cursor = undefined;
      pages = 0;
      again = false;
      if (exact) targetStatus = "error";
      publish({
        status: "error",
        limited: true,
        canLoadMore: false,
        error:
          "Thread view exceeded its memory limit. Refresh to read from the beginning.",
      });
      return false;
    }
    if (commit) remote = events;
    return true;
  }
  function receive(events: readonly RelayEvent[]) {
    if (disposed || !canAccess() || (!rootId && !exact)) return;
    const incoming = related(events);
    if (!incoming.length) return;
    if (retain(union(remote, incoming))) {
      publish();
    }
  }
  if (seed && canAccess() && contentKind(seed) && inChannel(seed, channelId)) {
    rootId = threadReference(seed)?.rootId ?? seed.id;
    if (seed.id === rootId) remote = [seed];
    publish();
  }
  function purge(clear = false) {
    controller?.abort();
    controller = undefined;
    again = false;
    staged = [];
    if (exact) targetStatus = "loading";
    if (clear || !canAccess()) {
      remote = [];
      staged = [];
      rootId = undefined;
      cursor = undefined;
      pages = 0;
    } else remote = visible(remote);
    publish({
      status: "idle",
      canLoadMore: false,
      limited: false,
      error: canAccess()
        ? "Thread read interrupted. Refresh to continue."
        : "This channel is no longer available.",
      readKind: undefined,
    });
  }
  async function run(replace: boolean) {
    if (disposed) return;
    if (controller) {
      if (replace) again = true;
      return;
    }
    if (!canAccess()) {
      purge();
      return;
    }
    if (!replace && (!snapshot.canLoadMore || snapshot.limited)) return;
    const owned = new AbortController();
    controller = owned;
    const active = () =>
      !disposed && !owned.signal.aborted && controller === owned;
    const targetPages = replace ? Math.max(1, pages) : 1;
    let nextCursor = replace ? undefined : cursor;
    let nextPages = replace ? 0 : pages;
    let fetched: readonly RelayEvent[] = [];
    // Repair retains already-verified presentation; only a new/unavailable
    // selection waits for its initial fold. Never unmount a reader on reconnect.
    if (exact && replace && targetStatus !== "ready") targetStatus = "loading";
    publishStatus({
      status: "loading",
      error: undefined,
      readKind: replace ? "refresh" : "older",
    });
    try {
      if (exact && replace) {
        const response = await reader.read(
          [{ ids: [messageId], "#h": [channelId], limit: 1 }],
          { signal: owned.signal },
        );
        if (!active()) return;
        // Admit the immutable selected content before retention, just as normal
        // reads do. Only its separately fetched overlays wait for closure.
        const selected = admit(response);
        if (!active()) return;
        const event = selected.find(
          (event) =>
            event.id === messageId &&
            contentKind(event) &&
            inChannel(event, channelId),
        );
        if (!event) {
          targetStatus = "unavailable";
          publish({ status: "ready", canLoadMore: false });
          return;
        }
        rootId = threadReference(event)?.rootId ?? event.id;
        if (!retain(union(remote, [event]))) return;
        // ID reads do not expand overlays. Fold the selected row even when it
        // lies beyond the thread's traversal cap; its ID never supplies a cursor.
        const overlays = await reader.read(
          [
            {
              kinds: [5, 7, 9005, 40003, 39005],
              "#e": [messageId],
              limit: 500,
            },
          ],
          { signal: owned.signal },
        );
        if (!active()) return;
        staged = related(overlays);
        if (!retain(union(remote, staged), false)) return;
        const ids = union(remote, staged)
          .filter(
            (event) =>
              AUX.has(event.kind) &&
              event.tags.some(
                ([name, value]) => name === "e" && value === messageId,
              ),
          )
          .map((event) => event.id);
        if (ids.length) {
          const tombstones = await reader.read(
            [{ kinds: [5, 9005], "#e": ids, limit: 500 }],
            { signal: owned.signal },
          );
          if (!active()) return;
          staged = union(staged, related(tombstones));
          if (!retain(union(remote, staged), false)) return;
        }
        // Keep incomplete finite overlays out of both our displayed fold and
        // the shared observation path. Live evidence still reconciles immediately.
        const accepted = admit([event, ...staged]);
        if (!active() || !retain(union(remote, related(accepted)))) return;
        staged = [];
        targetStatus = "ready";
        publish();
        if (snapshot.targetStatus !== "ready") {
          publish({ status: "ready", canLoadMore: false });
          return;
        }
      }
      if (!rootId) {
        const selected = await reader.read(
          [{ ids: [messageId], "#h": [channelId], limit: 1 }],
          { signal: owned.signal },
        );
        if (!active()) return;
        const event = selected.find(
          (event) =>
            event.id === messageId &&
            contentKind(event) &&
            inChannel(event, channelId),
        );
        if (!event) throw new Error("The selected message is unavailable.");
        rootId = threadReference(event)?.rootId ?? event.id;
      }
      const rootFilter: ReadFilter = {
        ids: [rootId],
        "#h": [channelId],
        limit: 1,
      };
      let root: readonly RelayEvent[] = [];
      if (mode !== "legacy") {
        // Strict requests cannot batch an ID lookup with a window. Admit the
        // verified root first so channel-less root aux has visibility evidence.
        // Revalidate once per run, not once per page of a retained-range repair.
        const rootResponse = await reader.read([rootFilter], {
          signal: owned.signal,
        });
        if (!active()) return;
        root = admit(rootResponse);
        if (!active()) return;
        if (
          !root.some(
            (event) =>
              event.id === rootId &&
              contentKind(event) &&
              inChannel(event, channelId) &&
              !threadReference(event),
          )
        ) {
          rootUnavailable = true;
          cursor = undefined;
          pages = 0;
          publish({ canLoadMore: false });
          throw new Error("The original thread message is unavailable.");
        }
        if (!retain(union(remote, related(root)))) return;
      }
      let more = false;
      for (let page = 0; page < targetPages; page++) {
        const filter: ReadFilter = {
          kinds: [9, 40002, 40008],
          "#h": [channelId],
          "#e": [rootId],
          depth_limit: 100,
          limit: PAGE_SIZE,
          include_aux: true,
        };
        let response: readonly RelayEvent[];
        let bounds: ReturnType<typeof threadBounds> | undefined;
        if (mode !== "legacy") {
          try {
            const page = await reader.read(
              [
                {
                  ...filter,
                  kinds: STRICT_WINDOW_KINDS,
                  limit: nextPages === 0 ? INITIAL_WINDOW_SIZE : PAGE_SIZE,
                  thread_window: true,
                  ...(nextCursor
                    ? { until: nextCursor.created_at, before_id: nextCursor.id }
                    : {}),
                },
              ],
              { signal: owned.signal },
            );
            if (!active()) return;
            const bound = page.find((event) => event.kind === 39007);
            if (!bound) throw new MissingThreadBounds();
            bounds = threadBounds(bound); // Reader already verified signer and full request binding.
            mode = "older";
            response = [
              ...root,
              ...page.filter((event) => event.kind !== 39007),
            ];
          } catch (error) {
            if (!active()) return;
            if (
              !(error instanceof MissingThreadBounds) ||
              !error.legacyRows ||
              mode !== "probe"
            )
              throw error;
            // A 200 without bounds is not support. Probe rows never entered the
            // session; retry from scratch without a reverse cursor or opt-in.
            mode = "legacy";
            nextCursor = undefined;
            nextPages = 0;
            response = await reader.read([rootFilter, filter], {
              signal: owned.signal,
            });
          }
        } else {
          response = await reader.read(
            [
              rootFilter,
              {
                ...filter,
                ...(nextCursor
                  ? {
                      thread_cursor: nextCursor.created_at,
                      thread_cursor_id: nextCursor.id,
                    }
                  : {}),
              },
            ],
            { signal: owned.signal },
          );
        }
        if (!active()) return;
        const events = admit(response);
        if (!active()) return;
        if (
          !events.some(
            (event) =>
              event.id === rootId &&
              contentKind(event) &&
              inChannel(event, channelId) &&
              !threadReference(event),
          )
        ) {
          // Hide unavailable history without throwing away known tombstones.
          rootUnavailable = true;
          cursor = undefined;
          pages = 0;
          publish({ canLoadMore: false });
          throw new Error("The original thread message is unavailable.");
        }
        // Count traversal rows before presentation filtering. The bridge may return
        // other content kinds, and appended auxiliaries do not consume its page limit.
        const replies = events
          .filter(
            (event) =>
              !AUX.has(event.kind) &&
              event.id !== rootId &&
              inChannel(event, channelId) &&
              threadReference(event)?.rootId === rootId,
          )
          .sort(compare);
        if (
          !bounds &&
          replies.some((event) => nextCursor && compare(event, nextCursor) <= 0)
        )
          throw new Error(
            "Thread pagination did not advance. Refresh to try again.",
          );
        nextCursor = bounds
          ? (bounds.cursor ?? undefined)
          : (replies.at(-1) ?? nextCursor);
        nextPages++;
        fetched = union(fetched, related(events));
        if (fetched.length > MAX_EVENTS || byteSize(fetched) > MAX_BYTES) {
          retain(fetched);
          return;
        }
        // Only strict bounds prove exhaustion. Legacy short pages may be filtered
        // after LIMIT, so an empty continuation means merely no more returned.
        more = bounds ? bounds.hasMore : replies.length > 0;
        if (!more) break;
      }
      if (!active()) return;
      // A bounded response cannot retract observed evidence. Retain known edits,
      // tombstones and live rows even when a later finite read omits them.
      if (!retain(union(remote, fetched))) return;
      rootUnavailable = false;
      cursor = nextCursor;
      pages = nextPages;
      publish({
        status: "ready",
        error: undefined,
        readKind: undefined,
        direction: mode === "older" ? "older" : "forward",
        canLoadMore: more && pages < MAX_PAGES,
        limited: more && pages >= MAX_PAGES,
      });
    } catch (error) {
      if (active()) {
        if (targetStatus === "loading") targetStatus = "error";
        publishStatus({ status: "error", error: String(error) });
      }
    } finally {
      if (controller === owned) {
        staged = [];
        controller = undefined;
        if (again && !disposed) {
          again = false;
          void run(true);
        }
      }
    }
  }
  return {
    channelId,
    // Staged verified IDs allow immediate live delete-of-overlay access checks,
    // without publishing the incomplete finite overlay into any shared view.
    event: (id: string) =>
      [...remote, ...staged].find((event) => event.id === id),
    receive,
    purge,
    changed: () => publish(),
    view: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      refresh: () => run(true),
      loadMore: () => run(false),
      dispose() {
        listeners.clear();
        purge(true);
        disposed = true;
      },
    } satisfies ThreadView,
  };
}
