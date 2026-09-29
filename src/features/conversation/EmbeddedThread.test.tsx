// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EmbeddedThread } from "./EmbeddedThread";
import type { Context } from "@deepseek-ai/cordis";
import type { ComponentProps } from "react";
import type { PanelProps, RegisteredPanel } from "../panels/service";
import type { ThreadPanelProps } from "../messages/ThreadPanel";

vi.mock("../messages/ThreadPanel", () => ({
  ThreadPanel: (props: ThreadPanelProps) => (
    <button type="button" onClick={() => props.onOpenLink("fixture:one")}>
      Open linked panel
    </button>
  ),
}));
vi.mock("../messages/MediaReviewViewer", () => ({
  MediaReviewViewer: () => null,
}));
vi.mock("../../shared/design-system/ui/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));
afterEach(cleanup);

it("retires panel actions on contribution removal, destination change and unmount", () => {
  let captured: PanelProps | undefined;
  const panel = {
    key: "fixture",
    id: "fixture",
    pluginId: "fixture",
    revision: "1",
    title: "Fixture",
    matches: () => true,
    component: (props: PanelProps) => {
      captured = props;
      return <p>Linked content</p>;
    },
  } as RegisteredPanel;
  let panels = [panel];
  const listeners = new Set<() => void>();
  const session = {} as ComponentProps<typeof EmbeddedThread>["session"];
  const scope = `https://fixture.test:${"a".repeat(64)}`;
  const host = {
    panels: {
      snapshot: () => panels,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      resolve: () => panels[0],
    },
    relay: { snapshot: () => ({ status: "ready", session, scope }) },
    navigation: { open: vi.fn() },
  } as unknown as Context;
  const props = {
    host,
    session,
    scope,
    channelId: "c",
    channelName: "Channel",
    messageId: "one",
    extensions: {} as ComponentProps<typeof EmbeddedThread>["extensions"],
  };
  const view = render(<EmbeddedThread {...props} />);
  fireEvent.click(screen.getByText("Open linked panel"));
  expect(screen.getByText("Linked content")).toBeVisible();
  const old = captured;
  view.rerender(<EmbeddedThread {...props} messageId="two" />);
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
  expect(old?.context?.open("fixture:two")).toBe(false);
  fireEvent.click(screen.getByText("Open linked panel"));
  const removed = captured;
  act(() => {
    panels = [];
    for (const fn of listeners) fn();
  });
  expect(screen.queryByText("Linked content")).not.toBeInTheDocument();
  expect(removed?.context?.open("fixture:two")).toBe(false);
  view.unmount();
  expect(removed?.context?.open("fixture:two")).toBe(false);
  expect(listeners.size).toBe(0);
});
