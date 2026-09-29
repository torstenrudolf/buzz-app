import type { ChannelMessage } from "../relay/contracts";

export function continuesMessageGroup(
  previous: ChannelMessage | undefined,
  current: ChannelMessage,
): boolean {
  return (
    !!previous &&
    !previous.membership &&
    !current.membership &&
    previous.channelId === current.channelId &&
    previous.authorId === current.authorId &&
    current.createdAt >= previous.createdAt &&
    current.createdAt - previous.createdAt <= 5 * 60 &&
    new Date(previous.createdAt * 1000).toDateString() ===
      new Date(current.createdAt * 1000).toDateString()
  );
}
