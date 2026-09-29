import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChannelLifecycleDialog } from "../../bundled/channels/ChannelLifecycleDialog";
import { ChannelLifecycleMenu } from "../../bundled/channels/ChannelLifecycleMenu";
import type { ChannelLifecycleAction } from "../relay/channel-lifecycle-protocol";
import { personalGroups } from "../channel-templates/setup";
import type { TemplateProviders } from "../channel-templates/provider";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { useChannelList, useRelayConnection } from "../relay/react";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuIcon,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import type { ChannelSummary } from "../relay/contracts";
import { useChannelRowMenu } from "../../bundled/channels/useChannelRowMenu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { clientMetrics } from "../developer/client-metrics";
import {
  BellIcon,
  BellSlashIcon,
  FolderSimpleIcon,
} from "../../shared/design-system/icons";
import { ChannelReadMenuItem } from "../../bundled/channels/ChannelReadMenuItem";
import { useOptimisticMute } from "../../bundled/channels/useOptimisticMute";
import { ChannelSidebarItem } from "../../bundled/channels/ChannelSidebarItem";
import { SidebarUnread } from "../../bundled/channels/SidebarUnread";
import { SidebarSection } from "../../bundled/channels/SidebarSection";
import { SidebarGroupIcon } from "../../bundled/channels/SidebarGroupIcon";
import { CreateSidebarSection } from "../../bundled/channels/CreateSidebarSection";
import { useSidebarStartup } from "../../bundled/channels/useSidebarStartup";
import { projectPersonalGroups } from "../relay/sidebar-personal-groups";
import { useChannelLabels } from "../../bundled/channels/useChannelLabels";
import { useHiddenDms } from "../../bundled/channels/useHiddenDms";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
import { useSidebarView } from "../../bundled/channels/useSidebarView";
import {
  sidebarSections,
  isChannelSectionKey,
} from "../../bundled/channels/sidebar-sections";
import {
  CreateChannelDialog,
  type CreateChannelInput,
} from "../../bundled/channels/CreateChannelDialog";
import { writeView } from "../../shared/view-state";
import { useChannelNavigation } from "./ChannelNavigationState";
import { newSessionParent } from "./routes";
import { ChannelSidebarResizeHandle } from "./ChannelSidebarResizeHandle";
import styles from "../../bundled/channels/Channels.module.css";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  providers: TemplateProviders;
  target: OpenTarget;
  sessionsEnabled: boolean;
  children: ReactNode;
};
export function ChannelSidebar(props: Props) {
  const connection = useRelayConnection(props.relay);
  const navigation = <SidebarNavigation>{props.children}</SidebarNavigation>;
  return (
    <SidebarBoundary
      key={`${connection.scope}:${connection.generation}`}
      fallback={navigation}
    >
      {connection.status === "ready" || connection.cached ? (
        <ReadySidebar
          {...props}
          key={`${connection.scope}:${connection.generation}`}
          cached={!!connection.cached}
          connectionError={connection.error}
          queries={connection.session}
          scope={connection.scope ?? "disconnected"}
          viewer={connection.viewer}
        />
      ) : (
        <div className="shell-sidebar-default">
          <Panel as="aside" aria-label="Channel sidebar">
            <div className={styles.sidebar}>
              <div className={styles.sidebarScroll}>
                {navigation}
                <p className={styles.empty}>
                  {connection.status === "connecting"
                    ? "Connecting to your relay…"
                    : (connection.error ??
                      "Choose a community to see channels.")}
                </p>
                {connection.status === "error" && (
                  <Button onClick={props.relay.retry}>Retry channels</Button>
                )}
              </div>
            </div>
          </Panel>
        </div>
      )}
    </SidebarBoundary>
  );
}

function SidebarNavigation({ children }: { children: ReactNode }) {
  return (
    <>
      <div className={styles.sidebarBrand}>
        <span
          className={styles.sidebarBrandMark}
          role="img"
          aria-label="Buzz"
        />
      </div>
      {/* The shell passes null when no primary page is active; the wrapper's margin must not remain around nothing. */}
      {children != null && children !== false && (
        <div className={styles.destinations}>{children}</div>
      )}
    </>
  );
}
class SidebarBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="shell-sidebar-default">
        <Panel as="aside" aria-label="Channel sidebar">
          <div className={styles.sidebar}>
            <div className={styles.sidebarScroll}>
              {this.props.fallback}
              <p role="alert">Channels couldn’t open.</p>
              <Button onClick={() => this.setState({ failed: false })}>
                Retry channels
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    ) : (
      this.props.children
    );
  }
}
function ReadySidebar({
  relay,
  navigator,
  providers,
  target,
  sessionsEnabled,
  children,
  queries,
  cached,
  connectionError,
  scope,
  viewer,
}: Props & {
  queries: RelaySession;
  cached: boolean;
  connectionError?: string | undefined;
  scope: string;
  viewer?: string | undefined;
}) {
  const list = useChannelList(queries.channels);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  const startup = useSidebarStartup(queries, list, preferences);
  const [activityErrorDismissed, setActivityErrorDismissed] = useState(false);
  useEffect(() => {
    if (list.activityStatus !== "error") setActivityErrorDismissed(false);
  }, [list.activityStatus]);
  const mute = useOptimisticMute(queries.sidebarPreferences.setMute);
  const rowMenuGeneration = useRef(0);
  const [readWrite, setReadWrite] = useState<{
    pending: boolean;
    error?: string;
  }>();
  const [rowFocus, setRowFocus] = useState<string>();
  const kitState = useSyncExternalStore(
    queries.channelKit.subscribe,
    queries.channelKit.snapshot,
  );
  const personal = personalGroups(kitState.entries)?.record.value;
  const groups = personal?.type === "groups" ? personal : undefined;
  const hiddenDms = useHiddenDms(scope, queries, list);
  const lifecycle = queries.channelLifecycle;
  const dmVisibility = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.snapshot,
    lifecycle.snapshot,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a completed roster refresh also refreshes per-viewer visibility.
  useEffect(() => {
    if (list.status === "ready") void lifecycle.refreshVisibility();
  }, [lifecycle, list.asOf, list.status]);
  const lifecycleFocus = useRef<string | undefined>(undefined);
  const lifecycleTrigger = useRef<HTMLElement | undefined>(undefined);
  const sidebar = useSidebarView(
    scope,
    startup.ready &&
      list.status === "ready" &&
      (preferences.status !== "loading" || !!preferences.cached),
  );
  const { channels, profiles: dmProfiles } = useChannelLabels(
    list.channels,
    queries.profiles,
    queries.names,
  );
  const workingIds = useSyncExternalStore(
    queries.agentActivity.subscribeWorking,
    queries.agentActivity.workingSnapshot,
    queries.agentActivity.workingSnapshot,
  );
  const workingChannels = useMemo(
    () => new Set<string>(JSON.parse(workingIds)),
    [workingIds],
  );
  const handoff = useChannelNavigation();
  const lifecycleDialog = handoff?.lifecycleDialog;
  const draftParents = handoff?.draftParents ?? [];
  const draftParent =
    target.kind === "page" &&
    target.pluginId === "buzz.channels" &&
    sessionsEnabled
      ? newSessionParent(target.route?.params)
      : undefined;
  const composingMessage =
    target.kind === "page" &&
    target.pluginId === "buzz.channels" &&
    target.route?.params === "new-message";
  const preparingDm = composingMessage ? handoff?.preparingDm : undefined;
  const sidebarChannels = channels.filter(
    (channel) =>
      !preparingDm ||
      preparingDm.existing.has(channel.id) ||
      channel.channelType !== "dm" ||
      channel.members?.length !== preparingDm.members.size ||
      !channel.members.every((member) => preparingDm.members.has(member)),
  );
  const current = channels.find(
    (channel) =>
      channel.id ===
      (target.kind === "conversation" ? target.channelId : draftParent),
  );
  const childSessions = useRef(new Map<string, typeof channels>());
  const childrenByParent = useMemo(() => {
    const children = new Map<string, typeof channels>();
    for (const item of channels) {
      if (item.channelType !== "session" || !item.parentChannelId) continue;
      const siblings = children.get(item.parentChannelId) ?? [];
      siblings.push(item);
      children.set(item.parentChannelId, siblings);
    }
    for (const [parent, siblings] of children) {
      siblings.sort(
        (a, b) =>
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
      );
      const previous = childSessions.current.get(parent);
      if (
        previous?.length === siblings.length &&
        siblings.every((child, index) => child === previous[index])
      )
        children.set(parent, previous);
    }
    childSessions.current = children;
    return children;
  }, [channels]);

  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const createChannelTrigger = useRef<HTMLButtonElement>(null);
  const startingSession = useRef(false);
  const removedDmFocus = useRef<
    { channelId: string; target: HTMLElement } | undefined
  >(undefined);
  const pendingCreate = useRef<ChannelSummary | undefined>(undefined);
  const [creatingFor, setCreatingFor] = useState<ChannelSummary>();

  const [initialGroup, setInitialGroup] = useState("");
  const pendingChannelCreation = useSyncExternalStore(
    queries.channelCreation.subscribe,
    queries.channelCreation.snapshot,
    queries.channelCreation.snapshot,
  );
  const setupNotices = useSyncExternalStore(
    queries.channelCreation.subscribe,
    queries.channelCreation.notices,
    queries.channelCreation.notices,
  );
  useEffect(() => {
    if (list.status === "ready") {
      queries.channelKit.ensure();
      void queries.unread.ensure();
    }
  }, [queries, list.status]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const chooseLifecycle = (
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
  ) => {
    // Let the existing context menu restore focus before opening confirmation.
    requestAnimationFrame(() => {
      if (mounted.current) handoff?.openLifecycle(channel, action);
    });
  };
  useLayoutEffect(() => {
    if (!lifecycleFocus.current || lifecycleDialog) return;
    const id = lifecycleFocus.current;
    lifecycleFocus.current = undefined;
    const trigger = lifecycleTrigger.current;
    lifecycleTrigger.current = undefined;
    if (trigger?.isConnected) {
      trigger.focus({ preventScroll: true });
      return;
    }
    const rows = [
      ...(sidebar.list.current?.querySelectorAll<HTMLButtonElement>(
        "[data-channel-id]",
      ) ?? []),
    ];
    const row =
      rows.find(
        (row) => row.dataset.channelId === id && row.getClientRects().length,
      ) ?? rows.find((row) => row.getClientRects().length);
    (
      row ??
      sidebar.list.current
        ?.closest("aside")
        ?.querySelector<HTMLButtonElement>("button")
    )?.focus({ preventScroll: true });
  }, [lifecycleDialog, sidebar.list]);
  const select = useCallback(
    (id: string) => {
      if (!viewer || relay.snapshot().session !== queries) return;
      clientMetrics.channelIntent(id, window.event);
      writeView(scope, "selected-channel", id);
      void navigator.open({
        version: 1,
        kind: "conversation",
        channelId: id,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    },
    [navigator, relay, queries, scope, viewer],
  );
  const startSession = useCallback(
    (parentId: string) => {
      const parent = channels.find((channel) => channel.id === parentId);
      if (
        !viewer ||
        relay.snapshot().session !== queries ||
        !sessionsEnabled ||
        !parent ||
        parent.readOnly ||
        parent.archived ||
        parent.channelType === "dm" ||
        parent.channelType === "session"
      )
        return;
      handoff?.updateDraftParents((previous) =>
        previous.includes(parentId) ? previous : [...previous, parentId],
      );
      sidebar.toggle(`session-children:${parentId}`, true);
      void navigator.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        route: { version: 1, params: { kind: "new-session", parentId } },
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    },
    [
      channels,
      viewer,
      relay,
      queries,
      sessionsEnabled,
      handoff,
      sidebar.toggle,
      navigator,
      scope,
    ],
  );
  const openActivityThread = useCallback(
    (channelId: string, rootId: string) => {
      if (!viewer || relay.snapshot().session !== queries) return;
      if (handoff)
        handoff.activityThread.current = {
          channelId,
          rootId,
          trigger:
            sidebar.list.current?.querySelector<HTMLElement>(
              `[data-channel-id="${CSS.escape(channelId)}"]`,
            ) ?? null,
        };
      void navigator.open({
        version: 1,
        kind: "conversation",
        channelId,
        messageId: rootId,
        threadRootId: rootId,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    },
    [viewer, relay, queries, handoff, sidebar.list, navigator, scope],
  );
  const createChannel = async (input: CreateChannelInput) => {
    const id = await queries.channelCreation.create(input);
    if (!mounted.current || relay.snapshot().session !== queries) return;
    select(id);
    sidebar.toggle(
      input.setup?.groupId ? `group:${input.setup.groupId}` : "channels",
      true,
    );
  };
  // The independent personal catalog remains readable when legacy preferences
  // fail. This fallback is presentation-only: the store still gates moves until
  // a successful retry and owns every optimistic placement when writable.
  const displayedPreferences =
    groups && !preferences.writable
      ? {
          ...preferences.data,
          ...projectPersonalGroups(groups),
          starred: preferences.data?.starred ?? [],
          muted: preferences.data?.muted ?? [],
        }
      : preferences.data;
  const sections = startup.ready
    ? sidebarSections(
        sidebarChannels,
        displayedPreferences,
        new Set([...hiddenDms.hiddenIds, ...dmVisibility.hidden]),
      )
    : [];
  const focusChannelPlacement = (channelId: string) => {
    const data = queries.sidebarPreferences.snapshot().data;
    const sectionId = data?.assignments[channelId];
    const sectionKey = data?.starred.includes(channelId)
      ? "starred"
      : sectionId
        ? `group:${sectionId}`
        : "channels";
    sidebar.toggle(sectionKey, true);
    setRowFocus(channelId);
  };
  const moveChannel = (
    channelId: string,
    operation: () => Promise<unknown>,
  ) => {
    const saving = operation(); // Publishes optimistic placement synchronously.
    closeRowMenu();
    focusChannelPlacement(channelId);
    void saving.catch(() => {
      // The session exposes retry even after page/menu unmount. Restore a row
      // focus lost to rollback, but never steal focus from another control.
      if (
        sidebar.list.current?.isConnected &&
        document.activeElement === document.body
      )
        focusChannelPlacement(channelId);
    });
  };
  const assignGroup = (channelId: string, sectionId?: string) =>
    moveChannel(channelId, () => preferences.assign(channelId, sectionId));
  const setChannelStar = (channelId: string, starred: boolean) =>
    moveChannel(channelId, () => preferences.setStar(channelId, starred));
  const setSectionSort = (key: string, mode: "alpha" | "recent") => {
    void preferences
      .setSort(
        key.startsWith("group:") ? `section:${key.slice(6)}` : key,
        mode,
        displayedPreferences?.sections.map((section) => section.id) ?? [],
      )
      .catch(() => {});
  };
  // Compose actual items here; menu availability is their count, not the policy
  // of any one action. Sibling actions keep their own eligibility checks.
  const rowActions = (channel: ChannelSummary, sectionKey: string) => {
    const actions: ReactNode[] = [];
    if (
      sessionsEnabled &&
      channel.channelType !== "dm" &&
      channel.channelType !== "session" &&
      !channel.archived
    ) {
      actions.push(
        <MenuItem
          key="new-session"
          onClick={() => {
            startingSession.current = true;
            startSession(channel.id);
          }}
        >
          New session
        </MenuItem>,
      );
    }
    if (
      preferences.writable &&
      preferences.starWritable &&
      preferences.data &&
      channel.channelType !== "dm" &&
      channel.channelType !== "forum"
    ) {
      const currentSectionId = sectionKey.startsWith("group:")
        ? sectionKey.slice("group:".length)
        : undefined;
      const starred = sectionKey === "starred";
      if (actions.length) actions.push(<MenuSeparator key="group-actions" />);
      actions.push(
        <MenuSubmenu key="move-channel">
          <MenuSubmenuTrigger>
            <MenuIcon>
              <FolderSimpleIcon size={14} />
            </MenuIcon>
            Move channel
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup
            aria-label={`Move ${channel.name} to section`}
            // The root restores by channel identity after relocation;
            // a nested popup must not refocus its retired trigger.
            finalFocus={false}
          >
            <MenuGroup>
              <MenuGroupLabel>Move to…</MenuGroupLabel>
            </MenuGroup>
            <MenuRadioGroup
              value={
                starred
                  ? "starred"
                  : currentSectionId
                    ? `group:${currentSectionId}`
                    : "channels"
              }
              onValueChange={(destination) => {
                if (destination === "starred")
                  void setChannelStar(channel.id, !starred);
                else {
                  const groupId = destination.slice("group:".length);
                  void assignGroup(
                    channel.id,
                    groupId === currentSectionId ? undefined : groupId,
                  );
                }
              }}
            >
              <MenuRadioItem value="starred" closeOnClick={false}>
                <MenuIcon>★</MenuIcon>
                Starred
              </MenuRadioItem>
              {preferences.data?.sections.map((group) => (
                <MenuRadioItem
                  key={group.id}
                  value={`group:${group.id}`}
                  closeOnClick={false}
                >
                  {group.icon && (
                    <MenuIcon>
                      <SidebarGroupIcon icon={group.icon} session={queries} />
                    </MenuIcon>
                  )}
                  {group.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                pendingCreate.current = channel;
              }}
            >
              <MenuIcon>＋</MenuIcon>Create new…
            </MenuItem>
            {(starred || currentSectionId) && (
              <MenuItem
                closeOnClick={false}
                onClick={() => {
                  if (starred) void setChannelStar(channel.id, false);
                  else void assignGroup(channel.id);
                }}
              >
                Remove from{" "}
                {sections.find((section) => section.key === sectionKey)?.title}
              </MenuItem>
            )}
          </MenuSubmenuPopup>
        </MenuSubmenu>,
      );
    }
    const muteable =
      queries.sidebarPreferences.muteWritable && !!preferences.data;
    const readable = queries.unread.sync().capability === "frontier-sync";
    if (actions.length && (muteable || readable))
      actions.push(<MenuSeparator key="attention-separator" />);
    if (muteable) {
      const intent = mute.intents.get(channel.id);
      const muted = intent?.pending
        ? intent.muted
        : (preferences.data?.muted.includes(channel.id) ?? false);
      actions.push(
        <MenuItem
          key="mute"
          closeOnClick={false}
          disabled={readWrite?.pending ?? false}
          onClick={() => changeMute(channel.id, channel.name, !muted)}
        >
          <MenuIcon>
            {muted ? <BellIcon size={14} /> : <BellSlashIcon size={14} />}
          </MenuIcon>
          {muted ? "Unmute" : "Mute"}
        </MenuItem>,
      );
    }
    if (readable)
      actions.push(
        <ChannelReadMenuItem
          key="read"
          unread={queries.unread}
          channelId={channel.id}
          pending={readWrite?.pending ?? false}
          run={(action) => runReadAction(channel.id, action)}
        />,
      );
    if (channel.channelType !== "session" && !channel.archived) {
      actions.push(
        <ChannelLifecycleMenu
          key="lifecycle"
          separator={actions.length > 0}
          channelId={channel.id}
          lifecycle={lifecycle}
          disabled={!!lifecycleDialog}
          choose={(action) => chooseLifecycle(channel, action)}
        />,
      );
    }
    if (channel.channelType === "dm") {
      actions.push(
        <MenuItem
          key="remove-message"
          onClick={() => {
            const trigger = sidebar.list.current?.querySelector<HTMLElement>(
              `[data-channel-id="${CSS.escape(channel.id)}"]`,
            );
            const section = trigger?.closest("[data-sidebar-section]");
            const rows = [
              ...(section?.querySelectorAll<HTMLElement>(
                "button[data-channel-id]",
              ) ?? []),
            ];
            const index = rows.indexOf(trigger as HTMLButtonElement);
            const survivingSummary = [
              ...(sidebar.list.current?.querySelectorAll<HTMLElement>(
                "[data-sidebar-section] details > summary",
              ) ?? []),
            ].find((summary) => !section?.contains(summary));
            const target =
              rows[index + 1] ?? rows[index - 1] ?? survivingSummary;
            removedDmFocus.current = target
              ? { channelId: channel.id, target }
              : undefined;
            hiddenDms.hide(channel.id);
          }}
        >
          Remove from Messages
        </MenuItem>,
      );
    }
    return actions;
  };
  const {
    rowMenu,
    open: openMenu,
    close: closeMenu,
  } = useChannelRowMenu(sections, rowActions);
  const openRowMenu = useCallback(
    (channel: ChannelSummary, sectionKey: string, anchor?: HTMLElement) => {
      startingSession.current = false;
      rowMenuGeneration.current++;
      setReadWrite(undefined);
      removedDmFocus.current = undefined;
      openMenu(channel, sectionKey, anchor);
    },
    [openMenu],
  );
  const closeRowMenu = useCallback(() => {
    rowMenuGeneration.current++;
    setReadWrite(undefined);
    closeMenu();
  }, [closeMenu]);
  const rowMenuClosed = useCallback((channelId: string) => {
    if (pendingCreate.current?.id === channelId) {
      setCreatingFor(pendingCreate.current);
      pendingCreate.current = undefined;
    }
  }, []);
  const rowMenuFinalFocus = useCallback(
    (channelId: string) =>
      pendingCreate.current
        ? false
        : removedDmFocus.current?.channelId === channelId
          ? removedDmFocus.current.target
          : startingSession.current
            ? (document
                .getElementById("new-session-prompt")
                ?.querySelector<HTMLElement>('[role="textbox"]') ?? false)
            : (sidebar.list.current?.querySelector<HTMLButtonElement>(
                `[data-channel-id="${CSS.escape(channelId)}"]`,
              ) ?? false),
    [sidebar.list],
  );
  useLayoutEffect(() => {
    if (!rowFocus) return;
    (
      sidebar.list.current?.querySelector<HTMLButtonElement>(
        `[data-channel-id="${CSS.escape(rowFocus)}"]`,
      ) ??
      [
        ...(sidebar.list.current?.querySelectorAll<HTMLButtonElement>(
          "[data-channel-id]",
        ) ?? []),
      ].find((row) => row.getClientRects().length) ??
      sidebar.list.current
        ?.closest("aside")
        ?.querySelector<HTMLButtonElement>("button")
    )?.focus({ preventScroll: true });
    setRowFocus(undefined);
  }, [rowFocus, sidebar.list]);
  const runReadAction = async (
    channelId: string,
    action: () => Promise<unknown>,
  ) => {
    const generation = rowMenuGeneration.current;
    setReadWrite({ pending: true });
    try {
      await action();
      if (!mounted.current || generation !== rowMenuGeneration.current) return;
      // Startup can move the row; resolve its current owner after the commit.
      setRowFocus(channelId);
      closeRowMenu();
    } catch (error) {
      if (!mounted.current || generation !== rowMenuGeneration.current) return;
      setReadWrite({
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const changeMute = (channelId: string, name: string, muted: boolean) => {
    mute.change(channelId, name, muted);
    setRowFocus(channelId);
    closeRowMenu();
  };
  return (
    <>
      {lifecycleDialog && (
        <ChannelLifecycleDialog
          channelId={lifecycleDialog.channel.id}
          channelName={lifecycleDialog.channel.name}
          action={lifecycleDialog.action}
          lifecycle={lifecycle}
          close={() => {
            lifecycleFocus.current = lifecycleDialog.channel.id;
            lifecycleTrigger.current = lifecycleDialog.trigger;
            handoff?.closeLifecycle();
          }}
          completed={() => {
            const id = lifecycleDialog.channel.id;
            lifecycleFocus.current = id;
            handoff?.closeLifecycle();
            // Confirmed access loss can already have removed current from the roster.
            if (
              (target.kind === "conversation"
                ? target.channelId
                : draftParent) === id
            ) {
              const next = sections
                .flatMap((section) => section.rows)
                .find((channel) => channel.id !== id);
              if (next) select(next.id);
              else {
                writeView(scope, "selected-channel", undefined);
                void navigator.open({
                  version: 1,
                  kind: "page",
                  pluginId: "buzz.channels",
                  pageId: "channels",
                  route: { version: 1, params: "empty" },
                });
              }
            }
          }}
        />
      )}
      {creatingFor && (
        <CreateSidebarSection
          channelName={creatingFor.name}
          maxLength={preferences.data?.groupSource === "personal" ? 120 : 256}
          writable={preferences.writable}
          refreshing={preferences.status === "loading"}
          retry={preferences.reload}
          create={(section) => {
            // The modal can outlive the snapshot that admitted its menu. Check
            // the live gate before handing its draft to the optimistic store.
            if (!queries.sidebarPreferences.writable) return false;
            moveChannel(creatingFor.id, () =>
              preferences.createAndAssign(creatingFor.id, section),
            );
            setCreatingFor(undefined);
            return true;
          }}
          close={() => {
            focusChannelPlacement(creatingFor.id);
            setCreatingFor(undefined);
          }}
        />
      )}
      <div className="shell-sidebar" style={{ width: sidebar.width }}>
        <Panel
          as="aside"
          aria-label="Channel sidebar"
          aria-busy={
            preferences.status === "loading" || startup.updating || undefined
          }
        >
          <div className={styles.sidebar}>
            {kitState.status === "error" && (
              <p role="alert">
                {kitState.error}{" "}
                <Button onClick={() => void queries.channelKit.refresh()}>
                  Retry templates
                </Button>
              </p>
            )}
            {setupNotices.map((notice) => (
              <ToastNotice
                key={notice.id}
                title={`Channel setup couldn’t finish: ${notice.name}`}
                description={notice.error}
                tone="warning"
              >
                <Button
                  size="sm"
                  onClick={() =>
                    queries.channelCreation.dismissNotice(notice.id)
                  }
                >
                  Dismiss
                </Button>
              </ToastNotice>
            ))}
            {!cached && dmVisibility.status === "error" && (
              <div role="alert">
                Hidden conversations could not be refreshed.{" "}
                <Button onClick={() => void lifecycle.refreshVisibility()}>
                  Retry hidden conversations
                </Button>
              </div>
            )}
            <SidebarUnread listRef={sidebar.list}>
              <SidebarNavigation>{children}</SidebarNavigation>
              {sections.map((section) => (
                <SidebarSection
                  key={section.key}
                  sectionKey={section.key}
                  title={section.title}
                  icon={section.icon}
                  session={queries}
                  open={!sidebar.collapsed.includes(section.key)}
                  onToggle={(open) => sidebar.toggle(section.key, open)}
                  createChannel={
                    isChannelSectionKey(section.key)
                      ? {
                          available: queries.channelCreation.available,
                          open: (trigger) => {
                            createChannelTrigger.current = trigger;
                            setInitialGroup(
                              section.key.startsWith("group:")
                                ? section.key.slice(6)
                                : "",
                            );
                            setCreateChannelOpen(true);
                          },
                        }
                      : undefined
                  }
                  newMessage={
                    section.key === "dms"
                      ? () => {
                          if (viewer && relay.snapshot().session === queries)
                            void navigator.open({
                              version: 1,
                              kind: "page",
                              pluginId: "buzz.channels",
                              pageId: "channels",
                              scope: {
                                viewer,
                                communityOrigin: scope.slice(
                                  0,
                                  -(viewer.length + 1),
                                ),
                              },
                              route: { version: 1, params: "new-message" },
                            });
                        }
                      : undefined
                  }
                  sort={
                    preferences.sortWritable
                      ? {
                          value:
                            preferences.data?.sort?.[
                              section.key.startsWith("group:")
                                ? `section:${section.key.slice(6)}`
                                : section.key
                            ] ?? "alpha",
                          change: (mode) => setSectionSort(section.key, mode),
                        }
                      : undefined
                  }
                >
                  {section.rows.map((channel) => {
                    const sessions = childrenByParent.get(channel.id);
                    const selected =
                      current?.id === channel.id ||
                      sessions?.some((child) => child.id === current?.id)
                        ? current?.id
                        : undefined;
                    const actions = rowActions(channel, section.key);
                    const menuEnabled = actions.length > 0;
                    const menuOpen =
                      menuEnabled &&
                      rowMenu?.channelId === channel.id &&
                      rowMenu.sectionKey === section.key;
                    return (
                      <ChannelSidebarItem
                        profile={
                          channel.channelType === "dm" &&
                          channel.participants?.length === 1
                            ? dmProfiles.get(channel.participants[0] ?? "")
                            : undefined
                        }
                        key={channel.id}
                        channel={channel}
                        session={queries}
                        working={workingChannels.has(channel.id)}
                        selected={composingMessage ? undefined : selected}
                        collapsed={sidebar.collapsed.includes(
                          `session-children:${channel.id}`,
                        )}
                        onToggle={sidebar.toggle}
                        draft={draftParents.includes(channel.id)}
                        draftSelected={draftParent === channel.id}
                        sessions={sessions}
                        onSelect={select}
                        onNewSession={startSession}
                        onOpenThread={openActivityThread}
                        menuEnabled={menuEnabled}
                        sectionKey={section.key}
                        onOpenMenu={openRowMenu}
                        menuOpen={menuOpen}
                        menuAnchor={menuOpen ? rowMenu.anchor : undefined}
                        menuContent={
                          menuOpen ? (
                            <>
                              {actions}
                              {readWrite?.pending && (
                                <p role="status">Saving…</p>
                              )}
                              {readWrite?.error && (
                                <p role="alert">{readWrite.error}</p>
                              )}
                            </>
                          ) : undefined
                        }
                        onCloseMenu={closeRowMenu}
                        onMenuClosed={rowMenuClosed}
                        menuFinalFocus={rowMenuFinalFocus}
                      />
                    );
                  })}
                </SidebarSection>
              ))}
              {!startup.ready && (
                <p className={styles.empty} role="status">
                  Loading your sidebar…
                </p>
              )}
              {list.status === "error" && (
                <p role="alert" className={styles.empty}>
                  {list.error}
                </p>
              )}
              {startup.ready && list.status === "ready" && !channels.length && (
                <p className={styles.empty}>No channels yet.</p>
              )}
            </SidebarUnread>
            {cached && connectionError && (
              <p className={styles.preferenceNotice} role="status">
                Offline · Showing saved conversations.
                <Button onClick={relay.retry}>Retry connection</Button>
              </p>
            )}
            {preferences.sortErrors?.map(({ group, mode, error }) => (
              <div key={group} className={styles.preferenceNotice} role="alert">
                <p>
                  Couldn’t save the sort order for{" "}
                  {sections.find(
                    ({ key }) =>
                      key ===
                      (group.startsWith("section:")
                        ? `group:${group.slice(8)}`
                        : group),
                  )?.title ?? "this section"}
                  . {error}
                </p>
                <button
                  type="button"
                  onClick={() => setSectionSort(group, mode)}
                >
                  Retry sort
                </button>
                <button
                  type="button"
                  onClick={() => preferences.dismissSortError(group)}
                >
                  Dismiss
                </button>
              </div>
            ))}
            {[...mute.intents.values()]
              .filter((intent) => !intent.pending)
              .map((intent) => (
                <ToastNotice
                  key={intent.channelId}
                  title={`Couldn’t ${intent.muted ? "mute" : "unmute"} ${intent.name}`}
                  description={intent.error ?? "Please try again."}
                  tone="warning"
                >
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      changeMute(intent.channelId, intent.name, intent.muted)
                    }
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      mute.dismiss(intent.channelId);
                      setRowFocus(intent.channelId);
                    }}
                  >
                    Dismiss
                  </Button>
                </ToastNotice>
              ))}
            {preferences.moves
              ?.filter((move) => !move.pending)
              .map((move) => (
                <div
                  key={move.id}
                  className={styles.preferenceNotice}
                  role="alert"
                >
                  <p>
                    Couldn’t save the move for{" "}
                    {channels.find(({ id }) => id === move.channelId)?.name ??
                      "this channel"}
                    . {move.error}
                  </p>
                  <p>
                    The previous placement is shown. A partial save may already
                    exist on the relay.
                  </p>
                  {!preferences.writable && (
                    <p>
                      Refresh saved sidebar preferences before retrying this
                      move.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={!preferences.writable}
                    onClick={() =>
                      moveChannel(move.channelId, () =>
                        preferences.retryMove(move.channelId),
                      )
                    }
                  >
                    Retry move
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      preferences.dismissMoveError(move.channelId);
                      focusChannelPlacement(move.channelId);
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              ))}
            {!cached && startup.ready && preferences.status === "error" ? (
              <ToastNotice
                title="Saved sidebar preferences couldn’t refresh"
                description="Your conversations are still available."
                tone="warning"
              >
                <Button type="button" size="sm" onClick={preferences.reload}>
                  Retry
                </Button>
              </ToastNotice>
            ) : !cached &&
              startup.ready &&
              preferences.status === "unsupported" ? (
              <p className={styles.preferenceNotice} role="status">
                Saved groups and stars aren’t supported by this host yet.
              </p>
            ) : null}
            {list.activityStatus === "error" && !activityErrorDismissed && (
              <ToastNotice
                title="Couldn’t refresh recent activity"
                description="Sections sorted by Recent may be out of date."
                tone="warning"
                onDismiss={() => setActivityErrorDismissed(true)}
              >
                <Button
                  type="button"
                  size="sm"
                  onClick={() => queries.channels.refreshList?.()}
                >
                  Retry
                </Button>
              </ToastNotice>
            )}
          </div>
        </Panel>
        <CreateChannelDialog
          open={createChannelOpen}
          onOpenChange={setCreateChannelOpen}
          onCreate={createChannel}
          pending={pendingChannelCreation}
          finalFocus={createChannelTrigger}
          session={queries}
          providers={providers}
          groups={groups}
          destinations={displayedPreferences?.sections ?? []}
          {...(preferences.data?.groupSource !== "personal"
            ? { groupSource: "legacy" as const }
            : {})}
          initialGroup={initialGroup}
          groupsReady={preferences.writable}
        />
      </div>
      <ChannelSidebarResizeHandle
        width={sidebar.width}
        setWidth={sidebar.setWidth}
      />
    </>
  );
}
