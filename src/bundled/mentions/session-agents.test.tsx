// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { RelaySession } from "../../features/relay/session";
import { MentionPicker } from "./MentionPicker";
import { MentionCompletion } from "./MentionCompletion";
import { ComposerCompletions } from "../../features/conversation/ComposerCompletions";
import type {
  ComposerCompletion,
  ComposerObservation,
} from "../../features/conversation/contracts";
import type { CompletionEditor } from "../../features/conversation/useCompletionEditor";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import type { Contribution } from "../../plugins/contributions";
import { mentionQuery } from "./mention-query";
import { createAgentChoices } from "../../features/agents/choices";
import { createAgentLibrary } from "../../features/agents/library";
import type { CompletionResult } from "../../features/conversation/contracts";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import type {
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import {
  followupDraft,
  type MentionRecipient,
} from "../../features/messages/mention-draft";
import { createMessages } from "../../features/relay/messages";
import type { Outbox } from "../../features/relay/outbox";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { profileTarget } from "../../features/profiles/target";
import { npubEncode } from "nostr-tools/nip19";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup(parent: boolean | null = true, archived = false) {
  const key = "b".repeat(64),
    member = "a".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey: key, name: "Outside agent" }],
  }));
  const list = {
    status: "ready",
    channels:
      parent === null
        ? []
        : [
            {
              id: "parent",
              channelType: parent ? "stream" : "session",
              members: [member],
              archived,
            },
          ],
  };
  const profiles = new Map([[member, { name: "Member" }]]);
  const listeners = new Set<() => void>();
  let archiveSnapshot: ReturnType<RelaySession["archives"]["snapshot"]> = {
    status: "ready",
    archived: [],
  };
  const setArchived = (archived: string[]) => {
    archiveSnapshot = { status: "ready", archived };
    for (const listener of listeners) listener();
  };
  const session = {
    directMessages: {
      people: vi.fn(async () => ({ people: [], hasMore: false })),
    },
    archives: {
      snapshot: () => archiveSnapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: async () => {},
      refresh: async () => {},
      state: (pubkey: string) =>
        archiveSnapshot.status !== "ready"
          ? ("unknown" as const)
          : archiveSnapshot.archived.includes(pubkey)
            ? ("archived" as const)
            : ("not-archived" as const),
    },
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => {},
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    names: {
      subscribe: () => () => {},
      snapshot: () => 0,
      resolve: (_key: string, fallback: string) => fallback,
      scope: () => () => undefined,
    },
    agentLibrary: library.queries,
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
    media: () => undefined,
  } as unknown as RelaySession;
  return { session, library, key, member, profiles, setArchived };
}
it("uses the same alphabetical and prefix ordering for typed and button mentions", async () => {
  const test = setup();
  const keys = ["c", "d", "e"].map((key) => key.repeat(64));
  const names = ["Zoe", "Adam Avery", "Avery"];
  const profiles = new Map(
    keys.map((key, index) => [key, { name: names[index] ?? key }]),
  );
  const list: ReturnType<RelaySession["channels"]["list"]> = {
    status: "ready",
    channels: [
      { id: "parent", name: "Parent", channelType: "stream", members: keys },
    ],
  };
  const session = {
    ...test.session,
    channels: { ...test.session.channels, list: () => list },
    profiles: { ...test.session.profiles, snapshot: () => profiles },
  } satisfies RelaySession;
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    query: { start: 0, end: 1, query: "" },
    publish,
  };
  const view = render(<MentionCompletion {...props} />);
  const completionNames = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.label,
    );
  await waitFor(() =>
    expect(completionNames()).toEqual(["Adam Avery", "Avery", "Zoe"]),
  );
  view.rerender(
    <MentionCompletion
      {...props}
      query={{ start: 0, end: 6, query: "avery" }}
    />,
  );
  await waitFor(() =>
    expect(completionNames()).toEqual(["Avery", "Adam Avery"]),
  );
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const pickerNames = () =>
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => keys.some((key) => label?.endsWith(key)))
      .map((label) => label?.slice(0, -65));
  expect(pickerNames()).toEqual(["Adam Avery", "Avery", "Zoe"]);
  await user.type(screen.getByRole("searchbox"), "avery");
  expect(pickerNames()).toEqual(["Avery", "Adam Avery"]);
  test.library.dispose();
});
it("offers outside agents in the session mention picker while ordinary channel pickers keep their roster", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    screen.queryByRole("button", { name: `Outside agent ${test.key}` }),
  ).not.toBeInTheDocument();
  view.rerender(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: `Outside agent ${test.key}` }),
  );
  expect(select).toHaveBeenCalledWith({
    pubkey: test.key,
    name: "Outside agent",
  });
  view.unmount();
  test.library.dispose();
});
it("focuses search on open and supports clear, Escape, and outside dismissal", async () => {
  const test = setup(),
    user = userEvent.setup();
  const view = render(
    <>
      <button type="button">Outside picker</button>
      <MentionPicker
        scope="scope"
        session={test.session}
        channelId="parent"
        disabled={false}
        select={() => true}
      />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Mention a member" });
  await user.click(trigger);
  const search = screen.getByRole("searchbox", {
    name: "Search community people and agents",
  });
  await waitFor(() => expect(search).toHaveFocus());
  await user.type(search, "no matching name");
  expect(screen.getByText("No matching channel members.")).toBeVisible();
  await user.click(
    screen.getByRole("button", {
      name: "Clear search community people and agents",
    }),
  );
  expect(search).toHaveFocus();
  expect(search).toHaveValue("");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
  const outside = screen.getByRole("button", { name: "Outside picker" });
  await user.click(outside);
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(outside).toHaveFocus();
  view.unmount();
  test.library.dispose();
});
it("navigates namesakes with arrows and selects the focused exact identity with Enter", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  test.profiles.set(test.member, { name: "Outside agent" });
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const first = await screen.findByRole("button", {
    name: `Outside agent ${test.member}`,
  });
  const last = await screen.findByRole("button", {
    name: `Outside agent ${test.key}`,
  });
  await user.keyboard("{ArrowDown}");
  expect(first).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(last).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(first).toHaveFocus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith({
    pubkey: test.key,
    name: "Outside agent",
  });
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  test.library.dispose();
});

it("selects filtered results from search, ignores IME Enter, and keeps rejected selections open", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => false);
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const search = screen.getByRole("searchbox");
  expect(
    screen.queryByText("Your agents are added to this channel when you send."),
  ).not.toBeInTheDocument();
  await user.type(search, "missing");
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(search).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  await user.clear(search);
  // Public keys are not completion matches; search by the member's name.
  await user.type(search, "Member");
  fireEvent.keyDown(search, { key: "Enter", isComposing: true });
  expect(fireEvent.keyDown(search, { key: "Enter", shiftKey: true })).toBe(
    false,
  );
  expect(select).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith({
    pubkey: test.member,
    name: "Member",
  });
  expect(search).toHaveFocus();
  select.mockReturnValue(true);
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  test.library.dispose();
});

it("does not keyboard-select disabled members", async () => {
  const test = setup(true, true),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  render(
    <MentionPicker
      scope="scope"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(screen.getByRole("searchbox")).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  test.library.dispose();
});
it.each([true, false])(
  "session picker discloses history access before selection: parent=%s",
  async (parent) => {
    const test = setup(parent);
    const list: ReturnType<RelaySession["channels"]["list"]> = {
      status: "ready",
      channels: [
        {
          id: "parent",
          name: "Session",
          channelType: "session",
          members: ["a".repeat(64)],
          ...(parent ? { parentChannelId: "parent-channel" } : {}),
        },
      ],
    };
    const session = {
      ...test.session,
      channels: { ...test.session.channels, list: () => list },
    };
    const user = userEvent.setup();
    const select = vi.fn(() => true);
    const view = render(
      <MentionPicker
        scope="test"
        session={session}
        channelId="parent"
        disabled={false}
        inviteAgents
        select={select}
      />,
    );
    try {
      await user.click(
        screen.getByRole("button", { name: "Mention a member" }),
      );
      const agent = await screen.findByRole("button", {
        name: `Outside agent ${test.key}`,
      });
      expect(
        screen.getByText(
          parent
            ? "Agents you mention join this session and its parent channel when you send, with access to their history."
            : "Agents you mention join this session when you send, with access to its history.",
        ),
      ).toBeVisible();
      expect(select).not.toHaveBeenCalled();
      await user.click(agent);
      expect(select).toHaveBeenCalledWith({
        pubkey: test.key,
        name: "Outside agent",
      });
    } finally {
      view.unmount();
      test.library.dispose();
    }
  },
);

it.each([true, false, null])(
  "typed @ completion offers outside agents with correct admission: parent=%s",
  async (parent) => {
    const test = setup(parent);
    let result: CompletionResult | undefined;
    const publish = vi.fn((next: CompletionResult) => {
      result = next;
      return () => {};
    });
    const props = {
      session: test.session,
      scope: "test",
      channelId: "parent",
      observation: { revision: 1, text: "@Outside", start: 8, end: 8 },
      query: { start: 0, end: 8, query: "Outside" },
      publish,
    };
    const view = render(<MentionCompletion {...props} inviteAgents />);
    await waitFor(() =>
      expect(result?.items).toEqual([
        expect.objectContaining({
          id: test.key,
          detail: expect.stringContaining(
            parent ? "Adds to session and parent channel" : "Adds to session ·",
          ),
          edit: { mention: { pubkey: test.key, name: "Outside agent" } },
        }),
      ]),
    );
    if (parent === null) {
      expect(result?.status).toBeUndefined();
      expect(result?.retry).toBeUndefined();
    }
    view.rerender(<MentionCompletion {...props} />);
    await waitFor(() => expect(result?.items).toHaveLength(0));
    view.unmount();
    test.library.dispose();
  },
);

it.each([
  "Member prose",
  "Member](nostr:npub1d6t84ajeg9skp2609l2k6axgcme8x7g7u7luj352r03hcwreg7lqnxcsex) whats your name",
])(
  "hides recovery UI for completed mention query %s while keeping valid-query recovery",
  async (staleQuery) => {
    const test = setup();
    const choices = {
      ...test.session.agentChoices.snapshot(),
      status: "error" as const,
      error: "Agent directory unavailable",
      pending: false,
    };
    const session = {
      ...test.session,
      agentChoices: {
        ...test.session.agentChoices,
        snapshot: () => choices,
      },
    };
    let result: CompletionResult | undefined;
    const props = {
      session,
      scope: "test",
      channelId: "parent",
      observation: {
        revision: 1,
        text: `@${staleQuery}`,
        start: staleQuery.length + 1,
        end: staleQuery.length + 1,
      },
      query: { start: 0, end: staleQuery.length + 1, query: staleQuery },
      publish: (next: CompletionResult) => {
        result = next;
        return () => {};
      },
    };
    const view = render(<MentionCompletion {...props} />);
    try {
      // Community lookup now owns an asynchronous loading state. Only its
      // completed empty result can refute prose and retire unrelated recovery.
      await waitFor(() => expect(result?.status).toBeUndefined());
      expect(result?.items).toHaveLength(0);
      expect(result?.retry).toBeUndefined();

      view.rerender(
        <MentionCompletion
          {...props}
          observation={{ revision: 2, text: "@Mem", start: 4, end: 4 }}
          query={{ start: 0, end: 4, query: "Mem" }}
        />,
      );
      await waitFor(() =>
        expect(result?.status).toBe("Could not load agents. Retry to refresh."),
      );
      expect(result?.items).toHaveLength(1);
      expect(result?.retry).toEqual(expect.any(Function));
    } finally {
      view.unmount();
      test.library.dispose();
    }
  },
);

// Exercise selection, wire text/p tags, and sent rendering, not an already-bound @name.
it.each(["picker", "completion"] as const)(
  "%s keeps native display labels out of serialized mentions",
  async (surface) => {
    const test = setup();
    const profiles = new Map([[test.key, { name: "Mic" }]]);
    const library = createAgentLibrary(async () => ({
      definitions: [],
      identities: [{ pubkey: test.key, name: "Legacy Mic" }],
    }));
    let state: AgentControlState = {
      status: "ready",
      busy: false,
      error: null,
      data: {
        runtimeAvailable: true,
        agents: [
          {
            pubkey: test.key,
            relayUrl: "wss://here.example",
            name: "Native Mic",
          } as AgentView,
        ],
      },
    };
    const listeners = new Set<() => void>();
    const provider = createAgentDirectory({
      snapshot: () => state,
      refresh: async () => {},
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    const session = {
      ...test.session,
      agentLibrary: library.queries,
      agentChoices: createAgentChoices({
        scope: "test",
        library: library.queries,
        signal: new AbortController().signal,
      }),
      profiles: { ...test.session.profiles, snapshot: () => profiles },
    };
    const names = bindNames(
      { ...session, relayUrl: "wss://here.example" },
      {
        snapshot: () => [provider],
        subscribe: () => () => {},
      },
    );
    session.names = names;
    const user = userEvent.setup();
    let selected: MentionRecipient | undefined;
    let result: CompletionResult | undefined;
    const select = (recipient: MentionRecipient) => {
      selected = recipient;
      return true;
    };
    const publish = (next: CompletionResult) => {
      result = next;
      return () => {};
    };
    try {
      const menu = render(
        surface === "picker" ? (
          <MentionPicker
            scope="test"
            session={session}
            channelId="parent"
            disabled={false}
            inviteAgents
            select={select}
          />
        ) : (
          <MentionCompletion
            session={session}
            scope="test"
            channelId="parent"
            inviteAgents
            observation={{ revision: 1, text: "@Native", start: 7, end: 7 }}
            query={{ start: 0, end: 7, query: "Native" }}
            publish={publish}
          />
        ),
      );
      if (surface === "picker") {
        await user.click(
          screen.getByRole("button", { name: "Mention a member" }),
        );
        await user.click(
          await screen.findByRole("button", { name: `Native Mic ${test.key}` }),
        );
      } else {
        await waitFor(() => expect(result?.items[0]?.label).toBe("Native Mic"));
        const edit = result?.items[0]?.edit;
        if (!edit || !("mention" in edit))
          throw new Error("Missing mention choice");
        select(edit.mention);
      }
      menu.unmount();
      if (!selected) throw new Error("No selected recipient");
      expect(selected).toEqual({ pubkey: test.key, name: "Legacy Mic" });
      const draft = followupDraft([selected]);
      const send = vi.fn<Outbox["send"]>(() => "sent");
      const messages = createMessages(
        { supports: () => true, send } as unknown as Outbox,
        "viewer",
        () => undefined,
        () => [],
        () => {},
      );
      messages.send(
        "parent",
        draft.text,
        draft.recipients.map((item) => item.pubkey),
      );
      const wire = send.mock.calls[0]?.[0];
      if (!wire) throw new Error("No outgoing message");
      expect(wire).toEqual({
        kind: 9,
        content: "@Legacy Mic",
        tags: [
          ["h", "parent"],
          ["p", test.key],
        ],
      });
      const open = vi.fn(() => true);
      const view = render(
        <MessageMarkdown
          session={session}
          row={{
            id: "sent",
            channelId: "parent",
            authorId: "viewer",
            content: wire.content,
            createdAt: 1,
            mentions: wire.tags
              .filter(([tag]) => tag === "p")
              .map(([, key]) => key ?? ""),
            participants: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
          }}
          participantProfiles={profiles}
          directory={{
            profiles,
            channels: [],
            agents: library.queries.snapshot().identities,
          }}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
        />,
      );
      const button = screen.getByRole("button", {
        name: "View Native Mic profile",
      });
      act(() => {
        const data = state.data;
        const agent = data?.agents[0];
        if (!data || !agent) throw new Error("Missing native agent");
        state = {
          ...state,
          data: {
            ...data,
            agents: [{ ...agent, name: "Renamed Mic" }],
          },
        };
        for (const listener of listeners) listener();
      });
      expect(
        screen.getByRole("button", { name: "View Renamed Mic profile" }),
      ).toBe(button);
      await user.click(button);
      expect(open).toHaveBeenCalledWith(profileTarget(test.key));
      view.unmount();
    } finally {
      names.dispose();
      library.dispose();
      test.library.dispose();
    }
  },
);

// Component lifecycle demand, not browser geometry: real source capabilities and
// remounts reproduce completion producers being replaced as the query changes.
it.each([false, true])(
  "completion remounts preserve warm evidence (invite=%s)",
  async (inviteAgents) => {
    const test = setup();
    const f = controlFixture();
    const native = createAgentControl(f.host);
    const read = vi.fn(async () => ({
      definitions: [],
      identities: [{ pubkey: test.key, name: "Outside agent" }],
    }));
    const library = createAgentLibrary(read);
    const lifetime = new AbortController();
    const session = {
      ...test.session,
      agentChoices: createAgentChoices({
        scope: `https://relay.example.test:${"aa".repeat(32)}`,
        library: library.queries,
        native,
        signal: lifetime.signal,
      }),
    };
    let result: CompletionResult | undefined;
    const props = {
      session,
      scope: "test",
      channelId: "parent",
      inviteAgents,
      observation: { revision: 1, text: "@Outside", start: 8, end: 8 },
      query: { start: 0, end: 8, query: "Outside" },
      publish: (next: CompletionResult) => {
        result = next;
        return () => {};
      },
    };
    const tree = (key: number) => (
      <StrictMode>
        <MentionCompletion key={key} {...props} />
      </StrictMode>
    );
    const view = render(tree(0));
    try {
      await waitFor(() => expect(native.snapshot().status).toBe("ready"));
      if (inviteAgents)
        await waitFor(() => expect(result?.items).toHaveLength(1));
      expect(read).toHaveBeenCalledTimes(inviteAgents ? 1 : 0);
      const warm = session.agentChoices.snapshot();
      for (let key = 1; key <= 3; key++) {
        view.rerender(tree(key));
        await act(async () => {});
        expect(session.agentChoices.snapshot()).toBe(warm);
        expect(read).toHaveBeenCalledTimes(inviteAgents ? 1 : 0);
        expect(
          f.calls.filter((call) => call.action === "snapshot"),
        ).toHaveLength(1);
      }
      // An explicit library change still reaches an ordinary open completion.
      await act(async () => {
        await library.queries.refresh();
      });
      expect(session.agentChoices.snapshot().identities).toContainEqual(
        expect.objectContaining({ pubkey: test.key }),
      );
      expect(read).toHaveBeenCalledTimes(inviteAgents ? 2 : 1);
    } finally {
      view.unmount();
      lifetime.abort();
      library.dispose();
      test.library.dispose();
      native.dispose();
    }
  },
);

it("opening and reopening an ordinary picker does not load the legacy library", async () => {
  const test = setup();
  const user = userEvent.setup();
  const view = render(
    <MentionPicker
      scope="test"
      session={test.session}
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  try {
    for (let i = 0; i < 3; i++) {
      await user.click(
        screen.getByRole("button", { name: "Mention a member" }),
      );
      expect(test.library.queries.snapshot().status).toBe("idle");
    }
  } finally {
    view.unmount();
    test.library.dispose();
  }
});

it("prioritizes the viewer-owned namesake in both menus and selects the exact owner-labeled recipient", async () => {
  const test = setup();
  const viewer = "1".repeat(64),
    owner = "2".repeat(64),
    mine = "c".repeat(64);
  const profiles = new Map([
    [viewer, { name: "Logan" }],
    [owner, { name: "Wes" }],
    [mine, { name: "Honey", isAgent: true as const, ownerPubkey: viewer }],
    [test.key, { name: "Honey", isAgent: true as const, ownerPubkey: owner }],
  ]);
  const list = {
    status: "ready" as const,
    channels: [{ id: "parent", name: "Parent", members: [mine, test.key] }],
  };
  const session = {
    ...test.session,
    viewer,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    channels: { ...test.session.channels, list: () => list },
  };
  const provider = createAgentDirectory();
  const library = createAgentLibrary(undefined);
  const names = bindNames(
    { viewer, profiles: session.profiles, agentLibrary: library.queries },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const publish = vi.fn();
  const completion = render(
    <MentionCompletion
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      observation={{ revision: 1, text: "@hon", start: 4, end: 4 }}
      query={{ start: 0, end: 4, query: "hon" }}
      publish={publish}
    />,
  );
  expect(
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.id,
    ),
  ).toEqual([mine, test.key]);
  completion.unmount();
  const select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.type(screen.getByRole("searchbox"), "hon");
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => label?.endsWith(mine) || label?.endsWith(test.key)),
  ).toEqual([`Honey ${mine}`, `Wes’s Honey ${test.key}`]);
  await user.click(
    await screen.findByRole("button", { name: `Wes’s Honey ${test.key}` }),
  );
  expect(select).toHaveBeenCalledWith({ pubkey: test.key, name: "Honey" });
  view.unmount();
  names.dispose();
  library.dispose();
  test.library.dispose();
});

it("keeps an outside namesake discoverable and qualifies the actual choice set", async () => {
  const test = setup();
  const member = "a".repeat(64),
    outside = test.key,
    unrelated = "d".repeat(64);
  const profiles = new Map(
    [member, outside, unrelated].map((key) => [
      key,
      { name: "Larry", isAgent: true as const },
    ]),
  );
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey: outside, name: "Larry" }],
  }));
  const session = {
    ...test.session,
    agentLibrary: library.queries,
    agentChoices: createAgentChoices({
      scope: "scope",
      library: library.queries,
      signal: new AbortController().signal,
    }),
    profiles: { ...test.session.profiles, snapshot: () => profiles },
  };
  const provider = createAgentDirectory();
  const names = bindNames(
    { profiles: session.profiles, agentLibrary: library.queries },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    await screen.findByRole("button", { name: `Larry ${member}` }),
  ).toBeInTheDocument();
  view.rerender(
    <MentionPicker
      scope="scope"
      session={{ ...session, names }}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  const outsideButton = await screen.findByRole("button", {
    name: new RegExp(`Larry · .+ ${outside}`),
  });
  expect(
    screen.getByRole("button", { name: new RegExp(`Larry · .+ ${member}`) }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: new RegExp(unrelated) }),
  ).not.toBeInTheDocument();
  await user.click(outsideButton);
  expect(select).toHaveBeenCalledWith({ pubkey: outside, name: "Larry" });
  view.unmount();
  names.dispose();
  library.dispose();
  test.library.dispose();
});

it("discovers outside humans from the selected directory in both menus, not cached profiles", async () => {
  const t = setup();
  const outsider = { pubkey: "e".repeat(64), name: "Outside human" };
  const cached = "f".repeat(64);
  const people = vi.fn(async () => ({ people: [outsider], hasMore: false }));
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    profiles: { ...t.session.profiles, snapshot: () => profiles },
  };
  const profiles = new Map([[cached, { name: "Cache only" }]]);
  const publish = vi.fn();
  const view = render(
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@Outside", start: 8, end: 8 }}
      query={{ start: 0, end: 8, query: "Outside" }}
      publish={publish}
    />,
  );
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
        (item) => item.id,
      ),
    ).toEqual([outsider.pubkey]),
  );
  expect(people).toHaveBeenCalledWith("Outside", 1, expect.any(AbortSignal));
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Mention a member" }));
  const row = await screen.findByRole("button", {
    name: `${outsider.name} ${outsider.pubkey}`,
  });
  expect(row).toHaveTextContent("Choose whether to add");
  expect(
    screen.queryByRole("button", { name: new RegExp(cached) }),
  ).not.toBeInTheDocument();
});

it("qualifies outside directory namesakes that have no cached profile", async () => {
  const t = setup();
  const member = "a".repeat(64);
  const people = vi.fn(async () => ({
    people: [
      { pubkey: "e".repeat(64), name: "Larry" },
      { pubkey: "f".repeat(64), name: "Larry", isAgent: true as const },
    ],
    hasMore: false,
  }));
  const profiles = new Map([[member, { name: "Larry" }]]);
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    profiles: { ...t.session.profiles, snapshot: () => profiles },
  };
  const provider = createAgentDirectory();
  const names = bindNames(
    { profiles: session.profiles, agentLibrary: t.library.queries },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const publish = vi.fn();
  render(
    <MentionCompletion
      session={{ ...session, names }}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@Larr", start: 5, end: 5 }}
      query={{ start: 0, end: 5, query: "Larr" }}
      publish={publish}
    />,
  );
  const labels = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.label,
    ) ?? [];
  await waitFor(() => expect(labels()).toHaveLength(3));
  expect(new Set(labels()).size).toBe(3);
  expect(labels()).not.toContain("Larry");
  names.dispose();
});

it.each(["dm", "session"] as const)(
  "never expands %s candidates from the community directory",
  async (channelType) => {
    const t = setup();
    const people = vi.fn(async () => ({
      people: [{ pubkey: "e".repeat(64), name: "Outside" }],
      hasMore: false,
    }));
    const list = {
      status: "ready" as const,
      channels: [
        {
          id: "parent",
          name: "Conversation",
          channelType,
          members: ["a".repeat(64)],
        },
      ],
    };
    const session = {
      ...t.session,
      directMessages: { ...t.session.directMessages, people },
      channels: { ...t.session.channels, list: () => list },
    };
    render(
      <MentionPicker
        session={session}
        scope="test"
        channelId="parent"
        disabled={false}
        select={() => true}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Mention a member" }));
    expect(people).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /Outside/ }),
    ).not.toBeInTheDocument();
  },
);

it("shows local rows before the directory, appends outside rows, and reuses settled pages", async () => {
  vi.useFakeTimers();
  const t = setup();
  const lara = { pubkey: "e".repeat(64), name: "Lara" };
  const larry = { pubkey: "f".repeat(64), name: "Larry Outside" };
  const pages = new Map<
    string,
    (value: {
      people: { pubkey: string; name: string }[];
      hasMore: boolean;
    }) => void
  >();
  const people = vi.fn(
    (query: string) =>
      new Promise<{
        people: { pubkey: string; name: string }[];
        hasMore: boolean;
      }>((resolve) => pages.set(query, resolve)),
  );
  const profiles = new Map([[t.member, { name: "Larkin" }]]);
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    profiles: { ...t.session.profiles, snapshot: () => profiles },
  };
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@La", start: 3, end: 3 },
    publish,
  };
  const last = () => publish.mock.lastCall?.[0] as CompletionResult | undefined;
  const labels = () => last()?.items.map((item) => item.label);
  const view = render(
    <MentionCompletion {...props} query={{ start: 0, end: 3, query: "La" }} />,
  );
  // The member is usable before the network search starts or settles.
  expect(labels()).toEqual(["Larkin"]);
  expect(last()?.status).toBe("Searching community…");
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(people).toHaveBeenCalledTimes(1);
  await act(async () =>
    pages.get("La")?.({ people: [lara, larry], hasMore: false }),
  );
  expect(labels()).toEqual(["Larkin", "Lara", "Larry Outside"]);
  expect(last()?.status).toBeUndefined();
  // A new query keeps still-matching people from the last page while it loads.
  view.rerender(
    <MentionCompletion
      {...props}
      query={{ start: 0, end: 4, query: "Larr" }}
    />,
  );
  expect(labels()).toEqual(["Larry Outside"]);
  expect(last()?.status).toBe("Searching community…");
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(people).toHaveBeenCalledTimes(2);
  const newer = { pubkey: "d".repeat(64), name: "Larry Newer" };
  await act(async () =>
    pages.get("Larr")?.({ people: [newer, larry], hasMore: false }),
  );
  // Appended below, never inserted above a visible row.
  expect(labels()).toEqual(["Larry Outside", "Larry Newer"]);
  // Returning to a settled query is instant and does not read again.
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 3, query: "La" }} />,
  );
  expect(labels()).toEqual(["Larkin", "Lara", "Larry Outside"]);
  expect(last()?.status).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(people).toHaveBeenCalledTimes(2);
});

it("waits for a typing pause before reading the directory", async () => {
  const t = setup();
  const people = vi.fn(async () => ({ people: [], hasMore: false }));
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  };
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@Out", start: 4, end: 4 },
    publish: vi.fn(),
  };
  const view = render(
    <MentionCompletion {...props} query={{ start: 0, end: 2, query: "O" }} />,
  );
  for (const query of ["Ou", "Out"])
    view.rerender(
      <MentionCompletion {...props} query={{ start: 0, end: 4, query }} />,
    );
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  expect(people).toHaveBeenCalledWith("Out", 1, expect.any(AbortSignal));
});

it("ignores a late directory result after the query changes and retries the current failure", async () => {
  const t = setup();
  let release = (_result: {
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }) => {};
  const old = new Promise<{
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }>((resolve) => {
    release = resolve;
  });
  const people = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({
      people: [{ pubkey: "e".repeat(64), name: "New person" }],
      hasMore: false,
    });
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  };
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@Old", start: 4, end: 4 },
    publish,
  };
  const view = render(
    <MentionCompletion {...props} query={{ start: 0, end: 4, query: "Old" }} />,
  );
  // Directory reads wait for a typing pause, so let the old query start first.
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 4, query: "New" }} />,
  );
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.status,
    ).toMatch(/Could not search community/),
  );
  await act(async () =>
    release({
      people: [{ pubkey: "f".repeat(64), name: "Old person" }],
      hasMore: false,
    }),
  );
  expect(
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items,
  ).toEqual([]);
  act(() => {
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.retry?.();
  });
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
        (item) => item.label,
      ),
    ).toEqual(["New person"]),
  );
});

it("keeps installed rows and fresh authorization through rename, removal, arrivals and archive Retry", async () => {
  const test = setup();
  const a = "a".repeat(64),
    b = "b".repeat(64),
    c = "c".repeat(64);
  let profiles = new Map([
    [a, { name: "Alpha" }],
    [b, { name: "Beta" }],
    [c, { name: "Aaron Bee" }],
  ]);
  let list = {
    status: "ready" as const,
    channels: [{ id: "parent", name: "Parent", members: [a, b] }],
  };
  let archive = { status: "ready" as const, archived: [] as string[] };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const refresh = vi.fn(async () => {
    for (const fn of listeners) fn();
  });
  const session = {
    ...test.session,
    channels: {
      ...test.session.channels,
      list: () => list,
      subscribeList: subscribe,
    },
    profiles: { ...test.session.profiles, snapshot: () => profiles, subscribe },
    archives: {
      snapshot: () => archive,
      subscribe,
      state: (key: string) =>
        archive.archived.includes(key) ? "archived" : "not-archived",
      ensure: async () => {},
      refresh,
      writable: false,
      consent: vi.fn(),
      request: vi.fn(),
    },
  } as RelaySession;
  let result: CompletionResult | undefined;
  const publish = (value: CompletionResult) => {
    result = value;
    return () => {};
  };
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    query: { start: 0, end: 1, query: "" },
    publish,
  };
  const view = render(<MentionCompletion {...props} />);
  expect(result?.items.map((i) => i.id)).toEqual([a, b]);
  const original = result?.items[0];
  act(() => {
    profiles = new Map([
      [a, { name: "Zeta" }],
      [b, { name: "Beta" }],
      [c, { name: "Aaron Bee" }],
    ]);
    for (const fn of listeners) fn();
  });
  expect(result?.items.map((i) => i.id)).toEqual([a, b]);
  expect(result?.items[0]?.label).toBe("Zeta");
  expect(result?.items[0]?.edit).toEqual({
    mention: { pubkey: a, name: "Zeta" },
  });
  act(() => {
    list = {
      ...list,
      channels: [{ id: "parent", name: "Parent", members: [b, c] }],
    };
    // Selection sees the new source even before subscriber callbacks/render.
    expect(original?.canSelect?.("Enter")).toBe(false);
    for (const fn of listeners) fn();
  });
  expect(result?.items.map((i) => i.id)).toEqual([a, b]);
  expect(result?.items[0]?.disabled).toBeTruthy();
  act(() => {
    archive = { ...archive, archived: [b] };
    for (const fn of listeners) fn();
  });
  expect(result?.items[1]?.disabled).toBe("Archived");
  await act(() => refresh());
  expect(result?.items.map((i) => i.id)).toEqual([a, b]);
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 2, query: "a" }} />,
  );
  expect(result?.items.map((i) => i.id)).toEqual([c]);
  view.rerender(
    <MentionCompletion
      {...props}
      query={{ start: 0, end: 8, query: "Aaron B" }}
    />,
  );
  expect(result?.items.map((i) => i.id)).toEqual([c]);
  act(() => {
    list = {
      ...list,
      channels: [{ id: "parent", name: "Parent", members: [] }],
    };
    for (const fn of listeners) fn();
  });
  expect(result?.items.map((i) => i.id)).toEqual([c]);
  expect(result?.items[0]?.disabled).toBeTruthy();
  view.unmount();
  test.library.dispose();
});

it("retains button rows while disabling an archived member, then hides it on reopen", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  let archive = { status: "ready" as const, archived: [] as string[] };
  const listeners = new Set<() => void>();
  const session = {
    ...test.session,
    archives: {
      snapshot: () => archive,
      state: (key: string) =>
        archive.archived.includes(key) ? "archived" : "not-archived",
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      ensure: async () => {},
      refresh: async () => {},
      writable: false,
      consent: vi.fn(),
      request: vi.fn(),
    },
  } as RelaySession;
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  const row = screen.getByRole("button", { name: `Member ${"a".repeat(64)}` });
  act(() => {
    archive = { ...archive, archived: ["a".repeat(64)] };
    for (const fn of listeners) fn();
  });
  expect(row).toBeDisabled();
  await user.click(row);
  expect(select).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    screen.queryByRole("button", { name: `Member ${"a".repeat(64)}` }),
  ).not.toBeInTheDocument();
  test.library.dispose();
});

it("offers usable partial agent choices without waiting for another source", async () => {
  const test = setup();
  const snapshot = {
    ...test.session.agentChoices.snapshot(),
    status: "ready" as const,
    pending: true,
    complete: false,
    identities: [
      { pubkey: "f".repeat(64), name: "Ready Agent", managed: true },
    ],
  };
  const session = {
    ...test.session,
    agentChoices: { ...test.session.agentChoices, snapshot: () => snapshot },
  };
  const view = render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      inviteAgents
      select={() => true}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    await screen.findByRole("button", {
      name: `Ready Agent ${"f".repeat(64)}`,
    }),
  ).toBeEnabled();
  view.unmount();
  test.library.dispose();
});

it("archived identities leave completion and return on unarchive; the viewer is never hidden from themself", async () => {
  const test = setup();
  const publish = vi.fn();
  const rows = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => [item.label, item.disabled],
    );
  const props = (query: string) => ({
    scope: "test",
    channelId: "parent",
    observation: {
      revision: 1,
      text: `@${query}`,
      start: query.length + 1,
      end: query.length + 1,
    },
    query: { start: 0, end: query.length + 1, query },
    publish,
  });
  const view = render(
    <MentionCompletion session={test.session} {...props("")} />,
  );
  expect(rows()).toEqual([["Member", undefined]]);
  // A shown row stays in place but cannot be chosen; the next query drops it.
  act(() => test.setArchived([test.member]));
  expect(rows()).toEqual([["Member", "Archived"]]);
  view.rerender(<MentionCompletion session={test.session} {...props("M")} />);
  expect(rows()).toEqual([]);
  // Unarchive returns the row on the next query; installed rows never grow.
  act(() => test.setArchived([]));
  view.rerender(<MentionCompletion session={test.session} {...props("Me")} />);
  expect(rows()).toEqual([["Member", undefined]]);
  act(() => test.setArchived([test.member]));
  view.rerender(
    <MentionCompletion
      session={{ ...test.session, viewer: test.member }}
      {...props("Mem")}
    />,
  );
  expect(rows()).toEqual([["Member", undefined]]);
  test.library.dispose();
});

it("closes prose after an unknown name without status or recovery, and skips searches a complete empty prefix refutes", async () => {
  const t = setup();
  const people = vi.fn(async (query: string) => ({
    people: query.startsWith("Ou")
      ? [{ pubkey: "e".repeat(64), name: "Outside" }]
      : [],
    hasMore: false,
  }));
  const uncached = new Map();
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
    profiles: { ...t.session.profiles, snapshot: () => uncached },
  };
  const publish = vi.fn();
  const last = () => publish.mock.lastCall?.[0] as CompletionResult | undefined;
  const complete = (query: string) => (
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{
        revision: 1,
        text: `@${query}`,
        start: query.length + 1,
        end: query.length + 1,
      }}
      query={{ start: 0, end: query.length + 1, query }}
      publish={publish}
    />
  );
  const view = render(complete("Zed"));
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(last()?.retry).toBeDefined());
  for (const prose of ["Zed ", "Zed is", "Zed is typing"]) {
    view.rerender(complete(prose));
    await waitFor(() => expect(last()).toEqual({ items: [] }));
  }
  expect(people).toHaveBeenCalledTimes(1);
  view.rerender(complete("Out"));
  await waitFor(() =>
    expect(people).toHaveBeenLastCalledWith("Out", 1, expect.any(AbortSignal)),
  );
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["Outside"]),
  );
  view.rerender(complete("Outside "));
  await waitFor(() => expect(people).toHaveBeenCalledTimes(3));
});

function directoryCompletion(people: RelaySessionPeople) {
  const t = setup();
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  };
  const publish = vi.fn();
  const last = () => publish.mock.lastCall?.[0] as CompletionResult | undefined;
  const complete = (query: string) => (
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{
        revision: 1,
        text: `@${query}`,
        start: query.length + 1,
        end: query.length + 1,
      }}
      query={{ start: 0, end: query.length + 1, query }}
      publish={publish}
    />
  );
  return { last, complete };
}
type RelaySessionPeople = (
  query: string,
) => Promise<{ people: { pubkey: string; name: string }[]; hasMore: boolean }>;

it("an empty partial-key search does not refute an exact-key lookup, and keys still match no choice", async () => {
  const key = "9".repeat(64);
  const people = vi.fn(async (query: string) => ({
    people: query === key ? [{ pubkey: key, name: "Keyholder" }] : [],
    hasMore: false,
  }));
  const { last, complete } = directoryCompletion(people);
  const view = render(complete("9".repeat(10)));
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(last()?.items).toEqual([]));
  view.rerender(complete(key));
  // The empty partial-key page does not refute the exact-key author lookup.
  await waitFor(() =>
    expect(people).toHaveBeenLastCalledWith(key, 1, expect.any(AbortSignal)),
  );
  // Choices still match names only, never public keys.
  await waitFor(() => expect(last()?.items).toEqual([]));
});

it("a failed multi-word directory search keeps its error and retry", async () => {
  const people = vi
    .fn<RelaySessionPeople>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      people: [{ pubkey: "f".repeat(64), name: "Mary Jane" }],
      hasMore: false,
    });
  const { last, complete } = directoryCompletion(people);
  render(complete("Mary J"));
  await waitFor(() =>
    expect(last()?.status).toBe(
      "Could not search community people. Retry to refresh.",
    ),
  );
  act(() => last()?.retry?.());
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["Mary Jane"]),
  );
});

it("a fresh search for a refuted name searches again, and non-word text refutes nothing", async () => {
  let published = false;
  const people = vi.fn(async (query: string) => ({
    people: [
      ...(published && query.startsWith("Zed")
        ? [{ pubkey: "9".repeat(64), name: "Zed" }]
        : []),
      ...(query.startsWith("🐝 B")
        ? [{ pubkey: "8".repeat(64), name: "🐝 Buzz Bot" }]
        : []),
    ],
    hasMore: false,
  }));
  const { last, complete } = directoryCompletion(people);
  const view = render(complete("Zed"));
  await waitFor(() => expect(people).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(last()?.items).toEqual([]));
  view.unmount();
  published = true;
  const fresh = render(complete("Zed"));
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["Zed"]),
  );
  fresh.rerender(complete("🐝"));
  await waitFor(() =>
    expect(people).toHaveBeenLastCalledWith("🐝", 1, expect.any(AbortSignal)),
  );
  await waitFor(() => expect(last()?.items).toEqual([]));
  fresh.rerender(complete("🐝 B"));
  await waitFor(() =>
    expect(last()?.items.map((item) => item.label)).toEqual(["🐝 Buzz Bot"]),
  );
});

it("uses base matches and visible lexical ties for Fizz in both chooser surfaces", async () => {
  const test = setup();
  const rows = [
    { key: "3".repeat(64), name: "Fast Fizz", label: "Fast Fizz" },
    { key: "0".repeat(64), name: "Fizz", label: "baxen’s Fizz · oncp" },
    { key: "4".repeat(64), name: "Fizz", label: "baxen’s Fizz · s03j" },
    { key: "5".repeat(64), name: "Fizz", label: "Kenny Lopez’s Fizz" },
    { key: "b".repeat(64), name: "Fizz", label: "baxen’s Fizz · 4prr" },
    { key: "c".repeat(64), name: "Fizz", label: "baxen’s Fizz · 06pl" },
  ];
  const profiles = new Map(
    rows.map((row) => [row.key, { name: row.name, isAgent: true as const }]),
  );
  const list = {
    status: "ready" as const,
    channels: [
      { id: "parent", name: "Parent", members: rows.map((row) => row.key) },
    ],
  };
  const names = test.session.names;
  if (!names) throw new Error("Missing fixture name service");
  const session = {
    ...test.session,
    profiles: { ...test.session.profiles, snapshot: () => profiles },
    channels: { ...test.session.channels, list: () => list },
    names: {
      ...names,
      resolve: (key: string) => rows.find((row) => row.key === key)?.label,
      scope: () => (key: string) => {
        const name = rows.find((row) => row.key === key)?.label;
        return name ? { name, source: "agent-directory" as const } : undefined;
      },
    },
  } satisfies RelaySession;
  const expected = [rows[5], rows[4], rows[1], rows[2], rows[3], rows[0]].map(
    (row) => row?.label,
  );
  const publish = vi.fn();
  const view = render(
    <MentionCompletion
      session={session}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@fizz", start: 5, end: 5 }}
      query={{ start: 0, end: 5, query: "fizz" }}
      publish={publish}
    />,
  );
  expect(
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.label,
    ),
  ).toEqual(expected);
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.type(screen.getByRole("searchbox"), "fizz");
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => rows.some((row) => label?.endsWith(row.key)))
      .map((label) => label?.slice(0, -65)),
  ).toEqual(expected);
  test.library.dispose();
});

it("does not complete public keys in either menu", async () => {
  const test = setup();
  const key =
    "150b20bdf6130418df9239dd1bd082c71612c8d653b47c277200365b9be215dc";
  const honey = "f".repeat(64);
  const unnamed = "e".repeat(64);
  const profiles = new Map([
    [key, { name: "Bad Janet" }],
    [honey, { name: "Honey" }],
  ]);
  const list = {
    status: "ready" as const,
    channels: [
      { id: "parent", name: "Parent", members: [key, honey, unnamed] },
    ],
  };
  const session = {
    ...test.session,
    profiles: { ...test.session.profiles, snapshot: () => profiles },
    channels: { ...test.session.channels, list: () => list },
  } satisfies RelaySession;
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    observation: { revision: 1, text: "@h", start: 2, end: 2 },
    query: { start: 0, end: 2, query: "h" },
    publish,
  };
  const view = render(<MentionCompletion {...props} />);
  const ids = () =>
    (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items.map(
      (item) => item.id,
    );
  expect(ids()).toEqual([honey]);
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 65, query: key }} />,
  );
  expect(ids()).toEqual([]);
  view.rerender(
    <MentionCompletion {...props} query={{ start: 0, end: 4, query: "eee" }} />,
  );
  expect(ids()).toEqual([]);
  view.unmount();
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  await user.type(screen.getByRole("searchbox"), "h");
  expect(screen.queryByRole("button", { name: `Bad Janet ${key}` })).toBeNull();
  expect(screen.getByRole("button", { name: `Honey ${honey}` })).toBeVisible();
  await user.clear(screen.getByRole("searchbox"));
  await user.type(screen.getByRole("searchbox"), key);
  expect(screen.queryByRole("button", { name: `Bad Janet ${key}` })).toBeNull();
  test.library.dispose();
});

it("keeps still-matching directory people across the inline host's per-keystroke remount", async () => {
  // jsdom has no layout; the host positions its popup with these.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const t = setup();
  const larry = { pubkey: "f".repeat(64), name: "Larry Outside" };
  const lara = { pubkey: "e".repeat(64), name: "Lara" };
  const resolvers = new Map<
    string,
    (value: { people: (typeof larry)[]; hasMore: boolean }) => void
  >();
  const people = vi.fn(
    (query: string) =>
      new Promise<{ people: (typeof larry)[]; hasMore: boolean }>((resolve) =>
        resolvers.set(query, resolve),
      ),
  );
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  } as unknown as RelaySession;
  // The real mention provider behind the real host, which keys each provider
  // mount by observation revision and query.
  const provider: Contribution<ComposerCompletion> = {
    id: "typeahead",
    key: "buzz.mentions/typeahead",
    pluginId: "buzz.mentions",
    revision: "1",
    title: "Mention",
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  };
  const providers = [provider];
  const registry = { snapshot: () => providers, subscribe: () => () => {} };
  // The host reads only its attributes and position; valid() is stubbed.
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input);
  const editor = (observation: ComposerObservation) =>
    ({
      observation,
      valid: () => true,
      observe: () => {},
      invalidate: () => {},
      keys: { current: undefined },
      composing: { current: false },
    }) as unknown as CompletionEditor;
  const host = (revision: number, text: string) => (
    <ComposerCompletions
      registry={registry}
      editor={editor({ revision, text, start: text.length, end: text.length })}
      input={{ current: input }}
      replace={() => true}
      resolved={{ text, recipients: [] }}
      session={session}
      scope="test"
      channelId="parent"
    />
  );
  const options = () =>
    screen.queryAllByRole("option").map((option) => option.textContent);
  const view = render(host(1, "@La"));
  await waitFor(() =>
    expect(people).toHaveBeenCalledWith("La", 1, expect.anything()),
  );
  await act(async () =>
    resolvers.get("La")?.({ people: [lara, larry], hasMore: false }),
  );
  await waitFor(() =>
    expect(options()).toEqual([
      expect.stringContaining("Lara"),
      expect.stringContaining("Larry Outside"),
    ]),
  );
  // Each keystroke remounts the provider. The still-matching person stays
  // while the new search waits and loads; the non-matching one leaves.
  view.rerender(host(2, "@Lar"));
  view.rerender(host(3, "@Larr"));
  expect(options()).toEqual([expect.stringContaining("Larry Outside")]);
  expect(screen.getByRole("status")).toHaveTextContent("Searching community…");
  await waitFor(() =>
    expect(people).toHaveBeenCalledWith("Larr", 1, expect.anything()),
  );
  expect(options()).toEqual([expect.stringContaining("Larry Outside")]);
  // A different `@` token is a new chooser lifetime and starts clean.
  view.rerender(host(4, "@Larr @Bo"));
  expect(options()).toEqual([]);
  input.remove();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it("the persistent toolbar picker reads an empty search again after close and reopen", async () => {
  let published = false;
  const people = vi.fn(async () => ({
    people: published ? [{ pubkey: "9".repeat(64), name: "Zed" }] : [],
    hasMore: false,
  }));
  const t = setup();
  const session = {
    ...t.session,
    directMessages: { ...t.session.directMessages, people },
  };
  render(
    <MentionPicker
      session={session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={() => true}
    />,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Mention a member" });
  await user.click(trigger);
  await user.type(screen.getByRole("searchbox"), "Zed");
  await waitFor(() =>
    expect(people).toHaveBeenCalledWith("Zed", 1, expect.any(AbortSignal)),
  );
  const calls = people.mock.calls.length;
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  published = true;
  // The picker stays mounted while closed, so this is the same hook instance.
  await user.click(trigger);
  const search = screen.getByRole("searchbox");
  if ((search as HTMLInputElement).value !== "Zed") {
    await user.clear(search);
    await user.type(search, "Zed");
  }
  await waitFor(() => expect(people.mock.calls.length).toBeGreaterThan(calls));
  expect(people).toHaveBeenLastCalledWith("Zed", 1, expect.any(AbortSignal));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: `Zed ${"9".repeat(64)}` }),
    ).toBeTruthy(),
  );
  t.library.dispose();
});

it("names the choice set only while the picker is shown, and qualifies namesakes in both menus", async () => {
  const t = setup();
  const member = "a".repeat(64),
    namesake = "c".repeat(64);
  const profiles = new Map([
    [member, { name: "Larry" }],
    [namesake, { name: "Larry" }],
  ]);
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "parent",
        name: "Parent",
        channelType: "stream" as const,
        members: [member, namesake],
      },
    ],
  };
  const session = {
    ...t.session,
    profiles: { ...t.session.profiles, snapshot: () => profiles },
    channels: { ...t.session.channels, list: () => list },
  };
  const names = bindNames(
    { profiles: session.profiles, agentLibrary: t.library.queries },
    { snapshot: () => [createAgentDirectory()], subscribe: () => () => {} },
  );
  const scope = vi.spyOn(names, "scope");
  const labels = [member, namesake].map(
    (key) => `Larry · ${npubEncode(key).slice(-4)}`,
  );
  const picker = (disabled: boolean) => (
    <MentionPicker
      scope="test"
      session={{ ...session, names }}
      channelId="parent"
      disabled={disabled}
      select={() => true}
    />
  );
  const view = render(picker(false));
  view.rerender(picker(false));
  expect(scope).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Mention a member" }));
  for (const [index, key] of [member, namesake].entries())
    expect(
      await screen.findByRole("button", { name: `${labels[index]} ${key}` }),
    ).toBeInTheDocument();
  view.rerender(picker(true));
  scope.mockClear();
  view.rerender(picker(true));
  expect(scope).not.toHaveBeenCalled();
  view.unmount();
  const publish = vi.fn();
  render(
    <MentionCompletion
      session={{ ...session, names }}
      scope="test"
      channelId="parent"
      observation={{ revision: 1, text: "@Larry", start: 6, end: 6 }}
      query={{ start: 0, end: 6, query: "Larry" }}
      publish={publish}
    />,
  );
  await waitFor(() =>
    expect(
      (publish.mock.lastCall?.[0] as CompletionResult | undefined)?.items
        .map((item) => item.label)
        .sort(),
    ).toEqual([...labels].sort()),
  );
  names.dispose();
  t.library.dispose();
});

it.each([false, true])(
  "shows agent loading only without retained mention choices (warm=%s)",
  async (warm) => {
    const test = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = !warm;
    const read = vi.fn(async () => {
      if (held) await gate;
      return {
        definitions: [],
        identities: [{ pubkey: test.key, name: "Outside agent" }],
      };
    });
    const library = createAgentLibrary(read);
    if (warm) await library.queries.refresh();
    const session = {
      ...test.session,
      agentChoices: createAgentChoices({
        scope: "test",
        library: library.queries,
        signal: new AbortController().signal,
      }),
    };
    const view = render(
      <MentionPicker
        session={session}
        scope="test"
        channelId="parent"
        disabled={false}
        inviteAgents
        select={() => true}
      />,
    );
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Mention a member" }));
      if (warm) {
        await screen.findByRole("button", {
          name: `Outside agent ${test.key}`,
        });
        held = true;
        act(() => {
          void session.agentChoices.refresh();
        });
      }
      await waitFor(() => expect(read).toHaveBeenCalledTimes(warm ? 2 : 1));
      expect(session.agentChoices.snapshot().status).toBe("loading");
      if (warm) {
        expect(
          screen.getByRole("button", { name: `Member ${test.member}` }),
        ).toBeVisible();
        expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
      } else expect(screen.getByText("Loading agents…")).toBeVisible();
      await act(async () => release());
      await waitFor(() =>
        expect(session.agentChoices.snapshot().status).toBe("ready"),
      );
      expect(
        screen.getByRole("button", { name: `Outside agent ${test.key}` }),
      ).toBeEnabled();
      expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
    } finally {
      await act(async () => release());
      view.unmount();
      library.dispose();
      test.library.dispose();
    }
  },
);
