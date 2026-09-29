// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { ReadError } from "../../features/relay/errors";
import {
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import { SearchResults } from "./SearchResults";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("opens with a conversation action and recent channels in activity order", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "older", "older", 1700000000),
    roster(relay, "older", [viewer.pubkey]),
    metadata(relay, "latest", "latest", 1700000100),
    roster(relay, "latest", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="older"
        onScopeChange={changeScope}
        openConversation={() => {}}
      />,
    );
    const action = await screen.findByRole("option", {
      name: /Search in older/,
    });
    const recent = within(
      screen.getByRole("group", { name: "Recent activity" }),
    );
    const [first, second] = recent.getAllByRole("option");
    expect(first).toHaveTextContent("latest");
    expect(second).toHaveTextContent("older");
    fireEvent.click(action);
    expect(changeScope).toHaveBeenCalledExactlyOnceWith("older");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows the real read failure, retains conversation choices, and retries to an exact message", async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "wes-crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wes-cr"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9], // The real reader canonicalizes set order.
        search: "wes-cr",
        search_mode: "prefix",
        limit: 20,
      },
    ]);
    await act(async () =>
      request.fail(new ReadError("unavailable", "Relay read timed out")),
    );
    expect(
      screen.getByText(/Message search couldn’t finish: Relay read timed out/),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /wes-crew/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
    expect(screen.queryByText(/Message search couldn’t finish/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    const hit = message(viewer, "crew", "wes-crew exact message", 1700000001);
    await act(async () => wire.next().respond([hit]));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(
      screen.getByRole("option", { name: /wes-crew exact message/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("scopes conversation search at the relay and discards out-of-scope hits", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    metadata(relay, "other", "other"),
    roster(relay, "other", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="scope"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        scopedChannelId="crew"
        onScopeChange={changeScope}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(180));
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        search: "scope",
        search_mode: "prefix",
        limit: 20,
        "#h": ["crew"],
      },
    ]);
    await act(async () =>
      request.respond([
        message(viewer, "crew", "scope match", 1700000001),
        message(viewer, "other", "scope elsewhere", 1700000002),
      ]),
    );
    expect(screen.getByRole("option", { name: /scope match/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /scope elsewhere/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Remove .* search scope/ }),
    );
    expect(changeScope).toHaveBeenCalledExactlyOnceWith();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["metadata", "denial"])(
  "does not resurrect displayed public hits after %s loss and regrant",
  async (loss) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const hit = message(viewer, "open", "crew public result", 1700000000);
    let live: LiveCallbacks | undefined;
    const metadata = (privateChannel: boolean, created_at: number) =>
      signed(relay, {
        kind: 39000,
        created_at,
        content: "",
        tags: [
          ["d", "open"],
          ["name", "Public"],
          [privateChannel ? "private" : "public"],
        ],
      });
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        return filters.some((filter) => filter.search)
          ? [hit]
          : filters.some((filter) => filter.kinds?.includes(39000))
            ? [metadata(false, 1700000000)]
            : [];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query="crew"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
      });
      expect(
        screen.getByRole("option", { name: /crew public result/ }),
      ).toBeVisible();
      const before = owner.session.channels.list();
      act(() => {
        if (loss === "denial")
          live?.denied("open", "restricted: not a channel member");
        else live?.receive([metadata(true, 1700000001)]);
        const denied = owner.session.channels.list();
        expect(denied).not.toBe(before);
        expect(denied.channels).toBe(before.channels);
        live?.receive([metadata(false, 1700000002)]);
      });
      expect(
        screen.queryByRole("option", { name: /crew public result/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not reveal a revoked public hit queued before React commits its result", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const hit = message(viewer, "open", "crew queued result", 1700000000);
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const publicEvent = (created_at: number) =>
    signed(relay, {
      kind: 39000,
      created_at,
      content: "",
      tags: [["d", "open"], ["public"]],
    });
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        filters.some((filter) => filter.kinds?.includes(39000))
          ? [publicEvent(1700000000)]
          : [],
      );
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    await act(async () => {
      wire.next().respond([hit]);
      // Drain the finite reader and palette's promise callback, without a React commit.
      await vi.advanceTimersByTimeAsync(0);
      live?.denied("open", "restricted: not a channel member");
      live?.receive([publicEvent(1700000001)]);
    });
    expect(
      screen.queryByRole("option", { name: /crew queued result/ }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["", "Crew"])(
  "explains cold conversation loading without redundant banners (query=%s)",
  async (query) => {
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      metadata(relay, "crew", "Crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      query(filters, signal) {
        return filters.some((filter) => filter.kinds?.includes(39002))
          ? wire.transport.query(filters, signal)
          : Promise.resolve(discovery);
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[
            {
              key: "settings",
              label: "Settings",
              icon: ChatCircleIcon,
              run() {},
            },
          ]}
          openConversation={() => {}}
        />,
      );
      const pending = wire.next();
      expect(owner.session.channels.list().status).toBe("loading");
      expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
      if (query) {
        expect(screen.getByText("Loading joined conversations…")).toBeVisible();
        expect(screen.queryByText("Loading recent conversations…")).toBeNull();
      } else {
        expect(screen.getByText("Loading recent conversations…")).toBeVisible();
        expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      }
      await act(async () => pending.respond(discovery));
      expect(await screen.findByRole("option", { name: /Crew/ })).toBeVisible();
      expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not announce conversation enrichment over retained search choices", () => {
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      list: () => list,
      ensureList() {},
    },
  };
  const list = {
    status: "loading" as const,
    channels: [{ id: "crew", name: "Crew", channelType: "stream" as const }],
  };
  try {
    render(
      <SearchResults
        session={session}
        query="Crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(screen.getByRole("option", { name: /Crew/ })).toBeVisible();
    expect(screen.queryByText("Loading joined conversations…")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});
