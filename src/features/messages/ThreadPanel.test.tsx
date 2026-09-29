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
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadPanel, type ThreadPanelProps } from "./ThreadPanel";
import type { MessageRowProps } from "./MessageRow";
import type { MessageComposerProps } from "./MessageComposer";
import { createAgentLibrary } from "../agents/library";
import type { RelaySession } from "../relay/session";
import type { PageNavigation } from "../navigation/service";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type { ChannelMessage } from "../relay/contracts";

// Real React owns effects, refs and subscriptions. Only independent child UI is
// reduced here; MessageRow/MessageComposer retain their own mounted suites.
vi.mock("../relay/react", () => {
  const profiles = new Map();
  return { useRowProfiles: () => profiles };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({
    row,
    scope,
    retry,
    onOpenMediaReview,
    onMediaPlayback,
  }: MessageRowProps) => (
    <article data-message-id={row.id} data-scope={scope}>
      <span>{row.content}</span>
      {row.attachments
        .filter((attachment) => attachment.kind === "video")
        .flatMap((attachment) =>
          [0, 42].map((seconds) => (
            <button
              key={`${attachment.url}:${seconds}`}
              type="button"
              onClick={() =>
                onMediaPlayback?.({
                  attachmentUrl: attachment.url,
                  seconds,
                })
              }
            >
              Report playback {seconds}
            </button>
          )),
        )}
      <button type="button" onClick={() => retry?.(row.id)}>
        Retry {row.id}
      </button>
      {row.attachments.map((attachment) => (
        <button
          key={attachment.url}
          type="button"
          onClick={() => onOpenMediaReview?.(row.id, attachment, 0)}
        >
          Open {row.content}
        </button>
      ))}
    </article>
  ),
}));
vi.mock("./MessageComposer", () => ({
  MessageComposer: ({
    threadRootId,
    channelId,
    scope,
    onSend,
  }: MessageComposerProps) => (
    <section
      aria-label="Composer"
      data-root={threadRootId}
      data-channel={channelId}
      data-scope={scope}
    >
      <button type="button" onClick={() => onSend?.("own-reply")}>
        Send fixture reply
      </button>
    </section>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
});
const row: ChannelMessage = {
  id: "a".repeat(64),
  channelId: "channel",
  authorId: "b".repeat(64),
  content: "root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 2,
};
function ordinaryNavigation() {
  return {
    entryId: "thread-visit",
    target: {
      version: 1,
      kind: "conversation",
      channelId: "channel",
      messageId: row.id,
      threadRootId: row.id,
      scope: {
        viewer: row.authorId,
        communityOrigin: "https://fixture.invalid",
      },
    },
    signal: new AbortController().signal,
    complete: vi.fn<PageNavigation["complete"]>(() => true),
    resolve: vi.fn(() => true),
    forSession: vi.fn<PageNavigation["forSession"]>(),
  } satisfies PageNavigation;
}
function messagesHarness(
  navigation?: PageNavigation,
  onOpenMediaReview?: ThreadPanelProps["onOpenMediaReview"],
) {
  const snapshot: { -readonly [K in keyof ThreadSnapshot]: ThreadSnapshot[K] } =
    {
      status: "ready",
      root: row,
      replies: [],
      error: undefined,
      canLoadMore: false,
      limited: false,
    };
  let published: ThreadSnapshot = { ...snapshot };
  const views: (ThreadView & {
    listeners: Set<() => void>;
    refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
    loadMore: ReturnType<typeof vi.fn<() => Promise<void>>>;
    dispose: ReturnType<typeof vi.fn>;
  })[] = [];
  const makeView = () => {
    const listeners = new Set<() => void>();
    const view = {
      snapshot: () => published,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      refresh: vi.fn(async () => {}),
      loadMore: vi.fn(async () => {}),
      dispose: vi.fn(),
      listeners,
    };
    views.push(view);
    return view;
  };
  const first = makeView();
  const thread = vi
    .fn()
    .mockImplementationOnce(() => first)
    .mockImplementation(makeView);
  const ensure = vi.fn(async () => {});
  const session = {
    thread,
    profiles: { ensure },
    agentChoices: createAgentLibrary(undefined).queries,
    messages: { retry: vi.fn() },
    media: () => undefined,
    unread: {
      sync: () => ({ capability: "unsupported" }),
      snapshot: () => undefined,
      subscribe: () => () => {},
      attention: () => ({ unread: false }),
    },
  } as unknown as RelaySession;
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  // Controlled dimensions exercise positioning policy, not browser layout.
  // Install before mount so the first real layout effect sees the same geometry.
  let height = 4000,
    top = 0;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => height,
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => top,
    set(value: number) {
      top = Math.max(0, Math.min(value, height - 600));
    },
  });
  const close = vi.fn(),
    bubble = vi.fn();
  const props = {
    session,
    scope: "scope",
    channelName: "General",
    channelId: "channel",
    messageId: row.id,
    navigation,
    close,
    onOpenLink: () => false,
    ...(onOpenMediaReview ? { onOpenMediaReview } : {}),
  };
  let mounted: ReturnType<typeof render> | undefined;
  let element: HTMLElement;
  return {
    snapshot,
    session,
    views,
    thread,
    ensure,
    close,
    bubble,
    props,
    get view() {
      return views.at(-1) ?? first;
    },
    get listeners() {
      return (views.at(-1) ?? first).listeners;
    },
    get element() {
      return element;
    },
    render(strict = false) {
      act(() => {
        published = { ...snapshot };
        for (const view of views)
          for (const listener of view.listeners) listener();
      });
      if (!mounted) {
        const tree = (
          <div role="application" onKeyDown={bubble}>
            <ThreadPanel {...props} />
          </div>
        );
        mounted = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
      }
      element =
        screen.queryByRole("region", { name: "Thread messages" }) ?? element;
      return element;
    },
    resize(value: number) {
      height = value;
    },
    scroll(value: number) {
      element.scrollTop = value;
      fireEvent.scroll(element);
    },
    unmount() {
      mounted?.unmount();
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
    },
  };
}
it("allocates only after commit and disposes distinct owned views under StrictMode", () => {
  const h = messagesHarness();
  renderToString(<ThreadPanel {...h.props} />);
  expect(h.thread).not.toHaveBeenCalled();
  h.render(true);
  expect(h.thread.mock.calls).toEqual([
    ["channel", row.id],
    ["channel", row.id],
  ]);
  expect(h.views[0]).not.toBe(h.views[1]);
  expect(h.views[0]?.dispose).toHaveBeenCalledOnce();
  expect(h.view.dispose).not.toHaveBeenCalled();
  for (const view of h.views) expect(view.refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
  fireEvent.keyDown(screen.getByRole("complementary", { name: "Thread" }), {
    key: "Escape",
  });
  expect(h.close).toHaveBeenCalledTimes(2);
  expect(h.bubble).not.toHaveBeenCalled();
  h.unmount();
  for (const view of h.views) {
    expect(view.dispose).toHaveBeenCalledOnce();
    expect(view.listeners.size).toBe(0);
  }
});
it("allocation failure exposes an effective retry rather than leaving a spinner", () => {
  const h = messagesHarness();
  h.thread
    .mockReset()
    .mockImplementationOnce(() => {
      throw new Error("capacity");
    })
    .mockReturnValue(h.view);
  h.render();
  expect(screen.getByRole("alert")).toHaveTextContent("capacity");
  fireEvent.click(screen.getByRole("button", { name: "Retry thread" }));
  expect(screen.getByText("root")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(h.thread).toHaveBeenCalledTimes(2);
  expect(h.view.refresh).toHaveBeenCalledOnce();
});
it("loads history automatically with error-only retry and no routine history controls", () => {
  const h = messagesHarness();
  h.render();
  expect(h.ensure).toHaveBeenCalledExactlyOnceWith(
    [row.authorId],
    "background",
  );
  for (const name of ["Refresh thread", "Retry thread", "Load more replies"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByText(/Existing history may be incomplete/)).toBeNull();
  expect(h.view.loadMore).not.toHaveBeenCalled();
  h.snapshot.canLoadMore = true;
  h.render();
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.snapshot.status = "loading";
  h.render();
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.snapshot.status = "error";
  h.snapshot.error = "offline";
  h.render();
  fireEvent.click(screen.getByRole("button", { name: "Retry thread" }));
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  expect(h.view.refresh).toHaveBeenCalledTimes(2);
  h.snapshot.status = "ready";
  h.snapshot.error = undefined;
  h.snapshot.canLoadMore = false;
  h.render();
  expect(screen.queryByRole("button", { name: "Retry thread" })).toBeNull();
  h.snapshot.limited = true;
  h.render();
  expect(screen.getByText("Thread history limit reached.")).toBeVisible();
  h.snapshot.status = "error";
  h.snapshot.error = "Thread view exceeded its memory limit.";
  h.render();
  expect(screen.queryByText(/appear automatically/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry thread" }));
  expect(h.view.refresh).toHaveBeenCalledTimes(3);
  expect(h.ensure).toHaveBeenCalledOnce();
});
it("starts a single older page after scrolling through 80% of loaded history", () => {
  const h = messagesHarness();
  h.snapshot.direction = "older";
  h.snapshot.canLoadMore = true;
  const section = h.render();
  fireEvent.wheel(section, { deltaY: -1 });
  h.scroll(681); // 20% of the 3,400px scrollable range is 680px.
  expect(h.view.loadMore).not.toHaveBeenCalled();
  h.scroll(680);
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.scroll(0);
  expect(h.view.loadMore).toHaveBeenCalledOnce();
  h.snapshot.status = "loading";
  h.render();
  h.scroll(0);
  expect(h.view.loadMore).toHaveBeenCalledOnce();
});
it("shows initial thread loading only until content is available", () => {
  const h = messagesHarness();
  h.snapshot.status = "loading";
  h.snapshot.root = undefined;
  const section = h.render();
  expect(within(section).getByText("Loading thread…")).toBeVisible();
  expect(
    within(section).queryByText("Original message unavailable."),
  ).toBeNull();
  h.snapshot.root = row;
  h.render();
  expect(within(section).getByText("root")).toBeVisible();
  expect(within(section).queryByText("Loading thread…")).toBeNull();
});
it("keeps older-page loading quiet and retry between root and replies", () => {
  const h = messagesHarness();
  h.snapshot.direction = "older";
  h.snapshot.canLoadMore = true;
  h.snapshot.replies = [{ ...row, id: "older-reply", content: "older reply" }];
  const section = h.render();
  fireEvent.wheel(section, { deltaY: -1 });
  h.scroll(0);
  expect(h.view.loadMore).toHaveBeenCalledOnce();

  h.snapshot.status = "loading";
  h.snapshot.readKind = "older";
  h.render();
  const root = screen.getByText("root").closest("article");
  const reply = screen.getByText("older reply").closest("article");
  if (!root || !reply) throw new Error("Missing root or older reply");
  expect(within(section).queryByText("Loading older replies…")).toBeNull();
  expect(root).toBeVisible();
  expect(reply).toBeVisible();
  expect(within(section).queryByText("Loading thread…")).toBeNull();

  h.snapshot.status = "error";
  h.snapshot.error = "offline";
  h.render();
  const alert = within(section).getByRole("alert");
  expect(alert).toHaveTextContent("offline");
  expect(
    root.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    alert.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(
    within(section).getByRole("button", { name: "Retry thread" }),
  );
  expect(h.view.loadMore).toHaveBeenCalledTimes(2);
  expect(h.view.refresh).toHaveBeenCalledOnce();

  h.snapshot.status = "ready";
  h.snapshot.error = undefined;
  h.render();
  expect(within(section).queryByText("Loading older replies…")).toBeNull();
});
it("keeps retained-range repair quiet and retry after the replies", () => {
  const h = messagesHarness();
  h.snapshot.direction = "older";
  h.snapshot.replies = [
    { ...row, id: "retained-reply", content: "retained reply" },
  ];
  h.snapshot.status = "loading";
  h.snapshot.readKind = "refresh";
  const section = h.render();
  expect(within(section).queryByText("Loading older replies…")).toBeNull();
  expect(within(section).queryByText("Loading thread…")).toBeNull();

  h.snapshot.status = "error";
  h.snapshot.error = "repair failed";
  h.render();
  const reply = screen.getByText("retained reply").closest("article");
  if (!reply) throw new Error("Missing retained reply");
  const alert = within(section).getByRole("alert");
  expect(alert).toHaveTextContent("repair failed");
  expect(
    reply.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(
    within(section).getByRole("button", { name: "Retry thread" }),
  );
  expect(h.view.refresh).toHaveBeenCalledTimes(2);
  expect(h.view.loadMore).not.toHaveBeenCalled();
});
it("positions after successful history loading, then follows live replies without another read", () => {
  const h = messagesHarness();
  h.snapshot.status = "loading";
  h.render();
  expect(h.element.scrollTop).toBe(0);
  h.snapshot.status = "error";
  h.render();
  expect(h.element.scrollTop).toBe(0);
  h.snapshot.status = "ready";
  h.render();
  expect(h.element.scrollTop).toBe(3400);
  h.scroll(3400);
  h.snapshot.replies = [{ ...row, id: "new", content: "live arrival" }];
  h.resize(4800);
  const section = h.render();
  expect(h.element.scrollTop).toBe(4200);
  expect(within(section).getByText("live arrival")).toBeVisible();
  expect(h.view.refresh).toHaveBeenCalledTimes(1); // Initial open only.
  expect(h.view.loadMore).not.toHaveBeenCalled();
});
it("preserves reading above the bottom through live updates and refresh, then resumes following on return", () => {
  const h = messagesHarness();
  h.render();
  h.scroll(500);
  h.snapshot.replies = [{ ...row, id: "new", content: "live arrival" }];
  h.resize(4800);
  h.render();
  expect(h.element.scrollTop).toBe(500);
  h.snapshot.status = "loading";
  h.render();
  h.snapshot.status = "ready";
  h.render();
  expect(h.element.scrollTop).toBe(500);
  h.scroll(4200);
  h.snapshot.replies = [...h.snapshot.replies, { ...row, id: "next" }];
  h.resize(5500);
  h.render();
  expect(h.element.scrollTop).toBe(4900);
});
it("keeps video threads free of the timestamp comment shortcut at any playback position", () => {
  const h = messagesHarness();
  h.snapshot.root = {
    ...row,
    attachments: [{ url: "https://safe/video.mp4", kind: "video" }],
  };
  h.render();
  for (const seconds of [0, 42]) {
    fireEvent.click(
      screen.getByRole("button", { name: `Report playback ${seconds}` }),
    );
    expect(
      screen.queryByRole("button", { name: /^Comment at / }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Composer" })).toBeVisible();
  }
});

it("counts replies recovered after a completed traversal, not initial history pages", () => {
  const h = messagesHarness();
  h.snapshot.canLoadMore = true;
  h.render();
  h.scroll(500);
  h.snapshot.status = "loading";
  h.snapshot.replies = [{ ...row, id: "history", createdAt: 1 }];
  h.render();
  h.snapshot.status = "ready";
  h.snapshot.canLoadMore = false;
  h.render();
  h.scroll(500);
  expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();

  h.snapshot.status = "loading";
  h.render();
  h.snapshot.replies = [
    ...h.snapshot.replies,
    { ...row, id: "recovered", createdAt: 2 },
  ];
  h.render();
  h.snapshot.status = "ready";
  h.render();
  expect(screen.getByRole("button", { name: "1 new message" })).toBeVisible();
  h.snapshot.replies = [
    ...h.snapshot.replies,
    { ...row, id: "live", createdAt: 3 },
  ];
  h.render();
  expect(screen.getByRole("button", { name: "2 new messages" })).toBeVisible();
});

it("transfers keyboard focus to the thread history before removing the jump button", () => {
  const h = messagesHarness();
  h.render();
  h.scroll(500);
  const jump = screen.getByRole("button", { name: "Jump to latest" });
  jump.focus();
  fireEvent.click(jump);
  expect(h.element).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
});

it("routes media in replies through the resolved root review workspace", () => {
  const open = vi.fn();
  const h = messagesHarness(undefined, open);
  const attachment = { url: "https://safe/image.png", kind: "image" as const };
  h.snapshot.root = { ...row, id: "resolved-root" };
  h.snapshot.replies = [
    { ...row, id: "reply", content: "media reply", attachments: [attachment] },
  ];
  h.render();
  fireEvent.click(screen.getByRole("button", { name: "Open media reply" }));
  expect(open).toHaveBeenCalledExactlyOnceWith("reply", attachment, 0, true);
});

it("uses the resolved root with the shared composer and reveals an own send even while reading above", () => {
  const h = messagesHarness();
  h.snapshot.root = { ...row, id: "resolved-root" };
  h.render();
  expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
    "data-root",
    "resolved-root",
  );
  expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
    "data-channel",
    "channel",
  );
  expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
    "data-scope",
    "scope",
  );
  h.scroll(500);
  fireEvent.click(screen.getByRole("button", { name: "Send fixture reply" }));
  h.snapshot.replies = [{ ...row, id: "own-reply", content: "own reply" }];
  h.resize(4800);
  h.render();
  expect(h.element.scrollTop).toBe(4200);
  const reply = screen.getByText("own reply").closest("article");
  expect(reply).toHaveAttribute("data-scope", "scope");
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  expect(
    vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts,
  ).toContain(reply);
  fireEvent.click(screen.getByRole("button", { name: "Retry own-reply" }));
  expect(h.session.messages.retry).toHaveBeenCalledWith("own-reply");
  h.snapshot.root = undefined;
  h.render();
  expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
});
it.each([
  { gap: 79, follows: true },
  { gap: 80, follows: false },
])(
  "uses the main timeline's near-bottom threshold: gap=$gap",
  ({ gap, follows }) => {
    const h = messagesHarness();
    h.render();
    h.scroll(3400 - gap);
    h.snapshot.replies = [{ ...row, id: "new" }];
    h.resize(4800);
    h.render();
    expect(h.element.scrollTop).toBe(follows ? 4200 : 3400 - gap);
  },
);
it("finishes automatic pages before initial positioning and preserves a reader’s intervening scroll", () => {
  const h = messagesHarness();
  h.snapshot.canLoadMore = true;
  h.render();
  expect(h.view.loadMore).toHaveBeenCalledTimes(1);
  expect(h.element.scrollTop).toBe(0);
  const section = h.render();
  fireEvent.wheel(section, { deltaY: -1 });
  h.scroll(500);
  h.snapshot.status = "loading";
  h.render();
  h.snapshot.status = "ready";
  h.snapshot.canLoadMore = false;
  h.snapshot.replies = [{ ...row, id: "history" }];
  h.resize(4800);
  h.render();
  expect(h.element.scrollTop).toBe(500);
  h.scroll(4200);
  h.snapshot.replies = [...h.snapshot.replies, { ...row, id: "live" }];
  h.resize(5500);
  h.render();
  expect(h.element.scrollTop).toBe(4900);
});
it.each([
  { limited: false, routed: false },
  { limited: true, routed: false },
  { limited: false, routed: true },
  { limited: true, routed: true },
])(
  "positions after automatic loading stops (limited=$limited, routed=$routed), without restarting pagination",
  ({ limited, routed }) => {
    const navigation = routed ? ordinaryNavigation() : undefined;
    const h = messagesHarness(navigation);
    h.snapshot.canLoadMore = true;
    h.render();
    expect(h.element.scrollTop).toBe(0);
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    if (navigation)
      expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
        status: "opened",
      });
    h.snapshot.status = "loading";
    h.render();
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    h.snapshot.status = "ready";
    h.snapshot.canLoadMore = false;
    h.snapshot.limited = limited;
    h.snapshot.replies = [{ ...row, id: "history" }];
    h.resize(4800);
    h.render();
    expect(h.element.scrollTop).toBe(4200);
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    // A live update follows without completing the same visit twice.
    h.snapshot.replies = [...h.snapshot.replies, { ...row, id: "live" }];
    h.render();
    if (navigation)
      expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
        status: "opened",
      });
  },
);
it.each(
  [false, true].flatMap((routed) =>
    ["wheel", "touchMove", "pointerDown", "keyDown"].map((handler) => ({
      routed,
      handler,
    })),
  ),
)(
  "a user $handler gesture before the page completes wins over initial positioning (routed=$routed)",
  ({ routed, handler }) => {
    const navigation = routed ? ordinaryNavigation() : undefined;
    const h = messagesHarness(navigation);
    h.snapshot.status = "loading";
    const section = h.render();
    fireEvent[handler as "wheel" | "touchMove" | "pointerDown" | "keyDown"](
      section,
      { key: "PageUp" },
    );
    h.snapshot.status = "ready";
    h.render();
    expect(h.element.scrollTop).toBe(0);
    if (navigation)
      expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
        status: "opened",
      });
  },
);
it("ordinary routed loading failure completes as unavailable, never as an opened visit", () => {
  const navigation = ordinaryNavigation();
  const h = messagesHarness(navigation);
  h.snapshot.status = "error";
  h.render();
  expect(h.element.scrollTop).toBe(0);
  expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
    status: "failed",
    reason: "unavailable",
  });
});
it("a presented ordinary thread survives the real navigation deadline while history is pending", async () => {
  vi.useFakeTimers();
  const controller = createNavigationController(createMemoryHistory());
  let release = () => {};
  try {
    const navigation = ordinaryNavigation();
    const result = controller.navigation.open(navigation.target);
    const { attempt } = controller.navigation.snapshot();
    navigation.signal = attempt.signal;
    navigation.complete.mockImplementation((result) =>
      controller.complete(attempt, result),
    );
    const h = messagesHarness(navigation);
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.view.loadMore.mockImplementation(() => held);
    h.snapshot.canLoadMore = true;
    h.render();
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    h.snapshot.status = "loading";
    h.render();
    await act(() => vi.advanceTimersByTimeAsync(16_000));
    expect(controller.navigation.snapshot().status).toBe("opened");
    expect(await result).toEqual({ status: "opened" });
    expect(attempt.signal.aborted).toBe(false);
    expect(h.view.dispose).not.toHaveBeenCalled();
    expect(h.element.scrollTop).toBe(0);
    release();
    await held;
    h.snapshot.status = "ready";
    h.snapshot.canLoadMore = false;
    h.render();
    expect(h.element.scrollTop).toBe(3400);
    expect(navigation.complete).toHaveBeenCalledTimes(1);
    h.unmount();
  } finally {
    release();
    controller.dispose();
    vi.useRealTimers();
  }
});
it("revoked ordinary presentation cannot position or complete after loading", () => {
  const controller = new AbortController();
  const navigation = { ...ordinaryNavigation(), signal: controller.signal };
  const h = messagesHarness(navigation);
  h.snapshot.status = "loading";
  h.snapshot.root = undefined;
  h.render();
  act(() => controller.abort());
  expect(h.view.dispose).toHaveBeenCalledTimes(1);
  expect(h.listeners.size).toBe(0);
  expect(screen.queryByRole("region", { name: "Thread messages" })).toBeNull();
  h.snapshot.status = "ready";
  h.render();
  expect(h.element.scrollTop).toBe(0);
  expect(navigation.complete).not.toHaveBeenCalled();
});

it("embedded presentation keeps the thread reader without a close header or Escape dismissal", () => {
  const thread = vi.fn(() => {
    throw new Error("fixture unavailable");
  });
  const session = { thread } as unknown as RelaySession;
  const props = {
    session,
    scope: "test",
    channelId: "c",
    channelName: "Channel",
    messageId: "root",
    onOpenLink: () => false,
  };
  const onEscape = vi.fn();
  document.addEventListener("keydown", onEscape);
  const { rerender } = render(
    <ThreadPanel {...props} presentation="embedded" />,
  );
  expect(
    screen.queryByRole("button", { name: "Close thread" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("fixture unavailable");
  fireEvent.keyDown(screen.getByRole("complementary", { name: "Thread" }), {
    key: "Escape",
  });
  document.removeEventListener("keydown", onEscape);
  expect(onEscape).toHaveBeenCalledOnce();
  const close = vi.fn();
  rerender(<ThreadPanel {...props} close={close} />);
  expect(screen.getByRole("button", { name: "Close thread" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("complementary", { name: "Thread" }), {
    key: "Escape",
  });
  expect(close).toHaveBeenCalledOnce();
});
