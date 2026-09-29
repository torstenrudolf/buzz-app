// FOUNDATION: Startup, navigation, contributed pages, and built-in Settings.
import { IdentitySetup } from "../features/identity/IdentitySetup";
import { ChannelSidebar } from "../features/channel-navigation/ChannelSidebar";
import { ChannelNavigationProvider } from "../features/channel-navigation/ChannelNavigationState";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { Button } from "../shared/design-system/ui/Button";
import { AgentWakeNotice } from "../features/agents/AgentWakeNotice";
import { UpdateNotice } from "../features/updates/UpdateNotice";
import { useEffect, useSyncExternalStore } from "react";
import { registerAppShortcuts } from "./shortcuts";
import type { AppServices } from "./services";
import { Settings } from "./Settings";
import { SettingsSidebar } from "./SettingsSidebar";
import { RecoveryScreen } from "./RecoveryScreen";
import { PageView } from "../features/pages/PageView";
import { useAppNavigation } from "./navigation";
import { NavigationControls } from "./shell/NavigationControls";
import { registerNavigationShortcuts } from "./shortcuts";
import { AppShell } from "./shell/AppShell";
import { pagePresentation, shellPresentation } from "./shell/presentation";
import { usePanelLauncher } from "./shell/usePanelLauncher";
import { PanelLaunchers } from "./shell/PanelLaunchers";
import { PanelCard } from "../features/panels/PanelCard";
import { communityDestination } from "../features/communities/destination";
import { profileTarget } from "../features/profiles/target";

export function App({ services }: { services: AppServices }) {
  return services.identity ? (
    <IdentitySetup identity={services.identity}>
      <ConnectedApp services={services} />
    </IdentitySetup>
  ) : (
    <ConnectedApp services={services} />
  );
}

function ConnectedApp({ services }: { services: AppServices }) {
  const { plugins } = services;
  const startup = useSyncExternalStore(plugins.subscribe, plugins.startup);
  const route = useAppNavigation(services);
  const launcher = usePanelLauncher(services.panels, startup === "ready");
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const connection = useSyncExternalStore(
    services.relay.subscribe,
    services.relay.snapshot,
  );
  const restoring = client.status === "loading" || !!connection.restoring;
  const settings = route.target.kind === "settings";
  const select = route.select;
  useEffect(
    () =>
      registerAppShortcuts(
        services.shortcuts,
        services.appearance,
        () => {
          void services.navigation.open({ version: 1, kind: "settings" });
          document.getElementById("main-content")?.focus();
        },
        true,
      ),
    [services],
  );
  useEffect(
    () => registerNavigationShortcuts(services.shortcuts, services.navigation),
    [services],
  );
  const presentation = route.page
    ? pagePresentation(route.page)
    : shellPresentation.settings;
  const selectedPanel = launcher.selected;
  const companion = selectedPanel && (
    <PanelCard
      ref={launcher.panelRef}
      panel={selectedPanel}
      target={launcher.target ?? ""}
      close={launcher.close}
    />
  );
  // Personal space has no community profile to view; the panel needs a session.
  const ownProfile =
    client.selected && client.viewer ? profileTarget(client.viewer) : undefined;
  const pageOwnsCompanion = !!route.page?.companion;
  // Keep the parser launch surface through local bootstrap, not network refresh.
  if (!settings && restoring)
    return (
      <div className="buzz-launch" role="status" aria-label="Opening Buzz">
        <img src="/buzz-mark.svg" alt="Buzz" width="72" height="72" />
      </div>
    );
  return (
    <ToastProvider>
      <ChannelNavigationProvider relay={services.relay}>
        <AppShell
          sidebar={(pageNavigation) =>
            settings ? (
              <SettingsSidebar
                cards={services.settingsCards}
                communities={services.communities}
                {...(route.target.kind === "settings" && route.target.section
                  ? { selected: route.target.section }
                  : {})}
                onBack={route.leaveSettings}
                onSection={(section) => {
                  const client = services.communities.snapshot();
                  void services.navigation.open({
                    version: 1,
                    kind: "settings",
                    section,
                    ...(client.viewer && client.selected
                      ? {
                          scope: {
                            viewer: client.viewer,
                            communityOrigin: communityDestination(
                              client.selected,
                            ).url,
                          },
                        }
                      : { scope: null }),
                  });
                }}
              />
            ) : (
              <ChannelSidebar
                relay={services.relay}
                navigator={services.navigation}
                providers={services.channelTemplates}
                target={route.target}
                sessionsEnabled={route.pages.some(
                  (page) => page.pluginId === "buzz.sessions",
                )}
              >
                {pageNavigation}
              </ChannelSidebar>
            )
          }
          navigationControls={
            <NavigationControls navigation={services.navigation} />
          }
          onCommunitySelect={(id) => {
            const recovering =
              services.navigation.snapshot().ingress &&
              services.navigation.snapshot().retryable;
            services.communities.select(id);
            if (!recovering) select("buzz.channels/channels");
          }}
          communities={services.communities}
          accountActions={services.accountActions}
          onProfile={
            ownProfile && launcher.canOpen(ownProfile)
              ? (trigger) => launcher.open(ownProfile, trigger)
              : undefined
          }
          searchServices={services}
          launchers={
            <PanelLaunchers
              panels={launcher.available}
              selected={selectedPanel}
              launch={launcher.launch}
            />
          }
          companion={pageOwnsCompanion ? undefined : companion}
          pages={startup === "ready" ? route.pages : []}
          selected={route.selected}
          navigationAttempt={route.state.attempt.id}
          onSelect={select}
          tone={presentation.tone}
          workspace={startup === "ready" && route.page?.layout === "workspace"}
        >
          <AgentWakeNotice control={services.agentControl} />
          <UpdateNotice updates={services.updates} />
          {startup === "recovery" && !settings ? (
            <RecoveryScreen plugins={plugins} />
          ) : (!route.state.ingress && route.failure) ||
            route.state.status === "failed" ? (
            <div role="alert" className="notice">
              <h1>This destination couldn’t open</h1>
              <p>
                {(route.state.reason ?? route.failure) === "denied"
                  ? "This target needs its original account and an already joined community."
                  : route.state.ingress && !route.state.retryable
                    ? "This link is invalid or unsupported."
                    : "The destination is unavailable or isn’t supported yet. Your target has been kept for retry."}
              </p>
              {(!route.state.ingress || route.state.retryable) && (
                <Button type="button" onClick={route.retry}>
                  Retry navigation
                </Button>
              )}
              <Button type="button" onClick={() => select("settings")}>
                Open Settings
              </Button>
            </div>
          ) : route.waiting ? (
            <p role="status">Opening destination…</p>
          ) : settings ? (
            <Settings
              plugins={plugins}
              cards={services.settingsCards}
              communities={services.communities}
              identity={services.identity}
              appearance={services.appearance}
              shortcuts={services.shortcuts}
              shortcutBindings={services.shortcutBindings}
              notifications={services.notifications}
              agentControl={services.agentControl}
              updates={services.updates}
              navigation={route.request}
              navigationPane
              onSection={(section) => {
                const client = services.communities.snapshot();
                void services.navigation.open({
                  version: 1,
                  kind: "settings",
                  section,
                  ...(client.viewer && client.selected
                    ? {
                        scope: {
                          viewer: client.viewer,
                          communityOrigin: communityDestination(client.selected)
                            .url,
                        },
                      }
                    : { scope: null }),
                });
              }}
            />
          ) : startup === "loading" ? (
            <p role="status">Opening destination…</p>
          ) : route.page ? (
            <PageView
              page={route.page}
              navigation={route.request}
              companion={pageOwnsCompanion ? companion : undefined}
            />
          ) : null}
        </AppShell>
      </ChannelNavigationProvider>
    </ToastProvider>
  );
}
