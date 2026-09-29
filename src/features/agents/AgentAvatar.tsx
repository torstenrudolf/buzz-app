import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { ThinkingBadge } from "../../shared/design-system/ui/agent-thinking/ThinkingBadge";
import type { RelaySession } from "../relay/session";
import "./agent-avatar.css";

type AgentAvatarProps = ComponentProps<typeof Avatar> & {
  session?: RelaySession | undefined;
  agentPubkey?: string | undefined;
  channelId?: string | undefined;
  working?: boolean | undefined;
  thinkingDescriptionId?: string | undefined;
};
export function AgentAvatar(props: AgentAvatarProps) {
  if (props.shape === "squircle") return <ActiveAgentAvatar {...props} />;
  return <Avatar {...props} />;
}
const noSubscribe = () => () => {};
function ActiveAgentAvatar({
  session,
  agentPubkey,
  channelId,
  working,
  thinkingDescriptionId,
  ...props
}: AgentAvatarProps) {
  const activity = session?.agentActivity;
  const getThinking = () => {
    const snapshot = activity?.snapshot();
    return (
      working ??
      !!(
        agentPubkey &&
        (snapshot?.turns.some(
          (turn) =>
            turn.agent === agentPubkey &&
            turn.state === "working" &&
            (!channelId || turn.channelId === channelId),
        ) ||
          snapshot?.typing.some(
            (entry) =>
              entry.agent === agentPubkey &&
              (!channelId || entry.channelId === channelId),
          ))
      )
    );
  };
  const thinking = useSyncExternalStore(
    activity?.subscribe ?? noSubscribe,
    getThinking,
    getThinking,
  );
  const visible = thinking || props.statusBadge === "online";
  const root = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(40);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const resize = () => setSize(node.getBoundingClientRect().width);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <span
        ref={root}
        className="agent-motion-avatar"
        data-size={props.size ?? "default"}
        role="img"
        aria-label={
          props.alt
            ? `${props.alt}${thinking ? ", thinking" : props.statusBadge === "online" ? ", available" : props.statusBadge ? `, ${props.statusBadge}` : ""}`
            : undefined
        }
        aria-hidden={!props.alt || undefined}
      >
        <ThinkingBadge avatarSize={size} thinking={thinking} enabled={visible}>
          <Avatar
            {...props}
            alt=""
            size="fill"
            statusBadge={visible ? undefined : props.statusBadge}
          />
        </ThinkingBadge>
      </span>
      {thinkingDescriptionId && (
        <span className="sr-only" id={thinkingDescriptionId}>
          {thinking ? "Agent is thinking" : ""}
        </span>
      )}
    </>
  );
}
