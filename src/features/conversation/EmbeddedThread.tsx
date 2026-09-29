import type { Context } from "@deepseek-ai/cordis";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { PanelView } from "../panels/PanelView";
import type { RegisteredPanel } from "../panels/service";
import type { Attachment } from "../relay/contracts";
import { MediaReviewViewer } from "../messages/MediaReviewViewer";
import { ThreadPanel, type ThreadPanelProps } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";

/** The host owns conversation behavior; the page owns its task and placement. */
export type EmbeddedThreadProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "messageId"
>;
type Props = EmbeddedThreadProps & {
  host: Context;
  extensions: NonNullable<ThreadPanelProps["extensions"]>;
};

export function EmbeddedThread(props: Props) {
  return (
    <OwnedEmbeddedThread
      key={messageViewKey(
        props.session,
        props.scope,
        props.channelId,
        props.messageId,
      )}
      {...props}
    />
  );
}

function OwnedEmbeddedThread({ host, extensions, ...props }: Props) {
  const { session, scope, channelId, channelName } = props;
  const available = useSyncExternalStore(
    host.panels.subscribe,
    host.panels.snapshot,
    host.panels.snapshot,
  );
  const [panel, setPanel] = useState<{
    contribution: RegisteredPanel;
    target: string;
  }>();
  const [media, setMedia] = useState<{
    messageId: string;
    attachment: Attachment;
    initialTime: number;
    hasComments: boolean;
  }>();
  const mediaTrigger = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  const opening = useRef(panel);
  useLayoutEffect(() => {
    opening.current = panel;
  }, [panel]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (panel && !available.includes(panel.contribution)) setPanel(undefined);
  }, [panel, available]);
  const active = () => {
    const connection = host.relay.snapshot();
    return (
      mounted.current &&
      connection.status === "ready" &&
      connection.session === session &&
      connection.scope === scope
    );
  };
  const canOpen = (target: string) => !!host.panels.resolve(target);
  const open = (url: string) => {
    if (!active()) return false;
    const target = buzzLinkTarget(url, {
      viewer: scope.slice(-64),
      communityOrigin: scope.slice(0, -65),
    });
    if (target) {
      setPanel(undefined);
      setMedia(undefined);
      void host.navigation.open(target);
      return true;
    }
    const contribution = host.panels.resolve(url);
    if (!contribution) return false;
    setPanel({ contribution, target: url });
    return true;
  };
  return (
    <>
      <ThreadPanel
        {...props}
        presentation="embedded"
        extensions={extensions}
        onOpenLink={open}
        canOpenLink={canOpen}
        onOpenMediaReview={(
          messageId,
          attachment,
          initialTime,
          hasComments = false,
        ) => {
          if (!active()) return;
          mediaTrigger.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          setMedia({ messageId, attachment, initialTime, hasComments });
        }}
      />
      {panel && available.includes(panel.contribution) && (
        <Dialog
          open
          title={panel.contribution.title}
          placement="right"
          height="stable"
          onOpenChange={(next) => {
            if (!next) setPanel(undefined);
          }}
        >
          <PanelView
            panel={panel.contribution}
            target={panel.target}
            close={() => {
              if (opening.current === panel) setPanel(undefined);
            }}
            channelContext={{
              scope,
              channelId,
              channelName,
              viewer: scope.slice(-64),
              relayUrl: scope.slice(0, -65),
              threadId: props.messageId,
            }}
            context={{
              channelId,
              canOpen,
              open: (target) =>
                opening.current === panel &&
                host.panels.snapshot().includes(panel.contribution) &&
                open(target),
            }}
          />
        </Dialog>
      )}
      {media && (
        <MediaReviewViewer
          {...media}
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelName}
          extensions={extensions}
          restoreFocus={mediaTrigger}
          onOpenLink={open}
          close={() => setMedia(undefined)}
        />
      )}
    </>
  );
}
