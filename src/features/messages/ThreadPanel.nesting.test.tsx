// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentLibrary } from "../agents/library";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot } from "../relay/threads";
import type { MessageComposerProps } from "./MessageComposer";
import type { MessageRowProps } from "./MessageRow";
import { ThreadPanel } from "./ThreadPanel";

vi.mock("./use-reading", () => ({ useReading: () => {} }));
vi.mock("../relay/react", () => {
  const profiles = new Map();
  return { useRowProfiles: () => profiles };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({ row, onReply, layout, compactAvatar }: MessageRowProps) => (
    <article
      data-message-id={row.id}
      data-layout={layout}
      data-compact-avatar={compactAvatar}
    >
      <span>{row.content}</span>
      <a href="https://example.com">Link in {row.content}</a>
      <button type="button" onClick={() => onReply?.(row.id)}>
        Reply to {row.content}
      </button>
    </article>
  ),
}));
vi.mock("./MessageComposer", () => ({
  MessageComposer: ({
    replyContext,
    replyParentId,
    onSend,
    disabled,
  }: MessageComposerProps) => (
    <section aria-label="Composer" data-parent={replyParentId}>
      {replyContext}
      <button type="button" disabled={disabled} onClick={() => onSend?.("new")}>
        Send fixture reply
      </button>
    </section>
  ),
}));
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
function row(id: string, replyParentId?: string): ChannelMessage {
  return {
    id,
    replyParentId,
    channelId: "c",
    authorId: "a".repeat(64),
    content: id,
    createdAt: 1,
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  };
}
function setup(messageId = "root") {
  let snapshot: ThreadSnapshot = {
    root: row("root"),
    replies: [
      row("parent", "root"),
      row("child", "parent"),
      row("grandchild", "child"),
    ],
    status: "ready",
    error: undefined,
    canLoadMore: false,
    limited: false,
  };
  const listeners = new Set<() => void>();
  const view = {
    snapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refresh: async () => {},
    loadMore: async () => {},
    dispose: () => {},
  };
  const session = {
    thread: () => view,
    profiles: { ensure: async () => {} },
    agentChoices: createAgentLibrary(undefined).queries,
    messages: { retry: () => {} },
    media: () => undefined,
    unread: {
      subscribe: () => () => {},
      snapshot: () => undefined,
      attention: () => ({ unread: false }),
    },
  } as unknown as RelaySession;
  render(
    <ThreadPanel
      session={session}
      scope="test"
      channelName="C"
      channelId="c"
      messageId={messageId}
      close={() => {}}
      onOpenLink={() => false}
    />,
  );
  return {
    setRoot(root: ChannelMessage | undefined) {
      act(() => {
        snapshot = { ...snapshot, root };
        for (const fn of listeners) fn();
      });
    },
    update(replies: ChannelMessage[]) {
      act(() => {
        snapshot = { ...snapshot, replies };
        for (const fn of listeners) fn();
      });
    },
  };
}
it("expands one level by keyboard, focuses the first child, and never offers re-collapse", async () => {
  setup();
  const user = userEvent.setup();
  const expand = screen.getByRole("button", { name: "View 2 replies" });
  expand.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByText("child").closest("article")).toHaveFocus();
  expect(expand).not.toBeInTheDocument();
  expect(screen.queryByText("grandchild")).not.toBeInTheDocument();
  screen.getByRole("button", { name: "View 1 reply" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByText("grandchild").closest("article")).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: /Hide replies|Collapse/ }),
  ).not.toBeInTheDocument();
});
it("retains expansion and parent identity through live zero-to-one child transitions", () => {
  const h = setup();
  h.update([row("parent", "root")]);
  const parent = screen.getByText("parent").closest("article");
  const reply = screen.getByRole("button", { name: "Reply to parent" });
  reply.focus();
  h.update([row("parent", "root"), row("child", "parent")]);
  expect(reply).toHaveFocus();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  reply.focus();
  h.update([row("parent", "root")]);
  h.update([row("parent", "root"), row("new", "parent")]);
  expect(screen.getByText("parent").closest("article")).toBe(parent);
  expect(reply).toHaveFocus();
  expect(screen.getByText("new")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "View 1 reply" }),
  ).not.toBeInTheDocument();
});
it("targets a child, cancels on repeated Reply, resets after send and reveals the own branch", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  const composer = screen.getByLabelText("Composer");
  expect(composer).toHaveAttribute("data-parent", "parent");
  expect(
    within(composer).getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  expect(composer).not.toHaveAttribute("data-parent");
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([row("parent", "root"), row("new", "parent")]);
  expect(screen.getByText("new")).toBeVisible();
  expect(composer).not.toHaveAttribute("data-parent");
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});
it("reveals all available ancestors for a selected descendant, including late history", () => {
  const h = setup("grandchild");
  expect(screen.getByText("grandchild")).toBeVisible();
  h.update([row("grandchild", "missing")]);
  expect(
    screen.getByText("Earlier reply unavailable in loaded history."),
  ).toBeVisible();
  expect(screen.getByText("grandchild")).toBeVisible();
  h.update([row("grandchild", "missing"), row("missing", "root")]);
  expect(screen.getByText("grandchild")).toBeVisible();
  expect(
    screen.queryByText("Earlier reply unavailable in loaded history."),
  ).not.toBeInTheDocument();
});
it("does not silently retarget a deleted parent to the root", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Reply to parent" }));
  h.update([]);
  expect(
    screen.getByText("Reply target is no longer available."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Send fixture reply" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reply target" }));
  expect(
    screen.getByRole("button", { name: "Send fixture reply" }),
  ).toBeEnabled();
});

it("groups the first same-author reply with the root but respects the time window", () => {
  const h = setup();
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "continuation",
  );
  h.update([{ ...row("parent", "root"), createdAt: 301 }]);
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "continuation",
  );
  h.update([{ ...row("parent", "root"), createdAt: 302 }]);
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
  h.update([{ ...row("parent", "root"), authorId: "b".repeat(64) }]);
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
});
it("keeps ordinary replies flat and visible when nested branches open or new replies arrive", () => {
  const h = setup();
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("peer", "root"),
  ]);
  const history = screen.getByRole("region", { name: "Thread messages" });
  expect(
    within(history).queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
  const parent = screen.getByText("parent").closest("li");
  const peer = screen.getByText("peer").closest("li");
  expect(parent?.parentElement).toBe(peer?.parentElement);
  expect(parent?.parentElement?.parentElement).toBe(history);
  fireEvent.click(screen.getByRole("button", { name: "View 1 reply" }));
  expect(screen.getByText("child")).toBeVisible();
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("peer", "root"),
    row("new", "root"),
  ]);
  for (const id of ["parent", "peer", "new", "child"])
    expect(screen.getByText(id)).toBeVisible();
  expect(screen.getByLabelText("Composer")).toBeVisible();
});
it("an own ordinary reply stays visible without opening a nested branch", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.update([row("parent", "root"), row("child", "parent"), row("new", "root")]);
  expect(screen.getByText("new")).toBeVisible();
  expect(screen.getByText("parent")).toBeVisible();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});

it("does not offer collapse controls for an empty thread", () => {
  const h = setup();
  h.update([]);
  expect(screen.getByText("root")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^View thread replies:/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Composer")).toBeVisible();
});

it("keeps same-author continuation layout through pending, failed, and accepted delivery", () => {
  const h = setup("child");
  for (const delivery of ["sending", "failed", "accepted"] as const) {
    h.update([row("parent", "root"), { ...row("child", "root"), delivery }]);
    expect(screen.getByText("child").closest("article")).toHaveAttribute(
      "data-layout",
      "continuation",
    );
  }
});

it("preserves ordinary reply identity, focus and unopened nested state through root loss and return", () => {
  const h = setup();
  const parent = screen.getByText("parent").closest("article");
  const reply = screen.getByRole("button", { name: "Reply to parent" });
  reply.focus();
  h.setRoot(undefined);
  expect(screen.getByText("Original message unavailable.")).toBeVisible();
  expect(screen.getByText("parent").closest("article")).toBe(parent);
  expect(reply).toHaveFocus();
  h.setRoot(row("root"));
  expect(screen.getByText("parent").closest("article")).toBe(parent);
  expect(reply).toHaveFocus();
  expect(screen.queryByText("child")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Hide thread replies" }),
  ).not.toBeInTheDocument();
});

for (const startsWithChild of [false, true])
  it(`preserves a reply subtree when it ${startsWithChild ? "loses its last" : "gains its first"} child`, () => {
    const h = setup("parent");
    const parent = row("parent", "root");
    const child = row("child", "parent");
    h.update(startsWithChild ? [parent, child] : [parent]);
    const message = screen.getByText("parent").closest("article");
    const reply = screen.getByRole("button", { name: "Reply to parent" });
    reply.focus();
    h.update(startsWithChild ? [parent] : [parent, child]);
    expect(screen.getByText("parent").closest("article")).toBe(message);
    expect(reply).toHaveFocus();
    expect(message).toBeInTheDocument();
    if (startsWithChild)
      expect(
        screen.queryByRole("button", { name: "View 1 reply" }),
      ).not.toBeInTheDocument();
    else
      expect(
        screen.getByRole("button", { name: "View 1 reply" }),
      ).toBeVisible();
  });

it("starts a nested branch with an author header even when the author matches its parent", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("child").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
});

it("groups same-parent siblings but restores the author after an expanded branch", () => {
  const h = setup();
  h.update([
    row("parent", "root"),
    row("child", "parent"),
    row("sibling", "parent"),
    row("peer", "root"),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("parent").closest("article")).toHaveAttribute(
    "data-layout",
    "continuation",
  );
  expect(screen.getByText("child").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
  expect(screen.getByText("sibling").closest("article")).toHaveAttribute(
    "data-layout",
    "continuation",
  );
  expect(screen.getByText("peer").closest("article")).toHaveAttribute(
    "data-layout",
    "thread",
  );
});

it("returns focus to the parent when the newly revealed focused child is deleted", async () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "View 2 replies" }));
  expect(screen.getByText("child").closest("article")).toHaveFocus();
  await act(async () => h.update([row("parent", "root")]));
  expect(screen.getByText("parent").closest("article")).toHaveFocus();
});

it("uses compact avatars only below ordinary thread replies", () => {
  setup("grandchild");
  for (const id of ["root", "parent"]) {
    expect(screen.getByText(id).closest("article")).not.toHaveAttribute(
      "data-compact-avatar",
      "true",
    );
  }
  for (const id of ["child", "grandchild"]) {
    expect(screen.getByText(id).closest("article")).toHaveAttribute(
      "data-compact-avatar",
      "true",
    );
  }
});

for (const focused of ["row", "button", "link"] as const) {
  for (const nested of [false, true]) {
    it(`recovers a deleted ${focused} to ${nested ? "its parent" : "tabbable history"}`, async () => {
      const h = setup(nested ? "child" : "parent");
      const id = nested ? "child" : "parent";
      const message = screen.getByText(id).closest("article");
      const target = nested
        ? screen.getByText("parent").closest("article")
        : screen.getByRole("region", { name: "Thread messages" });
      if (focused === "button")
        screen.getByRole("button", { name: `Reply to ${id}` }).focus();
      else if (focused === "link")
        screen.getByRole("link", { name: `Link in ${id}` }).focus();
      else if (message) {
        // Match the programmatic row focus used by exact-link navigation.
        message.tabIndex = -1;
        message.focus();
      }
      expect(message?.contains(document.activeElement)).toBe(true);
      const remaining = nested ? [row("parent", "root")] : [];
      await act(async () => h.update(remaining));
      expect(target).toHaveFocus();
      expect(target).toHaveAttribute("tabindex", nested ? "-1" : "0");
      h.update([...remaining, row("arrival", "root")]);
      expect(target).toHaveFocus();
      expect(target).toHaveAttribute("tabindex", nested ? "-1" : "0");
    });
  }
}

it("does not steal focus moved after removal but before queued recovery", async () => {
  const h = setup("child");
  const child = screen.getByRole("button", { name: "Reply to child" });
  child.focus();
  const send = screen.getByRole("button", { name: "Send fixture reply" });
  h.update([row("parent", "root")]);
  expect(child.isConnected).toBe(false);
  expect(document.body).toHaveFocus();
  send.focus();
  await act(async () => {});
  expect(send).toHaveFocus();
});
