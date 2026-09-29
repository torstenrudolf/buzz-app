import type { EventTemplate } from "nostr-tools";
import { newer, type RelayEvent } from "./events.ts";

export type ChannelLifecycleAction = "archive" | "delete" | "leave" | "hide";
export const CHANNEL_LIFECYCLE_KINDS = [9002, 9008, 9022, 41012] as const;
export const DM_VISIBILITY_KIND = 30622;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBKEY = /^[0-9a-f]{64}$/;

export function lifecycleChannelId(value: string): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error("Invalid channel ID");
  return value;
}

export function lifecycleTemplate(
  action: ChannelLifecycleAction,
  channelId: string,
): EventTemplate {
  const kind = { archive: 9002, delete: 9008, leave: 9022, hide: 41012 }[
    action
  ];
  const event = {
    kind,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["h", lifecycleChannelId(channelId)],
      ...(action === "archive" ? [["archived", "true"]] : []),
    ],
  };
  validateLifecycleTemplate(event);
  return event;
}

/** The host never accepts generic metadata edits or other-member removal. */
export function validateLifecycleTemplate(event: EventTemplate): void {
  if (
    !event ||
    !CHANNEL_LIFECYCLE_KINDS.some((kind) => kind === event.kind) ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length !== (event.kind === 9002 ? 2 : 1) ||
    event.tags[0]?.length !== 2 ||
    event.tags[0]?.[0] !== "h"
  )
    throw new Error("Invalid channel lifecycle command");
  lifecycleChannelId(event.tags[0]?.[1] ?? "");
  if (
    event.kind === 9002 &&
    JSON.stringify(event.tags[1]) !== JSON.stringify(["archived", "true"])
  )
    throw new Error("Only archive metadata may be changed here");
}

export function exactLifecycleTag(event: RelayEvent, name: string) {
  const matches = event.tags.filter(([key]) => key === name);
  if (matches.length > 1 || matches.some((entry) => entry.length !== 2))
    throw new Error(`Malformed channel ${name} state`);
  return matches[0]?.[1];
}

export function lifecycleRecord(
  events: readonly RelayEvent[],
  kind: number,
  id: string,
  relayAuthor: string,
) {
  let selected: RelayEvent | undefined;
  for (const event of events) {
    if (event.kind !== kind) continue;
    if (event.pubkey !== relayAuthor || exactLifecycleTag(event, "d") !== id)
      throw new Error("Channel state did not match the requested authority");
    selected = newer(selected, event);
  }
  return selected;
}

export type ChannelLifecycleSettings = Readonly<{
  channelId: string;
  channelType: "stream" | "forum" | "dm";
  canArchive: boolean;
  canDelete: boolean;
  deleteUnavailable?: boolean;
  canLeave: boolean;
  canHide: boolean;
  leaveReason?: string;
}>;

export function lifecycleSettings(
  events: readonly RelayEvent[],
  id: string,
  viewer: string,
  relayAuthor: string,
): ChannelLifecycleSettings {
  const metadata = lifecycleRecord(events, 39000, id, relayAuthor);
  const admins = lifecycleRecord(events, 39001, id, relayAuthor);
  const roster = lifecycleRecord(events, 39002, id, relayAuthor);
  if (!metadata || !admins || !roster)
    throw new Error("Current channel permissions could not be verified");
  const type = exactLifecycleTag(metadata, "t");
  if (type !== "stream" && type !== "forum" && type !== "dm")
    throw new Error("Current channel type could not be verified");
  const members = new Set<string>();
  for (const entry of roster.tags.filter(([key]) => key === "p")) {
    const member = entry[1];
    if (
      // NIP-29 membership permits ["p", key, relay_hint?, role?].
      // These hints do not grant authority; roles come from the 39001 record.
      entry.length < 2 ||
      entry.length > 4 ||
      !member ||
      !PUBKEY.test(member) ||
      members.has(member)
    )
      throw new Error("Malformed channel membership state");
    members.add(member);
  }
  const roles = new Map<string, string>();
  for (const entry of admins.tags.filter(([key]) => key === "p")) {
    const [, pubkey, role] = entry;
    if (
      entry.length !== 3 ||
      !pubkey ||
      !PUBKEY.test(pubkey) ||
      (role !== "owner" && role !== "admin") ||
      roles.has(pubkey) ||
      !members.has(pubkey)
    )
      throw new Error("Malformed channel administrator state");
    roles.set(pubkey, role);
  }
  if (!members.has(viewer))
    throw new Error("You are no longer a channel member");
  const role = roles.get(viewer);
  const lastOwner =
    role === "owner" &&
    [...roles.values()].filter((value) => value === "owner").length === 1;
  const archived = exactLifecycleTag(metadata, "archived");
  if (archived !== undefined && archived !== "true" && archived !== "false")
    throw new Error("Malformed channel archive state");
  return Object.freeze({
    channelId: id,
    channelType: type,
    canArchive:
      type !== "dm" &&
      archived !== "true" &&
      (role === "owner" || role === "admin"),
    canDelete: type !== "dm" && archived !== "true" && role === "owner",
    canLeave: type !== "dm" && !lastOwner,
    canHide: type === "dm",
    ...(lastOwner && type !== "dm"
      ? { leaveReason: "Transfer ownership before leaving the channel." }
      : {}),
  });
}
