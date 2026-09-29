// FOUNDATION: One relay session owns reads, local intent, delivery and shared views.
import { npubEncode } from "nostr-tools/nip19";
import { createMemberAdditions } from "../channel-members/operations";
import { addChannelMember, startAddedAgent } from "../channel-members/members";
import type { AgentControl } from "../agents/control";
import type { GitRead } from "../projects/git";
import { projectDestinations } from "../projects/destinations";
import { createAgentChoices, templateAgentChoices } from "../agents/choices";
import { parseLineup } from "../channel-templates/model";
import { createChannelKit } from "../channel-templates/capability";
import {
  createChannelSetup,
  personalGroups,
  type ChannelCreationInput,
} from "../channel-templates/setup";
import { createPresence } from "../presence/presence";
import { createAgentMemories } from "../agents/memory";
import type { PresenceActivity } from "../presence/activity";
import { bindNames, type IdentityNames } from "../identity-names/service";
import { sessionMetadata } from "../sessions/metadata";
import { createChannelLifecycle } from "./channel-lifecycle";
import { createChannelDetails } from "./channel-details";
import { createWorkflows } from "../workflows/capability";
import { isWorkflowOperation } from "../workflows/protocol";
import {
  createRelayReader,
  type ReadOptions,
  type RelayReader,
} from "./reader";
import { createAgentActivity } from "../agents/activity";
import { OBSERVER_KIND } from "../agents/observer";
import { createDirectMessages } from "./direct-messages";
import { createWorkSessions } from "./work-sessions";
import { inventoryReader } from "../agents/inventory";
import {
  isOwnerInventoryFilter,
  readRelayLibrary,
} from "../agents/relay-library";
import { createAgentLibrary } from "../agents/library";
import { createIdentityArchives } from "./identity-archives";
import {
  createReadState,
  browserReadPublisherLock,
  type ReadPublisherLock,
} from "./read-state";
import {
  browserReadStateStorage,
  type ReadStateStorage,
} from "./read-state-storage";
import { createTyping } from "./typing";
import { createUnread } from "./unread";
import type { IncomingListener, IncomingMessage } from "./incoming";
import { objectBody } from "./body";
import type { ChannelList } from "./contracts";
import { createChannelActivity } from "./channel-activity";
import { readSidebarPreferences } from "./sidebar-preferences";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import { createUserStatuses } from "./user-status";
import {
  activeSidebarAssignment,
  readActiveSidebarGroups,
} from "./sidebar-personal-groups";
import { createEmojiDirectory } from "./emoji-directory";
import { EMOJI_SET_KIND } from "./emoji";
import { createProfileDirectory } from "./profile-directory";
import { createChannelStore, type ChannelStoreOptions } from "./store";
import { MessageClock } from "./message-order";
import { UploadError, type UploadedAttachment } from "./attachments";
import { PRODUCT_FEEDBACK_KIND } from "./product-feedback";
import type { ReadTransport } from "./transport";
import type { LiveSnapshot, LiveSubscription } from "./live";
import {
  hasTag,
  type ReadFilter,
  type RelayEvent,
  type EventData,
} from "./events";
import { eventVisibility } from "./event-access";
import { ReadError, readErrorKind } from "./errors";
import {
  PublishRejected,
  browserOutboxStorage,
  createOutbox,
  type LocalEvents,
  type OutgoingEvent,
  type OutboxStorage,
} from "./outbox";
import { createMessages } from "./messages";
import { createThreadView } from "./threads";
import { ByteLru } from "./budget";
import { createRelayProfiler } from "./profiling";
import {
  retainEvents,
  matchesEvent,
  projectEvents,
  type VisibleEvent,
} from "./projection";

export type EventViewSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  events: readonly VisibleEvent[];
  error?: string | undefined;
}>;

type PendingChannelCreation = Readonly<{
  signature: string;
  id: string;
  operation: string;
  input: ChannelCreationInput;
}>;
const channelId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function restoredChannelCreation(
  events: LocalEvents | undefined,
  owned?: (id: string) => boolean,
): PendingChannelCreation | undefined {
  for (const item of [...(events?.snapshot() ?? [])].reverse()) {
    const restored = parseChannelCreation(item);
    if (restored && !owned?.(restored.id)) return restored;
  }
}

function parseChannelCreation(
  item: OutgoingEvent,
): PendingChannelCreation | undefined {
  if (item.event.kind !== 9007) return;
  const tags = item.event.tags.filter(([name]) => name !== "client-id");
  const [h, name, visibility, channelType, ...optional] = tags;
  const id = h?.[1];
  const channelName = name?.[1];
  const channelVisibility = visibility?.[1];
  const optionalNames = optional.map(([key]) => key);
  const validOptionalOrder = [[], ["about"], ["ttl"], ["about", "ttl"]].some(
    (names) =>
      names.length === optionalNames.length &&
      names.every((key, index) => key === optionalNames[index]),
  );
  if (
    item.event.content !== "" ||
    h?.length !== 2 ||
    h[0] !== "h" ||
    id === undefined ||
    !channelId.test(id) ||
    name?.length !== 2 ||
    name[0] !== "name" ||
    channelName === undefined ||
    !channelName.trim() ||
    visibility?.length !== 2 ||
    visibility[0] !== "visibility" ||
    channelVisibility === undefined ||
    !["open", "private"].includes(channelVisibility) ||
    channelType?.length !== 2 ||
    channelType[0] !== "channel_type" ||
    channelType[1] !== "stream" ||
    !validOptionalOrder ||
    optional.some((tag) => tag.length !== 2)
  )
    return;
  const description = optional.find(([key]) => key === "about")?.[1]?.trim();
  if (sessionMetadata(description) !== undefined) return;
  const ttlValue = optional.find(([key]) => key === "ttl")?.[1];
  const ttlSeconds = ttlValue === undefined ? undefined : Number(ttlValue);
  if (
    ttlSeconds !== undefined &&
    (!Number.isInteger(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds > 2_147_483_647)
  )
    return;
  const input: ChannelCreationInput = Object.freeze({
    name: channelName.trim(),
    visibility: channelVisibility as "open" | "private",
    ...(description ? { description } : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
  return Object.freeze({
    signature: JSON.stringify(input),
    id,
    operation: item.event.id,
    input,
  });
}
/** Compose once per relay/viewer. Plugins get one interface; the host owns disposal. */
export function createRelaySession(
  transport: ReadTransport | null,
  options: ChannelStoreOptions & {
    identityNames?: IdentityNames | undefined;
    agentChoices?:
      | Pick<AgentControl, "snapshot" | "subscribe" | "refresh">
      | undefined;
    presenceActivity?: PresenceActivity;
    outboxStorage?: OutboxStorage;
    readStateStorage?: ReadStateStorage;
    readPublisherLock?: ReadPublisherLock;
    deliveryTimeoutMs?: number;
  } = {},
) {
  let closed = false;
  const lifetime = new AbortController();
  let uploadLifetime = new AbortController();
  function cancelUploads() {
    uploadLifetime.abort();
    uploadLifetime = new AbortController();
  }
  const profiling =
    options.profiling ?? transport?.profiling ?? createRelayProfiler();
  const requests = createRelayReader(transport, { profiling });
  let revision = 0;
  let accessEpoch = 0;
  let cacheClearEpoch = 0;
  let cacheClearing = 0;
  // Access changes update every owned snapshot before invoking subscribers.
  // A subscriber of one projection may synchronously read any other projection.
  let revoking = 0;
  const notifications = new Set<() => void>();
  const notify = (listener: () => void) => {
    if (revoking) notifications.add(listener);
    else listener();
  };
  let canAccess: (id: string) => boolean = () => true;
  const typing = createTyping(
    transport?.viewer ?? "",
    (id) =>
      !closed &&
      channels.canParticipate(id) &&
      channels.queries.list().channels.some((channel) => channel.id === id),
    notify,
  );
  const recent = new ByteLru<{ event: RelayEvent; revision: number }>(
    4096,
    8 * 1024 * 1024,
  );
  const observations = new Set<(events: readonly RelayEvent[]) => void>();
  const incomingListeners = new Set<IncomingListener>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pendingConfirmation = new Set<string>();
  const refreshers = new Set<() => Promise<void>>();
  const views = new Map<() => void, (clear?: boolean) => void>();
  const threads = new Set<ReturnType<typeof createThreadView>>();
  const writer = transport?.writer;
  const clock = new MessageClock();
  const uploadAttachment = transport?.uploadAttachment;
  const writes =
    transport && writer
      ? createOutbox(
          transport.viewer,
          {
            ...writer,
            async sign(template, signal) {
              validateMentionEvent(template);
              validateCanvasWrite(template);
              workflows.validate({
                ...template,
                id: "",
                pubkey: transport.viewer,
              });
              return writer.sign(template, signal);
            },
          },
          options.outboxStorage ??
            browserOutboxStorage(
              `${transport.scope ?? transport.relayAuthor}:${transport.viewer}`,
            ),
          {
            ...(options.deliveryTimeoutMs
              ? { timeoutMs: options.deliveryTimeoutMs }
              : {}),
            profiling,
            clock,
            notifyListener: notify,
            onAccepted: (event) => {
              // Product feedback is accepted into a private sidecar, not queryable history.
              if (event.kind !== PRODUCT_FEEDBACK_KIND) confirm(event);
            },
            needsReceipt: isWorkflowOperation,
            onReceipt: (event, message) => workflows.receipt(event, message),
            preparePublish: async (event, signal) => {
              workflows.validate(event);
              if (event.kind === 40100) {
                const id = event.tags.find((t) => t[0] === "h")?.[1];
                if (!id) throw new Error("Canvas has no channel");
                await workSessions.refreshMembership(id);
                signal.throwIfAborted();
                validateCanvasWrite(event);
              }
              const checkMentions = await prepareMentionPublication(
                event,
                signal,
              );
              return () => {
                workflows.validate(event);
                validateCanvasWrite(event);
                checkMentions?.();
              };
            },
          },
        )
      : undefined;
  const rawLocal = () => writes?.local.snapshot() ?? [];
  let retainedChannelEvent: (id: string) => RelayEvent | undefined = () =>
    undefined;
  function retainedThreadEvent(id: string) {
    for (const thread of threads) {
      if (!canAccess(thread.channelId)) continue;
      const event = thread.event(id);
      if (event) return event;
    }
  }
  function retainedEvent(id: string) {
    return retainedThreadEvent(id) ?? retainedChannelEvent(id);
  }
  const canReadRemote = (id: string) =>
    !options.cachedOnly && canAccess(id) && !channels.queries.get?.(id)?.cached;
  function visibility(events: readonly EventData[] = [], remote = false) {
    const evidence = new Map(
      [...rawLocal().map((item) => item.event), ...events].map((event) => [
        event.id,
        event,
      ]),
    );
    return eventVisibility(
      remote ? canReadRemote : canAccess,
      // Retained view targets survive shared-cache eviction. They are evidence,
      // not an access grant: eventVisibility still checks every referenced target.
      (id) =>
        evidence.get(id) ??
        recent.peek(id)?.event ??
        retainedEvent(id) ??
        unread.event(id),
    );
  }
  const local = () => {
    const visible = visibility();
    return rawLocal().filter(
      (item) =>
        item.event.kind !== PRODUCT_FEEDBACK_KIND && visible(item.event),
    );
  };
  const localViews = writes
    ? { snapshot: local, subscribe: writes.local.subscribe }
    : undefined;
  function revokeAccess(commit: () => void) {
    revoking++;
    try {
      accessEpoch++;
      cancelUploads();
      lifecycle.cancel();
      details.cancel();
      typing.clear();
      // Saved owner inventory does not depend on channel access. Preserve only
      // that narrow read; broad, mixed, ID and channel reads must still retire.
      requests.invalidate(
        (filters) =>
          !filters.length ||
          filters.some(
            (filter) => !isOwnerInventoryFilter(filter, transport?.viewer),
          ),
      );
      const visible = visibility();
      const revoked = recent
        .entries()
        .flatMap(([id, { event }]) =>
          event.kind === 0 || !visible(event) ? [id] : [],
        );
      // Purge before notifying: callbacks must not be able to reseed denied data.
      for (const id of revoked) recent.delete(id);
      channels.purgeAccess((events) => events.filter(visibility(events)));
      // An undismissed ordinary creation receipt is recovery intent until
      // creator membership completes. Session receipts remain revocable.
      writes?.purgeConfirmed(
        (event) =>
          !!parseChannelCreation({ event, delivery: "seen" }) ||
          (event.kind !== 0 && visible(event)),
      );
      profiles.clear();
      emoji.clear();
      statuses.clear();
      activity.clear();
      memories.clear();
      presence.clear();
      channelActivity.clear();
      activityRosterKey = undefined;
      archives.clear();
      workflows.clear();
      for (const purge of views.values()) purge();
      commit();
      unread.purge();
    } finally {
      if (--revoking === 0) {
        const pending = [...notifications];
        notifications.clear();
        for (const listener of pending) notify(listener);
      }
    }
  }
  async function readVerified(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
    channelTraffic = true,
  ) {
    if (
      options.cachedOnly ||
      filters.some((filter) =>
        filter["#h"]?.some((id) => channels.queries.get?.(id)?.cached),
      )
    )
      throw new ReadError(
        "unavailable",
        "Reconnect to refresh conversation access.",
      );
    const epoch = accessEpoch;
    let events: readonly RelayEvent[];
    try {
      events = await requests.reader.read(filters, settings);
    } catch (error) {
      // A single explicit channel has an unambiguous denial owner. A failed
      // broad/multi-channel read is not evidence that every channel was revoked.
      const ids = new Set(filters.flatMap((filter) => filter["#h"] ?? []));
      const [id] = ids;
      if (
        channelTraffic &&
        !closed &&
        epoch === accessEpoch &&
        readErrorKind(error) === "denied" &&
        ids.size === 1 &&
        id !== undefined &&
        filters.every((filter) => filter["#h"]?.length)
      )
        channels.denyChannel(id, error);
      throw error;
    }
    if (closed || epoch !== accessEpoch)
      throw new DOMException("Stale relay read", "AbortError");
    // A broken or stale transport must not promote private sidecar events into
    // finite reads, retained views, or store discovery.
    events = events.filter((event) => event.kind !== PRODUCT_FEEDBACK_KIND);
    // Ranked global search needs channel authority before visibility filtering.
    // Store metadata reads use channelTraffic=false, so this cannot recurse.
    if (
      channelTraffic &&
      filters.every(
        (filter) =>
          filter.search !== undefined &&
          !filter["#h"]?.length &&
          !!filter.kinds?.length &&
          filter.kinds.every((kind) => [9, 40002, 40008].includes(kind)),
      )
    ) {
      const ids = [
        ...new Set(
          events.flatMap((event) => {
            const tags = event.tags.filter(([name]) => name === "h");
            return [9, 40002, 40008].includes(event.kind) &&
              tags.length === 1 &&
              tags[0]?.[1]
              ? [tags[0][1]]
              : [];
          }),
        ),
      ];
      await channels.queries.resolve?.(ids, settings);
      events = events.filter((event) => {
        const destinations = event.tags.filter(([name]) => name === "h");
        const id = destinations[0]?.[1];
        return (
          destinations.length === 1 && !!id && !!channels.queries.get?.(id)
        );
      });
      settings?.signal?.throwIfAborted();
      if (closed || epoch !== accessEpoch)
        throw new DOMException("Stale relay search", "AbortError");
    }
    const visible = accept(events, channelTraffic);
    // Discovery must see signed grants/removals even when their channel is
    // currently denied; only the store interprets roster completeness.
    return channelTraffic
      ? visible
      : events.filter(
          (event) =>
            [39000, 39002].includes(event.kind) || visible.includes(event),
        );
  }
  const verified: RelayReader = { read: readVerified };
  function accept(
    events: readonly RelayEvent[],
    channelTraffic = true,
  ): readonly RelayEvent[] {
    if (closed) return [];
    // Authority precedes every projection, even in a batch containing both a
    // membership removal and message content. Store reads apply discovery at
    // their own completeness boundary instead.
    if (
      channelTraffic &&
      events.some((event) => [39000, 39002].includes(event.kind))
    )
      channels.acceptDiscovery(events);
    // Ephemeral typing and observer telemetry never enter retained content views.
    const visible = events
      .filter(
        (event) =>
          event.kind !== OBSERVER_KIND &&
          event.kind !== 20002 &&
          event.kind !== PRODUCT_FEEDBACK_KIND,
      )
      .filter(visibility(events, true));
    const epoch = accessEpoch;
    typing.accept(visible);
    if (closed || epoch !== accessEpoch) return [];
    profiling.measure(
      "events.reconcile",
      events[0]?.id ?? "empty",
      () => {
        for (const event of visible)
          recent.set(event.id, { event, revision: ++revision });
        reads.accept(visible);
        unread.accept(visible);
        writes?.observe(visible);
        if (epoch !== accessEpoch) return;
        profiles.accept(visible);
        if (epoch !== accessEpoch) return;
        emoji.accept(visible);
        if (epoch !== accessEpoch) return;
        statuses.accept(visible);
        if (epoch !== accessEpoch) return;
        if (channelTraffic) channels.accept(visible);
        for (const listener of observations) {
          if (closed || epoch !== accessEpoch) return;
          listener(visible);
        }
      },
      visible.length,
    );
    return visible;
  }
  function confirm(event: RelayEvent, attempt = 0) {
    if (closed || (attempt === 0 && pendingConfirmation.has(event.id))) return;
    pendingConfirmation.add(event.id);
    void verified
      .read([{ ids: [event.id], limit: 1 }], {
        priority: attempt === 0 ? "foreground" : "background",
      })
      .catch(() => [])
      .then(() => {
        if (closed) return;
        const operation = writes?.outbox
          .snapshot()
          .find((item) => item.event.id === event.id);
        if (!operation || operation.delivery === "seen" || attempt >= 4) {
          pendingConfirmation.delete(event.id);
          return;
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          confirm(event, attempt + 1);
        }, [500, 1500, 4000, 10000][attempt]);
        timers.add(timer);
      });
  }
  const presence = createPresence(
    transport,
    options.presenceActivity,
    (status, signal) =>
      traffic?.publishPresence?.(status, signal) ?? Promise.resolve(false),
    notify,
  );
  const profiles = createProfileDirectory(verified, localViews, notify);
  const emoji = createEmojiDirectory(
    verified,
    notify,
    transport?.viewer,
    transport &&
      writer &&
      uploadAttachment &&
      (!writer.kinds || writer.kinds.includes(EMOJI_SET_KIND))
      ? {
          writer,
          async upload(file, signal) {
            const combined = AbortSignal.any([
              signal,
              lifetime.signal,
              uploadLifetime.signal,
            ]);
            combined.throwIfAborted();
            if (closed) throw new UploadError("denied");
            const result = await uploadAttachment(file, combined);
            combined.throwIfAborted();
            if (closed) throw new UploadError("denied");
            return result;
          },
        }
      : undefined,
  );
  const statuses = createUserStatuses(
    verified,
    transport?.viewer,
    writer,
    notify,
  );
  let memoryConnected = !transport?.subscribe;
  const memories = createAgentMemories(
    transport?.readAgentMemories,
    transport?.viewer ?? "",
    () => !closed && !revoking && !cacheClearing && memoryConnected,
    notify,
  );
  const agentLibrary = createAgentLibrary(
    transport
      ? inventoryReader(transport.readAgentLibrary, (signal) =>
          readRelayLibrary(requests.reader, transport.viewer, signal),
        )
      : undefined,
    notify,
  );
  const agentChoices = createAgentChoices({
    scope: `${transport?.scope ?? transport?.relayAuthor}:${transport?.viewer}`,
    library: agentLibrary.queries,
    native: options.agentChoices,
    signal: lifetime.signal,
  });
  const nameSource = {
    viewer: transport?.viewer,
    profiles: profiles.queries,
    agentLibrary: agentLibrary.queries,
    relayUrl: transport?.scope,
  };
  const identityNames =
    options.identityNames?.bind(nameSource) ?? bindNames(nameSource);
  const activity = createAgentActivity(
    !!transport?.agentActivity && !!transport.subscribe,
    (generation) => traffic?.observe?.(generation),
    (channel) => canAccess(channel),
    notify,
  );
  const archives = createIdentityArchives(
    requests.reader,
    transport?.archiveAuthority,
    notify,
    { writer: transport?.identityArchive, viewer: transport?.viewer },
  );
  const channelActivity = createChannelActivity(
    transport?.channelActivity
      ? (ids, signal) =>
          transport.channelActivity?.(ids, signal) ?? Promise.resolve([])
      : undefined,
    notify,
  );
  const channels = createChannelStore(
    transport
      ? {
          read: (filters, settings) => readVerified(filters, settings, false),
          viewer: transport.viewer,
          relayAuthor: transport.relayAuthor,
          media: (url, size) => transport.media(url, size),
          revokeAccess,
          visible: (events) => events.filter(visibility(events)),
          restored: (events) => unread.accept(events),
          demand: (channelId) => demandChannel(channelId),
          rosterChanged: () => publishLive(),
        }
      : null,
    profiles,
    {
      ...options,
      profiling,
      clock,
      notifyListener: notify,
      ...(localViews ? { local: localViews } : {}),
    },
  );
  canAccess = channels.canAccess;
  retainedChannelEvent = channels.retainedEvent;
  const projects = projectDestinations(async (filters, signal) => {
    const bound = AbortSignal.any([signal, lifetime.signal]);
    bound.throwIfAborted();
    const events = await requests.reader.read(filters, { signal: bound });
    bound.throwIfAborted();
    // NIP-34/NIP-MP metadata is global; channel tags are associations, not ACLs.
    return events;
  });
  const details = createChannelDetails({
    reader: transport && !options.cachedOnly ? requests.reader : undefined,
    writer: transport?.channelDetails,
    viewer: transport?.viewer ?? "",
    relayAuthor: transport?.relayAuthor ?? "",
    canAccess: (id) => !closed && channels.canParticipate(id),
    acceptDiscovery: (events) => channels.acceptDiscovery(events),
  });
  const lifecycle = createChannelLifecycle({
    reader: transport && !options.cachedOnly ? requests.reader : undefined,
    writer: transport?.channelLifecycle,
    viewer: transport?.viewer ?? "",
    relayAuthor: transport?.relayAuthor ?? "",
    canAccess: (id) => !closed && channels.canParticipate(id),
    acceptDiscovery: (events) => channels.acceptDiscovery(events),
    removed: (id) =>
      channels.denyChannel(id, new Error("Channel is no longer available")),
  });
  const workflows = createWorkflows({
    reader: transport ? verified : undefined,
    viewer: transport?.viewer ?? "",
    outbox: writes?.outbox,
    local: localViews,
    host: transport?.workflows,
    relayHttpUrl: transport?.relayHttpUrl,
    canAccess: (channelId) => channels.canParticipate(channelId),
    notify,
  });
  let sourceChannelList = channels.queries.list();
  let activityChannelList: ChannelList = Object.freeze({
    ...sourceChannelList,
    activityStatus: channelActivity.status(),
  });
  let channelActivityRevision = channelActivity.revision();
  const channelQueries = Object.freeze({
    ...channels.queries,
    list() {
      const snapshot = channels.queries.list();
      const activityRevision = channelActivity.revision();
      if (
        snapshot === sourceChannelList &&
        activityRevision === channelActivityRevision
      )
        return activityChannelList;
      sourceChannelList = snapshot;
      channelActivityRevision = activityRevision;
      const projected = snapshot.channels.map((channel) => {
        const lastActivityAt = channelActivity.last(channel.id);
        return lastActivityAt === undefined
          ? channel
          : Object.freeze({ ...channel, lastActivityAt });
      });
      activityChannelList = Object.freeze({
        ...snapshot,
        activityStatus: channelActivity.status(),
        channels: projected.every(
          (channel, index) => channel === snapshot.channels[index],
        )
          ? snapshot.channels
          : Object.freeze(projected),
      });
      return activityChannelList;
    },
    subscribeList(listener: () => void) {
      const offChannels = channels.queries.subscribeList(listener);
      const offActivity = channelActivity.subscribe(listener);
      return () => {
        offChannels();
        offActivity();
      };
    },
  });
  const readScope = `${transport?.scope ?? transport?.relayAuthor ?? "offline"}:${transport?.viewer ?? ""}`;
  const reads = createReadState({
    viewer: transport?.viewer ?? "",
    reader: requests.reader,
    host: transport?.readState,
    storage:
      options.readStateStorage ??
      browserReadStateStorage(readScope, transport?.viewer ?? ""),
    lock: options.readPublisherLock ?? browserReadPublisherLock(readScope),
    notify,
    broadcastName: transport?.readState
      ? `buzz-read-state:${readScope}`
      : undefined,
  });
  const unread = createUnread({
    reads,
    channels: channels.queries,
    // Repair owns evidence only, not timeline/history ingestion. The shared
    // scheduler and verified transport stay shared; unread fences access epochs.
    reader: requests.reader,
    viewer: transport?.viewer ?? "",
    notify,
  });
  let traffic: LiveSubscription | undefined;
  const liveListeners = new Set<() => void>();
  let liveSnapshot: LiveSnapshot = Object.freeze({
    status: transport?.subscribe ? "connecting" : "unavailable",
    routes: Object.freeze([]),
  });
  type Catchup = {
    generation: number;
    state: "pending" | "verified" | "deferred" | "error";
    error?: string | undefined;
    retryAt?: number;
  };
  const catchups = new Map<string, Catchup>();
  let liveGeneration = 0;
  let liveView = Object.freeze({
    ...liveSnapshot,
    roster: channels.roster(),
    heads: Object.freeze(
      [] as {
        channelId: string;
        state: "pending" | "verified" | "deferred" | "error";
        error?: string;
      }[],
    ),
  });
  const publishLive = () => {
    if (closed) return;
    liveView = Object.freeze({
      ...liveSnapshot,
      ...(channels.suspendedPreviews().length
        ? {
            error:
              "Public preview access needs rechecking; retry live updates.",
          }
        : {}),
      roster: channels.roster(),
      heads: Object.freeze(
        [...catchups].map(([channelId, { state, error }]) =>
          Object.freeze({ channelId, state, ...(error ? { error } : {}) }),
        ),
      ),
    });
    for (const listener of liveListeners) notify(listener);
  };
  const live = Object.freeze({
    snapshot: () => liveView,
    subscribe(listener: () => void) {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    retry() {
      channels.retryList();
      revalidatePreviews(channels.suspendedPreviews());
      for (const id of channels.demandedChannels()) demandChannel(id);
      traffic?.retry();
    },
  });
  function validateMentions(channelId: string, pubkeys: readonly string[]) {
    if (!pubkeys.length) return;
    const channel = channels.queries
      .list()
      .channels.find((item) => item.id === channelId);
    if (
      closed ||
      !channels.canParticipate(channelId) ||
      !channel?.members ||
      channel.archived ||
      (transport?.subscribe && liveSnapshot.status !== "connected")
    )
      throw new Error("Refresh channel membership before mentioning anyone");
    if (pubkeys.some((key) => !channel.members?.includes(key)))
      throw new Error(
        "A selected recipient is no longer a channel member; remove them or refresh membership",
      );
  }
  function validateCanvasWrite(event: Pick<EventData, "kind" | "tags">) {
    if (event.kind !== 40100) return;
    const id = event.tags.find((t) => t[0] === "h")?.[1];
    if (!id || closed || !channels.canParticipate(id))
      throw new Error("Canvas access changed; your draft is kept");
  }
  function validateMentionEvent(event: Pick<EventData, "kind" | "tags">) {
    if (event.kind !== 9) return;
    const recipients = event.tags.filter(([name]) => name === "p");
    if (!recipients.length) return;
    if (
      recipients.length > 32 ||
      recipients.some(
        (tag) => tag.length !== 2 || !/^[0-9a-f]{64}$/.test(tag[1] ?? ""),
      )
    )
      throw new Error("Invalid mention recipients");
    const destinations = event.tags.filter(([name]) => name === "h");
    if (destinations.length !== 1 || !destinations[0]?.[1])
      throw new Error("A channel is required");
    validateMentions(
      destinations[0][1],
      recipients.map((tag) => tag[1] ?? ""),
    );
  }
  async function prepareMentionPublication(
    event: RelayEvent,
    signal: AbortSignal,
  ) {
    if (event.kind !== 9 || !event.tags.some(([name]) => name === "p")) return;
    // A stream may have missed membership changes. Neither AUTH nor a cached
    // roster proves freshness; each attempt prepares outside the dispatch phase.
    const generation = liveGeneration;
    const epoch = accessEpoch;
    const cleared = cacheClearEpoch;
    try {
      await preflightMentions(event, signal);
    } catch (error) {
      throw new PublishRejected(
        error instanceof Error
          ? error.message
          : "Mention rejected before dispatch",
      );
    }
    return () => {
      if (
        closed ||
        generation !== liveGeneration ||
        epoch !== accessEpoch ||
        cleared !== cacheClearEpoch
      )
        throw new PublishRejected(
          "Channel membership changed during mention verification; retry",
        );
      try {
        validateMentionEvent(event);
      } catch (error) {
        throw new PublishRejected(
          error instanceof Error
            ? error.message
            : "Mention rejected before dispatch",
        );
      }
    };
  }
  async function preflightMentions(event: EventData, signal?: AbortSignal) {
    validateMentionEvent(event);
    if (event.kind !== 9 || !event.tags.some(([name]) => name === "p")) return;
    if (!transport) throw new Error("Relay is unavailable");
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    if (!channelId) throw new Error("A channel is required");
    const epoch = accessEpoch;
    const generation = liveGeneration;
    const cleared = cacheClearEpoch;
    const events = await requests.reader.read(
      [
        {
          kinds: [39002],
          authors: [transport.relayAuthor],
          "#d": [channelId],
          limit: 1,
        },
      ],
      { ...(signal ? { signal } : {}), priority: "foreground", fresh: true },
    );
    signal?.throwIfAborted();
    if (
      closed ||
      epoch !== accessEpoch ||
      generation !== liveGeneration ||
      cleared !== cacheClearEpoch
    )
      throw new Error(
        "Channel membership changed during mention verification; retry",
      );
    // Transport verifies signatures. Require positive evidence at this exact
    // authority/coordinate; an empty or failed read is unknown, never permission.
    const roster = events[0];
    const coordinates = roster?.tags.filter(([name]) => name === "d");
    if (
      events.length !== 1 ||
      !roster ||
      roster.kind !== 39002 ||
      roster.pubkey !== transport.relayAuthor ||
      !hasTag(roster, "d", channelId) ||
      coordinates?.length !== 1 ||
      coordinates[0]?.length !== 2
    )
      throw new Error(
        "Could not verify current channel membership; refresh and retry",
      );
    accept([roster]);
    validateMentionEvent(event); // A newer live removal beats an older read result.
    if (
      !hasTag(roster, "p", transport.viewer) ||
      event.tags.some(
        ([name, key]) => name === "p" && !hasTag(roster, "p", key ?? ""),
      )
    )
      throw new Error(
        "A selected recipient is no longer a channel member; remove them or refresh membership",
      );
  }
  const workSessions = createWorkSessions(
    writes?.outbox,
    channels.queries,
    verified,
    lifetime.signal,
    writes?.local,
    async (id) => {
      if (!transport) return false;
      // Confirm only this viewer's exact creation receipt. Discovery may be
      // incomplete; this never admits the channel or grants content access.
      const events = await requests.reader.read(
        [{ kinds: [9007], ids: [id], authors: [transport.viewer], limit: 1 }],
        { signal: lifetime.signal, fresh: true },
      );
      return events.some(
        (event) =>
          event.id === id &&
          event.kind === 9007 &&
          event.pubkey === transport.viewer,
      );
    },
    () => agentChoices.snapshot().identities.map((agent) => agent.pubkey),
    transport?.relayAuthor,
    { read: (filters, settings) => readVerified(filters, settings, false) },
  );
  // Roster authority invalidates in-flight reads, including account-owned
  // preferences. Retry those once at the current epoch, never channel content
  // or a read cancelled by its caller/session/cache clear.
  const preferenceReader = {
    async read(filters: readonly ReadFilter[], settings?: ReadOptions) {
      const epoch = accessEpoch;
      const cleared = cacheClearEpoch;
      try {
        return await verified.read(filters, settings);
      } catch (error) {
        if (
          readErrorKind(error) !== "cancelled" ||
          lifetime.signal.aborted ||
          settings?.signal?.aborted ||
          epoch === accessEpoch ||
          cleared !== cacheClearEpoch ||
          !filters.every(
            (filter) =>
              filter.kinds?.length === 1 &&
              filter.kinds[0] === 30078 &&
              filter.authors?.length === 1 &&
              filter.authors[0] === transport?.viewer,
          )
        )
          throw error;
        return verified.read(filters, settings);
      }
    },
  };
  const channelKit = createChannelKit({
    host: transport?.channelKit,
    reader: preferenceReader,
    outbox: writes?.outbox,
    local: writes?.local,
    ready: writes?.ready,
    viewer: transport?.viewer ?? "",
    community: transport?.scope ?? "",
    signal: lifetime.signal,
    canWrite: (id) => !closed && channels.canParticipate(id),
    delivered: workSessions.delivered,
  });
  const sidebarPreferences = createSidebarPreferencesStore(
    async (signal?: AbortSignal) => {
      const decode = transport?.decodeSidebarPreferences;
      if (closed || !transport || !decode)
        throw new Error(
          "Saved sidebar preferences are unavailable in this host",
        );
      const combined = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(10_000),
        ...(signal ? [signal] : []),
      ]);
      const legacy = await readSidebarPreferences(
        preferenceReader,
        transport.viewer,
        decode,
        combined,
      );
      return readActiveSidebarGroups(channelKit.capability, legacy, combined);
    },
    !!transport?.decodeSidebarPreferences,
    (() => {
      const write = transport?.writeSidebarAssignment;
      return write
        ? activeSidebarAssignment(channelKit.capability, (intent, signal) =>
            write(
              intent,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            ),
          )
        : undefined;
    })(),
    (() => {
      const write = transport?.writeSidebarStar;
      return write
        ? (intent, signal) =>
            write(
              intent,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    notify,
    (() => {
      const write = transport?.writeSidebarMute;
      return write
        ? (intent, signal) =>
            write(
              intent,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    (() => {
      const write = transport?.writeSidebarSort;
      return write
        ? (group, mode, sectionIds, signal) =>
            write(
              group,
              mode,
              sectionIds,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    options.persistence,
  );
  let groupHead: string | undefined;
  const stopSidebarGroups = channelKit.capability.subscribe(() => {
    const state = channelKit.capability.snapshot();
    if (state.status !== "ready") return;
    const head = personalGroups(state.entries)?.eventId;
    if (head === groupHead) return;
    groupHead = head;
    void sidebarPreferences.queries.refresh();
  });
  type SetupNotice = Readonly<{ id: string; name: string; error: string }>;
  let setupNotices: readonly SetupNotice[] = [];
  const setupListeners = new Set<() => void>();
  const notifySetup = () =>
    setupListeners.forEach((listener) => {
      listener();
    });
  const channelSetup =
    transport && writes && transport.channelKit
      ? createChannelSetup({
          scope: `${transport.scope ?? transport.relayAuthor}:${transport.viewer}`,
          outbox: writes.outbox,
          local: writes.local,
          signal: lifetime.signal,
          changed: notifySetup,
          create: (id, input, active) =>
            workSessions.createChannel(
              id,
              input.name,
              input.visibility,
              input.description,
              input.ttlSeconds,
              active,
            ),
          delivered: (id, active) =>
            workSessions.delivered(
              id,
              active,
              false,
              !!active && !workSessions.failed(id),
            ),
          confirm: async (id) => {
            await workSessions.delivered(id, undefined, false, false);
            if (
              !(
                await verified.read([{ ids: [id], limit: 1 }], {
                  signal: lifetime.signal,
                  fresh: true,
                })
              ).some((event) => event.id === id)
            )
              throw new Error("Setup is awaiting exact relay confirmation");
          },
          refresh: (id, member) => workSessions.refresh(id, { member }, false),
          canvasHead: async (id) => (await channelKit.canvas.read(id))?.id,
          async preflight(input) {
            if (
              !input.name.trim() ||
              [...input.name.trim()].length > 120 ||
              (input.description &&
                ([...input.description].length > 1000 ||
                  input.description.includes("Buzz session ("))) ||
              !["open", "private"].includes(input.visibility) ||
              (input.ttlSeconds !== undefined &&
                (!Number.isInteger(input.ttlSeconds) ||
                  input.ttlSeconds <= 0 ||
                  input.ttlSeconds > 2_147_483_647))
            )
              throw new Error(
                "Check the channel name, description, privacy and duration before creating it",
              );
            if (!workSessions.available)
              throw new Error("Channel creation is unavailable");
            const setup = input.setup;
            if (!setup) return;
            parseLineup({ ...setup, teamIds: [] });
            if (
              setup.groupSource !== undefined &&
              setup.groupSource !== "legacy"
            )
              throw new Error("Invalid group source");
            if (
              typeof setup.groupId !== "string" ||
              setup.groupId.length >
                (setup.groupSource === "legacy" ? 256 : 128) ||
              (setup.groupId !== "" &&
                (setup.groupSource === "legacy"
                  ? !setup.groupId.trim()
                  : !/^[a-zA-Z0-9_-]{1,128}$/.test(setup.groupId))) ||
              typeof setup.templateId !== "string" ||
              (setup.templateId !== "" &&
                !/^[a-zA-Z0-9_-]{1,128}$/.test(setup.templateId))
            )
              throw new Error("Invalid template or group selection");
            if (setup.canvas && !channelKit.canvas.available)
              throw new Error("Canvas writing is unavailable");
            if (setup.agents.length && !writes.outbox.supports(9000))
              throw new Error("Agent membership is unavailable");
            // These independent checks share the critical path, not a dependency.
            // Native teams never consume the legacy inventory as a fallback.
            await Promise.all([
              ...(setup.agents.length
                ? [
                    agentChoices.refresh("templates"),
                    archives.queries.refresh(),
                  ]
                : []),
              ...(setup.groupId ? [sidebarPreferences.queries.refresh()] : []),
            ]);
            lifetime.signal.throwIfAborted();
            if (setup.agents.length) {
              if (archives.queries.snapshot().status !== "ready")
                throw new Error(
                  "Agent archive state is unavailable; refresh before creating this lineup",
                );
              const choices = agentChoices.snapshot();
              if (choices.templates.status !== "ready")
                throw new Error(
                  choices.templates.error ??
                    "Agent inventory is unavailable; refresh before creating this lineup",
                );
              // Re-read the shared selection after awaits; process status is not eligibility.
              const available = new Set(
                templateAgentChoices(choices, channels.queries.list()).map(
                  (a) => a.pubkey,
                ),
              );
              const unavailable = setup.agents.filter(
                (key) =>
                  !available.has(key) ||
                  archives.queries.state(key) !== "not-archived",
              );
              if (unavailable.length)
                throw new Error(
                  `Selected agents are unavailable in this community: ${unavailable.map(npubEncode).join(", ")}. Refresh agents or remove them before creating the channel.`,
                );
            }
            if (setup.groupId) {
              const state = sidebarPreferences.queries.snapshot();
              if (
                !sidebarPreferences.queries.writable ||
                (setup.groupSource === "legacy") !==
                  (state.data?.groupSource !== "personal") ||
                !state.data?.sections.some((g) => g.id === setup.groupId)
              )
                throw new Error(
                  "The destination group is unavailable; refresh your sidebar before creating the channel",
                );
            }
          },
          async place(id, groupId, source) {
            await sidebarPreferences.queries.refresh();
            const state = sidebarPreferences.queries.snapshot();
            if (
              !sidebarPreferences.queries.writable ||
              (source === "legacy") !==
                (state.data?.groupSource !== "personal") ||
              !state.data?.sections.some((g) => g.id === groupId)
            )
              throw new Error(
                "The destination group changed or is unavailable; keep the partial channel and choose its group separately",
              );
            if (state.data.assignments[id] === groupId) return;
            await sidebarPreferences.queries.assign(id, groupId);
          },
        })
      : undefined;
  let pendingChannelCreation: PendingChannelCreation | undefined =
    restoredChannelCreation(writes?.local, channelSetup?.owns);
  let restoredOperation = pendingChannelCreation?.operation;
  const pendingCreation = () => {
    const restored = restoredChannelCreation(writes?.local, channelSetup?.owns);
    if (restored?.operation !== restoredOperation) {
      restoredOperation = restored?.operation;
      pendingChannelCreation = restored;
    }
    return pendingChannelCreation;
  };
  const channelCreation = Object.freeze({
    available: workSessions.available,
    subscribe: (listener: () => void) => {
      const local = writes?.local.subscribe(listener);
      setupListeners.add(listener);
      return () => {
        local?.();
        setupListeners.delete(listener);
      };
    },
    snapshot: () => channelSetup?.snapshot() ?? pendingCreation()?.input,
    notices: () => setupNotices,
    dismissNotice(id: string) {
      setupNotices = setupNotices.filter((item) => item.id !== id);
      notifySetup();
    },
    async create(input: ChannelCreationInput) {
      if (!transport) throw new Error("The community connection changed.");
      await writes?.ready;
      if (channelSetup && !pendingCreation()) {
        const run = channelSetup.run(input, transport.viewer);
        let opened: string | undefined;
        void run.completion.catch((error) => {
          if (!opened || lifetime.signal.aborted) return;
          setupNotices = [
            ...setupNotices,
            { id: opened, name: input.name, error: String(error) },
          ];
          notifySetup();
        });
        opened = await run.admission;
        return opened;
      }
      if (input.setup)
        throw new Error("Template setup is unavailable on this host");
      const normalized: ChannelCreationInput = {
        name: input.name.trim(),
        visibility: input.visibility,
        ...(input.description?.trim()
          ? { description: input.description.trim() }
          : {}),
        ...(input.ttlSeconds !== undefined
          ? { ttlSeconds: input.ttlSeconds }
          : {}),
      };
      const signature = JSON.stringify(normalized);
      await writes?.ready;
      const existing = pendingCreation();
      if (existing?.signature !== signature) {
        if (existing)
          throw new Error(
            "Another channel is still awaiting confirmation. Retry it before changing the details.",
          );
        const id = crypto.randomUUID();
        pendingChannelCreation = {
          signature,
          id,
          input: Object.freeze(normalized),
          operation: workSessions.createChannel(
            id,
            normalized.name,
            normalized.visibility,
            normalized.description,
            normalized.ttlSeconds,
          ),
        };
        restoredOperation = pendingChannelCreation.operation;
      }
      const pending = pendingChannelCreation;
      if (!pending) throw new Error("Channel creation could not be prepared.");
      try {
        await workSessions.delivered(
          pending.operation,
          () => !lifetime.signal.aborted,
          false,
          !workSessions.failed(pending.operation),
        );
        await workSessions.refresh(
          pending.id,
          { member: transport.viewer },
          false,
        );
        await writes?.outbox.dismiss(pending.operation);
        pendingChannelCreation = undefined;
        if (channelSetup?.recovered(pending.id)) {
          setupNotices = [
            ...setupNotices,
            {
              id: pending.id,
              name: pending.input.name,
              error:
                "Channel confirmed. Saved setup was not continued; check its group, Canvas and members before finishing them manually.",
            },
          ];
          notifySetup();
        }
        return pending.id;
      } catch (error) {
        if (workSessions.failed(pending.operation)) {
          await workSessions.discardFailed(pending.operation);
          pendingChannelCreation = undefined;
        }
        throw error;
      }
    },
  });
  const memberAdditions = createMemberAdditions(
    lifetime.signal,
    async (channelId, pubkey, intent): Promise<void> => {
      await addChannelMember(
        session,
        channelId,
        pubkey,
        lifetime.signal,
        intent,
        writes?.local,
      );
    },
    async (channelId, pubkey, control, retryStart): Promise<void> => {
      await startAddedAgent(
        control,
        session,
        channelId,
        pubkey,
        lifetime.signal,
        retryStart,
      );
    },
    writes?.local,
  );
  const session = Object.freeze({
    memberAdditions,
    presence,
    viewer: transport?.viewer,
    relayAuthor: transport?.relayAuthor,
    authorizeAgentLog: transport?.authorizeAgentLog,
    scope: readScope,
    /** Verified new live-route messages, after reconciliation. Never history or local intent. */
    subscribeIncoming(listener: IncomingListener) {
      if (closed) return () => {};
      incomingListeners.add(listener);
      return () => {
        incomingListeners.delete(listener);
      };
    },
    typing: typing.capability,
    channelCreation,
    channelKit: channelKit.capability,
    canvas: channelKit.canvas,
    workSessions,
    directMessages: createDirectMessages(
      transport,
      verified,
      channels.queries,
      writes?.outbox,
      writes?.local,
      lifetime.signal,
      {
        async read(filters, settings) {
          const cleared = cacheClearEpoch;
          const generation = liveGeneration;
          // Directory reads bypass shared profile admission. Retry one access
          // invalidation here, where caller/cache/connection lifetimes are known.
          for (let attempt = 0; ; attempt++) {
            const epoch = accessEpoch;
            try {
              const events = await requests.reader.read(filters, settings);
              settings?.signal?.throwIfAborted();
              if (
                closed ||
                epoch !== accessEpoch ||
                cleared !== cacheClearEpoch ||
                generation !== liveGeneration
              )
                throw new DOMException("Stale directory read", "AbortError");
              return events;
            } catch (error) {
              if (
                attempt > 0 ||
                readErrorKind(error) !== "cancelled" ||
                closed ||
                settings?.signal?.aborted ||
                epoch === accessEpoch ||
                cleared !== cacheClearEpoch ||
                generation !== liveGeneration
              )
                throw error;
            }
          }
        },
      },
    ),
    unread: unread.capability,
    sidebarPreferences: sidebarPreferences.queries,
    live,
    profiling,
    attachments:
      uploadAttachment && writes?.outbox.supports(9)
        ? Object.freeze({
            async upload(file: File, channelId: string, signal: AbortSignal) {
              const combined = AbortSignal.any([
                signal,
                lifetime.signal,
                uploadLifetime.signal,
              ]);
              combined.throwIfAborted();
              if (!channelId || closed || !channels.canParticipate(channelId))
                throw new UploadError("denied");
              const result = await uploadAttachment(file, combined);
              combined.throwIfAborted();
              if (!channels.canParticipate(channelId))
                throw new UploadError("denied");
              return result;
            },
          })
        : undefined,
    // Feedback text is private to the operator inbox; uploaded files retain
    // ordinary community-media access, matching Desktop's attachment path.
    feedbackUpload:
      uploadAttachment &&
      writes?.outbox.supports(PRODUCT_FEEDBACK_KIND) &&
      transport?.scope
        ? Object.freeze({
            origin: transport.scope,
            async upload(
              file: File,
              signal: AbortSignal,
            ): Promise<UploadedAttachment> {
              const combined = AbortSignal.any([signal, lifetime.signal]);
              combined.throwIfAborted();
              if (closed) throw new UploadError("denied");
              const result = await uploadAttachment(file, combined);
              combined.throwIfAborted();
              if (closed) throw new UploadError("denied");
              return result;
            },
          })
        : undefined,
    messages: createMessages(
      writes?.outbox,
      transport?.viewer,
      (id) =>
        local().find((item) => item.event.id === id)?.event ??
        recent.peek(id)?.event ??
        retainedEvent(id),
      emoji.tags,
      validateMentions,
      (id) => !closed && channels.canParticipate(id),
      transport?.scope,
      writer && (!writer.kinds || writer.kinds.includes(1984))
        ? async (template) => {
            if (closed) throw new Error("Relay session closed");
            const signal = AbortSignal.any([
              lifetime.signal,
              AbortSignal.timeout(10_000),
            ]);
            // Race each step so the deadline holds even if the writer ignores `signal`.
            const aborted = new Promise<never>((_, reject) => {
              const fail = () => reject(signal.reason);
              if (signal.aborted) fail();
              else signal.addEventListener("abort", fail, { once: true });
            });
            const signed = await Promise.race([
              writer.sign(template, signal),
              aborted,
            ]);
            signal.throwIfAborted();
            await Promise.race([writer.publish(signed, signal), aborted]);
          }
        : undefined,
    ),
    /** An owned bounded thread reader. Dispose on close; the session retains access/lifetime authority. */
    thread(
      channelId: string,
      messageId: string,
      options?: { exact?: boolean },
    ) {
      if (closed || views.size >= 64)
        throw new Error("Relay view capacity unavailable");
      if (!/^[0-9a-f]{64}$/.test(messageId))
        throw new Error("Thread needs a valid message ID");
      const thread = createThreadView({
        channelId,
        messageId,
        relayAuthor: transport?.relayAuthor ?? "",
        reader: options?.exact
          ? {
              async read(filters, settings) {
                if (!canReadRemote(channelId))
                  throw new ReadError(
                    "unavailable",
                    "Reconnect to refresh conversation access.",
                  );
                const epoch = accessEpoch;
                let events: readonly RelayEvent[];
                try {
                  events = await requests.reader.read(filters, settings);
                } catch (error) {
                  if (
                    !closed &&
                    epoch === accessEpoch &&
                    readErrorKind(error) === "denied"
                  )
                    channels.denyChannel(channelId, error);
                  throw error;
                }
                if (
                  closed ||
                  epoch !== accessEpoch ||
                  !canReadRemote(channelId)
                )
                  throw new DOMException("Stale thread target", "AbortError");
                settings?.signal?.throwIfAborted();
                // A capped raw target/overlay read cannot establish a safe fold.
                if (
                  !filters.some((filter) => filter.depth_limit) &&
                  events.length >= 500
                )
                  throw new Error(
                    "Selected message exceeded its evidence limit",
                  );
                // The thread owner admits the complete target fold atomically.
                return events.filter(
                  (event) => event.kind !== PRODUCT_FEEDBACK_KIND,
                );
              },
            }
          : verified,
        exact: options?.exact ?? false,
        admit: options?.exact ? (events) => accept(events, false) : undefined,
        seed: recent.peek(messageId)?.event ?? retainedEvent(messageId),
        local: localViews,
        clock,
        canAccess: () => !closed && canAccess(channelId),
        visible: (events) => events.filter(visibility(events)),
        notify,
      });
      threads.add(thread);
      thread.receive(recent.entries().map(([, item]) => item.event));
      observations.add(thread.receive);
      const unsubscribe = localViews?.subscribe(thread.changed);
      const dispose = () => {
        thread.view.dispose();
        unsubscribe?.();
        observations.delete(thread.receive);
        threads.delete(thread);
        views.delete(dispose);
      };
      views.set(dispose, thread.purge);
      return { ...thread.view, dispose };
    },
    channels: channelQueries,
    names: identityNames,
    profiles: profiles.queries,
    emoji: emoji.queries,
    statuses: statuses.queries,
    agentLibrary: agentLibrary.queries,
    agentChoices,
    workflows: workflows.capability,
    projects,
    projectGit: transport?.projectGit
      ? {
          async read(input: GitRead, signal: AbortSignal) {
            const bound = AbortSignal.any([signal, lifetime.signal]);
            bound.throwIfAborted();
            const host = transport.projectGit;
            if (!host) throw new Error("Repository reads unavailable");
            const result = await host.read(input, bound);
            bound.throwIfAborted();
            return result;
          },
        }
      : undefined,
    channelLifecycle: lifecycle.capability,
    channelDetails: details.capability,
    agentActivity: activity.queries,
    agentMemories: memories.capability,
    archives: archives.queries,
    media: (url: string, size?: "small") => transport?.media(url, size),
    /** A plugin may request writes from this same interface when the host supports them. */
    outbox: writes?.outbox,
    async read(filters: readonly ReadFilter[], settings?: ReadOptions) {
      const began = revision;
      const epoch = accessEpoch;
      const result = await verified.read(filters, settings);
      // Applying discovery can itself revoke access. Let that authority-only
      // read finish under current visibility; content/search completions must
      // still be fenced, including mixed discovery + content requests.
      const discoveryOnly =
        filters.length > 0 &&
        filters.every(
          (filter) =>
            !!filter.kinds?.length &&
            filter.kinds.every((kind) => [39000, 39002].includes(kind)),
        );
      if (closed || (epoch !== accessEpoch && !discoveryOnly))
        throw new DOMException("Stale relay read", "AbortError");
      const merged = new Map(result.map((event) => [event.id, event]));
      for (const [id, observation] of recent.entries()) {
        if (
          observation.revision > began &&
          filters.some((filter) => matchesEvent(observation.event, filter))
        )
          merged.set(id, observation.event);
      }
      const events = [...merged.values()];
      return projectEvents(events.filter(visibility(events)), local(), filters);
    },
    /** An owned retained event view, not a replacement query snapshot. Limits bound
     * requests, not retained results. Ranked search/feed filters require read().
     * Subscribe, refresh and dispose with the plugin's scope. */
    observe(input: readonly ReadFilter[]) {
      if (
        input.some(
          (filter) =>
            filter.search !== undefined || filter.feed_types !== undefined,
        )
      )
        throw new Error(
          "Observed views do not support ranked search/feed filters; use session.read() instead",
        );
      if (closed || views.size >= 64)
        throw new Error("Relay view capacity unavailable");
      const filters: readonly ReadFilter[] = JSON.parse(JSON.stringify(input));
      let remote: readonly RelayEvent[] = retainEvents(
        recent.entries().flatMap(([, { event }]) => {
          return filters.some((filter) => matchesEvent(event, filter))
            ? [event]
            : [];
        }),
      );
      remote = remote.filter(visibility(remote));
      let snapshot: EventViewSnapshot = Object.freeze({
        status: "idle",
        events: projectEvents(remote, local(), filters),
      });
      let controller: AbortController | undefined;
      let disposed = false;
      const listeners = new Set<() => void>();
      const update = (patch: Partial<EventViewSnapshot> = {}) => {
        if (disposed) return;
        remote = remote.filter(visibility(remote));
        const events = projectEvents(remote, local(), filters, snapshot.events);
        const next = { ...snapshot, ...patch, events };
        if (
          next.events === snapshot.events &&
          next.status === snapshot.status &&
          next.error === snapshot.error
        )
          return;
        snapshot = Object.freeze(next);
        for (const listener of listeners) notify(listener);
      };
      const receive = (incoming: readonly RelayEvent[]) => {
        const matching = incoming.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
        if (!matching.length) {
          update();
          return;
        }
        const merged = new Map(remote.map((event) => [event.id, event]));
        for (const event of matching) merged.set(event.id, event);
        // Each owned view retains its own bounded evidence, independently of shared-cache eviction.
        remote = retainEvents([...merged.values()]);
        update();
      };
      observations.add(receive);
      const unsubscribe = writes?.local.subscribe(() => update());
      const dispose = () => {
        disposed = true;
        controller?.abort();
        unsubscribe?.();
        observations.delete(receive);
        listeners.clear();
        views.delete(dispose);
        refreshers.delete(view.refresh);
      };
      views.set(dispose, (clear = false) => {
        controller?.abort();
        controller = undefined;
        const visible = visibility(remote);
        remote = clear
          ? []
          : remote.filter((event) => event.kind !== 0 && visible(event));
        update({ status: "idle", error: undefined });
      });
      const view = {
        snapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async refresh() {
          if (disposed || closed || controller) return;
          const owned = new AbortController();
          controller = owned;
          update({ status: "loading", error: undefined });
          try {
            const events = await verified.read(filters, {
              signal: owned.signal,
            });
            if (disposed || owned.signal.aborted) return;
            remote = retainEvents([...events, ...remote]);
            update({ status: "ready" });
          } catch (error) {
            if (!disposed && !owned.signal.aborted)
              update({ status: "error", error: String(error) });
          } finally {
            if (controller === owned) controller = undefined;
          }
        },
        dispose,
      };
      refreshers.add(view.refresh);
      return view;
    },
  });
  function revalidatePreviews(ids: readonly string[]) {
    for (let start = 0; start < ids.length; start += 128) {
      void channels.queries
        .resolve?.(ids.slice(start, start + 128), { signal: lifetime.signal })
        // A failed/cancelled lookup stays suspended and visible in live status.
        // Retry is deliberate; no independent recovery timer or signed denial.
        .catch(() => {})
        .finally(publishLive);
    }
  }
  let rosterTimer: ReturnType<typeof setTimeout> | undefined;
  function refreshRoster() {
    if (closed || rosterTimer) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      rosterTimer = undefined;
      if (!closed) channels.queries.refreshList?.();
    }, 0);
    rosterTimer = timer;
    timers.add(timer);
  }
  const updateInterests = () => {
    if (closed) return;
    const joined = channels.queries
      .list()
      .channels.filter((channel) => !channel.cached)
      .map((channel) => channel.id);
    const ids = [
      ...new Set([
        ...joined,
        ...channels
          .demandedChannels()
          .filter(
            (id) =>
              channels.canAccess(id) && !channels.queries.get?.(id)?.cached,
          ),
      ]),
    ];
    const wanted = new Set(ids);
    for (const id of catchups.keys()) if (!wanted.has(id)) catchups.delete(id);
    try {
      traffic?.prioritize?.(channels.demandedChannels());
      traffic?.update(ids, joined);
    } catch (error) {
      liveSnapshot = { ...liveSnapshot, status: "error", error: String(error) };
    }
    publishLive();
    warmRoster();
  };
  /** Warm every channel's head before it is opened: starred first, then the
   * rest by recency. The account preferences own the starred set, so warming
   * waits for them to settle; a slow read delays warmth, never demand loading. */
  const warmRoster = () => {
    if (closed || !options.warm) return;
    const prefs = sidebarPreferences.queries.snapshot();
    if (prefs.status === "idle" || prefs.status === "loading") return;
    channels.queries.warm?.(prefs.data?.starred ?? []);
  };
  const stopWarmPreferences = sidebarPreferences.queries.subscribe(warmRoster);
  // Starred-first warming needs the account preferences without waiting for
  // the sidebar page to mount and observe them.
  if (options.warm) void sidebarPreferences.queries.ensure();
  let refreshedGeneration = -1;
  const catchupRunning = new Map<string, Catchup>();
  const catchupQueue = new Set<string>();
  const isChannelHead = (filters: readonly ReadFilter[], channelId: string) =>
    filters.some(
      (filter) =>
        filter["#h"]?.includes(channelId) &&
        // Unread evidence also contains this channel, but is not a timeline head.
        filter.top_level === true &&
        filter.until === undefined &&
        filter.depth_limit === undefined &&
        filter.kinds?.includes(9),
    );
  function demandChannel(channelId: string): boolean {
    if (closed) return false;
    updateInterests();
    const job = catchups.get(channelId);
    if (!job || job.generation !== liveGeneration || job.state === "verified")
      return false;
    if (job.retryAt && performance.now() < job.retryAt) {
      channels.catchUpFailed(channelId, job.error);
      return true;
    }
    if (job.state !== "pending") {
      job.state = "pending";
      job.error = undefined;
      catchupQueue.add(channelId);
      publishLive();
    }
    if (catchupRunning.has(channelId))
      requests.promote((filters) => isChannelHead(filters, channelId));
    queueMicrotask(() => void catchUpNext());
    return true;
  }
  function catchUpNext() {
    if (closed) return;
    // One retained catch-up at a time. Only the selected channel can use a
    // second slot; background recovery never drains the roster in parallel.
    while (catchupQueue.size && catchupRunning.size < 2) {
      const demanded = channels.demandedChannels();
      const channelId = catchupRunning.size
        ? demanded
            .slice(0, 1)
            .find((id) => catchupQueue.has(id) && !catchupRunning.has(id))
        : (demanded.find((id) => catchupQueue.has(id)) ??
          catchupQueue.values().next().value);
      if (!channelId) return;
      catchupQueue.delete(channelId);
      const job = catchups.get(channelId);
      if (
        !job ||
        job.generation !== liveGeneration ||
        !channels.canAccess(channelId)
      )
        continue;
      catchupRunning.set(channelId, job);
      void catchUpChannel(channelId, job);
    }
  }
  async function catchUpChannel(channelId: string, job: Catchup) {
    const valid = () =>
      !closed &&
      job.generation === liveGeneration &&
      catchups.get(channelId) === job;
    try {
      // A pre-establishment finite read cannot satisfy the handoff obligation.
      requests.invalidate((filters) => isChannelHead(filters, channelId));
      const verified = await channels.catchUp(channelId);
      if (valid()) job.state = verified ? "verified" : "deferred";
    } catch (error) {
      if (!valid()) return;
      job.state = readErrorKind(error) === "cancelled" ? "deferred" : "error";
      job.error = job.state === "error" ? String(error) : undefined;
      if (error instanceof ReadError && error.retryAfterMs !== undefined) {
        job.retryAt = performance.now() + error.retryAfterMs;
        // Keep lightweight obligations, not paced requests inside reader deadlines.
        for (const id of catchupQueue) {
          const queued = catchups.get(id);
          if (queued) {
            queued.state = "error";
            queued.error = job.error;
            queued.retryAt = job.retryAt;
            channels.catchUpFailed(id, error);
          }
        }
        catchupQueue.clear();
      }
    } finally {
      if (catchupRunning.get(channelId) === job)
        catchupRunning.delete(channelId);
      publishLive();
      catchUpNext();
    }
  }
  traffic = transport?.subscribe?.({
    observer: (frame, generation) => activity.receive(frame, generation),
    receive(events, provenance) {
      if (closed) return;
      const candidates = new Set(
        provenance?.phase === "live" && provenance.channelId
          ? events
              .filter((event) => {
                const destinations = event.tags.filter(
                  ([name]) => name === "h",
                );
                return (
                  (event.kind === 9 ||
                    event.kind === 40002 ||
                    event.kind === 40008) &&
                  event.pubkey !== transport.viewer &&
                  destinations.length === 1 &&
                  destinations[0]?.[1] === provenance.channelId &&
                  !recent.peek(event.id) &&
                  !unread.event(event.id) &&
                  !rawLocal().some((item) => item.event.id === event.id)
                );
              })
              .map((event) => event.id)
          : [],
      );
      // Signed membership notifications are hints, not roster authority. Schedule
      // before visibility filtering, because a newly granted channel may be denied locally.
      if (
        events.some(
          (event) =>
            [44100, 44101].includes(event.kind) &&
            event.pubkey === transport.relayAuthor &&
            event.tags.some(
              ([name, value]) => name === "p" && value === transport.viewer,
            ),
        )
      )
        refreshRoster();
      const epoch = accessEpoch;
      const generation = liveGeneration;
      const visible = accept(events);
      // Completion subscribers can synchronously clear, revoke or retire this
      // live delivery. Do not admit its remaining pulses into the new lifetime.
      if (
        !closed &&
        epoch === accessEpoch &&
        generation === liveGeneration &&
        liveSnapshot.status === "connected"
      )
        typing.accept(
          events.filter((event) => event.kind === 20002),
          true,
        );
      if (
        !closed &&
        epoch === accessEpoch &&
        generation === liveGeneration &&
        liveSnapshot.status === "connected"
      )
        activity.channelEvents(
          events.filter((event) => event.pubkey !== transport.viewer),
        );
      if (
        !closed &&
        epoch === accessEpoch &&
        generation === liveGeneration &&
        liveSnapshot.status === "connected"
      )
        channelActivity.accept(visible);
      if (
        closed ||
        epoch !== accessEpoch ||
        !candidates.size ||
        !provenance?.channelId
      )
        return;
      const delivered = new Set<string>();
      const incoming: readonly IncomingMessage[] = Object.freeze(
        visible.flatMap((event) => {
          if (!candidates.has(event.id) || delivered.has(event.id)) return [];
          delivered.add(event.id);
          const body =
            event.kind === 40002 ? objectBody(event.content) : undefined;
          const content =
            typeof body?.content === "string" ? body.content : event.content;
          return [
            Object.freeze({
              channelId: provenance.channelId as string,
              messageId: event.id,
              createdAt: event.created_at,
              authorId: event.pubkey,
              previewContent: content.slice(0, 4096),
            }),
          ];
        }),
      );
      if (!incoming.length) return;
      for (const listener of incomingListeners) {
        if (closed || epoch !== accessEpoch) return;
        listener(incoming);
      }
    },
    state(snapshot) {
      if (closed) return;
      memoryConnected = snapshot.status === "connected";
      activity.state(snapshot);
      presence.connected(snapshot.status === "connected");
      if (snapshot.status !== "connected") {
        typing.clear();
        memories.clear();
      }
      if (
        snapshot.status !== "connected" &&
        liveSnapshot.status === "connected"
      ) {
        liveGeneration++;
        channelActivity.cancel();
        activityRosterKey = undefined;
        catchups.clear();
        catchupQueue.clear();
        requests.invalidate();
        agentLibrary.clear();
        archives.clear();
        workflows.interrupt();
        channels.staleHeads();
        unread.stale();
      }
      // Access-revoked CLOSED is a refresh hint, not signed archive/membership
      // authority. Aggregate snapshots repeat failures; only react to a new one.
      const revoked = (route: LiveSnapshot["routes"][number]) =>
        route.channelId &&
        route.status === "error" &&
        route.error === "restricted: channel access revoked";
      const previous = new Set(
        liveSnapshot.routes.filter(revoked).map((r) => r.id),
      );
      if (
        snapshot.routes.some(
          (route) => revoked(route) && !previous.has(route.id),
        )
      )
        refreshRoster();
      liveSnapshot = snapshot;
      // Suspend every affected preview before any recheck: one revocation can
      // cancel another read, but must never leave its old public grant readable.
      const previews = snapshot.routes
        .filter(
          (route) =>
            revoked(route) &&
            !previous.has(route.id) &&
            route.channelId &&
            channels.queries.get?.(route.channelId)?.readOnly,
        )
        .map((route) => route.channelId as string);
      channels.suspendPreviews(previews);
      revalidatePreviews(previews);
      publishLive();
    },
    established(channelId) {
      if (closed) return;
      if (!channelId) {
        if (refreshedGeneration !== liveGeneration) {
          refreshedGeneration = liveGeneration;
          refreshRoster();
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!closed) {
              agentLibrary.reconnect();
              activityRosterKey = undefined;
              refreshChannelActivity();
              emoji.reconnect();
              statuses.reconnect();
              unread.reconnect();
              for (const refresh of refreshers) void refresh();
            }
          }, 0);
          timers.add(timer);
        }
        return;
      }
      for (const id of typeof channelId === "string"
        ? [channelId]
        : channelId) {
        if (!channels.canAccess(id)) continue;
        for (const thread of threads)
          if (thread.channelId === id) void thread.view.refresh();
        const job = {
          generation: liveGeneration,
          state: "pending" as "pending" | "verified" | "deferred" | "error",
          error: undefined as string | undefined,
        };
        channels.staleHead(id);
        catchups.set(id, job);
        if (channels.retainedChannels().includes(id)) catchupQueue.add(id);
        else job.state = "deferred";
      }
      publishLive();
      queueMicrotask(() => void catchUpNext());
    },
    recover() {
      if (closed) return;
      refreshRoster();
      unread.reconnect();
    },
    denied(channelId, reason) {
      if (!closed) channels.denyChannel(channelId, new Error(reason));
    },
  });
  let activityRosterKey: string | undefined;
  const refreshChannelActivity = () => {
    if (closed || !transport?.channelActivity) return;
    if (
      !Object.values(
        sidebarPreferences.queries.snapshot().data?.sort ?? {},
      ).includes("recent")
    ) {
      channelActivity.cancel();
      activityRosterKey = undefined;
      return;
    }
    const roster = channels.queries.list();
    if (roster.status !== "ready") return;
    const ids = roster.channels
      .filter((channel) => !channel.cached)
      .map((channel) => channel.id)
      .sort();
    const key = ids.join("\0");
    if (key === activityRosterKey) return;
    activityRosterKey = key;
    void channelActivity.refresh(ids).catch(() => {
      if (activityRosterKey === key) activityRosterKey = undefined;
    });
  };
  const stopActivityRoster = channels.queries.subscribeList(
    refreshChannelActivity,
  );
  const stopActivityPreferences = sidebarPreferences.queries.subscribe(
    refreshChannelActivity,
  );
  const stopInterests = channels.queries.subscribeList(updateInterests);
  updateInterests();
  refreshChannelActivity();

  return {
    session,
    async restore() {
      await Promise.all([channels.restore(), sidebarPreferences.ready]);
    },
    async clearCache() {
      // Keep memory admission closed through asynchronous and overlapping purges.
      cacheClearing++;
      try {
        accessEpoch++;
        cancelUploads();
        cacheClearEpoch++;
        activity.clear();
        memories.clear();
        presence.clear();
        channelActivity.clear();
        activityRosterKey = undefined;
        typing.clear();
        sidebarPreferences.clear();
        channelKit.clear();
        lifecycle.clear();
        details.clear();
        // New windows must not yield to or receive errors from retired owners.
        catchups.clear();
        catchupQueue.clear();
        for (const clear of views.values()) clear(true);
        recent.clear();
        unread.clear();
        requests.invalidate();
        profiles.clear();
        emoji.clear();
        statuses.clear();
        agentLibrary.clear();
        archives.clear();
        workflows.clear();
        await channels.clearCache();
        updateInterests();
      } finally {
        cacheClearing--;
      }
    },
    dispose() {
      stopSidebarGroups();
      closed = true;
      typing.dispose();
      lifetime.abort();
      activity.dispose();
      memories.dispose();
      presence.dispose();
      channelActivity.dispose();
      stopActivityRoster();
      stopActivityPreferences();
      sidebarPreferences.dispose();
      lifecycle.dispose();
      details.dispose();
      stopInterests();
      stopWarmPreferences();
      traffic?.dispose();
      liveListeners.clear();
      incomingListeners.clear();
      observations.clear();
      for (const timer of timers) clearTimeout(timer);
      for (const dispose of [...views.keys()]) dispose();
      unread.dispose();
      writes?.dispose();
      requests.dispose();
      channels.dispose();
      profiles.dispose();
      emoji.dispose();
      statuses.dispose();
      workflows.dispose();
      identityNames.dispose();
      agentLibrary.dispose();
      archives.dispose();
    },
    retainedChannels: channels.retainedChannels,
    diagnostics: () => ({
      ...channels.diagnostics(),
      profiles: profiles.stats(),
    }),
  };
}
export type RelaySession = ReturnType<typeof createRelaySession>["session"];
