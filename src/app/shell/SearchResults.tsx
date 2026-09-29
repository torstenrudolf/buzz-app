import { useIdentityNames } from "../../features/identity-names/react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList } from "../../features/relay/react";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import type { SearchDestination, SearchInputProps } from "./SearchChoices";
import { SearchChoices } from "./SearchChoices";
import { useSearchMessages } from "./useSearchMessages";

function conversationName(
  channel: ChannelSummary,
  profiles: ReadonlyMap<string, Profile>,
  resolveName: ReturnType<typeof useIdentityNames>,
) {
  if (channel.channelType !== "dm" || !channel.participants)
    return channel.name;
  return (
    channel.participants
      .map((id) =>
        resolveName(
          id,
          profiles.get(id)?.name ?? id.slice(0, 10),
          channel.participants,
        ),
      )
      .join(", ") || "Notes to self"
  );
}

export function SearchResults({
  session,
  query,
  onQueryChange,
  input,
  pages,
  scopedChannelId,
  currentChannelId,
  onScopeChange,
  openConversation,
}: {
  session: RelaySession;
  pages: readonly SearchDestination[];
  scopedChannelId?: string | undefined;
  currentChannelId?: string | undefined;
  onScopeChange?: ((channelId?: string) => void) | undefined;
  openConversation: (channelId: string, messageId?: string) => void;
} & SearchInputProps) {
  const resolveName = useIdentityNames(session.names);
  const list = useChannelList(session.channels);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const channels = useMemo(
    () =>
      list.channels.filter(
        (channel) =>
          !channel.archived &&
          (!channel.hidden || channel.channelType === "dm") &&
          (!scopedChannelId || channel.id === scopedChannelId),
      ),
    [list.channels, scopedChannelId],
  );
  const search = useSearchMessages(session, query.trim(), scopedChannelId);
  const names = new Map(
    channels.map((channel) => [
      channel.id,
      conversationName(channel, profiles, resolveName),
    ]),
  );
  const profileKey = [
    ...new Set([
      ...channels.flatMap((channel) =>
        channel.channelType === "dm" ? (channel.participants ?? []) : [],
      ),
      ...search.messages.map((message) => message.authorId),
    ]),
  ]
    .sort()
    .slice(0, 1024)
    .join(":");
  useEffect(() => {
    if (profileKey)
      void session.profiles
        .ensure(profileKey.split(":"), "background")
        .catch(() => {});
  }, [session, profileKey]);
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  const matchingChannels = channels
    .filter((channel) => names.get(channel.id)?.toLowerCase().includes(needle))
    .slice(0, 8);
  const conversationDestination = (
    channel: ChannelSummary,
  ): SearchDestination => ({
    key: `channel:${channel.id}`,
    label: names.get(channel.id) ?? channel.name,
    detail:
      channel.channelType === "dm"
        ? "Direct message"
        : channel.channelType === "session"
          ? "Session"
          : "Conversation",
    icon: ChatCircleIcon,
    run: () => openConversation(channel.id),
  });
  const recent: SearchDestination[] = channels
    .filter((channel) => !channel.readOnly)
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
        (a.lastActivityAt ?? a.updatedAt ?? 0),
    )
    .slice(0, 4)
    .map((channel) => ({
      ...conversationDestination(channel),
      ...(channel.preview ? { detail: channel.preview } : {}),
    }));
  const currentChannel = currentChannelId
    ? channels.find((channel) => channel.id === currentChannelId)
    : undefined;
  const scopeAction: SearchDestination[] =
    !scopedChannelId && currentChannel && onScopeChange
      ? [
          {
            key: `scope:${currentChannel.id}`,
            label: `Search ${currentChannel.channelType === "dm" ? "conversation with" : "in"} ${names.get(currentChannel.id) ?? currentChannel.name}`,
            detail: "Search messages in this conversation",
            icon: ChatCircleIcon,
            run: () => onScopeChange(currentChannel.id),
          },
        ]
      : [];
  const messages: SearchDestination[] = search.messages.map((message) => ({
    key: message.id,
    label: message.preview,
    detail: `${names.get(message.channelId) ?? session.channels.get?.(message.channelId)?.name ?? "Conversation"} · ${resolveName(message.authorId, profiles.get(message.authorId)?.name ?? message.authorId.slice(0, 10), list.channels.find((channel) => channel.id === message.channelId)?.members ?? [])} · ${new Date(message.createdAt * 1000).toLocaleDateString()}`,
    icon: ChatCircleIcon,
    run: () => openConversation(message.channelId, message.id),
  }));
  const messageEmpty = search.loading
    ? "Searching messages…"
    : search.error
      ? "Message search is unavailable."
      : query.trim()
        ? "No matching messages in accessible conversations."
        : scopedChannelId
          ? "Type to search messages in this conversation."
          : "Type to search messages in this community.";
  return (
    <SearchChoices
      query={query}
      onQueryChange={onQueryChange}
      input={input}
      label={scopedChannelId ? "Search this conversation" : "Search Buzz"}
      placeholder={
        scopedChannelId
          ? "Search messages…"
          : "Search pages, conversations and messages…"
      }
      scope={
        scopedChannelId && onScopeChange
          ? {
              label:
                names.get(scopedChannelId) ??
                session.channels.get?.(scopedChannelId)?.name ??
                "Conversation",
              onRemove: () => onScopeChange(),
            }
          : undefined
      }
      groups={
        scopedChannelId
          ? [
              {
                label: "Most relevant",
                destinations: messages,
                empty: messageEmpty,
              },
            ]
          : !query.trim()
            ? [
                ...(scopeAction.length
                  ? [{ label: "This conversation", destinations: scopeAction }]
                  : []),
                {
                  label: "Recent activity",
                  destinations: recent,
                  empty:
                    list.status === "loading"
                      ? "Loading recent conversations…"
                      : "No recent activity yet.",
                },
                { label: "Actions", destinations: pages },
              ]
            : [
                ...(scopeAction.length
                  ? [{ label: "This conversation", destinations: scopeAction }]
                  : []),
                {
                  label: "Channels",
                  destinations: matchingChannels
                    .filter((channel) => channel.channelType !== "dm")
                    .map(conversationDestination),
                },
                {
                  label: "Direct messages",
                  destinations: matchingChannels
                    .filter((channel) => channel.channelType === "dm")
                    .map(conversationDestination),
                },
                { label: "Pages", destinations: pages },
                {
                  label: "Most relevant",
                  destinations: messages,
                  empty:
                    matchingChannels.length || pages.length
                      ? undefined
                      : messageEmpty,
                },
              ]
      }
    >
      <div
        className="space-y-2 px-3 text-body-sm text-subtle"
        aria-live="polite"
      >
        {list.status === "loading" && query.trim() && !list.channels.length && (
          <p>Loading joined conversations…</p>
        )}
        {list.status === "error" && (
          <div>
            <p>Couldn’t load all joined conversations.</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                session.channels.refreshList
                  ? session.channels.refreshList()
                  : session.channels.ensureList()
              }
            >
              Retry conversations
            </Button>
          </div>
        )}
        {list.coverage === "partial" && (
          <p>Conversation names include only loaded joined conversations.</p>
        )}
        {search.error && (
          <div>
            <p>{search.error}</p>
            <Button size="sm" variant="ghost" onClick={search.retry}>
              Retry messages
            </Button>
          </div>
        )}
      </div>
    </SearchChoices>
  );
}
