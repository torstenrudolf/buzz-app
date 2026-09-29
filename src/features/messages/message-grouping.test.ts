import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { continuesMessageGroup } from "./message-grouping";

const first: ChannelMessage = {
  id: "first",
  channelId: "channel",
  authorId: "author",
  content: "Hello",
  createdAt: new Date(2026, 8, 28, 12).getTime() / 1000,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};

it("groups adjacent same-author messages through the five-minute boundary", () => {
  for (const seconds of [0, 1, 299, 300]) {
    expect(
      continuesMessageGroup(first, {
        ...first,
        id: "next",
        createdAt: first.createdAt + seconds,
      }),
    ).toBe(true);
  }
});
it("breaks groups at missing history, author/channel changes, time gaps and reversed time", () => {
  expect(continuesMessageGroup(undefined, first)).toBe(false);
  for (const change of [
    { authorId: "other" },
    { channelId: "other" },
    { createdAt: first.createdAt + 301 },
    { createdAt: first.createdAt - 1 },
  ]) {
    expect(continuesMessageGroup(first, { ...first, ...change })).toBe(false);
  }
});
it("breaks at local midnight even within five minutes", () => {
  const before = {
    ...first,
    createdAt: new Date(2026, 8, 28, 23, 59).getTime() / 1000,
  };
  expect(
    continuesMessageGroup(before, {
      ...first,
      createdAt: before.createdAt + 120,
    }),
  ).toBe(false);
});
it("keeps membership events separate on either side", () => {
  const membership = {
    ...first,
    membership: {} as NonNullable<ChannelMessage["membership"]>,
  };
  expect(continuesMessageGroup(first, membership)).toBe(false);
  expect(continuesMessageGroup(membership, first)).toBe(false);
});
