// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { ChannelTimeline } from "./ChannelTimeline";
import { createRelaySession } from "../relay/session";
import type { ChannelWindow } from "../relay/contracts";
import { keypair, message, scriptedTransport } from "../relay/testing";
import { readView, writeView } from "../../shared/view-state";

// Real React lifecycle; only the virtualizer's imperative layout boundary is
// modeled here. Browser journeys retain the actual same-message/4px contract.
const scroll = vi.hoisted(() => ({ toIndex: vi.fn(), toOffset: vi.fn() }));
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollToIndex: scroll.toIndex,
        scrollTo: scroll.toOffset,
      }));
      return <ol style={{ height: 2000 }}>{children}</ol>;
    }),
  };
});
const frames = new Map<number, FrameRequestCallback>();
const resizes = new Set<() => void>();
let nextFrame = 0;
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  scroll.toIndex.mockClear();
  scroll.toOffset.mockClear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizes.add(this.callback);
      }
      disconnect() {
        resizes.delete(this.callback);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function frame() {
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  });
}
function mount(bottom = false, revealOnMount = false) {
  const viewer = keypair(),
    relay = keypair();
  const target = message(viewer, "c", "Saved reading anchor", 1);
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  owners.push(owner);
  writeView("scope", "scroll:c", {
    offset: 900,
    bottom,
    anchor: { id: target.id, y: 42 },
  });
  const window: ChannelWindow = {
    channelId: "c",
    status: "ready",
    freshness: "cached",
    hasMore: false,
    loadingOlder: false,
    error: undefined,
    rows: [
      {
        id: target.id,
        channelId: "c",
        authorId: viewer.pubkey,
        content: target.content,
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      },
    ],
  };
  const tree = (snapshot: ChannelWindow, revealMessageId?: string) => (
    <StrictMode>
      <ChannelTimeline
        channelId="c"
        scope="scope"
        queries={owner.session}
        window={snapshot}
        revealMessageId={revealMessageId}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  const first = window.rows[0];
  if (!first) throw new Error("Missing fixture row");
  const sent = { ...first, id: "sent", content: "New message" };
  const sentWindow = { ...window, rows: [...window.rows, sent] };
  const result = render(
    revealOnMount ? tree(sentWindow, sent.id) : tree(window),
  );
  return {
    saved: { offset: 900, bottom, anchor: { id: target.id, y: 42 } },
    unmount: result.unmount,
    reveal() {
      result.rerender(tree(sentWindow, sent.id));
    },
    refreshSent() {
      result.rerender(
        tree({ ...sentWindow, rows: [...sentWindow.rows] }, sent.id),
      );
    },
    awaitReveal() {
      result.rerender(tree(window, sent.id));
    },
    replaceAnchor() {
      const first = window.rows[0];
      if (!first) throw new Error("Missing fixture row");
      result.rerender(
        tree({ ...window, rows: [{ ...first, id: "replacement" }] }),
      );
    },
    promote() {
      result.rerender(
        tree({ ...window, freshness: "verified", rows: [...window.rows] }),
      );
    },
    async measured() {
      await act(async () => {
        screen.getByRole("list").style.height = "2120px";
        await Promise.resolve(); // deliver the real MutationObserver before rAF
      });
    },
  };
}
it("retains the saved anchor correction when cached rows are promoted before its frame", async () => {
  const h = mount();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
  scroll.toIndex.mockClear();
  await h.measured();
  h.promote();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
});
it("reader input cancels the queued correction even when cached rows are then promoted", async () => {
  const h = mount();
  await frame();
  scroll.toIndex.mockClear();
  await h.measured();
  fireEvent.wheel(
    screen.getByRole("region", { name: "Channel message history" }),
  );
  h.promote();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "local reveal retires restoration without canceling existing bottom follow=%s",
  async (bottom) => {
    const h = mount(bottom);
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    const calls = scroll.toIndex.mock.calls.length;
    await h.measured();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    expect(scroll.toIndex.mock.calls.length).toBe(calls + 1);
  },
);

it.each(["none", "wheel", "key"])(
  "a reveal on mount follows late measurements unless reader input=%s",
  async (input) => {
    const h = mount(false, true);
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    scroll.toIndex.mockClear();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (input === "wheel") fireEvent.wheel(feed);
    if (input === "key") fireEvent.keyDown(feed, { key: "PageUp" });
    await h.measured();
    await frame();
    if (input === "none") {
      expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
      h.unmount();
      expect(readView("scope", "scroll:c", null)).toMatchObject({
        bottom: true,
      });
    } else expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it.each(["wheel", "key"])(
  "reader input before the reveal frame stays authoritative after a row refresh: %s",
  async (input) => {
    const h = mount();
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (input === "wheel") fireEvent.wheel(feed);
    else fireEvent.keyDown(feed, { key: "PageUp" });
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    // A later echo/edit replaces rows; it must not revive the canceled reveal.
    h.refreshSent();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it("waits for a sent row to arrive without restoring over its reveal", async () => {
  const h = mount();
  await frame();
  h.awaitReveal();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  h.reveal();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  scroll.toIndex.mockClear();
  h.reveal();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "the first intermediate bottom-follow scroll retains intent unless reader input=%s",
  async (readerInput) => {
    const h = mount(true);
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // Virtua can deliver an intermediate offset before measuring its final range.
    feed.scrollTop = 162;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    scroll.toIndex.mockClear();
    await h.measured();
    await frame();
    if (readerInput) expect(scroll.toIndex).not.toHaveBeenCalled();
    else expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  },
);

it("a resize before the local reveal scroll event cannot revive the prior reading anchor", async () => {
  const h = mount();
  await frame();
  h.reveal();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  scroll.toIndex.mockClear();
  // Composer/sidebar layout may resize before the browser delivers scroll.
  await act(async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    for (const resize of resizes) resize();
  });
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  expect(scroll.toIndex).not.toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
});

it.each([false, true])(
  "a scroll before any visible virtual row mounts retains restoration unless reader input=%s",
  async (readerInput) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // The virtualizer has accepted the offset, but its mounted range is still
    // offscreen. No paragraph or row is available to replace the saved anchor.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? -200 : 0, 800, 100);
      },
    );
    feed.scrollTop = 900;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(
      readerInput ? { offset: 900, bottom: false } : h.saved,
    );
  },
);

it.each([false, true])(
  "does not turn cold clamps into reader follow intent, repeated=%s",
  async (repeat) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // Cold estimated row heights can clamp the restoring viewport to the bottom.
    // The saved row is mounted, so this is not the anchorless-range case above.
    let rowY = 84;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
      },
    );
    feed.scrollTop = 1400;
    fireEvent.scroll(feed);
    if (repeat) {
      feed.scrollTop = 1200;
      rowY = 284;
      fireEvent.scroll(feed);
      feed.scrollTop = 1400;
      rowY = 84;
      fireEvent.scroll(feed);
    }
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -42,
    });
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(h.saved);
  },
);

it.each(["converged", "gesture", "removed"])(
  "allows bottom follow after restoration is superseded: %s",
  async (boundary) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? 42 : 0, 800, 100);
      },
    );
    if (boundary === "converged") {
      feed.scrollTop = 900;
      fireEvent.scroll(feed);
    } else if (boundary === "gesture") {
      fireEvent.pointerDown(feed);
    } else {
      h.replaceAnchor();
      await frame();
    }
    feed.scrollTop = 1400;
    fireEvent.scroll(feed);
    h.unmount();
    expect(
      readView<{ bottom: boolean }>("scope", "scroll:c", { bottom: false })
        .bottom,
    ).toBe(true);
  },
);
