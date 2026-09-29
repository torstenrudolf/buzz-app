// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import userEvent from "@testing-library/user-event";
import { bindNames } from "./service";
import { createAgentDirectory } from "./testing";
import type { RelaySession } from "../relay/session";
import type { PresenceStatus } from "../presence/presence";
import { BuzzLinkPreview } from "../conversation/BuzzLinkPreview";
import { SearchResults } from "../../app/shell/SearchResults";
import { useChannelLabels } from "../../bundled/channels/useChannelLabels";
import { AgentChoice } from "../sessions/AgentChoice";
import { ActivityAccessory } from "../../bundled/agent-activity/ActivityAccessory";

const a = "a".repeat(64),
  b = "b".repeat(64);
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
});
function fixture() {
  const listeners = new Set<() => void>();
  let presenceStatus: PresenceStatus = "unknown";
  const profiles = new Map([
    [a, { name: "Larry", isAgent: true as const }],
    [b, { name: "Larry", isAgent: true as const }],
  ]);
  let channel = {
    id: "c",
    name: "DM",
    channelType: "dm" as const,
    members: [a],
    participants: [a],
  };
  let list = { status: "ready" as const, channels: [channel] };
  const library = {
    status: "ready",
    identities: [{ pubkey: a, name: "Larry" }],
    definitions: [],
  };
  const message = {
    id: "m",
    channelId: "c",
    authorId: a,
    content: "hello",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const thread = {
    status: "ready",
    root: message,
    replies: [],
    canLoadMore: false,
  };
  const activity = {
    status: "ready",
    records: [],
    turns: [],
    typing: [{ channelId: "c", agent: a }],
    trimmed: 0,
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const session = {
    presence: {
      status: () => presenceStatus,
      limited: () => false,
      subscribe: (_pubkey: string, listener: () => void) => subscribe(listener),
    },
    profiles: { snapshot: () => profiles, subscribe, ensure: async () => {} },
    channels: {
      list: () => list,
      subscribeList: subscribe,
      ensureList() {},
      get: () => channel,
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe,
      retain: () => () => {},
      refresh: async () => {},
    },
    agentChoices: {
      snapshot: () => library,
      subscribe,
      retain: () => () => {},
      ensure() {},
      refresh: async () => {},
    },
    agentActivity: { snapshot: () => activity, subscribe },
    thread: () => ({
      snapshot: () => thread,
      subscribe,
      refresh: async () => {},
      dispose() {},
    }),
    media: () => undefined,
    read: async () => [
      {
        id: "m",
        kind: 9,
        pubkey: a,
        created_at: 1,
        content: "hello",
        tags: [["h", "c"]],
      },
    ],
  } as unknown as RelaySession;
  const names = bindNames(session, {
    snapshot: () => [createAgentDirectory()],
    subscribe: () => () => {},
  });
  stops.push(() => names.dispose());
  return {
    session: { ...session, names },
    setPresence(status: PresenceStatus) {
      presenceStatus = status;
      for (const listener of listeners) listener();
    },
    join() {
      channel = { ...channel, members: [a, b], participants: [a, b] };
      list = { ...list, channels: [channel] };
      for (const listener of listeners) listener();
    },
  };
}
it("uses channel scope in link previews and activity, and participant scope in sidebar DMs", async () => {
  const f = fixture();
  function Sidebar() {
    const labels = useChannelLabels(
      f.session.channels.list().channels,
      f.session.profiles,
      f.session.names,
    );
    return <output aria-label="DM label">{labels.channels[0]?.name}</output>;
  }
  const view = render(
    <>
      <Sidebar />
      <BuzzLinkPreview session={f.session} channelId="c" messageId="m" />
      <ActivityAccessory
        session={f.session}
        scope="test"
        channelId="c"
        canOpen={() => true}
        open={() => true}
      />
    </>,
  );
  expect(view.container.querySelector("strong")).toHaveTextContent("Larry");
  expect(screen.getByLabelText("DM label")).toHaveTextContent(/^Larry$/);
  expect(
    screen.getByRole("button", {
      name: `View activity for Larry ${a.slice(0, 12)}`,
    }),
  ).toBeVisible();
  act(() => f.setPresence("away"));
  expect(
    screen.getByRole("button", {
      name: `View activity for Larry ${a.slice(0, 12)}, Presence: away`,
    }),
  ).toBeVisible();
  act(() => f.join());
  expect(view.container.querySelector("strong")).toHaveTextContent(
    "Larry · rcaj",
  );
  expect(screen.getByLabelText("DM label")).toHaveTextContent(
    "Larry · rcaj, Larry · 04hu",
  );
  expect(
    screen.getByRole("button", {
      name: `View activity for Larry · rcaj ${a.slice(0, 12)}, Presence: away`,
    }),
  ).toBeVisible();
});
it("scopes search DM labels and message authors to their own conversation", async () => {
  const f = fixture();
  render(
    <SearchResults
      session={f.session}
      query="hello"
      onQueryChange={() => {}}
      input={createRef()}
      pages={[]}
      openConversation={() => {}}
    />,
  );
  expect(
    await screen.findByRole("option", { name: /hello.*Larry · Larry/ }),
  ).toBeVisible();
  act(() => f.join());
  expect(
    screen.getByRole("option", {
      name: /hello.*Larry · rcaj, Larry · 04hu · Larry · rcaj/,
    }),
  ).toBeVisible();
});
it("keeps a unique selectable agent plain despite a cached namesake", async () => {
  const f = fixture();
  const change = vi.fn();
  render(<AgentChoice session={f.session} value={a} onChange={change} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Change agent: Larry" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Larry" }));
  expect(change).toHaveBeenCalledWith(a, expect.anything());
});
