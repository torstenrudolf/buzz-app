import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppServices } from "./services";
import { communityDestination } from "../features/communities/destination";
import type { OpenTarget } from "../features/navigation/targets";
import type { PageNavigation } from "../features/navigation/service";
import type { OpenFailure } from "../features/navigation/controller";
import { developerMode } from "./Settings";

const channelsKey = "buzz.channels/channels";
export function useAppNavigation(services: AppServices) {
  const navigation = services.navigation;
  const state = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const pages = useSyncExternalStore(
    services.pages.subscribe,
    services.pages.snapshot,
  );
  const plugins = useSyncExternalStore(
    services.plugins.subscribe,
    services.plugins.snapshot,
  );

  const startup = plugins.configuration.status;
  const target = state.entry.target;
  const settings = target.kind === "settings";
  const visibility = useSyncExternalStore(
    services.settingsCards.subscribe,
    () =>
      settings && target.section
        ? services.settingsCards.visibility(target.section)
        : true,
  );
  // Demand belongs to the route, including pending/error presentation and retry.
  const [retainedAttempt, setRetainedAttempt] =
    useState<typeof state.attempt>();
  useLayoutEffect(() => {
    if (!settings) return;
    const release = services.settingsCards.retainVisibility();
    setRetainedAttempt(state.attempt);
    return release;
  }, [services, settings, state.attempt]);
  const lastNonSettings = useRef<OpenTarget | undefined>(undefined);
  if (target.kind !== "settings") lastNonSettings.current = target;
  const scope = "scope" in target ? target.scope : undefined;
  const pageKey =
    target.kind === "page"
      ? `${target.pluginId}/${target.pageId}`
      : target.kind === "conversation"
        ? channelsKey
        : undefined;
  const page = pages.find((page) => page.key === pageKey);
  const membership = scope
    ? client.memberships.find(
        (item) => communityDestination(item.id).url === scope.communityOrigin,
      )
    : undefined;
  let failure: OpenFailure | undefined;
  const legacyHome = target.kind === "home";
  const legacyPage =
    target.kind === "page" &&
    pageKey === channelsKey &&
    target.route?.version === 1 &&
    (target.route.params === "Inbox" || target.route.params === "Bestie")
      ? target.route.params.toLowerCase()
      : undefined;
  let waiting = legacyHome || legacyPage !== undefined;
  if (scope === null) {
    waiting ||= client.status === "loading" || client.selected !== null;
  } else if (scope) {
    if (client.status === "loading") waiting = true;
    else if (client.viewer !== scope.viewer) failure = "denied";
    else if (!membership) failure = "denied";
    else if (client.selected !== membership.id) waiting = true;
  }
  if (pageKey && !failure && !legacyPage) {
    if (startup === "loading") waiting = true;
    else if (
      plugins.activation[
        target.kind === "page" ? target.pluginId : "buzz.channels"
      ]?.status === "starting"
    )
      waiting = true;
    else if (!page) failure = "unavailable";
    else if (target.kind === "page" && target.route) {
      try {
        if (
          !page.route ||
          page.route.version !== target.route.version ||
          !page.route.validate(target.route.params)
        )
          failure = "unavailable";
      } catch {
        failure = "unavailable";
      }
    }
  }
  if (
    target.kind === "settings" &&
    !failure &&
    !waiting &&
    target.section &&
    ![
      "profile",
      "plugins",
      "appearance",
      "shortcuts",
      "agents",
      "notifications",
      "updates",
    ].includes(target.section) &&
    !(developerMode && target.section === "developer")
  ) {
    // Plugin cards are addressed by contribution key.
    const section = target.section;
    const owner = section.split("/")[0] ?? "";
    if (visibility !== true) {
      if (
        retainedAttempt !== state.attempt ||
        startup === "loading" ||
        plugins.activation[owner]?.status === "starting" ||
        visibility === "pending"
      )
        waiting = true;
      else failure = "unavailable";
    }
  }
  // Legacy Home resolves to Messages; version-1 placeholder routes resolve to
  // their standalone plugins. Preserve scope so normalization never grants access.
  // Resolve in place before paint: links and history share one policy.
  // Keep the caller and visit rather than adding a redirect to browser history.
  useLayoutEffect(() => {
    if (legacyHome)
      services.navigationHost.resolve(state.attempt, {
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
      });
    else if (legacyPage)
      services.navigationHost.resolve(state.attempt, {
        version: 1,
        kind: "page",
        pluginId: `buzz.${legacyPage}`,
        pageId: legacyPage,
        ...(scope !== undefined ? { scope } : {}),
      });
  }, [services, state.attempt, legacyHome, legacyPage, scope]);
  const owner = useMemo(
    () => ({ attempt: state.attempt, page, waiting, failure }),
    [state.attempt, page, waiting, failure],
  );
  const [presentation, setPresentation] = useState<{
    owner: typeof owner;
    request: PageNavigation;
  }>();
  useLayoutEffect(() => {
    if (owner.waiting || owner.failure) return;
    const { request, dispose } = services.navigationHost.request(
      owner.attempt,
      {
        valid() {
          // Check exact registration identity at use time, before eventual React cleanup.
          if (owner.page && !services.pages.snapshot().includes(owner.page))
            return false;
          const target = owner.attempt.entry.target;
          if (!("scope" in target) || target.scope === undefined) return true;
          const client = services.communities.snapshot();
          if (client.status === "loading") return false;
          if (target.scope === null) return client.selected === null;
          const scope = target.scope;
          return (
            client.viewer === scope.viewer &&
            client.memberships.some(
              (item) =>
                item.id === client.selected &&
                communityDestination(item.id).url === scope.communityOrigin,
            )
          );
        },
        subscribe(listener) {
          const stopPages = services.pages.subscribe(listener);
          const stopClient = services.communities.subscribe(listener);
          const stopSettingsCards = services.settingsCards.subscribe(listener);
          return () => {
            stopPages();
            stopClient();
            stopSettingsCards();
          };
        },
      },
    );
    setPresentation({ owner, request });
    return dispose;
  }, [services, owner]);
  const request =
    presentation?.owner === owner ? presentation.request : undefined;
  useEffect(() => {
    if (state.attempt.signal.aborted) return;
    if (failure) {
      services.navigationHost.complete(state.attempt, {
        status: "failed",
        reason: failure,
      });
      return;
    }
    if (
      scope === null &&
      client.status !== "loading" &&
      client.selected !== null
    )
      services.communities.select(null);
    if (
      scope &&
      client.status !== "loading" &&
      client.viewer === scope.viewer &&
      membership &&
      client.selected !== membership.id
    ) {
      services.communities.select(membership.id);
    }
  }, [services, state.attempt, failure, scope, client, membership]);
  const select = (key: string) => {
    const selectedClient = services.communities.snapshot();
    let destination: OpenTarget;
    if (key === "settings")
      destination = {
        version: 1,
        kind: "settings",
        ...(selectedClient.viewer && selectedClient.selected
          ? {
              scope: {
                viewer: selectedClient.viewer,
                communityOrigin: communityDestination(selectedClient.selected)
                  .url,
              },
            }
          : { scope: null }),
      };
    else {
      const selected = pages.find((page) => page.key === key);
      if (!selected) return;
      destination = {
        version: 1,
        kind: "page",
        pluginId: selected.pluginId,
        pageId: selected.id,
        ...(selectedClient.viewer && selectedClient.selected
          ? {
              scope: {
                viewer: selectedClient.viewer,
                communityOrigin: communityDestination(selectedClient.selected)
                  .url,
              },
            }
          : { scope: null }),
      };
    }
    void navigation.open(destination);
  };
  return {
    state,
    target,
    pages,
    page,
    request,
    select,
    waiting,
    failure,
    selected: pageKey ?? target.kind,
    leaveSettings() {
      const previous = lastNonSettings.current;
      if (previous) {
        void navigation.open(previous);
        return;
      }
      const selectedClient = services.communities.snapshot();
      if (!selectedClient.viewer) return;
      void navigation.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        ...(selectedClient.selected
          ? {
              scope: {
                viewer: selectedClient.viewer,
                communityOrigin: communityDestination(selectedClient.selected)
                  .url,
              },
            }
          : { scope: null }),
      });
    },
    retry() {
      // Retrying presentation must also repair its failed dependency. Only touch the
      // selected, authorized destination; never reconnect an unrelated community.
      if (
        (pageKey === channelsKey ||
          pageKey === "buzz.projects/projects" ||
          pageKey === "buzz.agents/agents" ||
          settings) &&
        !state.ingress &&
        (!failure ||
          (settings && failure === "unavailable" && visibility === "error")) &&
        !waiting
      ) {
        const status = services.relay.snapshot().status;
        if (status === "error" || status === "disconnected")
          services.relay.retry();
      }
      void navigation.retry();
    },
  };
}
