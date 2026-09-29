// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "./avatar-testing";
stubAvatarBrowserApis();
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { AgentAvatar } from "./AgentAvatar";

vi.mock("../../shared/design-system/ui/agent-thinking/ThinkingBadge", () => ({
  ThinkingBadge: ({ thinking }: { thinking: boolean }) => (
    <span>{thinking ? "Thinking motion" : "Available motion"}</span>
  ),
}));
afterEach(() => {
  cleanup();
});

it("follows only this agent's fresh working activity and returns when the turn ends", () => {
  let turns: { agent: string; channelId: string; state: string }[] = [];
  let typing: { agent: string; channelId: string }[] = [];
  const listeners = new Set<() => void>();
  const activity = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => ({ turns, typing }),
  };
  const session = { agentActivity: activity } as unknown as RelaySession;
  const { unmount } = render(
    <AgentAvatar
      session={session}
      agentPubkey="agent"
      channelId="channel"
      alt="Agent"
      fallback="A"
      shape="squircle"
      statusBadge="online"
    />,
  );
  expect(screen.getByText("Available motion")).toBeInTheDocument();
  const update = (next: typeof turns) =>
    act(() => {
      turns = next;
      for (const listener of listeners) listener();
    });
  update([{ agent: "other", channelId: "channel", state: "working" }]);
  expect(screen.getByText("Available motion")).toBeInTheDocument();
  update([{ agent: "agent", channelId: "elsewhere", state: "working" }]);
  expect(screen.getByText("Available motion")).toBeInTheDocument();
  update([{ agent: "agent", channelId: "channel", state: "working" }]);
  expect(screen.getByText("Thinking motion")).toBeInTheDocument();
  update([{ agent: "agent", channelId: "channel", state: "ended" }]);
  expect(screen.getByText("Available motion")).toBeInTheDocument();
  typing = [{ agent: "agent", channelId: "channel" }];
  update([]);
  expect(screen.getByText("Thinking motion")).toBeInTheDocument();
  typing = [];
  update([]);
  expect(screen.getByText("Available motion")).toBeInTheDocument();
  unmount();
  expect(listeners.size).toBe(0);
});
