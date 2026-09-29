import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MagnifyingGlassIcon } from "../../shared/design-system/icons/index";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import type { RegisteredPage } from "../../features/pages/service";
import { communityDestination } from "../../features/communities/destination";
import { useRelayConnection } from "../../features/relay/react";
import type { KeyBinding } from "../../features/shortcuts/bindings";
import {
  formatBinding,
  isApplePlatform,
} from "../../features/shortcuts/format";
import type { ShortcutBindingsSnapshot } from "../../features/shortcuts/preferences";
import type { AppServices } from "../services";
import { HOST_SHORTCUT_ORDER } from "../shortcuts";
import {
  orderPages,
  pagePresentation,
  shellPresentation,
} from "./presentation";
import {
  SearchChoices,
  type SearchInputProps,
  type SearchDestination,
} from "./SearchChoices";
import { SearchResults } from "./SearchResults";

export type SearchServices = Pick<
  AppServices,
  "communities" | "shortcuts" | "shortcutBindings" | "navigation"
>;
const SEARCH_ID = "global-search";
const SEARCH_BINDING: KeyBinding = { key: "k", mod: true };
const CONVERSATION_SEARCH_ID = "conversation-search";
const CONVERSATION_SEARCH_BINDING: KeyBinding = { key: "f", mod: true };
const NO_OVERRIDES: ShortcutBindingsSnapshot = { overrides: {}, error: null };
const noSubscribe = () => () => {};
const noOverrides = () => NO_OVERRIDES;

export function PageSearch({
  pages,
  onSelect,
  services,
}: {
  pages: readonly RegisteredPage[];
  onSelect: (key: string) => void;
  services?: SearchServices | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [contentPresent, setContentPresent] = useState(false);
  const [query, setQuery] = useState("");
  const [scopedChannelId, setScopedChannelId] = useState<string>();
  const currentTarget = useSyncExternalStore(
    services?.navigation?.subscribe ?? noSubscribe,
    () => services?.navigation?.snapshot().entry.target ?? null,
  );
  const input = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const openRef = useRef(false);
  const setSearchOpen = useCallback((next: boolean) => {
    openRef.current = next;
    if (next) setContentPresent(true);
    setOpen(next);
  }, []);
  const begin = useCallback(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : trigger.current;
    setQuery("");
    setScopedChannelId(undefined);
    setSearchOpen(true);
  }, [setSearchOpen]);
  const beginScoped = useCallback(() => {
    if (currentTarget?.kind !== "conversation") return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : trigger.current;
    setQuery("");
    setScopedChannelId(currentTarget.channelId);
    setSearchOpen(true);
  }, [currentTarget, setSearchOpen]);
  useEffect(
    () =>
      services?.shortcuts.registerHost({
        id: SEARCH_ID,
        title: "Search Buzz",
        binding: SEARCH_BINDING,
        order: HOST_SHORTCUT_ORDER.search,
        allowInEditable: true,
        run: begin,
      }),
    [services, begin],
  );
  useEffect(
    () =>
      services?.shortcuts.registerHost({
        id: CONVERSATION_SEARCH_ID,
        title: "Search this conversation",
        binding: CONVERSATION_SEARCH_BINDING,
        order: HOST_SHORTCUT_ORDER.search + 1,
        allowInEditable: true,
        when: () => currentTarget?.kind === "conversation",
        run: beginScoped,
      }),
    [services, currentTarget, beginScoped],
  );
  // The hint follows the person's rebind, derived from the same binding object.
  const { overrides } = useSyncExternalStore(
    services?.shortcutBindings.subscribe ?? noSubscribe,
    services?.shortcutBindings.snapshot ?? noOverrides,
  );
  const destinations: SearchDestination[] = [
    ...orderPages(pages).map((page) => ({
      key: page.key,
      ...pagePresentation(page),
    })),
    { key: "settings", ...shellPresentation.settings },
  ]
    .filter((page) =>
      page.label.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .map((page) => ({
      ...page,
      run: () => {
        returnFocus.current = document.getElementById("main-content");
        onSelect(page.key);
        setSearchOpen(false);
      },
    }));
  const shortcut = formatBinding(
    overrides[SEARCH_ID] ?? SEARCH_BINDING,
    isApplePlatform(navigator.platform),
  ).text;
  return (
    <>
      <IconButton
        ref={trigger}
        variant="chrome"
        shape="round"
        aria-label="Search Buzz"
        title={`Search Buzz (${shortcut})`}
        onClick={() => {
          trigger.current?.focus();
          begin();
        }}
        icon={<MagnifyingGlassIcon size={16} aria-hidden="true" />}
      />
      <Dialog
        open={open}
        onOpenChange={setSearchOpen}
        title={scopedChannelId ? "Search this conversation" : "Search Buzz"}
        motion="default"
        dismissOnOutsideClick
        closeLabel="Close search"
        initialFocus={input}
        finalFocus={() =>
          returnFocus.current?.id === "main-content"
            ? false
            : returnFocus.current
        }
        onOpenChangeComplete={(open) => {
          if (!open && !openRef.current) setContentPresent(false);
          // Base UI otherwise chooses main's first tabbable child. Preserve a
          // destination's own focus target if it already presented one.
          const main = returnFocus.current;
          if (
            !open &&
            !openRef.current &&
            main?.id === "main-content" &&
            !main.contains(document.activeElement)
          )
            main.focus({ preventScroll: true });
        }}
      >
        {contentPresent &&
          (services ? (
            <CommunitySearch
              services={services}
              pages={destinations}
              query={query}
              onQueryChange={setQuery}
              input={input}
              enabled={pages.some(
                (page) => page.key === "buzz.channels/channels",
              )}
              scopedChannelId={scopedChannelId}
              currentChannelId={
                currentTarget?.kind === "conversation"
                  ? currentTarget.channelId
                  : undefined
              }
              onScopeChange={(channelId) => {
                setScopedChannelId(channelId);
                input.current?.focus();
              }}
              close={() => {
                returnFocus.current = document.getElementById("main-content");
                setSearchOpen(false);
              }}
            />
          ) : (
            <SearchChoices
              query={query}
              onQueryChange={setQuery}
              input={input}
              groups={[{ label: "Pages", destinations }]}
            />
          ))}
      </Dialog>
    </>
  );
}

function CommunitySearch({
  services,
  pages,
  query,
  onQueryChange,
  input,
  enabled,
  scopedChannelId,
  currentChannelId,
  onScopeChange,
  close,
}: {
  services: SearchServices;
  pages: readonly SearchDestination[];
  enabled: boolean;
  scopedChannelId?: string | undefined;
  currentChannelId?: string | undefined;
  onScopeChange: (channelId?: string) => void;
  close: () => void;
} & SearchInputProps) {
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const connection = useRelayConnection(services.communities.relay);
  if (
    !enabled ||
    !client.selected ||
    !client.viewer ||
    connection.status !== "ready"
  ) {
    return (
      <SearchChoices
        query={query}
        onQueryChange={onQueryChange}
        input={input}
        label={scopedChannelId ? "Search this conversation" : "Search Buzz"}
        placeholder={scopedChannelId ? "Search messages…" : undefined}
        scope={
          scopedChannelId
            ? { label: "This conversation", onRemove: () => onScopeChange() }
            : undefined
        }
        groups={
          scopedChannelId
            ? [
                {
                  label: "Most relevant",
                  destinations: [],
                  empty: "Connect to this community to search messages.",
                },
              ]
            : query.trim()
              ? [
                  {
                    label: "Pages",
                    destinations: pages,
                    empty: "No matching pages.",
                  },
                ]
              : [
                  {
                    label: "Recent activity",
                    destinations: [],
                    empty: !enabled
                      ? "Enable Messages to see conversations."
                      : !client.selected
                        ? "Choose a community to see recent conversations."
                        : "Connecting to this community…",
                  },
                  { label: "Actions", destinations: pages },
                ]
        }
      >
        {enabled &&
          client.selected &&
          ["error", "disconnected"].includes(connection.status) && (
            <div className="px-3 text-body-sm text-subtle" aria-live="polite">
              <p>
                Message search is unavailable while this community is
                disconnected.
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => services.communities.relay.retry()}
              >
                Retry connection
              </Button>
            </div>
          )}
      </SearchChoices>
    );
  }
  const scope = {
    viewer: client.viewer,
    communityOrigin: communityDestination(client.selected).url,
  };
  return (
    <SearchResults
      key={`${client.selected}:${connection.scope}:${connection.generation}`}
      session={connection.session}
      query={query}
      onQueryChange={onQueryChange}
      input={input}
      pages={pages}
      scopedChannelId={scopedChannelId}
      currentChannelId={currentChannelId}
      onScopeChange={onScopeChange}
      openConversation={(channelId, messageId) => {
        const current = services.communities.snapshot();
        if (
          current.viewer !== scope.viewer ||
          current.selected !== client.selected ||
          services.communities.relay.snapshot().session !==
            connection.session ||
          !connection.session.channels.get?.(channelId)
        )
          return;
        close();
        void services.navigation.open({
          version: 1,
          kind: "conversation",
          scope,
          channelId,
          ...(messageId ? { messageId } : {}),
        });
      }}
    />
  );
}
