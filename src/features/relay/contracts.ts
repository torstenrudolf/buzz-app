import type { CustomEmoji } from "./emoji";
import type { ReadOptions } from "./reader";
import type { Delivery } from "./outbox";

export const MAX_ATTACHMENT_DURATION_SECONDS = 86_400;

export type MessageReaction = Readonly<{
  content: string;
  emoji?: CustomEmoji;
  /** Retain every event so toggling off removes duplicate reactions by one author. */
  events: readonly Readonly<{ id: string; authorId: string }>[];
}>;

/** Folded, read-only channel state. Rows are domain data, not wire events or presentation. */
export type ChannelSummary = Readonly<{
  id: string;
  name: string;
  /** Ordinary channel prose; session machine metadata is not a description. */
  description?: string | undefined;
  /** Explicit signed visibility; absent means unknown, not public. */
  visibility?: "public" | "private" | undefined;
  preview?: string | undefined;
  /** Newest verified user-visible activity for sidebar ordering, in Unix seconds. */
  lastActivityAt?: number | undefined;
  /** Readable public nonmember channel; not part of the joined roster. */
  readOnly?: true;
  /** Downloaded membership is display-only pending current relay confirmation. */
  cached?: true;
  /** Members-only channel omitted from directories (NIP-29 `hidden`), such as a DM. */
  hidden?: true;
  /** Relay-authored metadata; absent while metadata is unavailable. */
  channelType?: "stream" | "forum" | "dm" | "session";
  /** Relay-authored channel visibility; private channels use restricted presentation. */
  private?: true;
  /** Presentation-only parent from signed channel metadata; never grants access. */
  parentChannelId?: string | undefined;
  /** Metadata update time used for stable work-history ordering. */
  updatedAt?: number;
  archived?: true;
  /** Exact members from the relay-signed roster; absent means unknown. */
  members?: readonly string[];
  /** Other DM members from the authorized roster; empty for a self-DM. */
  participants?: readonly string[];
}>;
export type Profile = Readonly<{
  name: string;
  picture?: string;
  about?: string;
  /** Self-declared NIP-05 identifier; not proof of DNS verification. */
  nip05?: string;
  /** Self-declared display hint, not proof of ownership, membership or authority. */
  isAgent?: true;
  /** Owner named by the profile auth tag; display metadata, never authorization. */
  ownerPubkey?: string;
}>;
export type Attachment = Readonly<{
  url: string;
  kind: "image" | "video" | "audio" | "file";
  /** Sender-supplied presentation metadata; `size` is a claim, `name` is display/download only. */
  mime?: string;
  size?: number;
  name?: string;
  /** Sender/relay-claimed duration in seconds; display hint, corrected by the element. */
  duration?: number;
  dimensions?: Readonly<{ width: number; height: number }>;
  /** Validated message-carried BlurHash; decoded locally only for presentation. */
  blurhash?: string;
  /** Signed video poster or media thumbnail URL. */
  previewUrl?: string;
}>;
/** Relay-authored membership activity, not a membership grant or user message. */
export type MembershipChange = Readonly<{
  type: "member_joined" | "member_left" | "member_removed";
  actor: string;
  target: string;
}>;
export type ChannelMessage = Readonly<{
  id: string;
  channelId: string;
  delivery?: Delivery | undefined;
  deliveryError?: string | undefined;
  authorId: string;
  /** Unix seconds from the signed event. */
  createdAt: number;
  /** Effective send ms (valid `ms` tag, else createdAt * 1000); ordered by `compareMessages`. */
  createdAtMs?: number;
  content: string;
  /** Unprojected current body when attachment presentation removed Markdown. */
  sourceContent?: string;
  /** Original kind 40002, regardless of edits; self-declared display evidence, not authority. */
  agentEnvelope?: true;
  /** Original kind 40008. Untrusted display metadata; content stays a raw patch. */
  diff?: Readonly<{
    filePath?: string | undefined;
    repoUrl?: string | undefined;
    commitSha?: string | undefined;
    description?: string | undefined;
    truncated: boolean;
  }>;
  membership?: MembershipChange;
  /** Current body came from a replacement edit; original recipients do not bind its prose. */
  edited?: true;
  /** Attachment removal changed the signed body; new text adjacency cannot bind identities. */
  attachmentContentRemoved?: true;
  /** Pubkeys named by signed `p` tags. Identity never comes from prose. */
  mentions: readonly string[];
  /** Signed two-field mention tags bind display only; never notification recipients. */
  mentionReferences?: readonly string[];
  /** Authorized edit supplying current imeta; absent when sourced from the original. */
  attachmentSourceId?: string;
  attachments: readonly Attachment[];
  /** Event-local mappings, never the current community palette. */
  emoji?: readonly CustomEmoji[];
  reactions: readonly MessageReaction[];
  /** Canonical thread-opening target from signed reply/root tags; absent on root messages. */
  threadRootId?: string | undefined;
  /** Immediate signed reply target; separate from the canonical thread root. */
  replyParentId?: string | undefined;
  /** Relay-signed whole-thread reply total (including nested replies).
   * Falls back to direct replies when the summary lacks a valid descendant total. */
  replyCount: number;
  /** Pubkeys the relay reports as thread participants (may be empty even with replies). */
  participants: readonly string[];
}>;
export type ListStatus = "unavailable" | "idle" | "loading" | "ready" | "error";
export type ChannelList = Readonly<{
  status: ListStatus;
  /** Set when the viewer's roster read hit its cap; omitted channels are then not evidence of removal. */
  coverage?: "partial";
  asOf?: number;
  /** Initial Recent ordering observation, independent of roster/access readiness. */
  activityStatus?: "idle" | "loading" | "ready" | "error" | "unavailable";
  channels: readonly ChannelSummary[];
  error?: string;
}>;
export type WindowStatus = "idle" | "loading" | "ready" | "error";
/** One bounded, chronologically ordered history window. Not the whole channel. */
export type ChannelWindow = Readonly<{
  channelId: string;
  status: WindowStatus;
  rows: readonly ChannelMessage[];
  /** False only after the relay's window bounds reported no more history. */
  hasMore: boolean;
  loadingOlder: boolean;
  error: string | undefined;
  /** Cached rows are immediately readable, but not claimed fresh until revalidated. */
  freshness?: "cached" | "verified";
  historyLimited?: boolean;
}>;
/** Reads are side-effect-free; snapshots retain identity until their value changes.
 * Commands are idempotent requests; the store decides whether network work is needed. */
export interface ChannelQueries {
  list(): ChannelList;
  /** Bounded discovery lookup; never inserts public previews into list(). */
  get?(channelId: string): ChannelSummary | undefined;
  resolve?(channelIds: readonly string[], options?: ReadOptions): Promise<void>;
  subscribeList(listener: () => void): () => void;
  window(channelId: string): ChannelWindow;
  subscribeWindow(channelId: string, listener: () => void): () => void;
  ensureList(): void;
  ensure(channelId: string): void;
  loadOlder(channelId: string): void;
  /** Explicit same-scope head revalidation; replaces the bounded head, not a realtime tail. */
  refresh?(channelId: string): void;
  /** Intent warming is optional for fixture-only query implementations. */
  prepare?(channelId: string): void;
  /** Roster warming is optional for fixture-only query implementations. The
   * caller supplies preferred (e.g. starred) ids; the store orders the rest. */
  warm?(preferred: readonly string[]): void;
  refreshList?(): void;
}
