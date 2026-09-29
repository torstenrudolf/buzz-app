import { Button } from "../../shared/design-system/ui/Button";
import { useReading } from "./use-reading";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Virtualizer } from "virtua";
import { ChannelTimeline } from "./ChannelTimeline";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { createAgentLibrary } from "../agents/library";
import { createRelaySession } from "../relay/session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";

// Boundary test, not a browser renderer. Capture this production component's
// effects/refs and invoke its returned DOM handlers. Deliberately stale Virtua
// metrics reproduce the event ordering measured separately in Chromium/WebKit.
// Reading geometry/dwell has its own real-hook boundary suite. This fixture
// deliberately supplies only the DOM shape needed for positioning.
vi.mock("./use-reading", () => ({ useReading: vi.fn() }));
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  memos: [] as { deps: readonly unknown[]; value: unknown }[],
  effects: [] as {
    deps: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }[],
  pending: [] as (() => void)[],
  ref: 0,
  state: 0,
  memo: 0,
  effect: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef(value: unknown) {
    const index = hooks.ref++;
    hooks.refs[index] ??= { current: value };
    return hooks.refs[index];
  },
  useState(initial: unknown) {
    const index = hooks.state++;
    if (!(index in hooks.states))
      hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] = value;
      },
    ];
  },
  useCallback(value: unknown, deps: readonly unknown[]) {
    const index = hooks.memo++;
    const old = hooks.memos[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.memos[index] = { deps, value };
    return hooks.memos[index]?.value;
  },
  useMemo(factory: () => unknown, deps: readonly unknown[]) {
    const index = hooks.memo++;
    const old = hooks.memos[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.memos[index] = { deps, value: factory() };
    return hooks.memos[index]?.value;
  },
  useEffect(create: () => (() => void) | undefined, deps: readonly unknown[]) {
    const index = hooks.effect++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.pending.push(() => {
        old?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: create() };
      });
  },
  useLayoutEffect(
    create: () => (() => void) | undefined,
    deps: readonly unknown[],
  ) {
    const index = hooks.effect++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      hooks.pending.push(() => {
        old?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: create() };
      });
    }
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
vi.mock("../relay/react", () => ({
  useRowProfiles: () => new Map(),
}));
afterEach(() => vi.unstubAllGlobals());

const timelineMessage = (id: string): ChannelMessage => ({
  id,
  channelId: "channel",
  authorId: "author",
  content: "",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
});

function setup({
  freshness = "verified" as NonNullable<ChannelWindow["freshness"]>,
  status = "ready" as ChannelWindow["status"],
  blocked = undefined as boolean | undefined,
  session = undefined as RelaySession | undefined,
  hasMore = false,
  loadingOlder = false,
  historyLimited = false,
  error = undefined as string | undefined,
  initial = undefined as unknown,
  mounted = [] as { id: string; y: number }[],
  initialRows = undefined as ChannelMessage[] | undefined,
} = {}) {
  Object.assign(hooks, {
    refs: [],
    states: [],
    memos: [],
    effects: [],
    pending: [],
    ref: 0,
    state: 0,
    memo: 0,
    effect: 0,
  });
  const data = new Map<string, string>();
  if (initial !== undefined)
    data.set(
      'buzz-view.v1:["scope","scroll:channel"]',
      JSON.stringify(initial),
    );
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const observers = new Map<() => void, Set<unknown>>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<unknown>();
      constructor(callback: () => void) {
        observers.set(callback, this.targets);
      }
      observe(target: unknown) {
        this.targets.add(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  const resized = (target: unknown) => {
    for (const [callback, targets] of observers)
      if (targets.has(target)) callback();
  };
  const mutations = new Map<() => void, Map<unknown, MutationObserverInit>>();
  vi.stubGlobal(
    "MutationObserver",
    class {
      targets = new Map<unknown, MutationObserverInit>();
      constructor(callback: () => void) {
        mutations.set(callback, this.targets);
      }
      observe(target: unknown, options: MutationObserverInit) {
        this.targets.set(target, options);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  const list = { style: { height: "3706px", pointerEvents: "" } };
  const styleChanged = () => {
    for (const [callback, targets] of mutations) {
      const options = targets.get(list);
      if (options?.attributes && options.attributeFilter?.includes("style"))
        callback();
    }
  };
  const element = {
    clientWidth: 1124,
    clientHeight: 668,
    scrollHeight: 3706,
    scrollTop: 2388,
    focus: vi.fn(),
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => list,
    querySelectorAll: () =>
      mounted.map(({ id, y }) => ({
        dataset: { messageId: id },
        getBoundingClientRect: () => ({ top: y, bottom: y + 100 }),
        querySelector: () => ({
          getBoundingClientRect: () => ({ top: y + 32, bottom: y + 80 }),
        }),
      })),
  };
  const handle = {
    scrollOffset: 3038,
    scrollSize: 3649.5,
    viewportSize: 668,
    cache: [],
    scrollTo: vi.fn(),
    scrollToIndex: vi.fn(),
  };
  blocked ??= freshness === "cached";
  let accepted = false;
  const olderReads = vi.fn();
  const snapshot = (): ChannelWindow => ({
    channelId: "channel",
    status,
    freshness,
    rows,
    hasMore,
    loadingOlder: loadingOlder || accepted,
    historyLimited,
    error,
  });
  const loadOlder = vi.fn(() => {
    if (!blocked && !accepted && !loadingOlder) {
      accepted = true;
      olderReads();
    }
  });
  const queries =
    session ??
    ({
      channels: { loadOlder, window: snapshot },
      profiles: {},
      agentChoices: createAgentLibrary(undefined).queries,
      // Geometry fixtures are read-only; reading behavior has its own boundary tests.
      unread: { sync: () => ({ capability: "unsupported" }) },
      media: () => undefined,
    } as unknown as RelaySession);
  let rows = initialRows ?? [timelineMessage("first"), timelineMessage("last")];
  type Section = ReactElement<{
    ref: { current: unknown };
    children: unknown[];
    onScroll: (event: unknown) => void;
    onWheel: () => void;
    onFocus: (event: unknown) => void;
    onBlur: (event: unknown) => void;
  }>;
  let section: Section;
  let channelId = "channel";
  let revealMessageId: string | undefined;
  let key: string | null = null;
  const flush = () => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  };
  function render(runFrames = true) {
    hooks.ref = hooks.state = hooks.memo = hooks.effect = 0;
    const scoped = ChannelTimeline({
      channelId,
      scope: "scope",
      queries,
      window: session?.channels.window(channelId) ?? {
        channelId,
        status,
        freshness,
        error,
        rows,
        hasMore,
        loadingOlder,
        historyLimited,
      },
      onOpenLink: () => false,
      revealMessageId,
    });
    if (key !== null && key !== scoped.key) {
      for (const effect of hooks.effects) effect.cleanup?.();
      Object.assign(hooks, {
        refs: [],
        states: [],
        memos: [],
        effects: [],
        pending: [],
      });
    }
    key = scoped.key;
    section = (scoped.type as (props: typeof scoped.props) => Section)(
      scoped.props,
    );
    section.props.ref.current = element;
    const virtualizer = section.props.children.find(
      (child) =>
        !!child &&
        typeof child === "object" &&
        "type" in child &&
        child.type === Virtualizer,
    ) as ReactElement<{ ref: { current: unknown } }>;
    if (virtualizer) virtualizer.props.ref.current = handle;
    for (const effect of hooks.pending.splice(0)) effect();
    if (runFrames) flush();
  }
  render(); // Mount/measure through the production layout effect.
  render(); // Apply its setWidth before attaching the virtualizer.
  return {
    element,
    handle,
    focus(id?: string) {
      section.props.onFocus({
        target: { closest: () => (id ? { dataset: { messageId: id } } : null) },
      });
      render();
    },
    blur(inside: boolean) {
      section.props.onBlur({
        currentTarget: { contains: () => inside },
        relatedTarget: null,
      });
      render();
    },
    pinned() {
      const virtualizer = section.props.children.find(
        (child) =>
          !!child &&
          typeof child === "object" &&
          "type" in child &&
          child.type === Virtualizer,
      ) as ReactElement<{ keepMounted: number[] }>;
      return virtualizer.props.keepMounted;
    },
    loadOlder,
    olderReads,
    flush,
    render,
    unblock() {
      blocked = false;
    },
    reveal(id: string) {
      revealMessageId = id;
      render();
    },
    navigate(next: string) {
      channelId = next;
      render();
      render();
    },
    update(patch: Partial<ChannelWindow>) {
      accepted = false;
      if (patch.freshness) freshness = patch.freshness;
      if (patch.freshness === "verified") blocked = false;
      if ("status" in patch && patch.status) status = patch.status;
      if ("error" in patch) error = patch.error;
      if ("loadingOlder" in patch) loadingOlder = !!patch.loadingOlder;
      if ("hasMore" in patch) hasMore = !!patch.hasMore;
      if ("historyLimited" in patch) historyLimited = !!patch.historyLimited;
      render();
    },
    retry() {
      const edge = section.props.children[0] as ReactElement<{
        children: ReactElement[];
      }>;
      const button = edge.props.children.find(
        (child) => child?.type === Button,
      ) as ReactElement<{ onClick(): void }>;
      button.props.onClick();
    },
    resize(runFrames = true) {
      resized(element);
      render(runFrames);
    },
    measureRows(runFrames = true) {
      list.style.height = `${Number.parseFloat(list.style.height) + 100}px`;
      styleChanged();
      if (runFrames) flush();
    },
    scrollStyle() {
      list.style.pointerEvents = list.style.pointerEvents ? "" : "none";
      styleChanged();
      flush();
    },
    gesture() {
      section.props.onWheel();
    },
    dispatchScroll() {
      section.props.onScroll({ currentTarget: element });
    },
    scroll(user = true) {
      resized(element);
      render();
      if (user) section.props.onWheel();
      section.props.onScroll({ currentTarget: element });
    },
    edit(runFrames = true) {
      rows = rows.map((row) =>
        row.id === "last" ? { ...row, content: "Longer edited message" } : row,
      );
      render(runFrames);
    },
    setRows(next: ChannelMessage[], runFrames = true) {
      rows = next;
      render(runFrames);
    },
    prepend() {
      rows = [timelineMessage("older"), ...rows];
      render();
    },
    append() {
      rows = [...rows, timelineMessage("appended")];
      render();
    },
    jumpToLatest() {
      const button = section.props.children.find(
        (child) =>
          !!child &&
          typeof child === "object" &&
          "type" in child &&
          child.type === JumpToLatestButton,
      ) as ReactElement<{ onClick(): void }> | undefined;
      button?.props.onClick();
    },
    hasJumpToLatest() {
      return section.props.children.some(
        (child) =>
          !!child &&
          typeof child === "object" &&
          "type" in child &&
          child.type === JumpToLatestButton,
      );
    },
    unmount() {
      for (const effect of hooks.effects) effect.cleanup?.();
    },
    saved() {
      const raw = data.get('buzz-view.v1:["scope","scroll:channel"]');
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

it("pins only the focused message by identity across prepend and releases on focus exit", () => {
  const h = setup();
  expect(h.pinned()).toEqual([]);
  h.focus("last");
  expect(h.pinned()).toEqual([1]);
  h.prepend();
  expect(h.pinned()).toEqual([2]);
  h.blur(true);
  expect(h.pinned()).toEqual([2]);
  h.focus("first");
  expect(h.pinned()).toEqual([1]);
  h.blur(false);
  expect(h.pinned()).toEqual([]);
  h.focus("last");
  h.focus(); // The history region itself is not a message row.
  expect(h.pinned()).toEqual([]);
  h.focus("last");
  h.setRows([]);
  expect(h.pinned()).toEqual([]);
  h.unmount();
});

it("persists the event target's reading position at real component cleanup, not the previous virtualizer offset", () => {
  const h = setup();
  h.scroll();
  h.unmount();
  expect(h.saved()).toEqual({ offset: 2388, bottom: false });
});
it("a bottom-position event persists bottom intent even when the virtualizer still reports zero", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.handle.scrollOffset = 0;
  h.scroll(false);
  h.unmount();
  expect(h.saved()).toEqual({ offset: 3038, bottom: true });
});
it("an append follows the actual bottom position, not stale virtualizer position", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.handle.scrollOffset = 0;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(2, { align: "end" });
  h.unmount();
});
it("an append does not steal a reading position when virtualizer still reports bottom", () => {
  const h = setup();
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  h.render();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  expect(h.hasJumpToLatest()).toBe(true);
  h.jumpToLatest();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.render();
  expect(h.hasJumpToLatest()).toBe(false);
  h.unmount();
});
it("loads older rows at the current DOM threshold despite a stale far-away virtualizer offset", () => {
  const h = setup({ hasMore: true });
  h.handle.scrollOffset = 3300;
  h.scroll();
  expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("channel");
  h.unmount();
});
it("does not load older rows when only the old virtualizer position is inside the threshold", () => {
  const h = setup({ hasMore: true });
  h.element.scrollHeight = 8000;
  h.element.scrollTop = 3300;
  h.handle.scrollOffset = 2388;
  h.scroll();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});
it.each([
  { hasMore: false },
  { hasMore: true, loadingOlder: true },
  { hasMore: true, historyLimited: true },
  { hasMore: true, error: "Relay requests paused" },
])("keeps the existing paging guard %j", (options) => {
  const h = setup(options);
  h.scroll();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});
it("programmatic scroll does not page before a user gesture", () => {
  const h = setup({ hasMore: true });
  h.scroll(false);
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});

it.each([
  { height: 668, gap: 79, bottom: true },
  { height: 668, gap: 80, bottom: false },
  { height: 1000, gap: 79, bottom: true },
  { height: 1000, gap: 80, bottom: false },
])(
  "uses current geometry for the strict bottom threshold: $height/$gap",
  ({ height, gap, bottom }) => {
    const h = setup();
    h.element.clientHeight = height;
    h.element.scrollTop = h.element.scrollHeight - h.element.clientHeight - gap;
    h.scroll();
    h.unmount();
    expect(h.saved()).toEqual({ offset: h.element.scrollTop, bottom });
  },
);
it.each([
  { height: 668, offset: 2999, calls: 1 },
  { height: 668, offset: 3000, calls: 0 },
  { height: 1000, offset: 3999, calls: 1 },
  { height: 1000, offset: 4000, calls: 0 },
])(
  "uses current viewport for the strict max(3000, 4×height) paging boundary: $height/$offset",
  ({ height, offset, calls }) => {
    const h = setup({ hasMore: true });
    Object.assign(h.element, {
      clientHeight: height,
      scrollHeight: 8000,
      scrollTop: offset,
    });
    h.scroll();
    expect(h.loadOlder).toHaveBeenCalledTimes(calls);
    h.unmount();
  },
);

it("restores a saved message anchor instead of an unreachable cold pixel offset", () => {
  const h = setup({
    initial: { offset: 80851, bottom: false, anchor: { id: "last", y: 42 } },
  });
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(1, {
    align: "start",
    offset: -42,
  });
  expect(h.handle.scrollTo).not.toHaveBeenCalled();
  h.unmount();
});
it("a restoration scroll through unmeasured rows does not become bottom follow", () => {
  const h = setup({
    mounted: [{ id: "last", y: 42 }],
    initial: { offset: 80851, bottom: false, anchor: { id: "last", y: 42 } },
  });
  // Virtua's scroll event lands at the estimated bottom before rows measure.
  h.element.scrollTop = 3038;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.setRows([timelineMessage("first"), timelineMessage("last")]);
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  h.unmount();
  expect(h.saved()).toMatchObject({
    bottom: false,
    anchor: { id: "last" },
  });
});
it.each([
  { offset: 1234, bottom: false },
  { offset: 1234, bottom: false, anchor: { id: "missing", y: 42 } },
])(
  "keeps an offset fallback for legacy positions and an anchor outside retained history: %j",
  (initial) => {
    const h = setup({ initial });
    expect(h.handle.scrollTo).toHaveBeenCalledWith(1234);
    h.unmount();
  },
);
it("captures the mounted message at cleanup and restores that anchor after resize", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 650;
  h.resize();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "start",
    offset: -42,
  });
  h.unmount();
  expect(h.saved()).toEqual({
    offset: 2388,
    bottom: false,
    anchor: { id: "last", y: 42 },
  });
});
it("resize-generated scroll retains the restored message when its paragraph no longer fits", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  // The preferred row remains visible, but no longer wholly fits. A preceding
  // clipped row would otherwise replace it during restoration-generated scroll.
  h.element.clientHeight = 100;
  mounted.unshift({ id: "first", y: -20 });
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 1124;
  h.resize();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "start",
    offset: -42,
  });
  h.unmount();
  expect(h.saved().anchor).toEqual({ id: "last", y: 42 });
});
it("a new gesture can replace the restored anchor", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  mounted.unshift({ id: "first", y: 0 });
  h.scroll();
  h.unmount();
  expect(h.saved().anchor).toEqual({ id: "first", y: 0 });
});
it("local-send navigation releases the restored anchor", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  mounted.unshift({ id: "first", y: 0 });
  h.reveal("first");
  h.scroll(false);
  h.unmount();
  expect(h.saved().anchor).toEqual({ id: "first", y: 0 });
});
it.each([-200, 800])(
  "a restored row outside the viewport (%s) is not preferred",
  (y) => {
    const mounted = [{ id: "last", y: 42 }];
    const h = setup({ mounted });
    h.scroll();
    h.element.clientWidth = 650;
    h.resize();
    mounted.splice(0, 1, { id: "last", y });
    mounted.push({ id: "first", y: 0 });
    h.scroll(false);
    h.unmount();
    expect(h.saved().anchor).toEqual({ id: "first", y: 0 });
  },
);
it("an unmounted restored anchor falls back to a visible message", () => {
  const mounted = [{ id: "last", y: 42 }];
  const h = setup({ mounted });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  mounted.splice(0, 1, { id: "first", y: 0 });
  h.scroll(false);
  h.unmount();
  expect(h.saved().anchor).toEqual({ id: "first", y: 0 });
});
it("a gesture after resize cancels queued restoration instead of fighting the reader", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.element.clientWidth = 650;
  h.resize(false);
  h.gesture();
  h.flush();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("a same-ID content update follows bottom without waiting for another message", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.unmount();
});
it("same-ID content updates leave an above-bottom reader to virtualizer anchoring", () => {
  const h = setup();
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("prepending history does not become a follow-to-bottom command", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.prepend();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("a new gesture wins over content-follow scheduled by an edit", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.handle.scrollToIndex.mockClear();
  h.edit(false);
  h.gesture();
  h.flush();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("a user gesture at a restored top pages without needing a DOM scroll event", () => {
  const h = setup({ hasMore: true, initial: { offset: 0, bottom: false } });
  h.element.scrollTop = 0;
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.gesture();
  expect(h.loadOlder).toHaveBeenCalledExactlyOnceWith("channel");
  h.unmount();
});

it.each([
  { hasMore: false },
  { hasMore: true, loadingOlder: true },
  { hasMore: true, historyLimited: true },
  { hasMore: true, error: "Relay requests paused" },
])("a boundary gesture preserves the history guard %j", (options) => {
  const h = setup(options);
  h.element.scrollTop = 0;
  h.gesture();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.unmount();
});

it("keeps bottom restoration through repeated late list measurements without another viewport resize", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  // The viewport and rows are unchanged; only Virtua's measured list reflows.
  h.measureRows();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledTimes(2);
  expect(h.handle.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  h.unmount();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
});
it("ignores non-height list styles and coalesces measured height changes", () => {
  const h = setup();
  h.handle.scrollToIndex.mockClear();
  h.scrollStyle();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.measureRows(false);
  h.measureRows(false);
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.handle.scrollToIndex.mockClear();
  h.scrollStyle(); // The new height has already been consumed.
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.measureRows(false);
  h.unmount();
  h.flush();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
});
it.each([false, true])(
  "a new gesture cancels late bottom reflow, including queued=%s",
  (queued) => {
    const h = setup();
    h.element.scrollTop = 3038;
    h.scroll();
    h.element.clientWidth = 650;
    h.resize();
    h.handle.scrollToIndex.mockClear();
    if (queued) h.measureRows(false);
    h.gesture();
    if (queued) h.flush();
    else h.measureRows();
    expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
    h.unmount();
  },
);
it("late measurements restore the reading anchor instead of converting it to bottom follow", () => {
  const h = setup({ mounted: [{ id: "last", y: 42 }] });
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "start",
    offset: -42,
  });
  h.handle.scrollToIndex.mockClear();
  h.measureRows(false);
  h.gesture();
  h.flush();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});
it("prepending retires the preceding bottom-reflow observer and its queued frame", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 650;
  h.resize();
  h.handle.scrollToIndex.mockClear();
  h.measureRows(false);
  h.prepend();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
});

it("initial bottom and ordinary appends follow late measured list reflow", () => {
  const h = setup();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
    align: "end",
  });
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
});

it("honors one cached top-edge gesture when the replacement head becomes verified", () => {
  const h = setup({
    hasMore: true,
    freshness: "cached",
    initial: { offset: 0, bottom: false },
  });
  h.element.scrollTop = 0;
  h.gesture();
  h.gesture();
  h.update({ freshness: "cached" }); // A handoff is not successful revalidation.
  expect(h.olderReads).not.toHaveBeenCalled();
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.update({ freshness: "cached" });
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("verification alone never pages a restored top", () => {
  const h = setup({
    hasMore: true,
    freshness: "cached",
    initial: { offset: 0, bottom: false },
  });
  h.element.scrollTop = 0;
  h.scroll(false);
  h.update({ freshness: "verified" });
  expect(h.olderReads).not.toHaveBeenCalled();
  h.unmount();
});
it.each([
  { error: "Head revalidation failed" },
  { error: "Access denied", status: "error" as const },
  { loadingOlder: true },
  { hasMore: false },
  { historyLimited: true },
])("retires cached paging demand on %j, including later recovery", (patch) => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.update(patch);
  h.update({
    freshness: "verified",
    status: "ready",
    error: undefined,
    loadingOlder: false,
    hasMore: true,
    historyLimited: false,
  });
  expect(h.olderReads).not.toHaveBeenCalled();
  h.unmount();
});
it("rechecks current geometry before honoring the cached gesture", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.element.scrollTop = 4000;
  h.update({ freshness: "verified" });
  h.element.scrollTop = 0;
  h.update({ freshness: "verified" });
  expect(h.olderReads).not.toHaveBeenCalled();
  h.unmount();
});
it("gestures during an older read do not queue a following page", () => {
  const h = setup({ hasMore: true });
  h.element.scrollTop = 0;
  h.gesture();
  h.update({ loadingOlder: true });
  h.gesture();
  h.gesture();
  h.update({ loadingOlder: false });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("a manual retry with more history does not revive automatic paging", () => {
  const h = setup({ hasMore: true });
  h.element.scrollTop = 0;
  h.gesture();
  h.update({ loadingOlder: true });
  h.update({ loadingOlder: false, error: "rate-limited", freshness: "cached" });
  h.gesture();
  h.retry();
  h.update({ loadingOlder: true, error: undefined });
  h.gesture();
  h.update({ loadingOlder: false, freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(2);
  h.unmount();
});
it("a blocked button preserves cached gesture until verification accepts one older read", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.retry();
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("unmount drops cached intent before a late successful head", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.unmount();
  h.update({ freshness: "verified" }); // Probe retired refs as well as keyed remount.
  expect(h.olderReads).not.toHaveBeenCalled();
});

it("a switch away and back cannot inherit the first mount's cached gesture", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.navigate("other");
  h.navigate("channel");
  h.update({ freshness: "verified" });
  expect(h.olderReads).not.toHaveBeenCalled();
  h.gesture();
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});

it("cached rows without a head owner page immediately over the normal read path", () => {
  const h = setup({ hasMore: true, freshness: "cached", blocked: false });
  h.element.scrollTop = 0;
  h.gesture();
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});

it.each(["held head", "live handoff", "disconnected"])(
  "real store accepts one older page after cached input: %s",
  async (mode) => {
    const relay = keypair(),
      viewer = keypair();
    const event = message(viewer, "channel", "cached", 20);
    const head = [
      event,
      bounds(relay, "channel", "head", {
        has_more: true,
        next_cursor: { created_at: 20, id: event.id },
      }),
    ];
    const scripted = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...scripted.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      {
        prepared: true,
        persistence: {
          read: async () => [
            {
              channelId: "channel",
              savedAt: Date.now(),
              events: head,
              profiles: [],
            },
          ],
          write: async () => {},
          retain: async () => {},
          remove: async () => {},
          clear: async () => {},
          close: () => {},
        },
      },
    );
    const channels = owner.session.channels;
    channels.ensureList();
    scripted
      .next()
      .respond([
        roster(relay, "channel", [viewer.pubkey]),
        metadata(relay, "channel", "Channel"),
      ]);
    await flush();
    channels.ensure("channel");
    await vi.waitFor(() =>
      expect(channels.window("channel").freshness).toBe("cached"),
    );
    const held = scripted.next();
    if (mode === "disconnected") {
      held.respond(head);
      await vi.waitFor(() =>
        expect(channels.window("channel").freshness).toBe("verified"),
      );
      live.state({ status: "connected", routes: [] });
      live.state({ status: "retrying", routes: [] });
      expect(channels.window("channel").freshness).toBe("cached");
    }
    const h = setup({
      session: owner.session,
      initial: { offset: 0, bottom: false },
    });
    h.element.scrollTop = 0;
    try {
      h.gesture();
      h.retry();
      if (mode !== "disconnected") {
        expect(channels.window("channel").loadingOlder).toBe(false);
        expect(scripted.pending).toHaveLength(0);
        let completing = held;
        if (mode === "live handoff") {
          live.established("channel");
          await vi.waitFor(() => expect(held.signal?.aborted).toBe(true));
          completing = scripted.next();
        }
        completing.respond(head);
        await vi.waitFor(() =>
          expect(channels.window("channel").freshness).toBe("verified"),
        );
      }
      h.render();
      expect(channels.window("channel").loadingOlder).toBe(true);
      const older = () =>
        scripted.pending.filter((read) => read.filters[0]?.until !== undefined);
      await vi.waitFor(() => expect(older()).toHaveLength(1));
      expect(older()[0]?.filters[0]).toMatchObject({
        until: 20,
        before_id: event.id,
      });
      h.render();
      expect(older()).toHaveLength(1);
    } finally {
      h.unmount();
      owner.dispose();
    }
  },
);

it("cached rerenders do not reissue a blocked attempt", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  expect(h.loadOlder).toHaveBeenCalledTimes(1);
  h.update({ freshness: "cached" });
  h.update({ freshness: "cached" });
  expect(h.loadOlder).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("an accepted button read retires earlier blocked gesture before verification", () => {
  const h = setup({ hasMore: true, freshness: "cached" });
  h.element.scrollTop = 0;
  h.gesture();
  h.unblock();
  h.retry();
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.update({ freshness: "verified" });
  expect(h.olderReads).toHaveBeenCalledTimes(1);
  h.unmount();
});

it("wires the shared reading hook to its owned scroller and settled position", () => {
  vi.mocked(useReading).mockClear();
  setup();
  expect(useReading).toHaveBeenCalledWith({
    session: expect.any(Object),
    channelId: "channel",
    scroller: expect.objectContaining({ current: expect.anything() }),
    settled: expect.objectContaining({ current: expect.any(Boolean) }),
  });
});

const membershipRow = (id: string, time: number): ChannelMessage => ({
  id,
  channelId: "channel",
  authorId: "relay",
  createdAt: time,
  content: "",
  membership: { type: "member_joined", actor: "viewer", target: id },
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
});
it("restores an anchor inside a membership group after history joins across a page seam", () => {
  const h = setup({
    initialRows: [
      membershipRow("older", 1),
      membershipRow("anchor", 2),
      membershipRow("newer", 3),
    ],
    initial: { offset: 80851, bottom: false, anchor: { id: "anchor", y: 42 } },
  });
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
  expect(h.handle.scrollTo).not.toHaveBeenCalled();
  h.handle.scrollToIndex.mockClear();
  h.setRows([
    membershipRow("oldest", 0),
    membershipRow("older", 1),
    membershipRow("anchor", 2),
    membershipRow("newer", 3),
  ]);
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "start",
    offset: -42,
  });
  h.unmount();
});
it("live group growth follows the displayed group index rather than a hidden raw row", () => {
  const first = membershipRow("first", 1),
    second = membershipRow("second", 2);
  const h = setup({ initialRows: [first, second] });
  h.element.scrollTop = 3038;
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.setRows([first, second, membershipRow("third", 3)]);
  expect(h.handle.scrollToIndex).toHaveBeenCalledWith(0, { align: "end" });
  h.unmount();
});

it("membership append retains bottom intent across intermediate scroll geometry and another append", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.setRows([first, membershipRow("second", 2)]);
  // List measurements change after the end-scroll. No reader gesture occurred.
  h.element.scrollHeight += 200;
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "end",
  });
  h.handle.scrollToIndex.mockClear();
  h.setRows([first, membershipRow("second", 2), membershipRow("third", 3)]);
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "a reader gesture cancels membership late-follow, queued=%s",
  (queued) => {
    const first = membershipRow("first", 1);
    const h = setup({ initialRows: [first] });
    h.element.scrollTop = 3038;
    h.scroll();
    h.setRows([first, membershipRow("second", 2)]);
    h.handle.scrollToIndex.mockClear();
    if (queued) h.measureRows(false);
    h.gesture();
    h.element.scrollTop = 2000;
    h.scroll();
    h.measureRows();
    h.setRows([first, membershipRow("second", 2), membershipRow("third", 3)]);
    expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
    h.unmount();
    expect(h.saved().bottom).toBe(false);
  },
);

it.each([false, true])(
  "a restored membership anchor survives delayed group growth until a gesture=%s",
  (gesture) => {
    const { membership: _membership, ...preceding } = membershipRow(
      "preceding",
      0,
    );
    const later = { ...preceding, id: "later", createdAt: 4 };
    const rows = [
      preceding,
      membershipRow("anchor", 1),
      membershipRow("representative", 2),
      later,
    ];
    const mounted = [
      { id: "preceding", y: -20 },
      { id: "representative", y: 42 },
    ];
    const h = setup({
      initialRows: rows,
      mounted,
      initial: {
        offset: 80851,
        bottom: false,
        anchor: { id: "anchor", y: 42 },
      },
    });
    expect(h.handle.scrollToIndex).toHaveBeenCalledWith(1, {
      align: "start",
      offset: -42,
    });
    h.scroll(false);
    // A delayed activity row lands inside history, not at the loaded tail.
    // It replaces B's rendered identity with C while retaining A/B as members.
    h.setRows([...rows.slice(0, -1), membershipRow("grown", 3), later]);
    mounted[1] = { id: "grown", y: 42 };
    h.dispatchScroll(); // Reflow, with no reader gesture.
    h.handle.scrollToIndex.mockClear();
    h.element.clientWidth = 650;
    h.resize();
    expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
      align: "start",
      offset: -42,
    });
    h.scroll(gesture);
    h.handle.scrollToIndex.mockClear();
    h.element.clientWidth = 1124;
    h.resize();
    expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(
      gesture ? 0 : 1,
      {
        align: "start",
        offset: gesture ? 20 : -42,
      },
    );
    h.unmount();
    expect(h.saved().anchor).toEqual(
      gesture ? { id: "preceding", y: -20 } : { id: "grown", y: 42 },
    );
  },
);

it("a gesture cannot re-arm bottom follow through an intervening membership append", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.handle.scrollToIndex.mockClear();
  h.setRows([first, membershipRow("second", 2)], false);
  h.element.scrollTop = 2000;
  h.scroll(false);
  h.measureRows();
  h.setRows([first, membershipRow("second", 2), membershipRow("third", 3)]);
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("an append before gesture geometry arrives cannot make later reader scroll sticky", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.setRows([first, membershipRow("second", 2)]);
  h.element.scrollTop = 2000;
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  h.setRows([first, membershipRow("second", 2), membershipRow("third", 3)]);
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("a gesture with no movement does not disable the next append's bottom follow", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.handle.scrollToIndex.mockClear();
  h.append();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.scroll(false);
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("a reader scroll handler before the append frame cancels its bottom command", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.handle.scrollToIndex.mockClear();
  h.setRows([first, membershipRow("second", 2)], false);
  h.element.scrollTop = 2000;
  h.dispatchScroll();
  h.flush();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("a no-scroll click followed by a tall append follows without mistaking growth for movement", () => {
  const first = membershipRow("first", 1);
  const h = setup({ initialRows: [first] });
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.setRows([first, membershipRow("second", 2)], false);
  h.element.scrollHeight += 200;
  h.handle.scrollToIndex.mockClear();
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "end",
  });
  h.element.scrollTop += 200;
  h.dispatchScroll();
  h.element.scrollHeight += 200;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("multiple scroll events from one gesture can leave the near-bottom threshold", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.gesture();
  h.element.scrollTop -= 40;
  h.dispatchScroll();
  h.element.scrollTop -= 260;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.append();
  h.measureRows();
  expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(false);
});

it("cancelled resize settles before later reader scroll/save", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.element.clientWidth = 650;
  h.gesture();
  h.resize(false);
  h.element.scrollTop = 2000;
  h.flush();
  h.element.scrollTop = 1900;
  h.dispatchScroll();
  h.unmount();
  expect(h.saved()).toEqual({ offset: 1900, bottom: false });
});

it("list shrinkage clamps the offset without revoking bottom follow", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.element.scrollHeight -= 200;
  h.element.scrollTop -= 200;
  h.dispatchScroll();
  h.element.scrollHeight += 200;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("input saves pending DOM movement even if navigation precedes its scroll event", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  // A later input/navigation can arrive after movement but before onScroll.
  h.element.scrollTop = 2000;
  h.gesture();
  h.unmount();
  expect(h.saved()).toEqual({ offset: 2000, bottom: false });
});

it("growth before a no-scroll click does not revoke the existing bottom intent", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.element.scrollHeight += 200;
  h.gesture();
  h.handle.scrollToIndex.mockClear();
  h.edit();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalled();
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("estimated list shrinkage can leave an intermediate gap without becoming reader movement", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  // Virtua first overestimates the new rows, then contracts its list before
  // the final end-scroll catches up. Both height and offset drop together.
  h.element.scrollHeight += 400;
  h.dispatchScroll();
  h.element.scrollHeight -= 200;
  h.element.scrollTop -= 200;
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.measureRows();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it("records a measured shrink before an append hides its queued native scroll clamp", () => {
  const h = setup();
  h.element.scrollTop = 3038;
  h.scroll();
  h.append();
  h.element.scrollHeight -= 200;
  h.element.scrollTop -= 200;
  h.measureRows(false); // Mutation delivery precedes the queued native scroll.
  h.element.scrollHeight += 300; // A new event arrives before that scroll.
  h.dispatchScroll();
  h.handle.scrollToIndex.mockClear();
  h.flush();
  expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(2, {
    align: "end",
  });
  h.unmount();
  expect(h.saved().bottom).toBe(true);
});

it.each([false, true])(
  "a row refresh before the first measured height preserves cold restoration unless the reader intervenes=%s",
  (gesture) => {
    const mountedRow = { id: "last", y: 42 };
    const mounted = [mountedRow];
    const h = setup({
      initial: { offset: 80851, bottom: false, anchor: { id: "last", y: 42 } },
      mounted,
    });
    mountedRow.y = 142; // Native cold layout can report the right ID at the wrong Y.
    h.dispatchScroll();
    if (gesture) h.gesture();
    h.handle.scrollToIndex.mockClear();
    h.edit(); // Refresh cancels the original observer before any height delivery.
    h.handle.scrollToIndex.mockClear();
    h.measureRows();
    if (gesture) expect(h.handle.scrollToIndex).not.toHaveBeenCalled();
    else
      expect(h.handle.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
        align: "start",
        offset: -42,
      });
    h.unmount();
  },
);
