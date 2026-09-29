import {
  memoryResponseText,
  type MemoryReader,
  type MemoryListing,
} from "../agents/memory";
import { publicationRefusal } from "../developer/traffic";
import { brokerUpload, type AttachmentUpload } from "./attachments";
import type { ChannelKitHost } from "../channel-templates/host";
import type { KitRecord } from "../channel-templates/model";
import { workflowHost } from "../workflows/http";
import { projectGitHost, type ProjectGit } from "../projects/git";
import type { WorkflowHost } from "../workflows/host";
import { readReceiptText } from "./receipt";
import type { ReadStateHost, ReadStateSigning } from "./read-state-host";
import {
  parseReadSnapshot,
  readSnapshotFilter,
  readSnapshotText,
} from "./read-state-snapshot";
import type { AgentLibraryReader } from "../agents/library";
import {
  projectSidebarPreferences,
  type SidebarAssignmentMutator,
  type SidebarStarMutator,
  type SidebarSortMutator,
  type SidebarDecoder,
  type SidebarMuteMutator,
  type SidebarPreferences,
} from "./sidebar-preferences";
import { createHostAdmission } from "./host-admission";
import { relayOrigin } from "../communities/destination";
import {
  admittedApiRequest,
  ApiPaused,
  ApiNotSent,
  readApiFailure,
  presenceFilter,
  presenceText,
} from "./http-admission";
import { yieldToHost } from "./yield";
import { clientMetrics } from "../developer/client-metrics";
import { createRelayProfiler, type RelayProfiler } from "./profiling";
import {
  subscribeRelayTraffic,
  type LiveCallbacks,
  type LiveSubscription,
} from "./live";
import { subscribeBrokerTraffic } from "./broker-live";
import { PublishRejected } from "./outbox";
import { httpReadError, ReadError } from "./errors";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import {
  createEventVerifier,
  eventDto,
  type ReadFilter,
  type RelayEvent,
} from "./events";

/** Relay connection. Implementations verify signatures; callers never see raw JSON. */
export interface RelayWriter {
  readonly kinds?: readonly number[];
  sign(event: EventTemplate, signal: AbortSignal): Promise<RelayEvent>;
  /** Accepted receipt text is ephemeral; callers must never journal it. */
  publish(
    event: RelayEvent,
    signal: AbortSignal,
  ): Promise<string> | Promise<void>;
}
export interface ReadTransport {
  readonly projectGit?: ProjectGit;
  readonly readAgentMemories?: MemoryReader;
  /** Session-scoped owner proof, not an arbitrary signing capability. */
  readonly authorizeAgentLog?: (
    target: { id: string; pubkey: string; relayUrl: string },
    nonce: string,
  ) => Promise<string>;
  readonly uploadAttachment?: AttachmentUpload;
  /** Host-owned idempotent DM opening. The session verifies membership before use. */
  readonly openDirectMessage?: (
    pubkeys: readonly string[],
    signal: AbortSignal,
  ) => Promise<string>;
  readonly workflows?: WorkflowHost;
  /** Narrow lifecycle signer/publisher; never supplied to the message outbox. */
  readonly channelLifecycle?: RelayWriter;
  /** Name/about/private-only metadata writer, separate from lifecycle and outbox. */
  readonly channelDetails?: RelayWriter;
  /** Narrow NIP-IA 9035/9036 signer/publisher; never supplied to the message outbox. */
  readonly identityArchive?: RelayWriter;
  /** Purpose-bound observer decoding on the shared host live stream. */
  readonly agentActivity?: boolean;
  /** Explicit relay-advertised session command support. */
  /** Host-projected local library; display only, never relay authority. */
  readonly readAgentLibrary?: AgentLibraryReader;
  /** Host-only decoder of the viewer's signed sidebar preference coordinates. */
  readonly decodeSidebarPreferences?: SidebarDecoder;
  readonly writeSidebarSort?: SidebarSortMutator;
  readonly readState?: ReadStateHost;
  readonly channelKit?: ChannelKitHost;
  /** Strictly validated atomic writer snapshot; never an ordinary event-array query. */
  readStateSnapshot?(
    signal: AbortSignal,
    requestId: string,
    priority: "foreground" | "background",
  ): Promise<RelayEvent[]>;
  /** Demand-scoped verified ephemeral events on the session-owned socket. */
  observePresence?(
    authors: readonly string[],
    receive: (event: RelayEvent) => void,
  ): () => void;
  /** Complete bounded presence read. null is a local admission skip. */
  presenceSnapshot?(
    authors: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<
    string,
    "online" | "away" | "offline" | "unknown"
  > | null>;
  readonly writeSidebarMute?: SidebarMuteMutator;
  /** Host-only, relay-scoped mutation of one existing sidebar group assignment. */
  readonly writeSidebarAssignment?: SidebarAssignmentMutator;
  readonly writeSidebarStar?: SidebarStarMutator;
  readonly profiling?: RelayProfiler;
  /** Verified incoming traffic. The session owns this subscription and fences late delivery. */
  subscribe?(callbacks: LiveCallbacks): LiveSubscription;
  /** Stable community endpoint identity for durable session partitioning. */
  readonly scope?: string;
  /** Relay HTTP base for display only, such as a workflow's webhook address. */
  readonly relayHttpUrl?: string;
  /** Optional host-owned write capability, exposed to plugins only through the outbox. */
  readonly writer?: RelayWriter;
  /** The signed-in viewer whose channel roster is authoritative. */
  readonly viewer: string;
  /** Relay authority that signs discovery and window-bounds events. */
  readonly relayAuthor: string;
  /** Explicit NIP-11 self from this community, never a contact-key fallback. */
  readonly archiveAuthority?: string;
  /** Purpose-bound authoritative recency, verified and max 128 channel IDs. */
  channelActivity?(
    channelIds: readonly string[],
    signal: AbortSignal,
  ): Promise<RelayEvent[]>;
  query(
    filters: readonly ReadFilter[],
    signal?: AbortSignal,
    requestId?: string,
    priority?: "foreground" | "background",
  ): Promise<RelayEvent[]>;
  /** Display URL for a media URL, or undefined when this transport cannot fetch it. */
  media(url: string, size?: "small"): string | undefined;
}
/** Third-party https images load directly; relay-hosted media needs a signed read. */
export function mediaUrl(
  url: string,
  relayProxy: ((url: string) => string) | undefined,
  relayOrigin: string | undefined,
  size?: "small",
): string | undefined {
  if (url.startsWith(`${relayOrigin}/media/`)) {
    const media =
      size === "small"
        ? url.replace(/\/([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?$/, "/$1.thumb.jpg")
        : url;
    return relayProxy?.(media);
  }
  return /^https:\/\//.test(url) ? url : undefined;
}
export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  /** Native hosts authenticate and send exact bytes without exposing credentials to JS. */
  request?(url: string, body: string, signal?: AbortSignal): Promise<Response>;
}

/** The host's explicit HTTP base wins; otherwise translate the ws(s) relay URL's scheme. */
export function relayHttpBase(
  explicit: unknown,
  relayUrl: unknown,
): string | undefined {
  const candidate =
    typeof explicit === "string"
      ? explicit
      : typeof relayUrl === "string"
        ? relayUrl.replace(/^ws(s?):\/\//i, "http$1://")
        : undefined;
  return candidate && /^https?:\/\/[^\s/?#@]+\/?$/i.test(candidate)
    ? candidate.replace(/\/$/, "")
    : undefined;
}

async function parseEvents(
  raw: unknown,
  verify: (value: unknown) => RelayEvent,
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  if (!Array.isArray(raw))
    throw new ReadError(
      "invalid-response",
      "Relay response is not an event array",
    );
  const events: RelayEvent[] = [];
  // Signature checks are CPU work too. Yield between small batches so speculative
  // head/profile responses cannot monopolize input and foreground rendering.
  for (let index = 0; index < raw.length; index += 12) {
    if (signal?.aborted) throw new DOMException("Read cancelled", "AbortError");
    const started = performance.now();
    const batch = raw.slice(index, index + 12).map(verify);
    clientMetrics.cpu("verify.read", performance.now() - started, batch.length);
    events.push(...batch);
    if (index + 12 < raw.length) await yieldToHost();
  }
  return events;
}

/** Development metrics: one record per finite read, never per event.
 * `sized` passes the decoded response body through and records its length. */
async function measureQuery<T>(
  session: string,
  priority: "foreground" | "background",
  read: (sized: (text: string) => string) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let bytes = 0;
  let ok = false;
  try {
    const result = await read((text) => {
      bytes = text.length;
      return text;
    });
    ok = true;
    return result;
  } finally {
    clientMetrics.query(session, {
      ms: performance.now() - started,
      bytes,
      priority,
      ok,
    });
  }
}
/** Report live route state to development metrics before the session sees it. */
function measuredLive(
  session: string,
  callbacks: LiveCallbacks,
): LiveCallbacks {
  return {
    ...callbacks,
    state(snapshot) {
      clientMetrics.live(session, snapshot);
      callbacks.state(snapshot);
    },
  };
}

/** Binds the presence owner to the existing session stream, including startup ordering. */
function presenceObservation() {
  let traffic: LiveSubscription | undefined;
  let authors: readonly string[] = [];
  let listener: ((event: RelayEvent) => void) | undefined;
  return {
    receive: (event: RelayEvent) => listener?.(event),
    attach(value: LiveSubscription) {
      traffic = value;
      traffic.watchPresence?.(authors);
    },
    observe(keys: readonly string[], receive: (event: RelayEvent) => void) {
      authors = keys;
      listener = receive;
      traffic?.watchPresence?.(authors);
      return () => {
        if (listener !== receive) return;
        listener = undefined;
        authors = [];
        traffic?.watchPresence?.(authors);
      };
    },
  };
}

async function parsePresence(
  raw: unknown,
  authors: readonly string[],
  relay: string,
  signal: AbortSignal,
) {
  if (!Array.isArray(raw) || raw.length > authors.length)
    throw new Error("Invalid presence snapshot");
  const values = new Map<string, "online" | "away" | "offline" | "unknown">();
  for (const event of await parseEvents(raw, eventDto, signal)) {
    const subjects = event.tags.filter(([tag]) => tag === "p");
    const subject = subjects[0]?.[1];
    let status: unknown = event.content;
    if (event.content.startsWith("{")) {
      try {
        status = JSON.parse(event.content).status;
      } catch {
        status = undefined;
      }
    }
    if (
      event.kind !== 20001 ||
      event.pubkey !== relay ||
      subjects.length !== 1 ||
      subjects[0]?.length !== 2 ||
      !subject ||
      !authors.includes(subject) ||
      values.has(subject)
    )
      throw new Error("Untrusted presence snapshot");
    // The relay permits extensible status strings. An unsupported value is
    // Unknown for this subject, not a trust failure for unrelated peers.
    values.set(
      subject,
      status === "online" || status === "away" || status === "offline"
        ? status
        : "unknown",
    );
  }
  signal.throwIfAborted();
  for (const author of authors)
    if (!values.has(author)) values.set(author, "offline");
  return values;
}

/** Register trusted-app-origin intent before contacting a new destination. No remote join. */
export async function registerBrokerCommunity(
  community: string,
  signal?: AbortSignal,
  base = "",
) {
  const response = await fetch(`${base}/api/relay/register`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: community }),
    signal: signal ?? null,
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(
      result.error ?? `Community registration failed (${response.status})`,
    );
  }
}

/** Dev-only: a same-origin broker (see dev/relay-broker.mjs) holds the key and signs reads. */
export async function connectBrokerTransport(
  base = "",
  signal?: AbortSignal,
  community?: string,
): Promise<ReadTransport> {
  if (community) await registerBrokerCommunity(community, signal, base);
  const endpoint = `${base}/api/relay${community ? `/${encodeURIComponent(community)}` : ""}`;
  const profiling = createRelayProfiler();
  const verify = createEventVerifier();
  const response = await fetch(`${endpoint}/session`, {
    credentials: "same-origin",
    signal: signal ?? null,
  });
  if (!response.ok) throw httpReadError(response.status);
  const session = (await response.json()) as {
    viewer?: unknown;
    relayAuthor?: unknown;
    archiveAuthority?: unknown;
    writeKinds?: number[];
    workflowReads?: boolean;
    projectGit?: boolean;
    attachmentUploads?: boolean;
    directMessages?: boolean;
    channelLifecycle?: boolean;
    channelDetails?: boolean;
    identityArchives?: boolean;
    relayUrl?: string;
    relayHttpUrl?: string;
    live?: boolean;
    presence?: boolean;
    sidebarPreferences?: boolean;
    sidebarSortWrites?: boolean;
    channelActivity?: boolean;
    sidebarMuteWrites?: boolean;
    channelKit?: boolean;
    sidebarPreferenceWrites?: boolean;
    sidebarStarWrites?: boolean;
    agentLibrary?: boolean;
    agentMemories?: boolean;
    agentLogProof?: boolean;
    agentActivity?: boolean;
    readState?: boolean;
    readStateCommunity?: string;
  };
  if (
    typeof session.viewer !== "string" ||
    typeof session.relayAuthor !== "string" ||
    (session.archiveAuthority !== undefined &&
      (typeof session.archiveAuthority !== "string" ||
        !/^[0-9a-f]{64}$/.test(session.archiveAuthority) ||
        session.archiveAuthority !== session.relayAuthor))
  )
    throw new ReadError(
      "invalid-response",
      "Relay broker session is malformed",
    );
  let traffic: LiveSubscription | undefined;
  const presence = presenceObservation();
  const relayHttpUrl = relayHttpBase(session.relayHttpUrl, session.relayUrl);
  const publicationHeaders = () => ({
    "Content-Type": "application/json",
    // Matched development frontend/host: publication requires the existing owner.
    "X-Buzz-Live-ID": traffic?.identity?.() ?? "",
  });
  /** Dedicated shape-limited host sign/publish routes, separate from the outbox writer. */
  const routeWriter = (route: string): RelayWriter => ({
    async sign(template: EventTemplate, signal: AbortSignal) {
      const response = await fetch(`${endpoint}/${route}-sign`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(template),
        signal,
      });
      if (!response.ok) throw new Error((await readApiFailure(response)).error);
      return eventDto(await response.json());
    },
    async publish(event: RelayEvent, signal: AbortSignal) {
      const response = await fetch(`${endpoint}/${route}-publish`, {
        method: "POST",
        credentials: "same-origin",
        headers: publicationHeaders(),
        body: JSON.stringify(event),
        signal,
      });
      return acceptPublish(response, event.id);
    },
  });
  return {
    profiling,
    ...(session.attachmentUploads === true && session.relayUrl
      ? { uploadAttachment: brokerUpload(endpoint, session.relayUrl) }
      : {}),
    ...(session.presence && session.live
      ? {
          observePresence: presence.observe,
          async presenceSnapshot(
            authors: readonly string[],
            signal: AbortSignal,
          ) {
            const filters = [
              { kinds: [20001], authors, limit: authors.length },
            ];
            if (!presenceFilter(filters))
              throw new Error("Invalid presence demand");
            const bounded = AbortSignal.any([
              signal,
              AbortSignal.timeout(10000),
            ]);
            const result = await fetch(`${endpoint}/presence-snapshot`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(filters),
              signal: bounded,
            });
            if (result.status === 204) return null;
            if (!result.ok) {
              const failure = await readApiFailure(result);
              throw new ReadError(
                "unavailable",
                failure.error,
                result.status,
                failure.retryAfterMs,
              );
            }
            return parsePresence(
              JSON.parse(await presenceText(result)),
              authors,
              session.relayAuthor as string,
              bounded,
            );
          },
        }
      : {}),
    agentActivity: session.agentActivity === true && session.live === true,
    ...(session.live
      ? {
          subscribe: (callbacks: LiveCallbacks) => {
            traffic = subscribeBrokerTraffic(
              endpoint,
              measuredLive(endpoint, {
                ...callbacks,
                presence: presence.receive,
              }),
            );
            presence.attach(traffic);
            return traffic;
          },
        }
      : {}),
    ...(session.relayUrl ? { scope: session.relayUrl } : {}),
    ...(relayHttpUrl ? { relayHttpUrl } : {}),
    ...(session.directMessages === true
      ? {
          async openDirectMessage(
            pubkeys: readonly string[],
            signal: AbortSignal,
          ) {
            const result = await fetch(`${endpoint}/direct-message`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pubkeys }),
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            });
            if (!result.ok)
              throw new Error("Could not open the direct message. Try again.");
            const value = await result.json();
            if (
              typeof value?.channelId !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                value.channelId,
              )
            )
              throw new Error("The relay returned an invalid direct message.");
            return value.channelId;
          },
        }
      : {}),
    viewer: session.viewer,
    relayAuthor: session.relayAuthor,
    ...(typeof session.archiveAuthority === "string"
      ? { archiveAuthority: session.archiveAuthority }
      : {}),
    ...(session.workflowReads === true
      ? {
          workflows: workflowHost((route, body, signal) =>
            fetch(`${endpoint}/${route}`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal,
            }),
          ),
        }
      : {}),
    ...(session.projectGit === true
      ? {
          projectGit: projectGitHost((body, signal) =>
            fetch(`${endpoint}/project-git`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal,
            }),
          ),
        }
      : {}),
    ...(session.agentLogProof === true && community
      ? {
          authorizeAgentLog: async (
            target: { id: string; pubkey: string; relayUrl: string },
            nonce: string,
          ) => {
            if (
              !session.relayUrl ||
              relayOrigin(target.relayUrl) !== relayOrigin(session.relayUrl)
            )
              throw new Error("Log authorization unavailable");
            const response = await fetch(`${endpoint}/agent-log-proof`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...target, nonce }),
            });
            if (!response.ok) throw new Error("Log authorization unavailable");
            const value: unknown = await response.json();
            if (
              !value ||
              typeof value !== "object" ||
              !("signature" in value) ||
              typeof value.signature !== "string" ||
              !/^[0-9a-f]{128}$/.test(value.signature)
            )
              throw new Error("Log authorization unavailable");
            return value.signature;
          },
        }
      : {}),
    ...(session.agentMemories === true && community
      ? {
          readAgentMemories: async (
            agent: string,
            signal: AbortSignal,
          ): Promise<MemoryListing> => {
            const response = await fetch(`${endpoint}/agent-memories`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ agent }),
              signal,
            });
            if (!response.ok) {
              await response.body?.cancel();
              const error = new Error("Memory read failed");
              if (response.status === 401 || response.status === 403)
                error.name = "MemoryDenied";
              throw error;
            }
            const listing = JSON.parse(
              await memoryResponseText(response),
            ) as MemoryListing;
            signal.throwIfAborted();
            return listing;
          },
        }
      : {}),
    ...(session.agentLibrary
      ? {
          readAgentLibrary: async (signal: AbortSignal) => {
            const result = await fetch(`${endpoint}/agent-library`, {
              credentials: "same-origin",
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            });
            if (!result.ok) throw new Error("Current Buzz library unavailable");
            return result.json();
          },
        }
      : {}),
    ...(session.sidebarPreferences
      ? {
          async decodeSidebarPreferences(
            events: readonly RelayEvent[],
            signal: AbortSignal,
          ): Promise<SidebarPreferences> {
            const result = await fetch(`${endpoint}/sidebar-preferences`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(events),
              signal,
            });
            if (!result.ok)
              throw new Error(`Local decoder failed (HTTP ${result.status})`);
            return result.json();
          },
        }
      : {}),
    ...(session.channelKit
      ? {
          channelKit: {
            async prepare(record: KitRecord, signal: AbortSignal) {
              const response = await fetch(`${endpoint}/channel-kit-prepare`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(record),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Recipe preparation failed (${response.status})`,
                );
              const result = await response.json();
              if (
                typeof result.content !== "string" ||
                result.content.length > 24 * 1024
              )
                throw new Error("Invalid encrypted recipe");
              return result.content as string;
            },
            async decode(events: readonly RelayEvent[], signal: AbortSignal) {
              const response = await fetch(`${endpoint}/channel-kit-decode`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(events),
                signal,
              });
              if (!response.ok)
                throw new Error(`Recipe decode failed (${response.status})`);
              return response.json();
            },
          },
        }
      : {}),
    ...(session.readState
      ? {
          readState: {
            ...(session.readStateCommunity
              ? { communityId: session.readStateCommunity }
              : {}),
            async decode(events: readonly RelayEvent[], signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-decode`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(events),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Read-state decode failed (${response.status})`,
                );
              return response.json();
            },
            async sign(intent: ReadStateSigning, signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-sign`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(intent),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Read-state signing failed (${response.status})`,
                );
              return eventDto(await response.json());
            },
            async publish(event: RelayEvent, signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-publish`, {
                method: "POST",
                credentials: "same-origin",
                headers: publicationHeaders(),
                body: JSON.stringify(event),
                signal,
              });
              await acceptPublish(response, event.id);
            },
          },
        }
      : {}),
    ...(session.readStateCommunity
      ? {
          async readStateSnapshot(
            signal: AbortSignal,
            requestId: string,
            priority: "foreground" | "background",
          ) {
            return measureQuery(endpoint, priority, async (sized) => {
              const response = await fetch(`${endpoint}/query`, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                  "Content-Type": "application/json",
                  "X-Buzz-Read-Priority": priority,
                },
                body: JSON.stringify(
                  readSnapshotFilter(session.viewer as string),
                ),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Read-state snapshot failed (${response.status})`,
                );
              recordServerTiming(response, profiling, requestId);
              return parseReadSnapshot(
                JSON.parse(sized(await readSnapshotText(response))),
                session.viewer as string,
                session.readStateCommunity as string,
                signal,
              );
            });
          },
        }
      : {}),
    ...(session.sidebarSortWrites
      ? {
          async writeSidebarSort(group, mode, sectionIds, signal) {
            const result = await fetch(`${endpoint}/sidebar-sort`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ group, mode, sectionIds }),
              signal,
            });
            if (!result.ok) {
              const failure = await readApiFailure(result);
              throw new Error(failure.error);
            }
            const value = (await result.json()) as { groups?: unknown };
            return (
              projectSidebarPreferences(
                undefined,
                undefined,
                undefined,
                {
                  version: 1,
                  groups: value.groups,
                },
                sectionIds,
              ).sort ?? {}
            );
          },
        }
      : {}),
    ...(session.sidebarMuteWrites
      ? {
          async writeSidebarMute(intent, signal) {
            const result = await fetch(`${endpoint}/sidebar-mute`, {
              method: "POST",
              credentials: "same-origin",
              headers: publicationHeaders(),
              body: JSON.stringify(intent),
              signal,
            });
            if (!result.ok)
              throw new Error((await readApiFailure(result)).error);
            return projectSidebarPreferences(
              undefined,
              undefined,
              await result.json(),
            ).muted;
          },
        }
      : {}),
    ...(session.channelDetails === true
      ? { channelDetails: routeWriter("channel-details") }
      : {}),
    ...(session.channelLifecycle === true
      ? { channelLifecycle: routeWriter("channel-lifecycle") }
      : {}),
    ...(session.identityArchives === true
      ? { identityArchive: routeWriter("identity-archive") }
      : {}),
    ...(session.sidebarPreferenceWrites
      ? {
          async writeSidebarAssignment(intent, signal) {
            const result = await fetch(`${endpoint}/sidebar-assignment`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(intent),
              signal,
            });
            if (!result.ok) {
              const failure = await readApiFailure(result);
              throw new Error(failure.error);
            }
            const value = (await result.json()) as SidebarPreferences;
            const groups = projectSidebarPreferences(
              {
                version: 1,
                sections: value.sections,
                assignments: value.assignments,
              },
              undefined,
            );
            return {
              sections: groups.sections,
              assignments: groups.assignments,
            };
          },
        }
      : {}),
    ...(session.sidebarStarWrites
      ? {
          async writeSidebarStar(intent, signal) {
            const result = await fetch(`${endpoint}/sidebar-star`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(intent),
              signal,
            });
            if (!result.ok)
              throw new Error((await readApiFailure(result)).error);
            return projectSidebarPreferences(undefined, await result.json())
              .starred;
          },
        }
      : {}),
    ...(session.writeKinds
      ? {
          writer: {
            kinds: session.writeKinds,
            async sign(template: EventTemplate, signal: AbortSignal) {
              const result = await fetch(`${endpoint}/sign`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(template),
                signal,
              });
              if (!result.ok)
                throw new Error(`Signing failed (${result.status})`);
              const event = eventDto(await result.json());
              recordServerTiming(result, profiling, event.id);
              return event;
            },
            async publish(event: RelayEvent, signal: AbortSignal) {
              const result = await fetch(`${endpoint}/publish`, {
                method: "POST",
                credentials: "same-origin",
                headers: publicationHeaders(),
                body: JSON.stringify(event),
                signal,
              });
              recordServerTiming(result, profiling, event.id);
              return acceptPublish(result, event.id);
            },
          },
        }
      : {}),
    ...(session.channelActivity
      ? {
          async channelActivity(channelIds, signal) {
            return measureQuery(endpoint, "background", async (sized) => {
              const result = await fetch(`${endpoint}/channel-activity`, {
                method: "POST",
                credentials: "same-origin",
                headers: {
                  "Content-Type": "application/json",
                  "X-Buzz-Read-Priority": "background",
                },
                body: JSON.stringify(
                  channelIds.map((channelId) => ({
                    kinds: [9, 40002, 40008, 45001, 45003],
                    "#h": [channelId],
                    limit: 1,
                  })),
                ),
                signal,
              });
              if (!result.ok) throw httpReadError(result.status);
              return parseEvents(
                JSON.parse(sized(await result.text())),
                verify,
                signal,
              );
            });
          },
        }
      : {}),
    media: (url, size) =>
      mediaUrl(
        url,
        (target) => `${endpoint}/media?url=${encodeURIComponent(target)}`,
        session.relayUrl,
        size,
      ),
    query: (filters, signal, requestId = "read", priority = "foreground") =>
      measureQuery(endpoint, priority, async (sized) => {
        const result = await fetch(`${endpoint}/query`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Buzz-Read-Priority": priority,
          },
          body: JSON.stringify(filters),
          signal: signal ?? null,
        });
        if (!result.ok) {
          const failure = await readApiFailure(result);
          throw new ReadError(
            result.status === 401 || result.status === 403
              ? "denied"
              : "unavailable",
            failure.error,
            result.status,
            failure.retryAfterMs,
          );
        }
        recordServerTiming(result, profiling, requestId);
        return profiling.measureAsync("read.verify", requestId, async () =>
          parseEvents(JSON.parse(sized(await result.text())), verify, signal),
        );
      }),
  };
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const signedAdmissions = createHostAdmission();
/** NIP-98 signed reads for a host that owns a signer (Tauri, NIP-07). Reads and writes use the same identity and relay scope. */
export async function connectSignedTransport(
  signer: Signer,
  httpOrigin: string,
  relayAuthor: string,
): Promise<ReadTransport> {
  const viewer = await signer.getPublicKey();
  httpOrigin = relayOrigin(httpOrigin);
  const principal = () => signedAdmissions(httpOrigin, viewer);
  const profiling = createRelayProfiler();
  const verify = createEventVerifier();
  const presence = presenceObservation();
  return {
    profiling,
    observePresence: presence.observe,
    async presenceSnapshot(authors, signal) {
      const filters = [{ kinds: [20001], authors, limit: authors.length }];
      if (!presenceFilter(filters)) throw new Error("Invalid presence demand");
      const lane = principal().api;
      const release = lane.tryPresence();
      if (!release) return null;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      try {
        const response = await signedPost(
          signer,
          `${httpOrigin}/query`,
          filters,
          bounded,
          profiling,
          "presence",
          lane,
          "background",
          true,
        );
        if (!response.ok) {
          const failure = await readApiFailure(response);
          if (failure.quota === "api" && failure.retryAfterMs !== undefined)
            lane.pause(failure.retryAfterMs);
          throw new ReadError(
            "unavailable",
            failure.error,
            response.status,
            failure.retryAfterMs,
          );
        }
        return await parsePresence(
          JSON.parse(await presenceText(response)),
          authors,
          relayAuthor,
          bounded,
        );
      } finally {
        release();
      }
    },
    subscribe: (callbacks) => {
      const owner = principal();
      owner.streams++;
      let traffic: LiveSubscription;
      try {
        traffic = subscribeRelayTraffic(
          httpOrigin.replace(/^http/, "ws"),
          (event) => signer.signEvent(event),
          viewer,
          measuredLive(httpOrigin, {
            ...callbacks,
            presence: presence.receive,
          }),
          undefined,
          owner.live,
        );
      } catch (error) {
        owner.streams--;
        throw error;
      }
      presence.attach(traffic);
      let closed = false;
      return {
        ...traffic,
        dispose() {
          if (closed) return;
          closed = true;
          owner.streams--;
          traffic.dispose();
        },
      };
    },
    scope: httpOrigin,
    relayHttpUrl: httpOrigin,
    viewer,
    relayAuthor,
    media: (url, size) => mediaUrl(url, undefined, httpOrigin, size),
    writer: {
      sign: (event) => signer.signEvent(event),
      async publish(event, signal) {
        return acceptPublish(
          await signedPost(
            signer,
            `${httpOrigin}/events`,
            event,
            signal,
            profiling,
            event.id,
            principal().api,
          ).catch((error) => {
            if (error instanceof ApiPaused || error instanceof ApiNotSent)
              throw new PublishRejected(error.message);
            throw error;
          }),
          event.id,
        );
      },
    },
    query: (filters, signal, requestId = "read", priority = "foreground") =>
      measureQuery(httpOrigin, priority, async (sized) => {
        const result = await signedPost(
          signer,
          `${httpOrigin}/query`,
          filters,
          signal,
          profiling,
          requestId,
          principal().api,
          priority,
        );
        if (!result.ok) {
          const failure = await readApiFailure(result);
          throw new ReadError(
            result.status === 401 || result.status === 403
              ? "denied"
              : "unavailable",
            failure.error,
            result.status,
            failure.retryAfterMs,
          );
        }
        recordServerTiming(result, profiling, requestId);
        return profiling.measureAsync("read.verify", requestId, async () =>
          parseEvents(JSON.parse(sized(await result.text())), verify, signal),
        );
      }),
  };
}

async function signedPost(
  signer: Signer,
  url: string,
  value: unknown,
  signal: AbortSignal | undefined,
  profiling: RelayProfiler,
  id: string,
  admission: Parameters<typeof admittedApiRequest>[0],
  priority: "foreground" | "background" = "foreground",
  optionalPresence = false,
) {
  const dispatch = (request: () => Promise<Response>) =>
    optionalPresence
      ? admission.prepare(request)
      : admittedApiRequest(admission, request, signal, priority);
  signal?.throwIfAborted();
  return admission.prepare(async () => {
    const body = JSON.stringify(value);
    const request = signer.request?.bind(signer);
    if (request)
      return dispatch(() => {
        signal?.throwIfAborted();
        return profiling.measureAsync("http.fetch", id, () =>
          request(url, body, signal),
        );
      });
    const payload = hex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    );
    if (signal?.aborted) throw signal.reason;
    const auth = await profiling.measureAsync("http.auth", id, () =>
      signer.signEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", payload],
          ["nonce", crypto.randomUUID()],
        ],
      }),
    );
    if (signal?.aborted) throw signal.reason;
    // Preparation retains this principal. Dispatch rechecks capacity and any
    // server pause learned during asynchronous signing.
    const queued = profiling.start("http.admission", id);
    try {
      return await dispatch(() => {
        queued();
        signal?.throwIfAborted();
        if (Math.abs(Math.floor(Date.now() / 1000) - auth.created_at) > 45)
          throw new ApiNotSent(
            "Request authentication expired before dispatch; retry available",
          );
        return profiling.measureAsync("http.fetch", id, () =>
          fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
              "Content-Type": "application/json",
            },
            body,
            signal: signal ?? null,
          }),
        );
      });
    } finally {
      queued();
    }
  });
}
/** A transport failure is an unknown outcome; only a definitive rejection is a failed write. */
async function acceptPublish(response: Response, id: string) {
  if (!response.ok) {
    if ([400, 401, 403, 404, 413, 422].includes(response.status))
      throw new PublishRejected(
        `Relay rejected the message (${response.status})`,
      );
    // Only proven non-delivery is safe to mark failed. Socket quota reasons are
    // display-only: keep them distinct from HTTP API quota/cooldown ownership.
    const body = await readApiFailure(response, (value) => {
      if (!value || typeof value !== "object") return;
      const failure = value as { sent?: unknown; error?: unknown };
      if (
        failure.sent === false &&
        typeof failure.error === "string" &&
        failure.error.startsWith("rate-limited:")
      )
        return publicationRefusal(failure.error);
    });
    if (body.sent === false || body.quota === "api")
      throw new PublishRejected(body.error);
    throw new Error(
      `Relay delivery could not be confirmed (${response.status})`,
    );
  }
  const text = await readReceiptText(response);
  const result = JSON.parse(text) as {
    accepted?: unknown;
    event_id?: unknown;
    message?: unknown;
  };
  if (result.event_id !== id || typeof result.accepted !== "boolean")
    throw new Error("Relay returned an invalid delivery receipt");
  if (!result.accepted)
    throw new PublishRejected(
      typeof result.message === "string"
        ? result.message
        : "Relay rejected the message",
    );
  return typeof result.message === "string" ? result.message : "";
}

function recordServerTiming(
  response: Response,
  profiling: RelayProfiler,
  id: string,
) {
  for (const entry of (response.headers.get("Server-Timing") ?? "").split(
    ",",
  )) {
    const match = /^\s*([a-z_]+);dur=([\d.]+)/.exec(entry);
    if (!match) continue;
    const duration = Number(match[2]);
    if (Number.isFinite(duration))
      profiling.record({
        stage: `broker.${match[1]}`,
        id,
        start: performance.now() - duration,
        duration,
        outcome: response.ok ? "ok" : "error",
      });
  }
}
