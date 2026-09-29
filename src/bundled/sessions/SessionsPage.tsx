import { Button } from "../../shared/design-system/ui/Button";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { useCallback, useState } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../../features/messages/MessageManagement";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { rejectUnhandledFileDrop } from "../../features/messages/use-file-drop";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { readView, writeView } from "../../shared/view-state";
import { SessionsWorkspace } from "./SessionsWorkspace";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import {
  NewSessionView,
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import styles from "../../features/sessions/Sessions.module.css";
import { UnreadBadge } from "../channels/UnreadBadge";

export function SessionsPage({
  relay,
  extensions,
  navigator,
}: {
  relay: RelayData;
  extensions: ConversationExtensions;
  navigator?: Navigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  return connection.status === "ready" ? (
    <LiveSessions
      key={`${connection.scope}:${connection.generation}`}
      session={connection.session}
      scope={connection.scope ?? ""}
      extensions={extensions}
      navigator={navigator}
    />
  ) : (
    <section className={styles.empty} aria-label="Sessions">
      <ChatCircleIcon size={28} />
      <h1>Sessions</h1>
      <p>
        {connection.status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to work with your agents."}
      </p>
      {connection.status === "error" && (
        <>
          <p role="alert">{connection.error ?? "The connection failed."}</p>
          <Button type="button" onClick={relay.retry}>
            Retry connection
          </Button>
        </>
      )}
    </section>
  );
}

function LiveSessions({
  session,
  scope,
  extensions,
  navigator,
}: {
  session: RelaySession;
  scope: string;
  extensions: ConversationExtensions;
  navigator?: Navigation | undefined;
}) {
  const list = useChannelList(session.channels);
  const [selected, setSelected] = useState(() => {
    const saved = readView<unknown>(scope, "sessions:selected", "");
    return typeof saved === "string" ? saved : "";
  });
  const selectedSession = list.channels.find(
    (item) => item.id === selected && item.channelType === "session",
  );
  const sessions = list.channels
    .filter((item) => item.channelType === "session" && !item.archived)
    .sort(
      (a, b) =>
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
    );
  const select = (id: string) => {
    setSelected(id);
    writeView(scope, "sessions:selected", id);
  };
  return (
    <SessionsWorkspace
      sessions={sessions.map((item) => {
        const parent = list.channels.find(
          (candidate) => candidate.id === item.parentChannelId,
        );
        return {
          id: item.id,
          title: item.name,
          content: (
            <UnreadBadge
              session={session}
              channelId={item.id}
              label={item.name}
            />
          ),
          ...(item.parentChannelId
            ? {
                parentName: parent?.name ?? "Channel session",
                ...(parent?.private ? { parentPrivate: true as const } : {}),
              }
            : {}),
        };
      })}
      selected={selected}
      onSelect={select}
      onNew={() => {
        select("");
      }}
      listStatus={
        list.status === "loading" && !sessions.length ? (
          <p role="status">Loading sessions…</p>
        ) : list.status === "error" ? (
          <div role="alert">
            <p>{list.error ?? "Sessions couldn’t load."}</p>
            <Button
              type="button"
              onClick={() => session.channels.refreshList?.()}
            >
              Retry
            </Button>
          </div>
        ) : undefined
      }
    >
      {selectedSession ? (
        <SessionWork
          key={selectedSession.id}
          session={session}
          scope={scope}
          channel={selectedSession}
          extensions={extensions}
          navigator={navigator}
          parentName={
            list.channels.find(
              (item) => item.id === selectedSession.parentChannelId,
            )?.name
          }
        />
      ) : (
        <NewSessionView>
          <NewSessionComposer
            extensions={extensions}
            session={session}
            scope={scope}
            onStarted={select}
          />
        </NewSessionView>
      )}
    </SessionsWorkspace>
  );
}

function SessionWork({
  session,
  scope,
  channel,
  extensions,
  parentName,
  navigator,
}: {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  extensions: ConversationExtensions;
  parentName?: string | undefined;
  navigator?: Navigation | undefined;
}) {
  const window = useChannelWindow(session.channels, channel.id);
  const [sent, setSent] = useState<string>();
  const targetForLink = useCallback(
    (url: string) => sessionLinkTarget(url, scope, session.viewer),
    [scope, session.viewer],
  );
  const canOpenLink = useCallback(
    (url: string) => !!navigator && !!targetForLink(url),
    [navigator, targetForLink],
  );
  const openLink = useCallback(
    (url: string) => {
      const target = targetForLink(url);
      if (!navigator || !target) return false;
      void navigator.open(target);
      return true;
    },
    [navigator, targetForLink],
  );
  const workspace = (
    // biome-ignore lint/a11y/noStaticElementInteractions: pane file-drop fallback; the composer provides a keyboard-accessible picker.
    <div
      className={styles.work}
      data-attachment-drop-zone=""
      onDragOver={rejectUnhandledFileDrop}
      onDrop={rejectUnhandledFileDrop}
    >
      <SessionHeading channel={channel} parentName={parentName} />
      <SessionColumn>
        <MessageManagementStatus />
        <div className={styles.timeline}>
          {window.status === "error" && !window.rows.length ? (
            <div className={styles.empty} role="alert">
              <p>{window.error}</p>
              <Button
                type="button"
                onClick={() => session.channels.ensure(channel.id)}
              >
                Retry messages
              </Button>
            </div>
          ) : window.status !== "ready" && !window.rows.length ? (
            <p className={styles.empty} role="status">
              Loading messages…
            </p>
          ) : (
            <ChannelTimeline
              extensions={extensions}
              queries={session}
              viewer={session.viewer}
              scope={scope}
              channelId={channel.id}
              window={window}
              revealMessageId={sent}
              onOpenLink={openLink}
            />
          )}
        </div>
        <MessageComposer
          sessionConversation
          onSend={setSent}
          extensions={extensions}
          session={session}
          scope={scope}
          channelId={channel.id}
          channelName={channel.name}
          label="Message this session"
          disabled={!!channel.archived || window.status !== "ready"}
          onOpenLink={openLink}
          canOpenLink={canOpenLink}
        />
      </SessionColumn>
    </div>
  );
  return (
    <MessageManagement session={session} channelId={channel.id}>
      {workspace}
    </MessageManagement>
  );
}

export function sessionLinkTarget(
  url: string,
  scope: string,
  viewer: string | undefined,
): ReturnType<typeof buzzLinkTarget> {
  if (!viewer || !isBuzzLink(url)) return null;
  return buzzLinkTarget(url, {
    viewer,
    communityOrigin: scope.slice(0, -(viewer.length + 1)),
  });
}
