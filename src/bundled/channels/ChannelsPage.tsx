import type { AgentControl } from "../../features/agents/control";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { clientMetrics } from "../../features/developer/client-metrics";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import {
  channelPlaceholder,
  newSessionParent,
} from "../../features/channel-navigation/routes";
import { personalGroups } from "../../features/channel-templates/setup";
import type { TemplateProviders } from "../../features/channel-templates/provider";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { ChannelCanvasDialog } from "./ChannelCanvasDialog";
import { Select } from "../../shared/design-system/ui/Select";
import { NewMessage } from "../../features/direct-messages/NewMessage";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useChannelPanels } from "./useChannelPanels";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";
import { ChannelLifecycleActions } from "./ChannelLifecycleActions";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import { SessionMessageTarget } from "../../features/sessions/SessionMessageTarget";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import {
  NewSessionView,
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import { UnreadOptions } from "./UnreadBadge";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DotsThreeIcon,
  PlugIcon,
  ChatCircleIcon,
} from "../../shared/design-system/icons/index";
import { channelIcon } from "../../features/channels/channel-icon";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import type { PagesReader } from "../../features/pages/service";
import { PanelCard } from "../../features/panels/PanelCard";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { OutboxStatus } from "./OutboxStatus";
import { RelayTimings } from "./RelayTimings";
import { LiveStatus } from "./LiveStatus";
import { rejectUnhandledFileDrop } from "../../features/messages/use-file-drop";
import { MessageComposer } from "../../features/messages/MessageComposer";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { MediaReviewViewer } from "../../features/messages/MediaReviewViewer";
import type { Attachment } from "../../features/relay/contracts";
import { readView, writeView } from "../../shared/view-state";
import { useChannelLabels } from "./useChannelLabels";
import { useComposerSent } from "./useComposerSent";
import { useSidebarPreferences } from "./useSidebarPreferences";
import styles from "./Channels.module.css";

export function ChannelsPage({
  agentControl,
  providers,
  extensions,
  relay,
  panels,
  pages,
  companion,
  navigation,
  navigator,
}: {
  agentControl?: AgentControl | undefined;
  providers: TemplateProviders;
  extensions?: ConversationExtensions | undefined;
  relay: RelayData;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  panels: Panels;
  pages: PagesReader;
  companion?: ReactNode;
}) {
  const session = useRelayConnection(relay);
  const registeredPages = useSyncExternalStore(
    pages.subscribe,
    pages.snapshot,
    pages.snapshot,
  );
  const sessionsEnabled = registeredPages.some(
    (page) => page.pluginId === "buzz.sessions",
  );
  const sessionNavigation = navigation?.forSession(relay, session);
  useEffect(() => {
    if (!navigation || !sessionNavigation) return;
    if (session.status === "disconnected" && navigation.target.kind === "page")
      sessionNavigation.complete({ status: "opened" });
    else if (session.status === "error" && !session.cached)
      sessionNavigation.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, sessionNavigation, session.status, session.cached]);
  return (
    <section className={styles.root} aria-label="Channels">
      {session.status !== "ready" && !session.cached ? (
        <PanelFrame companion={companion}>
          <div className={styles.connect}>
            <div className={styles.connectIcon}>
              <PlugIcon size={30} />
            </div>
            <h1>Your channels, one conversation.</h1>
            <p>
              {session.status === "disconnected"
                ? "Use the left community rail to choose or add a community. Your profile and settings work without a community."
                : "Connection details and retry are in the sidebar. Your profile and settings work without a community."}
            </p>
          </div>
        </PanelFrame>
      ) : (
        <ChannelWorkspace
          agentControl={agentControl}
          providers={providers}
          extensions={extensions}
          key={`${session.scope ?? "disconnected"}:${session.generation}`}
          scope={session.scope ?? "disconnected"}
          cached={!!session.cached}
          queries={session.session}
          relay={relay}
          navigation={sessionNavigation}
          navigator={navigator}
          viewer={session.viewer}
          panels={panels}
          sessionsEnabled={sessionsEnabled}
          companion={companion}
        />
      )}
    </section>
  );
}

function ChannelWorkspace({
  agentControl,
  providers,
  extensions,
  queries,
  cached,
  relay,
  panels,
  sessionsEnabled,
  scope,
  companion,
  navigation,
  navigator,
  viewer,
}: {
  agentControl?: AgentControl | undefined;
  providers: TemplateProviders;
  extensions?: ConversationExtensions | undefined;
  companion?: ReactNode;
  scope: string;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  viewer?: string | undefined;
  queries: RelaySession;
  cached: boolean;
  relay: RelayData;
  panels: Panels;
  sessionsEnabled: boolean;
}) {
  const composingMessage =
    navigation?.target.kind === "page" &&
    navigation.target.route?.params === "new-message";
  const placeholder =
    navigation?.target.kind === "page"
      ? channelPlaceholder(navigation.target.route?.params)
      : undefined;
  const list = useChannelList(queries.channels);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  const kitState = useSyncExternalStore(
    queries.channelKit.subscribe,
    queries.channelKit.snapshot,
  );
  const templateProviders = useSyncExternalStore(
    providers.subscribe,
    providers.snapshot,
  );
  const templateProvider =
    templateProviders.length === 1 ? templateProviders[0] : undefined;
  useEffect(() => {
    // Initial channel discovery cancels in-flight reads as it settles access.
    // Start the optional catalog afterward so opening Messages cannot strand it.
    if (list.status === "ready") queries.channelKit.ensure();
  }, [queries, list.status]);
  const groupEntry = personalGroups(kitState.entries);
  const personal =
    groupEntry?.record.value.type === "groups"
      ? groupEntry.record.value
      : undefined;
  const [canvasOpen, setCanvasOpen] = useState(false);
  const canvasTrigger = useRef<HTMLButtonElement>(null);
  const [kitError, setKitError] = useState("");
  useEffect(() => {
    void queries.emoji.ensure();
  }, [queries]);
  useEffect(() => {
    if (list.status === "ready") void queries.unread.ensure();
  }, [queries, list.status]);
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [selected, setSelected] = useState<string | undefined>(() =>
    readView(scope, "selected-channel", undefined),
  );
  const handoff = useChannelNavigation();
  const draftParent =
    navigation?.target.kind === "page"
      ? newSessionParent(navigation.target.route?.params)
      : undefined;
  const clearPreparingDm = handoff?.clearPreparingDm;
  useEffect(() => {
    if (!composingMessage) clearPreparingDm?.();
    return () => clearPreparingDm?.();
  }, [composingMessage, clearPreparingDm]);
  const navigate = useCallback(
    (id: string) => {
      setSelected(id);
      writeView(scope, "selected-channel", id);
      if (navigator && viewer) {
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: id,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      }
    },
    [navigator, viewer, scope],
  );
  const [thread, setThread] = useState<{
    channelId: string;
    messageId: string;
  }>();
  const select = useCallback(
    (id: string) => {
      navigate(id);
      setThread(undefined);
    },
    [navigate],
  );
  const threadTrigger = useRef<HTMLElement | null>(null);
  const [sent, setSent] = useState<{ channelId: string; id: string }>();
  const { channels } = useChannelLabels(
    list.channels,
    queries.profiles,
    queries.names,
  );
  const requestedChannel =
    draftParent ??
    (navigation?.target.kind === "conversation"
      ? navigation.target.channelId
      : undefined);
  const [resolved, setResolved] = useState<{
    request: PageNavigation;
    available: boolean;
  }>();
  const joinedRequest = channels.some(
    (channel) => channel.id === requestedChannel,
  );
  useEffect(() => {
    // Let initial membership discovery settle before resolving an omitted target.
    // A premature exact lookup publishes a one-channel list and starts readers
    // that the completing full roster then invalidates.
    if (
      cached ||
      !requestedChannel ||
      !navigation ||
      joinedRequest ||
      list.status === "idle" ||
      list.status === "loading" ||
      !queries.channels.resolve
    )
      return;
    const controller = new AbortController();
    void queries.channels
      .resolve([requestedChannel], {
        signal: AbortSignal.any([controller.signal, navigation.signal]),
        priority: "foreground",
      })
      .then(() => {
        if (!controller.signal.aborted && !navigation.signal.aborted)
          setResolved({ request: navigation, available: true });
      })
      .catch(() => {
        if (!controller.signal.aborted && !navigation.signal.aborted) {
          setResolved({ request: navigation, available: false });
          navigation.complete({ status: "failed", reason: "unavailable" });
        }
      });
    return () => controller.abort();
  }, [
    cached,
    requestedChannel,
    navigation,
    joinedRequest,
    queries,
    list.status,
  ]);
  const resolving =
    !!requestedChannel &&
    !joinedRequest &&
    !!queries.channels.resolve &&
    resolved?.request !== navigation;
  // Lifecycle completion must not reopen retained archived/hidden membership
  // through the mounted workspace's saved selection or first-channel fallback.
  const emptyDestination =
    navigation?.target.kind === "page" &&
    navigation.target.route?.params === "empty";
  const current = emptyDestination
    ? undefined
    : requestedChannel
      ? (channels.find((channel) => channel.id === requestedChannel) ??
        (resolved?.request === navigation && resolved?.available
          ? queries.channels.get?.(requestedChannel)
          : undefined))
      : (channels.find((channel) => channel.id === selected) ??
        channels.find((item) => item.channelType !== "session"));
  // Sidebar routing can update the same mounted page. Keep its saved default
  // aligned with the resolved conversation, not only page-local clicks.
  useEffect(() => {
    if (navigation?.target.kind !== "conversation" || !current) return;
    setSelected(current.id);
    writeView(scope, "selected-channel", current.id);
  }, [navigation?.target, current, scope]);
  const CurrentChannelIcon = channelIcon(current);
  useEffect(() => {
    if (navigation?.signal.aborted) return;
    if (composingMessage || placeholder) {
      navigation?.complete({ status: "opened" });
      return;
    }
    if (
      !cached &&
      requestedChannel &&
      !resolving &&
      list.status === "ready" &&
      !current
    )
      navigation?.complete({ status: "failed", reason: "unavailable" });
    if (!requestedChannel && !current && list.status === "ready")
      navigation?.complete({ status: "opened" });
    if (!requestedChannel && current && navigation && viewer) {
      // Resolve the saved default within this attempt, keeping its caller and deadline.
      navigation.resolve({
        version: 1,
        kind: "conversation",
        channelId: current.id,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    }
  }, [
    cached,
    composingMessage,
    placeholder,
    requestedChannel,
    resolving,
    current,
    list.status,
    navigation,
    viewer,
    scope,
  ]);
  const requestedMessage =
    navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined;
  const requestedThread =
    navigation?.target.kind === "conversation"
      ? navigation.target.threadRootId
      : undefined;
  const currentId = current?.id;
  useEffect(() => {
    if (!currentId || composingMessage || placeholder || draftParent) return;
    // Retire this visit's reveal intent without discarding a new-DM handoff.
    return () => {
      setSent((previous) =>
        previous?.channelId === currentId ? undefined : previous,
      );
    };
  }, [currentId, composingMessage, placeholder, draftParent]);
  const [settings, setSettings] = useState<{
    channelId: string | undefined;
    entryId: string | undefined;
  }>();
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const showingSettings =
    !!settings &&
    settings.channelId === currentId &&
    settings.entryId === navigation?.entryId;
  useEffect(() => {
    if (settings && !showingSettings) setSettings(undefined);
  }, [settings, showingSettings]);
  const closeSettings = () => {
    setSettings(undefined);
    settingsTrigger.current?.focus({ preventScroll: true });
  };
  const canStartSession =
    !!current &&
    sessionsEnabled &&
    !current.readOnly &&
    !current.archived &&
    current.channelType !== "dm" &&
    current.channelType !== "session";
  const drafting =
    canStartSession &&
    !!draftParent &&
    draftParent === currentId &&
    !requestedMessage;
  useEffect(() => {
    if (drafting && navigation?.target.kind === "page")
      navigation.complete({ status: "opened" });
    if (
      !cached &&
      draftParent &&
      (!sessionsEnabled || (current && !canStartSession))
    )
      navigation?.complete({ status: "failed", reason: "unavailable" });
  }, [
    cached,
    drafting,
    navigation,
    draftParent,
    sessionsEnabled,
    current,
    canStartSession,
  ]);
  const flatSession = current?.channelType === "session";
  const onComposerSend = useComposerSent(
    currentId,
    flatSession && !!requestedMessage,
    setSent,
    select,
  );
  const [exactOpening, setExactOpening] = useState<{
    request: PageNavigation;
    inTimeline: boolean;
  }>();
  useEffect(() => {
    if (
      cached ||
      current?.cached ||
      !navigation ||
      !requestedMessage ||
      (!flatSession && requestedThread === requestedMessage) ||
      !currentId ||
      navigation.signal.aborted
    )
      return;
    let selected = false;
    const choose = () => {
      if (selected || navigation.signal.aborted) return;
      const window = queries.channels.window(currentId);
      if (window.status === "idle" || window.status === "loading") return;
      selected = true;
      // Freeze the presentation for this attempt. An isolated lookup or later
      // live event must not move an already-opened thread into the timeline.
      setExactOpening({
        request: navigation,
        inTimeline:
          (flatSession || requestedThread !== requestedMessage) &&
          window.status === "ready" &&
          window.freshness !== "cached" &&
          window.rows.some(
            (row) =>
              row.id === requestedMessage && (flatSession || !row.threadRootId),
          ),
      });
    };
    const stop = queries.channels.subscribeWindow(currentId, choose);
    choose();
    return stop;
  }, [
    cached,
    current?.cached,
    navigation,
    requestedMessage,
    requestedThread,
    currentId,
    queries,
    flatSession,
  ]);
  // A live connection can still be confirming its restored membership. Keep
  // the pending intent; an exact reader cannot use display-only authority.
  const exact =
    cached || current?.cached
      ? undefined
      : !flatSession &&
          navigation &&
          requestedMessage &&
          requestedThread === requestedMessage
        ? { request: navigation, inTimeline: false }
        : exactOpening?.request === navigation
          ? exactOpening
          : undefined;
  type ShowingThread = {
    channelId: string;
    messageId: string;
    navigation?: PageNavigation | undefined;
  };
  const priorRoutedThread = useRef<ShowingThread | undefined>(undefined);
  let showingThread: ShowingThread | undefined =
    !cached && requestedMessage
      ? exact && !exact.inTimeline && current
        ? { channelId: current.id, messageId: requestedMessage, navigation }
        : undefined
      : thread && thread.channelId === current?.id
        ? { ...thread, navigation: undefined }
        : undefined;
  if (flatSession) {
    showingThread = undefined;
    priorRoutedThread.current = undefined;
  }
  if (showingThread?.navigation) priorRoutedThread.current = showingThread;
  else if (
    current &&
    !showingThread &&
    (!navigation || (requestedMessage && !exact))
  )
    showingThread = priorRoutedThread.current;
  else priorRoutedThread.current = undefined;
  useEffect(() => {
    if (thread && !showingThread) setThread(undefined);
  }, [thread, showingThread]);
  type Opening = { channelId: string; panel: RegisteredPanel; target: string };
  const [opened, setOpened] = useState<Opening>();
  const opening = useRef<Opening | undefined>(undefined);
  const open = useCallback((next: Opening | undefined) => {
    // Retire callbacks synchronously, before React commits the next opening.
    opening.current = next;
    setOpened(next);
  }, []);
  useLayoutEffect(() => {
    if (draftParent || composingMessage || placeholder || requestedMessage) {
      setThread(undefined);
      open(undefined);
    }
    const activity = handoff?.activityThread.current;
    if (
      activity &&
      activity.channelId === requestedChannel &&
      activity.rootId === requestedThread
    ) {
      threadTrigger.current = activity.trigger;
      handoff.activityThread.current = undefined;
    }
  }, [
    draftParent,
    composingMessage,
    placeholder,
    requestedMessage,
    requestedChannel,
    requestedThread,
    open,
    handoff?.activityThread,
  ]);
  const panel =
    opened &&
    opened.channelId === current?.id &&
    available.includes(opened.panel)
      ? opened.panel
      : undefined;
  const mounted = useRef(false);
  const channel = useRef(current?.id);
  useLayoutEffect(() => {
    channel.current = current?.id;
  }, [current?.id]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (opened && !panel) open(undefined);
  }, [opened, panel, open]);
  const [replyRequest, setReplyRequest] = useState<{
    channelId: string;
    messageId: string;
    entryId: string | undefined;
    sequence: number;
  }>();
  const activeEntryId = navigator?.snapshot().entry.id;
  useEffect(() => {
    if (
      replyRequest &&
      (replyRequest.channelId !== currentId ||
        replyRequest.entryId !== activeEntryId)
    )
      setReplyRequest(undefined);
  }, [currentId, activeEntryId, replyRequest]);
  const openThread = useCallback(
    (messageId: string, threadRootId: string, intent?: "reply") => {
      if (!currentId) return;
      const requestReply = () =>
        setReplyRequest((previous) =>
          intent === "reply"
            ? {
                channelId: currentId,
                messageId,
                entryId: navigator?.snapshot().entry.id,
                sequence: (previous?.sequence ?? 0) + 1,
              }
            : undefined,
        );
      setSettings(undefined);
      const target = navigator?.snapshot().entry.target;
      if (
        target?.kind === "conversation" &&
        target.channelId === currentId &&
        target.messageId === messageId &&
        target.threadRootId === threadRootId
      ) {
        requestReply();
        return;
      }
      threadTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (navigator && viewer) {
        setThread(undefined);
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: currentId,
          messageId,
          threadRootId,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      } else setThread({ channelId: currentId, messageId });
      requestReply();
      open(undefined);
    },
    [currentId, navigator, viewer, scope, open],
  );
  const mediaReviewTrigger = useRef<HTMLElement | null>(null);
  const [mediaReview, setMediaReview] = useState<{
    channelId: string;
    channelName: string;
    messageId: string;
    attachment: Attachment;
    initialTime: number;
    hasComments: boolean;
    entryId?: string | undefined;
  }>();
  // The current destination may be an authorized public preview, which is
  // intentionally absent from the joined-channel list.
  const showingMediaReview = current?.archived
    ? undefined
    : mediaReviewForDestination(mediaReview, current?.id, navigation?.entryId);
  useEffect(() => {
    if (mediaReview && !showingMediaReview) setMediaReview(undefined);
  }, [mediaReview, showingMediaReview]);
  // Timeline rows are memoized; their callbacks read the shown destination at
  // call time so a new navigation request does not rerender every row.
  const destination = useRef({ current, navigation });
  useLayoutEffect(() => {
    destination.current = { current, navigation };
  }, [current, navigation]);
  const openMediaReview = useCallback(
    (
      messageId: string,
      attachment: Attachment,
      initialTime: number,
      hasComments = false,
    ) => {
      const { current, navigation } = destination.current;
      if (!current) return;
      setSettings(undefined);
      mediaReviewTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setThread(undefined);
      setMediaReview({
        channelId: current.id,
        channelName: current.name,
        messageId,
        attachment,
        initialTime,
        hasComments,
        ...(navigation ? { entryId: navigation.entryId } : {}),
      });
    },
    [],
  );
  const closeThread = () => {
    setReplyRequest(undefined);
    if (showingThread?.navigation && current) select(current.id);
    setThread(undefined);
    if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  };
  const panelTrigger = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    open(undefined);
    if (panelTrigger.current?.isConnected)
      panelTrigger.current.focus({ preventScroll: true });
    else if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  }, [open]);
  // Availability follows active contributions; dispatch still re-resolves at click time.
  const canOpenLink = useCallback(
    (target: string) =>
      available.some((candidate) => {
        try {
          return candidate.matches(target);
        } catch {
          return false;
        }
      }),
    [available],
  );
  const linkContext = useRef({
    channelId: currentId,
    routedThread: !!showingThread?.navigation,
  });
  useLayoutEffect(() => {
    linkContext.current = {
      channelId: currentId,
      routedThread: !!showingThread?.navigation,
    };
  }, [currentId, showingThread?.navigation]);
  const openLink = useCallback(
    (url: string) => {
      const { current, navigation } = destination.current;
      const connection = relay.snapshot();
      if (
        !mounted.current ||
        channel.current !== current?.id ||
        connection.status !== "ready" ||
        connection.session !== queries ||
        navigation?.signal.aborted
      )
        return false;
      if (isBuzzLink(url) && navigator && viewer) {
        const target = buzzLinkTarget(url, {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        });
        // Internal panel targets also use buzz:. Only routable links belong
        // to the navigator; registered panels handle the remaining targets.
        if (target) {
          if (target.kind === "conversation" && target.messageId)
            threadTrigger.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          setThread(undefined);
          open(undefined);
          void navigator.open(target);
          return true;
        }
      }
      const candidate = panels.resolve(url);
      const context = linkContext.current;
      if (context.channelId && candidate) {
        setSettings(undefined);
        panelTrigger.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (context.routedThread) select(context.channelId);
        setThread(undefined);
        open({
          channelId: context.channelId,
          panel: candidate,
          target: url,
        });
        return true;
      }
      return false;
    },
    [panels, open, relay, queries, select, navigator, viewer, scope],
  );
  const panelActive = () => {
    const connection = relay.snapshot();
    return !!(
      mounted.current &&
      opened &&
      panel &&
      opening.current === opened &&
      channel.current === opened.channelId &&
      panels.snapshot().includes(panel) &&
      connection.status === "ready" &&
      connection.session === queries &&
      !navigation?.signal.aborted
    );
  };
  const panelContext =
    opened && panel
      ? {
          channelId: opened.channelId,
          canOpen: (target: string) => !!panels.resolve(target),
          open: (target: string) => {
            if (!panelActive()) return false;
            const next = panels.resolve(target);
            if (!next) return false;
            // Keep the original conversation trigger for close/focus restoration.
            open({ channelId: opened.channelId, panel: next, target });
            return true;
          },
        }
      : undefined;
  const drawerContext = useMemo(
    () =>
      current && !current.readOnly && viewer && !placeholder
        ? {
            scope,
            viewer,
            channelId: current.id,
            channelName: current.name,
            relayUrl: scope
              .slice(0, -(viewer.length + 1))
              .replace(/^https:/, "wss:")
              .replace(/^http:/, "ws:"),
            ...(showingThread && { threadId: showingThread.messageId }),
          }
        : undefined,
    [scope, viewer, current, showingThread, placeholder],
  );
  const drawer = useChannelPanels(panels, drawerContext, () =>
    setSettings(undefined),
  );
  const showingChannelPanel =
    !composingMessage &&
    (showingSettings || panel || showingThread || drawer.side);
  const showingPanel = companion || showingChannelPanel;
  const workspace = (
    <div className={`${styles.board} ${showingPanel ? styles.withPanel : ""}`}>
      {current && !current.readOnly && canvasOpen && (
        <ChannelCanvasDialog
          key={`${scope}:${current.id}`}
          canvas={queries.canvas}
          scope={scope}
          channelId={current.id}
          open={canvasOpen}
          onOpenChange={setCanvasOpen}
          finalFocus={canvasTrigger}
        />
      )}
      <Panel as="article" aria-label="Conversation">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: file-drop fallback; the composer also provides a keyboard-accessible picker. */}
        <div
          className={styles.conversation}
          data-attachment-drop-zone=""
          onDragOver={rejectUnhandledFileDrop}
          onDrop={rejectUnhandledFileDrop}
        >
          {composingMessage ? (
            <NewMessage
              session={queries}
              scope={scope}
              extensions={extensions}
              onPreparing={(pubkeys) => handoff?.prepareDm(pubkeys)}
              onOpened={(channelId) => {
                handoff?.clearPreparingDm();
                select(channelId);
              }}
              onStarted={(channelId, id) => {
                handoff?.clearPreparingDm();
                setSent({ channelId, id });
                select(channelId);
              }}
            />
          ) : placeholder ? (
            <>
              <PanelHeader title={placeholder} />
              <div className={styles.placeholder}>
                <p>Content coming soon</p>
              </div>
            </>
          ) : drafting && current ? (
            <NewSessionView parentName={current.name}>
              <NewSessionComposer
                extensions={extensions}
                key={current.id}
                session={queries}
                scope={scope}
                parent={current}
                onStarted={(id) => {
                  handoff?.updateDraftParents((previous) =>
                    previous.filter((parent) => parent !== current.id),
                  );
                  select(id);
                }}
              />
            </NewSessionView>
          ) : draftParent ? (
            <p role="status" className={styles.empty}>
              Checking session parent access…
            </p>
          ) : (
            <>
              {current?.channelType === "session" ? (
                <SessionHeading
                  channel={current}
                  parentName={
                    channels.find(
                      (parent) => parent.id === current.parentChannelId,
                    )?.name
                  }
                />
              ) : (
                <PanelHeader
                  title={current?.name ?? "Channels"}
                  icon={
                    current?.channelType === "dm" ? (
                      <ChatCircleIcon size={20} />
                    ) : (
                      <CurrentChannelIcon size={20} />
                    )
                  }
                  actions={
                    <>
                      {current && (
                        <ChannelMembersButton
                          key={current.id}
                          session={queries}
                          channelId={current.id}
                          control={agentControl}
                        />
                      )}
                      {drawer.launchers}
                      <IconButton
                        ref={settingsTrigger}
                        size="toolbar"
                        aria-label="Channel settings"
                        title="Channel settings"
                        aria-expanded={showingSettings}
                        onClick={() => {
                          if (showingSettings) closeSettings();
                          else {
                            drawer.close();
                            setSettings({
                              channelId: currentId,
                              entryId: navigation?.entryId,
                            });
                          }
                        }}
                        icon={<DotsThreeIcon size={19} aria-hidden="true" />}
                      />
                    </>
                  }
                />
              )}
              <SessionColumn enabled={flatSession}>
                <MessageManagementStatus />
                {!cached && (
                  <LiveStatus
                    live={queries.live}
                    channelId={current?.id}
                    partialRoster={list.coverage === "partial"}
                  />
                )}
                {flatSession &&
                current &&
                navigation &&
                requestedMessage &&
                exact &&
                !exact.inTimeline ? (
                  <SessionMessageTarget
                    key={`${current.id}:${requestedMessage}`}
                    session={queries}
                    scope={scope}
                    channelId={current.id}
                    messageId={requestedMessage}
                    navigation={navigation}
                    extensions={extensions}
                    onOpenLink={openLink}
                    canOpenLink={canOpenLink}
                    onLatest={() => select(current.id)}
                    onRetry={() => {
                      void navigator?.retry();
                    }}
                  />
                ) : current ? (
                  <ChannelBody
                    viewer={viewer}
                    extensions={extensions}
                    key={current.id}
                    queries={queries}
                    scope={scope}
                    channelId={current.id}
                    cached={cached}
                    navigation={
                      flatSession || !requestedMessage || exact?.inTimeline
                        ? navigation
                        : undefined
                    }
                    onOpenLink={openLink}
                    canOpenLink={canOpenLink}
                    onOpenThread={flatSession ? undefined : openThread}
                    onOpenMediaReview={openMediaReview}
                    revealMessageId={
                      sent?.channelId === current.id ? sent.id : undefined
                    }
                  />
                ) : (
                  <div className={styles.empty}>
                    {resolving
                      ? "Checking conversation access…"
                      : "Select a channel to read it."}
                  </div>
                )}
                {current?.readOnly && !current.cached && (
                  <p className="px-4 py-2 text-body-sm text-subtle">
                    Read-only preview · You haven’t joined this conversation.
                  </p>
                )}
                {current && (
                  <MessageComposer
                    sessionConversation={current.channelType === "session"}
                    extensions={extensions}
                    key={`composer:${current.id}`}
                    session={queries}
                    scope={scope}
                    channelId={current.id}
                    channelName={current.name}
                    autoFocus={
                      !current.readOnly && !requestedMessage && !requestedThread
                    }
                    onOpenLink={openLink}
                    canOpenLink={canOpenLink}
                    label={
                      current.channelType === "session"
                        ? "Message this session"
                        : undefined
                    }
                    onSend={onComposerSend}
                  />
                )}
              </SessionColumn>
              {drawer.content}
            </>
          )}
        </div>
      </Panel>
      {showingMediaReview && (
        <MediaReviewViewer
          extensions={extensions}
          attachment={showingMediaReview.attachment}
          session={queries}
          scope={scope}
          channelId={showingMediaReview.channelId}
          channelName={showingMediaReview.channelName}
          messageId={showingMediaReview.messageId}
          initialTime={showingMediaReview.initialTime}
          hasComments={showingMediaReview.hasComments}
          restoreFocus={mediaReviewTrigger}
          onOpenLink={openLink}
          close={() => setMediaReview(undefined)}
        />
      )}
      {showingPanel && !showingMediaReview && (
        <div className={styles.panelStack}>
          {showingChannelPanel && showingSettings && (
            <ChannelSettingsPanel
              canvas={queries.canvas}
              canvasOpen={canvasOpen}
              openCanvas={(trigger) => {
                canvasTrigger.current = trigger;
                setCanvasOpen(true);
              }}
              setupTools={
                current && (
                  <div style={{ display: "grid", gap: "var(--space-3)" }}>
                    {templateProvider && (
                      <OwnedContribution
                        key={current.id}
                        entry={templateProvider}
                        registry={providers}
                      >
                        {(entry, active) => {
                          const SaveAs = entry.saveAs;
                          return (
                            <SaveAs
                              session={queries}
                              channel={current}
                              active={active}
                            />
                          );
                        }}
                      </OwnedContribution>
                    )}
                    {personal && (
                      <Select
                        label="Personal group"
                        variant="field"
                        value={personal.assignments[current.id] ?? ""}
                        groups={[
                          {
                            label: "",
                            options: [
                              { value: "", label: "No group" },
                              ...personal.groups.map((g) => ({
                                value: g.id,
                                label: g.name,
                              })),
                            ],
                          },
                        ]}
                        onValueChange={async (groupId) => {
                          const assignments = { ...personal.assignments };
                          if (groupId) assignments[current.id] = groupId;
                          else delete assignments[current.id];
                          setKitError("");
                          try {
                            await queries.channelKit.save(
                              { ...personal, assignments },
                              groupEntry?.eventId,
                            );
                          } catch (error) {
                            setKitError(String(error));
                          }
                        }}
                      />
                    )}
                    {kitError && <p role="alert">{kitError}</p>}
                    {handoff &&
                      !current.readOnly &&
                      current.channelType !== "dm" &&
                      current.channelType !== "session" && (
                        <ChannelLifecycleActions
                          key={current.id}
                          channelId={current.id}
                          lifecycle={queries.channelLifecycle}
                          choose={(action, trigger) =>
                            handoff.openLifecycle(current, action, trigger)
                          }
                        />
                      )}
                  </div>
                )
              }
              key={currentId ?? "channels"}
              channel={current}
              details={queries.channelDetails}
              close={closeSettings}
            >
              <UnreadOptions session={queries} channelId={current?.id} />
              <LiveStatus
                live={queries.live}
                channelId={current?.id}
                partialRoster={list.coverage === "partial"}
                diagnostics
              />
              <p>
                {list.coverage === "partial" ? "Partial roster" : "Roster"} ·{" "}
                {channels.length} channels
              </p>
              <Button
                type="button"
                onClick={() => queries.channels.refreshList?.()}
              >
                Refresh channels
              </Button>
              {preferences.error && (
                <p>Saved groups and stars: {preferences.error}</p>
              )}
              {preferences.status !== "unsupported" && (
                <Button
                  type="button"
                  disabled={preferences.status === "loading"}
                  onClick={preferences.reload}
                >
                  Refresh groups and stars
                </Button>
              )}
              {current && (
                <Button
                  type="button"
                  onClick={() => queries.channels.refresh?.(current.id)}
                >
                  Refresh messages
                </Button>
              )}
              {queries.outbox ? (
                <OutboxStatus
                  outbox={queries.outbox}
                  profiling={queries.profiling}
                />
              ) : (
                <RelayTimings profiling={queries.profiling} />
              )}
            </ChannelSettingsPanel>
          )}
          {showingChannelPanel && showingThread && (
            <div className={styles.retainedPanel} inert={showingSettings}>
              <ThreadPanel
                sessionConversation={current?.channelType === "session"}
                extensions={extensions}
                session={queries}
                scope={scope}
                channelName={current?.name ?? ""}
                channelId={showingThread.channelId}
                messageId={showingThread.messageId}
                navigation={showingThread.navigation}
                replyRequest={
                  replyRequest?.channelId === showingThread.channelId &&
                  replyRequest.messageId === showingThread.messageId &&
                  replyRequest.entryId === showingThread.navigation?.entryId
                    ? replyRequest.sequence
                    : undefined
                }
                close={closeThread}
                onOpenLink={openLink}
                onOpenMediaReview={openMediaReview}
                canOpenLink={canOpenLink}
              />
            </div>
          )}

          {showingChannelPanel && panel && opened && (
            <div className={styles.retainedPanel} inert={showingSettings}>
              <PanelCard
                key="target"
                panel={panel}
                target={opened.target}
                context={panelContext}
                close={close}
                closeLabel="Close channel panel"
              />
            </div>
          )}
          {showingChannelPanel && drawer.side && (
            <div className={styles.retainedPanel} hidden={showingSettings}>
              {drawer.side}
            </div>
          )}
          {companion && (
            <div key="companion" className={styles.companion}>
              {companion}
            </div>
          )}
        </div>
      )}
    </div>
  );
  return (
    <MessageManagement session={queries} channelId={currentId}>
      {workspace}
    </MessageManagement>
  );
}

export function mediaReviewForDestination<
  T extends { channelId: string; entryId?: string | undefined },
>(
  review: T | undefined,
  channelId: string | undefined,
  entryId: string | undefined,
): T | undefined {
  return review &&
    review.channelId === channelId &&
    (review.entryId === undefined || review.entryId === entryId)
    ? review
    : undefined;
}

const ChannelBody = memo(function ChannelBody({
  cached,
  viewer,
  extensions,
  scope,
  queries,
  channelId,
  onOpenLink,
  canOpenLink,
  revealMessageId,
  onOpenThread,
  onOpenMediaReview,
  navigation,
}: {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  queries: RelaySession;
  cached: boolean;
  viewer?: string | undefined;
  channelId: string;
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
    | undefined;
  onOpenMediaReview(
    messageId: string,
    attachment: Attachment,
    seconds: number,
    hasComments?: boolean,
  ): void;
}) {
  // ChannelWorkspace already keys this lifetime by viewer/scope/generation.
  const continuityKey = useId();
  const window = useChannelWindow(queries.channels, channelId);
  useLayoutEffect(() => {
    clientMetrics.channelMounted(channelId);
    return () => clientMetrics.channelUnmounted(channelId);
  }, [channelId]);
  const newest = window.rows.at(-1)?.id;
  const settled = window.status === "ready" || window.status === "error";
  useLayoutEffect(() => {
    // Repeat calls for the same open are ignored; only the first rows count.
    // Any row counts as content, since a saved scroll position may keep the
    // newest one unmounted.
    if (newest)
      clientMetrics.channelRendered(
        channelId,
        () =>
          !!document.querySelector(
            `[data-channel-timeline="${CSS.escape(channelId)}"] [data-message-id]`,
          ),
      );
    else if (settled) clientMetrics.channelEmpty(channelId);
  }, [channelId, newest, settled]);
  useEffect(() => {
    // Only the normalized conversation attempt can acknowledge its channel.
    // A warm child effect runs before the parent's default resolution effect.
    if (
      navigation?.target.kind !== "conversation" ||
      navigation.target.messageId
    )
      return;
    if (window.status === "ready") navigation?.complete({ status: "opened" });
    else if (!cached && window.status === "error")
      navigation?.complete({ status: "failed", reason: "unavailable" });
  }, [cached, navigation, window.status]);
  if (window.status === "error" && !window.rows.length)
    return (
      <div className={styles.empty} role="alert">
        <p>{window.error}</p>
        <Button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </Button>
      </div>
    );
  if (window.status !== "ready" && !window.rows.length)
    return (
      <div className={styles.empty} role="status">
        Loading messages…
      </div>
    );
  return (
    <ChannelTimeline
      continuityKey={continuityKey}
      viewer={viewer}
      extensions={extensions}
      scope={scope}
      channelId={channelId}
      queries={queries}
      window={window}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      {...(onOpenThread ? { onOpenThread } : {})}
      onOpenMediaReview={onOpenMediaReview}
      revealMessageId={revealMessageId}
      navigation={navigation}
    />
  );
});
