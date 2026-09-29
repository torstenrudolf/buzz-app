// @vitest-environment jsdom
import { createMemberAdditions } from "../channel-members/operations";
import { addChannelMember } from "../channel-members/members";
import "@testing-library/jest-dom/vitest";
import { composerDOMFixture } from "./composer-testing";
import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../identity-names/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  ComposerTool,
  ComposerToolProps,
  CompletionResult,
  InlineRenderer,
} from "../conversation/contracts";
import type { AgentLibrarySnapshot } from "../agents/library";
import { createAgentChoices } from "../agents/choices";
import { createAgentControl, type AgentControl } from "../agents/control";
import { controlFixture } from "../agents/control-testing";
import type { OutgoingEvent } from "../relay/outbox";
import { MessageComposer, type MessageComposerProps } from "./MessageComposer";
import { createRelaySession, type RelaySession } from "../relay/session";
import { keypair, metadata, roster, signed } from "../relay/testing";
import type { EventTemplate } from "nostr-tools";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { readView, writeView } from "../../shared/view-state";
import { emojiMatches, type CustomEmoji } from "../relay/emoji";
import { CustomEmoji as CustomEmojiImage } from "../../bundled/emoji/CustomEmoji";
import type { ComposerInputElement } from "./composer-dom";
import { profileTarget } from "../profiles/target";
import { setRememberAgentsPreference } from "./mention-preferences";

composerDOMFixture();

const first = { pubkey: "a".repeat(64), name: "Honey" };
const second = { pubkey: "b".repeat(64), name: "Honey" };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

function mount(
  options: Partial<MessageComposerProps> = {},
  control?: AgentControl,
  viewer?: string,
) {
  let commands: ComposerToolProps;
  const completionRequests: ComposerCompletionProps["publish"][] = [];
  function Completion({ publish }: ComposerCompletionProps) {
    useLayoutEffect(() => {
      completionRequests.push(publish);
    }, [publish]);
    return null;
  }
  const completionListeners = new Set<() => void>();
  const completion = (revision: string): Contribution<ComposerCompletion> => ({
    id: "delayed",
    key: "test/delayed",
    pluginId: "test",
    revision,
    title: "Delayed",
    match: ({ text, start }) =>
      text.startsWith("!") && start > 0
        ? { start: 0, end: start, query: text.slice(1, start) }
        : null,
    component: Completion,
  });
  let completions: readonly Contribution<ComposerCompletion>[] = [
    completion("1"),
  ];
  function Tool(props: ComposerToolProps) {
    useLayoutEffect(() => {
      commands = props;
    });
    return (
      <>
        <button type="button" onClick={() => props.insertMention(first)}>
          First Honey
        </button>
        <button type="button" onClick={() => props.insertMention(second)}>
          Second Honey
        </button>
      </>
    );
  }
  const tools: readonly Contribution<ComposerTool>[] = [
    {
      id: "fixture",
      key: "test/fixture",
      pluginId: "test",
      revision: "1",
      title: "Fixture tools",
      component: Tool,
    },
  ];
  const emojiListeners = new Set<() => void>();
  let emoji = {
    status: "ready" as const,
    entries: [] as readonly CustomEmoji[],
  };
  const outboxListeners = new Set<() => void>();
  let pending: readonly OutgoingEvent[] = [];
  let rows: readonly ChannelMessage[] = [];
  const setPending = (next: readonly OutgoingEvent[]) => {
    pending = next;
    for (const listener of outboxListeners) listener();
  };
  const messages = {
    edit: vi.fn<RelaySession["messages"]["edit"]>((id, content) => {
      setPending([
        {
          event: {
            id: "edit-id",
            kind: 40003,
            pubkey: first.pubkey,
            created_at: 100,
            content,
            tags: [
              ["h", "channel"],
              ["e", id],
            ],
          },
          delivery: "sending",
        },
      ]);
      return "edit-id";
    }),
    send: vi.fn<RelaySession["messages"]["send"]>(() => "channel-id"),
    reply: vi.fn<RelaySession["messages"]["reply"]>(() => "reply-id"),
  };
  const typing: ReturnType<RelaySession["typing"]["snapshot"]> = [];
  let profiles: ReadonlyMap<string, Profile> = new Map();
  const profileListeners = new Set<() => void>();
  const libraryListeners = new Set<() => void>();
  let library: AgentLibrarySnapshot = {
    status: "ready",
    identities: [],
    definitions: [],
  };
  const channelList = {
    status: "ready" as const,
    channels: [{ id: "channel", members: [first.pubkey, second.pubkey] }],
  };
  const rawSession = {
    viewer,
    messages,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
    profiles: {
      snapshot: () => profiles,
      subscribe(listener: () => void) {
        profileListeners.add(listener);
        return () => {
          profileListeners.delete(listener);
        };
      },
      ensure: vi.fn(async () => {}),
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe(listener: () => void) {
        libraryListeners.add(listener);
        return () => libraryListeners.delete(listener);
      },
      refresh: vi.fn(async () => {}),
      retain: () => () => {},
    },
    emoji: {
      snapshot: () => emoji,
      subscribe(listener: () => void) {
        emojiListeners.add(listener);
        return () => {
          emojiListeners.delete(listener);
        };
      },
      ensure: vi.fn(() => Promise.resolve()),
      refresh: vi.fn(() => Promise.resolve()),
    },
    media: (url: string) => url,
    outbox: {
      supports: () => true,
      snapshot: () => pending,
      subscribe(listener: () => void) {
        outboxListeners.add(listener);
        return () => outboxListeners.delete(listener);
      },
      retry: vi.fn((id: string) =>
        setPending(
          pending.map((item) =>
            item.event.id === id
              ? { ...item, delivery: "sending", error: undefined }
              : item,
          ),
        ),
      ),
    },
    channels: {
      window: () => ({ rows }),
      list: () => channelList,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const session = {
    ...rawSession,
    names: bindNames(rawSession, {
      snapshot: () => [createAgentDirectory()],
      subscribe: () => () => {},
    }),
  };
  const onSend = vi.fn();
  const inline: readonly Contribution<InlineRenderer>[] = [
    {
      id: "emoji",
      key: "test/emoji",
      pluginId: "test",
      revision: "1",
      title: "Emoji",
      matches: ({ text, message }) => [
        ...emojiMatches(text, message.emoji ?? []),
      ],
      component: ({ text, content, media }) => {
        const entry = content.message.emoji?.find(
          (entry) => `:${entry.shortcode}:` === text.toLowerCase(),
        );
        return entry ? <CustomEmojiImage emoji={entry} media={media} /> : text;
      },
    },
  ];
  let props: MessageComposerProps = {
    session,
    onSend,
    scope: "scope",
    channelId: "channel",
    channelName: "General",
    extensions: {
      tools: { snapshot: () => tools, subscribe: () => () => {} },
      inline: { snapshot: () => inline, subscribe: () => () => {} },
      completions: {
        snapshot: () => completions,
        subscribe(listener) {
          completionListeners.add(listener);
          return () => completionListeners.delete(listener);
        },
      },
    },
    ...options,
  };
  const bindChoices = () => {
    const library = props.session.agentLibrary;
    props = {
      ...props,
      session: {
        ...props.session,
        scope: props.scope,
        agentChoices: createAgentChoices({
          scope: props.scope,
          library: { ...library, retain: () => () => {} },
          native: control,
          signal: new AbortController().signal,
        }),
      },
    };
  };
  bindChoices();
  const tree = () => <MessageComposer {...props} />;
  const view = render(tree(), {
    reactStrictMode: true,
  });
  const input = () =>
    within(view.container).getByRole<ComposerInputElement>("textbox");
  return {
    ...view,
    input,
    messages,
    setRows(next: readonly ChannelMessage[]) {
      rows = next;
    },
    setDelivery(delivery: OutgoingEvent["delivery"]) {
      act(() =>
        setPending(
          pending.map((item) => ({
            ...item,
            delivery,
            error:
              delivery === "failed" ? "Relay rejected this edit" : undefined,
          })),
        ),
      );
    },
    onSend,
    session: props.session,
    emojiListeners,
    user: userEvent.setup(),
    commands: () => commands,
    completionRequests,
    publish(index: number, text = "chosen") {
      const request = completionRequests[index];
      if (!request) throw new Error("No observed completion request");
      const result: CompletionResult = {
        items: [{ id: text, label: text, edit: { text } }],
      };
      let published: ReturnType<ComposerCompletionProps["publish"]> = false;
      act(() => {
        published = request(result);
      });
      return published;
    },
    replaceCompletionProvider() {
      act(() => {
        completions = [completion("2")];
        for (const listener of completionListeners) listener();
      });
    },
    retarget(next: Partial<MessageComposerProps>) {
      const changedSession =
        (next.session !== undefined && next.session !== props.session) ||
        (next.scope !== undefined && next.scope !== props.scope);
      props = { ...props, ...next };
      if (changedSession) bindChoices();
      view.rerender(tree());
    },
    setProfiles(next: ReadonlyMap<string, Profile>) {
      act(() => {
        profiles = next;
        for (const listener of profileListeners) listener();
      });
    },
    setLibrary(identities: AgentLibrarySnapshot["identities"]) {
      act(() => {
        library = { ...library, identities };
        for (const listener of libraryListeners) listener();
      });
    },
    setEmoji(entries: readonly CustomEmoji[]) {
      act(() => {
        emoji = { status: "ready", entries };
        for (const listener of emojiListeners) listener();
      });
    },
    fill(text: string) {
      const field = input();
      act(() => {
        field.focus();
        field.value = text;
        field.setSelectionRange(text.length, text.length);
      });
      fireEvent.input(field);
      // Browsers queue selectionchange after the editor restores its native
      // selection. Deliver that boundary explicitly in this synchronous fixture.
      fireEvent(document, new Event("selectionchange"));
    },
    submit() {
      fireEvent.submit(within(view.container).getByRole("form"));
    },
  };
}

it("shows a local draft in the cached composer without completion, typing or transport reads", async () => {
  const viewer = keypair(),
    relay = keypair();
  const query = vi.fn(async () => []);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
    },
    {
      cachedOnly: true,
      prepared: true,
      persistence: {
        readStartup: async () => ({
          discovery: {
            savedAt: Date.now(),
            relayAuthor: relay.pubkey,
            events: [
              roster(relay, "channel", [viewer.pubkey]),
              metadata(relay, "channel", "General"),
            ],
          },
        }),
        read: async () => [],
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close() {},
      },
    },
  );
  await owner.restore();
  writeView("cached-composer", "draft:channel", "!Saved draft");
  const typing = vi.fn(owner.session.typing.subscribe);
  const h = mount({
    session: {
      ...owner.session,
      typing: { ...owner.session.typing, subscribe: typing },
    },
    scope: "cached-composer",
  });
  try {
    expect(h.input()).toHaveValue("!Saved draft");
    expect(h.input()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByText(/does not support sending/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.focus(h.input());
    fireEvent(document, new Event("selectionchange"));
    h.submit();
    await act(async () => {}); // Flush mounted effects before the negative assertions.
    expect(h.completionRequests).toEqual([]);
    expect(typing).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(h.input()).toHaveValue("!Saved draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    h.unmount();
    owner.dispose();
  }
});

it("autofocuses each selected conversation once without stealing focus on updates", () => {
  const h = mount({ autoFocus: true });
  expect(h.input()).toHaveFocus();
  const other = document.createElement("button");
  document.body.append(other);
  try {
    other.focus();
    h.retarget({ channelName: "Renamed", autoFocus: false });
    h.retarget({ autoFocus: true });
    expect(other).toHaveFocus();
    h.retarget({ channelId: "another-channel" });
    expect(h.input()).toHaveFocus();
    h.retarget({ channelId: "keyboard-navigation" });
    expect(h.input()).toHaveFocus();
  } finally {
    other.remove();
  }
});

it("restores the draft end through StrictMode replay without resetting a deliberate selection on updates", () => {
  writeView("scope", "draft:channel", "Saved draft");
  const h = mount({ autoFocus: true });
  expect(h.input()).toHaveFocus();
  expect(h.input().selectionStart).toBe("Saved draft".length);
  expect(h.input().selectionEnd).toBe("Saved draft".length);
  act(() => h.input().setSelectionRange(1, 4));
  h.retarget({ channelName: "Renamed" });
  expect(h.input().selectionStart).toBe(1);
  expect(h.input().selectionEnd).toBe(4);
  h.retarget({ channelId: "other" });
  h.retarget({ channelId: "channel" });
  expect(h.input()).toHaveFocus();
  expect(h.input().selectionStart).toBe("Saved draft".length);
});

it("lets an explicit focus restoration in the mount commit win", () => {
  const h = mount();
  h.unmount();
  const target = document.createElement("button");
  document.body.append(target);
  function RestoreFocus() {
    useLayoutEffect(() => target.focus(), []);
    return null;
  }
  try {
    render(
      <>
        <MessageComposer
          session={h.session}
          scope="scope"
          channelId="channel"
          channelName="General"
          autoFocus
        />
        <RestoreFocus />
      </>,
      { reactStrictMode: true },
    );
    expect(target).toHaveFocus();
  } finally {
    target.remove();
  }
});

it("leaves focus alone unless an enabled composer opts into mount focus", () => {
  const h = mount();
  expect(h.input()).not.toHaveFocus();
  h.retarget({
    channelId: "disabled-channel",
    disabled: true,
    autoFocus: true,
  });
  expect(h.input()).not.toHaveFocus();
});

it("keeps unpublished completions invisible but lets Escape revoke pending work", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!pending");
  const pending = h.completionRequests.length - 1;
  expect(pending).toBeGreaterThanOrEqual(0);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-controls");
  expect(input).not.toHaveAttribute("aria-haspopup");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(h.publish(pending, "late result")).toBe(false);
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(input).toHaveValue("!pending");

  h.fill("!fresh");
  expect(h.publish(h.completionRequests.length - 1)).not.toBe(false);
  expect(screen.getByRole("option", { name: "chosen" })).toBeVisible();
  expect(input).toHaveAttribute("aria-controls");
});

it("shows provider-owned pending and retry states and hides an empty publication", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!search");
  const publish = h.completionRequests.at(-1);
  if (!publish) throw new Error("No observed completion request");
  act(() => {
    publish({ items: [], status: "Searching fixture…" });
  });
  expect(screen.getByRole("status")).toHaveTextContent("Searching fixture…");
  const retry = vi.fn(() =>
    publish({
      items: [
        { id: "recovered", label: "Recovered", edit: { text: "recovered" } },
      ],
    }),
  );
  act(() => {
    publish({ items: [], status: "Unavailable", retry });
  });
  expect(
    screen.getByRole("option", { name: "Retry suggestions" }),
  ).toBeVisible();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("option", { name: "Recovered" })).toBeVisible();
  expect(h.messages.send).not.toHaveBeenCalled();
  act(() => {
    publish({ items: [] });
  });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-controls");
});

it("revokes stale completion publications across editor and ownership lifecycles and recovers freshly", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!a");
  const edit = h.completionRequests.length - 1;
  h.fill("!b");
  h.fill("!a");
  expect(h.publish(edit, "stale ABA")).toBe(false);
  const afterAba = h.completionRequests.length - 1;
  expect(h.publish(afterAba)).not.toBe(false);
  expect(screen.getByRole("option", { name: "chosen" })).toBeVisible();

  fireEvent.keyDown(input, { key: "Escape" });
  expect(h.publish(afterAba, "stale dismissal")).toBe(false);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

  h.fill("!provider");
  const oldProvider = h.completionRequests.length - 1;
  h.replaceCompletionProvider();
  expect(h.publish(oldProvider, "stale provider")).toBe(false);
  const replacement = h.completionRequests.length - 1;
  expect(h.publish(replacement, "replacement fresh")).not.toBe(false);
  expect(
    screen.getByRole("option", { name: "replacement fresh" }),
  ).toBeVisible();

  h.fill("!destination");
  const oldDestination = h.completionRequests.length - 1;
  h.retarget({ threadRootId: "root" });
  expect(h.input()).toHaveValue("");
  expect(h.publish(oldDestination, "stale destination")).toBe(false);
  h.input().focus();
  h.fill("!fresh");
  const fresh = h.completionRequests.length - 1;
  expect(h.publish(fresh, "fresh recovery")).not.toBe(false);
  expect(screen.getByRole("option", { name: "fresh recovery" })).toBeVisible();

  h.unmount();
  expect(h.publish(fresh, "stale unmount")).toBe(false);
});

it.each(["disabled", "readOnly"] as const)(
  "rejects late and displayed completion results when the editor becomes %s",
  (state) => {
    const h = mount();
    const input = h.input();
    input.focus();
    h.fill("!late");
    const late = h.completionRequests.length - 1;
    if (state === "disabled") {
      h.retarget({ disabled: true });
      expect(input).toHaveAttribute("aria-disabled", "true");
      expect(input).toHaveAttribute("contenteditable", "false");
    } else input.readOnly = true;
    expect(h.publish(late, "late result")).toBe(false);

    if (state === "disabled") h.retarget({ disabled: false });
    else input.readOnly = false;
    expect(h.input().disabled).toBe(false);
    expect(h.input().readOnly).toBe(false);
    h.input().focus();
    h.fill("!displayed");
    const displayed = h.completionRequests.length - 1;
    expect(h.publish(displayed, "displayed choice")).not.toBe(false);
    expect(
      screen.getByRole("option", { name: "displayed choice" }),
    ).toBeVisible();
    if (state === "disabled") h.retarget({ disabled: true });
    else h.input().readOnly = true;
    fireEvent.keyDown(h.input(), { key: "Enter" });
    expect(h.input()).toHaveValue("!displayed");
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it("sends channel messages and thread replies through real form and keyboard events", async () => {
  const h = mount();
  await h.user.type(h.input(), "channel draft");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "channel draft",
    [],
    [],
  );
  expect(h.messages.reply).not.toHaveBeenCalled();
  h.retarget({ threadRootId: "root" });
  await h.user.type(h.input(), "thread draft");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(h.input()).toHaveValue("thread draft\n");
  // This checks the composition guard, not native IME behavior.
  fireEvent.keyDown(h.input(), { key: "Enter", isComposing: true });
  expect(h.messages.reply).not.toHaveBeenCalled();
  await h.user.keyboard("{Enter}");
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "thread draft\n",
    [],
    [],
  );
  expect(h.messages.send).toHaveBeenCalledTimes(1);
  expect(h.onSend.mock.calls).toEqual([["channel-id"], ["reply-id"]]);
  expect(h.input()).toHaveValue("");
});

it("prefixes thread replies with the selected media time and clears it after send", async () => {
  const clearMediaTime = vi.fn();
  const h = mount({
    threadRootId: "root",
    mediaTimeSeconds: 72.8,
    clearMediaTime,
  });
  expect(screen.getByText("Commenting at 1:12")).toBeVisible();
  await h.user.type(h.input(), "trim this ");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "⏱ 1:12 — trim this",
    [],
    [],
  );
  expect(clearMediaTime).toHaveBeenCalledOnce();
  expect(h.input()).toHaveValue("");
});

it("lets the visible media time indicator dismiss without sending", async () => {
  const clearMediaTime = vi.fn();
  const h = mount({
    threadRootId: "root",
    mediaTimeSeconds: 12,
    clearMediaTime,
  });
  await h.user.click(screen.getByRole("button", { name: "Remove video time" }));
  expect(clearMediaTime).toHaveBeenCalledOnce();
  expect(h.messages.reply).not.toHaveBeenCalled();
});

it("hides the media time indicator while keeping the send prefix", async () => {
  const clearMediaTime = vi.fn();
  const h = mount({
    threadRootId: "root",
    mediaTimeSeconds: 12,
    clearMediaTime,
    hideMediaTimeIndicator: true,
  });
  expect(screen.queryByText("Commenting at 0:12")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Remove video time" }),
  ).not.toBeInTheDocument();
  await h.user.type(h.input(), "hidden frame");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "⏱ 0:12 — hidden frame",
    [],
    [],
  );
  expect(clearMediaTime).toHaveBeenCalledOnce();
});

it("isolates channel, thread and identity drafts through retargeting and remounting", () => {
  const h = mount();
  h.fill("channel draft");
  h.retarget({ threadRootId: "one" });
  expect(h.input()).toHaveValue("");
  h.fill("first thread");
  h.retarget({ threadRootId: "two" });
  h.fill("second thread");
  h.retarget({ threadRootId: "one", scope: "other identity" });
  expect(h.input()).toHaveValue("");
  h.fill("other identity");
  h.retarget({ threadRootId: "one", scope: "scope" });
  expect(h.input()).toHaveValue("first thread");
  h.retarget({ threadRootId: "two" });
  expect(h.input()).toHaveValue("second thread");
  h.unmount();
  const restored = mount();
  expect(restored.input()).toHaveValue("channel draft");
  restored.retarget({ threadRootId: "one", scope: "other identity" });
  expect(restored.input()).toHaveValue("other identity");
});

it("retains rejected intent and clears the draft only after the outbox accepts it", async () => {
  const h = mount({ threadRootId: "root" });
  h.fill("retry me");
  h.messages.reply.mockImplementationOnce(() => {
    throw new Error("outbox full");
  });
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.input()).toHaveValue("retry me");
  expect(h.onSend).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("outbox full");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledTimes(2);
  expect(h.input()).toHaveValue("");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("labels simultaneous composers independently and prevents disabled or unsupported writes", async () => {
  const channel = mount();
  const thread = mount({ threadRootId: "root" });
  expect(screen.getByLabelText("Message #General")).toBe(channel.input());
  expect(screen.getByRole("textbox", { name: "Reply to thread" })).toBe(
    thread.input(),
  );
  expect(thread.input().id).not.toBe(channel.input().id);
  thread.fill("retain me");
  thread.retarget({ disabled: true });
  expect(thread.input()).toHaveAttribute("aria-disabled", "true");
  expect(thread.input()).toHaveAttribute("contenteditable", "false");
  await thread.user.click(
    within(thread.container).getByRole("button", { name: "Send message" }),
  );
  expect(thread.messages.reply).not.toHaveBeenCalled();
  expect(thread.input()).toHaveValue("retain me");
  thread.retarget({
    session: {
      ...thread.session,
      outbox: { supports: () => false },
    } as unknown as RelaySession,
  });
  expect(
    within(thread.container).queryByRole("textbox"),
  ).not.toBeInTheDocument();
  expect(
    within(thread.container).getByText(
      "This relay connection supports reading only.",
    ),
  ).toBeVisible();
});

it("subscribes to emoji changes and releases the subscription when unmounted", () => {
  const h = mount();
  h.fill(":party:");
  expect(h.input().querySelectorAll("img[alt=':party:']")).toHaveLength(0);
  expect(h.emojiListeners.size).toBe(1);
  expect(h.session.emoji.ensure).toHaveBeenCalled();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  expect(h.input().querySelectorAll("img[alt=':party:']")).toHaveLength(1);
  h.setEmoji([]);
  expect(h.input().querySelectorAll("img[alt=':party:']")).toHaveLength(0);
  h.unmount();
  expect(h.emojiListeners.size).toBe(0);
});

it("enlarges Unicode-only drafts and restores normal text presentation", () => {
  const h = mount();
  for (const draft of ["😀", "😀 🙏 👏", "😀 🙏 👏 😄"]) {
    h.fill(draft);
    expect(h.input()).toHaveAttribute("data-single-emoji", "true");
    h.fill(`${draft} hello`);
    expect(h.input()).not.toHaveAttribute("data-single-emoji");
  }
});

it.each([undefined, "root"])(
  "persists exact namesake recipients for %s without resolving typed prose",
  async (root) => {
    const options = root ? { threadRootId: root } : {};
    let h = mount(options);
    h.fill("@Honey prose only");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.[root ? 3 : 2],
    ).toEqual([]);
    h.fill("Please help ");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
    h.unmount();
    h = mount(options);
    expect(h.input()).toHaveValue("Please help @Honey @Honey ");
    expect(
      within(h.input()).getAllByRole("img", {
        name: /^Person Honey, public key ending/,
      }),
    ).toHaveLength(2);
    expect(
      within(
        screen.getByRole("region", { name: "Explicit mentions" }),
      ).getAllByRole("button"),
    ).toHaveLength(2);
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.[root ? 3 : 2],
    ).toEqual([first.pubkey, second.pubkey]);
    expect(h.input()).toHaveValue("");
    h.unmount();
    h = mount(options);
    h.fill("@Honey typed after send");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.[root ? 3 : 2],
    ).toEqual([]);
  },
);

it("restores live profile avatars with one removal control per exact recipient", async () => {
  const h = mount();
  const media = vi
    .spyOn(h.session, "media")
    .mockImplementation((url) =>
      url ? `https://media.test/${url}` : undefined,
    );
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertMention(second);
    h.commands().insertMention(second);
  });
  let region = screen.getByRole("region", {
    name: "Explicit mentions",
  });
  const controls = within(region).getAllByRole("button");
  expect(controls).toHaveLength(2);
  expect(controls[1]).toHaveTextContent("H");
  // Profiles can arrive after draft restoration; artwork must update without an edit.
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", picture: "person.png" }],
      [second.pubkey, { name: "Honey", picture: "agent.png", isAgent: true }],
    ]),
  );
  expect(controls[0]?.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  expect(controls[1]?.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(controls[1]?.querySelector("img")).toHaveAttribute(
    "src",
    "https://media.test/agent.png",
  );
  expect(media).toHaveBeenCalledWith("agent.png", "small");
  // Loaded-library hints update both artwork layers without another keystroke;
  // clearing them removes only that fallback, not self-declared agent metadata.
  for (const control of controls)
    expect(control.querySelectorAll("[data-avatar-shape]")).toHaveLength(2);
  for (const identities of [[first], []]) {
    h.setLibrary(identities);
    for (const [index, control] of controls.entries())
      for (const artwork of control.querySelectorAll("[data-avatar-shape]"))
        expect(artwork).toHaveAttribute(
          "data-avatar-shape",
          index === 1 || identities.length ? "squircle" : "circle",
        );
  }
  expect(h.session.agentLibrary.refresh).not.toHaveBeenCalled();
  h.retarget({ disabled: true });
  for (const control of controls) expect(control).toBeDisabled();
  h.retarget({ disabled: false, extensions: undefined });
  // The optional picker does not own saved intent or its removal controls.
  region = screen.getByRole("region", { name: "Explicit mentions" });
  await h.user.click(
    within(region).getByRole("button", {
      name: `Remove mention Honey ${second.pubkey}`,
    }),
  );
  expect(within(region).getAllByRole("button")).toHaveLength(1);
  expect(h.input()).toHaveValue("@Honey @Honey @Honey ");
  expect(h.input().querySelectorAll(".inline-chip")).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    "@Honey @Honey @Honey ",
    [first.pubkey],
    [],
  );
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).not.toBeInTheDocument();
});

// Explicit notification intent must remain visible even where Markdown previews are suppressed.
it.each([
  ["inline code", "`", " `"],
  ["fenced code", "```\n", "\n```"],
  ["indented code", "    ", ""],
  ["image", "![", "](https://example.test/image.png)"],
  [
    "image reference",
    "![",
    "][image]\n\n[image]: https://example.test/image.png",
  ],
  ["definition", '[image]: https://example.test/image.png "', '"'],
  ["HTML", "<!-- ", " -->"],
  ["link label", "[", "](https://example.test)"],
  ["deep Markdown", "> ".repeat(101), ""],
])(
  "discloses selected namesakes in %s before and after restoring a draft",
  (_kind, prefix, suffix) => {
    let h = mount();
    h.fill(`${prefix}@Honey ${suffix}`);
    expect(h.input().querySelector(".inline-chip")).toBeNull();
    h.submit();
    expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([]);
    h.fill(`${prefix}${suffix}`);
    h.input().setSelectionRange(prefix.length, prefix.length);
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertMention(second);
    });
    const text = `${prefix}@Honey @Honey ${suffix}`;
    const labels = [
      "Person Honey, public key ending r c a j",
      "Person Honey, public key ending 0 4 h u",
    ];
    const check = () => {
      expect(h.input()).toHaveValue(text);
      for (const name of labels)
        expect(within(h.input()).getByRole("img", { name })).toBeVisible();
    };
    check();
    h.unmount();
    h = mount();
    check();
    h.submit();
    expect(h.messages.send).toHaveBeenCalledWith(
      "channel",
      text,
      [first.pubkey, second.pubkey],
      [],
    );
  },
);

it.each([undefined, "root"])(
  "keeps an untouched mention when smart punctuation replaces text behind the caret in %s",
  async (root) => {
    const h = mount(root ? { threadRootId: root } : {});
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertText("can you see this is's");
    });
    const input = h.input();
    const paragraph = input.querySelector("p");
    if (!paragraph) throw new Error("Missing editor paragraph");
    const text = [...paragraph.childNodes].find(
      (node) => node instanceof Text && node.data.includes("is's"),
    );
    if (!(text instanceof Text)) throw new Error("Missing editable text");
    const quote = text.data.indexOf("'");
    expect(quote).toBeGreaterThan(0);
    const target = document.createRange();
    target.setStart(text, quote);
    target.setEnd(text, quote + 1);
    // WebKit's replacement range is behind the caret, not the selection.
    act(() => input.setSelectionRange(input.value.length, input.value.length));
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: "’",
    });
    Object.defineProperty(before, "getTargetRanges", {
      value: () => [target],
    });
    fireEvent(input, before);
    text.replaceData(quote, 1, "’");
    fireEvent.input(input, {
      inputType: "insertReplacementText",
      data: "’",
    });
    await waitFor(() =>
      expect(input).toHaveValue("@Honey can you see this is’s"),
    );
    expect(
      within(input).getByRole("img", { name: "Person Honey" }),
    ).toBeVisible();
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.[root ? 3 : 2],
    ).toEqual([first.pubkey]);
  },
);

it("qualifies both namesakes retroactively without changing source and removes qualifiers with ambiguity", () => {
  const h = mount();
  act(() => {
    h.commands().insertMention(first);
  });
  expect(
    within(h.input()).getByRole("img", { name: "Person Honey" }),
  ).toBeVisible();
  act(() => {
    h.commands().insertMention(first);
  });
  expect(h.input().textContent).not.toContain("npub");
  act(() => {
    h.commands().insertMention(second);
  });
  expect(h.input()).toHaveValue("@Honey @Honey @Honey ");
  expect(
    within(h.input()).getAllByRole("img", {
      name: "Person Honey, public key ending r c a j",
    }),
  ).toHaveLength(2);
  expect(
    within(h.input()).getByRole("img", {
      name: "Person Honey, public key ending 0 4 h u",
    }),
  ).toHaveTextContent("Honey · 04hu");
  h.input().setSelectionRange(14, 20);
  act(() => {
    h.commands().insertText("");
  });
  expect(h.input()).toHaveValue("@Honey @Honey  ");
  expect(h.input().textContent).not.toContain("npub");
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    "@Honey @Honey  ",
    [first.pubkey, first.pubkey],
    [],
  );
});

it.each([0, 7])(
  "does not replay qualifier motion after removing at %i or restoring a destination draft",
  (start) => {
    const h = mount();
    act(() => {
      h.commands().insertMention(first);
    });
    act(() => {
      h.commands().insertMention(second);
    });
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(1);
    h.input().setSelectionRange(start, start + 6);
    act(() => {
      h.commands().insertText("");
    });
    act(() => {
      h.commands().insertMention(start === 0 ? first : second);
    });
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(0);
    h.retarget({ channelId: "other" });
    act(() => {
      h.commands().insertMention(first);
    });
    h.retarget({ channelId: "channel" });
    expect(h.input().querySelectorAll(".inline-chip-qualifier")).toHaveLength(
      2,
    );
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(0);
  },
);

it("replacing an inline mention with ordinary prose removes notification intent", async () => {
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  expect(
    screen.getByRole("region", { name: "Explicit mentions" }),
  ).toBeVisible();
  h.fill("no recipient now");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([]);
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  expect(
    within(h.input()).getByRole("img", { name: "Person Honey" }),
  ).toBeVisible();
  h.input().setSelectionRange(0, 6);
  act(() => {
    h.commands().insertText("Honey");
  });
  expect(within(h.input()).queryByRole("img")).not.toBeInTheDocument();
  h.submit();
  expect(h.messages.send.mock.calls[1]?.[2]).toEqual([]);
});

it("ambiguous namesake replacement cannot notify the wrong remaining identity", async () => {
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  h.fill("@Honey help");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([]);
});

it("serializes tool commands in one React batch and rejects malformed recipients", () => {
  const h = mount();
  h.fill("Hi ");
  act(() => {
    const { insertText, insertMention } = h.commands();
    expect(insertText("there ")).toBe(true);
    expect(insertMention(first)).toBe(true);
    expect(insertText("and ")).toBe(true);
    expect(insertMention(second)).toBe(true);
    expect(insertMention({ pubkey: "wrong", name: "Honey" })).toBe(false);
    expect(insertMention({ ...first, name: "  " })).toBe(false);
    expect(insertMention(null as unknown as typeof first)).toBe(false);
  });
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "Hi there @Honey and @Honey ",
    [first.pubkey, second.pubkey],
    [],
  );
});

it("revokes captured tool commands after retargeting, disabling and unmounting", () => {
  const h = mount();
  h.fill("channel draft");
  const channel = h.commands();
  h.retarget({ threadRootId: "root" });
  act(() => {
    expect(channel.insertText("stale")).toBe(false);
    expect(channel.insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue("");
  const thread = h.commands();
  h.retarget({ disabled: true });
  act(() => {
    expect(thread.insertText("disabled")).toBe(false);
  });
  h.retarget({ disabled: false });
  act(() => {
    expect(h.commands().insertText("current")).toBe(true);
  });
  expect(h.input()).toHaveValue("current");
  const current = h.commands();
  h.unmount();
  act(() => {
    expect(current.insertText("unmounted")).toBe(false);
  });
});

it("keeps custom emoji text readable and sends repeated shortcodes unchanged", () => {
  const h = mount();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  act(() => {
    expect(h.commands().insertText(":party:")).toBe(true);
  });
  expect(h.input()).toHaveValue(":party:");
  expect(h.input()).toHaveAttribute("data-single-emoji", "true");
  act(() => {
    expect(h.commands().insertText(":party:")).toBe(true);
  });
  expect(h.input()).toHaveValue(":party::party:");
  expect(h.input().querySelectorAll("img[alt=':party:']")).toHaveLength(2);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":party::party:",
    [],
    [],
  );
});

it("renders a leading custom emoji inline without changing trailing text", () => {
  const h = mount();
  h.setEmoji([{ shortcode: "bufo", url: "https://emoji.test/bufo.png" }]);
  h.fill(":bufo:lakjsdlkjflakjsdf");
  expect(h.input()).not.toHaveAttribute("data-single-emoji");
  expect(h.input()).toHaveValue(":bufo:lakjsdlkjflakjsdf");
  expect(h.container.querySelectorAll("img")).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":bufo:lakjsdlkjflakjsdf",
    [],
    [],
  );
});

it("rejects overlong and over-limit tool edits without changing accepted intent", () => {
  const h = mount();
  h.fill("x".repeat(15999));
  act(() => {
    expect(h.commands().insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue("x".repeat(15999));
  expect(screen.getByRole("alert")).toHaveTextContent("too long");
  h.fill("");
  act(() => {
    for (let i = 0; i < 32; i++)
      expect(h.commands().insertMention(first)).toBe(true);
  });
  const before = h.input().value;
  act(() => {
    expect(h.commands().insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue(before);
  expect(screen.getByRole("alert")).toHaveTextContent("at most 32 recipients");
});

// The production composer must perform enrollment, not a pre-populated test roster.
for (const threadRootId of [undefined, "f".repeat(64)])
  it(`adds a selected local agent only on Send, then sends after membership confirmation (thread=${!!threadRootId})`, async () => {
    const f = controlFixture();
    f.agent.pubkey = first.pubkey;
    const control = createAgentControl(f.host);
    await control.refresh();
    const h = mount(
      {
        scope: `https://relay.example.test:${"d".repeat(64)}`,
        ...(threadRootId ? { threadRootId } : {}),
      },
      control,
    );
    const channel = {
      id: "channel",
      name: "General",
      channelType: "stream" as const,
      members: ["d".repeat(64)],
    };
    const listeners = new Set<() => void>();
    // An acknowledged old invitation does not replace this explicit addition.
    const invitation: OutgoingEvent = {
      acknowledged: true,
      delivery: "failed",
      event: {
        id: "c".repeat(64),
        pubkey: "d".repeat(64),
        kind: 9000,
        content: "",
        created_at: Math.floor(Date.now() / 1000) - 16 * 60,
        tags: [
          ["h", "channel"],
          ["p", first.pubkey],
        ],
      },
    };
    let operations: readonly OutgoingEvent[] = [invitation];
    const retry = vi.fn();
    const add = vi.fn((input) => {
      operations = [
        {
          event: {
            ...input,
            pubkey: "d".repeat(64),
            id: "e".repeat(64),
            created_at: Math.floor(Date.now() / 1000),
          },
          delivery: "sending",
        },
      ];
      return "e".repeat(64);
    });
    const list = { status: "ready", channels: [channel] };
    Object.assign(h.session, {
      channels: { list: () => list, subscribeList: () => () => {} },
      viewer: "d".repeat(64),
      archives: { state: () => "not-archived" },
      workSessions: {
        refreshMembership: vi.fn(async () => {
          if (operations[0]?.delivery === "accepted")
            channel.members = [...channel.members, first.pubkey];
          return channel;
        }),
      },
      outbox: {
        supports: () => true,
        send: add,
        retry,
        ready: async () => {},
        recover: async () => {},
        acknowledge: async () => {},
        snapshot: () => operations,
        subscribe: (fn: () => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    });
    Object.assign(h.session, {
      memberAdditions: createMemberAdditions(
        new AbortController().signal,
        (channelId, key, intent) =>
          addChannelMember(
            h.session,
            channelId,
            key,
            new AbortController().signal,
            intent,
          ),
        vi.fn(),
      ),
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
      expect(add).not.toHaveBeenCalled();
      fireEvent.submit(screen.getByRole("form"));
      await act(async () => {});
      expect(add).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Invite" }));
      await act(async () => {});
      expect(add).toHaveBeenCalledWith(
        {
          kind: 9000,
          content: "",
          tags: [
            ["h", "channel"],
            ["p", first.pubkey],
            ["role", "bot"],
          ],
        },
        { key: `member-add:channel:${first.pubkey}`, value: "1" },
      );
      expect(h.messages.send).not.toHaveBeenCalled();
      expect(h.messages.reply).not.toHaveBeenCalled();
      await act(async () => {
        operations = operations.map((item) => ({
          ...item,
          delivery: "accepted",
        }));
        for (const listener of listeners) listener();
      });
      const send = threadRootId ? h.messages.reply : h.messages.send;
      expect(send).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(send.mock.calls[0]?.[threadRootId ? 3 : 2]).toEqual([
        first.pubkey,
      ]);
      // Native evidence now shares the ordinary remember-agent classification.
      expect(h.input().value).toBe("@Honey ");
    } finally {
      control.dispose();
    }
  });

it.each([false, true])(
  "keeps the selected draft on an enrollment error (expired=%s) without sending the message",
  async (expired) => {
    const f = controlFixture();
    f.agent.pubkey = first.pubkey;
    const control = createAgentControl(f.host);
    await control.refresh();
    const h = mount(
      { scope: `https://relay.example.test:${"d".repeat(64)}` },
      control,
    );
    const add = vi.fn(() => {
      throw new Error("Cannot add agent");
    });
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    const operations = expired
      ? [
          {
            delivery: "failed",
            event: {
              id: "e".repeat(64),
              kind: 9000,
              created_at: Math.floor(Date.now() / 1000) - 16 * 60,
              tags: [
                ["h", "channel"],
                ["p", first.pubkey],
                ["role", "bot"],
              ],
            },
          },
        ]
      : [];
    Object.assign(h.session, {
      channels: { list: () => list, subscribeList: () => () => {} },
      viewer: "d".repeat(64),
      archives: { state: () => "not-archived" },
      workSessions: { refreshMembership: async () => list.channels[0] },
      outbox: {
        supports: () => true,
        send: add,
        snapshot: () => operations,
        ready: async () => {},
        recover: async () => {},
        acknowledge: async () => {},
      },
    });
    Object.assign(h.session, {
      memberAdditions: createMemberAdditions(
        new AbortController().signal,
        (channelId, key, intent) =>
          addChannelMember(
            h.session,
            channelId,
            key,
            new AbortController().signal,
            intent,
          ),
        vi.fn(),
      ),
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
      fireEvent.submit(screen.getByRole("form"));
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Invite" }));
      await act(async () => {});
      expect(screen.getByRole("alert")).toHaveTextContent(
        expired ? "addition expired" : "Cannot add agent",
      );
      expect(
        (screen.getByRole("textbox", { hidden: true }) as HTMLInputElement)
          .value,
      ).toBe("@Honey ");
      expect(h.messages.send).not.toHaveBeenCalled();
      if (expired) expect(add).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await act(async () => {});
      expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      control.dispose();
    }
  },
);

it.each(
  ["send", "unmount", "disabled", "denied"].flatMap((outcome) =>
    ["mention", "avatar"].flatMap((recipient) =>
      [true, false].map((parent) => ({
        outcome,
        recipient,
        parent,
      })),
    ),
  ),
)(
  "waits for agent admission before saved session messages: $recipient / $outcome / parent=$parent",
  async ({ outcome, recipient, parent }) => {
    const view = mount();
    const list = {
      status: "ready",
      channels: [
        {
          id: "channel",
          channelType: "session",
          ...(parent ? { parentChannelId: "parent" } : {}),
          members: [] as string[],
        },
      ],
    };
    const library = { status: "ready", definitions: [], identities: [first] };
    let release = () => {};
    const addAgents = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          release = () => {
            if (outcome === "denied") reject(new Error("Cannot add agents"));
            else {
              list.channels[0]?.members.push(first.pubkey);
              resolve();
            }
          };
        }),
    );
    const session = {
      ...view.session,
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
        refresh: async () => {},
        retain: () => () => {},
      },
      workSessions: {
        addAgents,
        refreshMembership: vi.fn(async () => list.channels[0]),
      },
    } as unknown as RelaySession;
    view.retarget({ session, sessionConversation: true });
    expect(view.commands().inviteAgents).toBe(true);
    if (recipient === "mention") {
      await view.user.click(
        screen.getByRole("button", { name: "First Honey" }),
      );
    } else {
      await view.user.type(view.input(), "Hello Honey");
      await view.user.click(
        screen.getByRole("button", { name: "Choose an agent" }),
      );
      await view.user.click(
        await screen.findByRole("menuitemradio", {
          name: parent
            ? "Honey Adds to session and channel"
            : "Honey Adds to session",
        }),
      );
    }
    expect(addAgents).not.toHaveBeenCalled();
    expect(session.workSessions.refreshMembership).not.toHaveBeenCalled();
    expect(view.messages.send).not.toHaveBeenCalled();
    view.submit();
    await waitFor(() =>
      expect(addAgents).toHaveBeenCalledWith(
        "channel",
        [first.pubkey],
        expect.any(Function),
      ),
    );
    expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "unmount") view.unmount();
    if (outcome === "disabled") view.retarget({ disabled: true });
    await act(async () => release());
    if (outcome === "send") {
      await waitFor(() => expect(view.messages.send).toHaveBeenCalledOnce());
      expect(addAgents).toHaveBeenCalledOnce();
    } else expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "denied") {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Cannot add agents",
      );
      expect(view.input()).toHaveTextContent("Honey");
    }
  },
);

it.each(
  [undefined, "root"].flatMap((root) =>
    [false, true].map((removeMention) => ({ root, removeMention })),
  ),
)(
  "resolves a sole session agent before send/reply: root=$root, removed=$removeMention",
  async ({ root, removeMention }) => {
    const view = mount();
    const channel = {
      id: "channel",
      channelType: "session" as const,
      members: [first.pubkey],
    };
    const list = { status: "ready" as const, channels: [channel] };
    const library = {
      status: "ready" as const,
      definitions: [],
      identities: [first],
    };
    const session = {
      ...view.session,
      viewer: "viewer",
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
        refresh: vi.fn(async () => {}),
      },
      workSessions: {
        refreshMembership: vi.fn(async () => channel),
        addAgents: vi.fn(async () => {}),
      },
    } as unknown as RelaySession;
    view.retarget({
      session,
      sessionConversation: true,
      ...(root ? { threadRootId: root } : {}),
    });
    view.fill("Keep going ");
    if (removeMention) {
      await view.user.click(
        screen.getByRole("button", { name: "First Honey" }),
      );
      const remove = screen.getByRole("button", {
        name: `Remove mention Honey ${first.pubkey}`,
      });
      await view.user.hover(remove);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Remove explicit mention of Honey (aaaaaaaa)",
      );
      await view.user.click(remove);
      expect(view.input()).toHaveValue("Keep going @Honey ");
      expect(view.input().querySelector(".inline-chip")).toBeNull();
      expect(
        screen.queryByRole("region", { name: "Explicit mentions" }),
      ).not.toBeInTheDocument();
    }
    view.submit();
    await waitFor(() =>
      expect(
        root ? view.messages.reply : view.messages.send,
      ).toHaveBeenCalled(),
    );
    if (root)
      expect(view.messages.reply).toHaveBeenCalledExactlyOnceWith(
        "channel",
        root,
        removeMention ? "Keep going @Honey " : "Keep going ",
        [first.pubkey],
        [],
      );
    else
      expect(view.messages.send).toHaveBeenCalledExactlyOnceWith(
        "channel",
        removeMention ? "Keep going @Honey " : "Keep going ",
        [first.pubkey],
        [],
      );
    expect(session.workSessions.addAgents).not.toHaveBeenCalled();
  },
);

it("routes to the avatar choice and lets an explicit mention override it", async () => {
  const view = mount();
  const library = {
    status: "ready",
    definitions: [],
    identities: [first, { ...second, name: "Fizz" }],
  };
  const list = {
    status: "ready",
    channels: [
      {
        id: "channel",
        channelType: "session",
        members: [first.pubkey, second.pubkey],
      },
    ],
  };
  const session = {
    ...view.session,
    channels: { list: () => list, subscribeList: () => () => {} },
    workSessions: {
      refreshMembership: vi.fn(async () => list.channels[0]),
      addAgents: vi.fn(async () => {}),
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  } as unknown as RelaySession;
  view.retarget({ session, sessionConversation: true });
  await view.user.click(
    screen.getByRole("button", { name: "Choose an agent" }),
  );
  await view.user.click(
    await screen.findByRole("menuitemradio", { name: "Fizz" }),
  );
  await view.user.type(view.input(), "Hello");
  await view.user.keyboard("{Enter}");
  expect(view.messages.send).toHaveBeenLastCalledWith(
    "channel",
    "Hello",
    [second.pubkey],
    [],
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Change agent: Fizz" }),
    ).toBeEnabled(),
  );
  await view.user.click(screen.getByRole("button", { name: "First Honey" }));
  view.submit();
  await waitFor(() =>
    expect(view.messages.send).toHaveBeenLastCalledWith(
      "channel",
      expect.any(String),
      [first.pubkey],
      [],
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  // The remembered explicit mention still overrides the picker until removed.
  expect(view.input()).toHaveValue("@Honey ");
  await view.user.click(
    screen.getByRole("button", {
      name: `Remove mention Honey ${first.pubkey}`,
    }),
  );
  expect(view.input()).toHaveValue("@Honey ");
  expect(view.input().querySelector(".inline-chip")).toBeNull();
  view.submit();
  await waitFor(() =>
    expect(view.messages.send).toHaveBeenLastCalledWith(
      "channel",
      "@Honey ",
      [second.pubkey],
      [],
    ),
  );
  expect(session.workSessions.addAgents).not.toHaveBeenCalled();
});

it.each(["ready", "failed", "unmounted"])(
  "refreshes cached membership before sending an existing mention: %s",
  async (outcome) => {
    const view = mount();
    const channel = {
      id: "channel",
      channelType: "session",
      members: [first.pubkey],
    };
    const list = { status: "ready", channels: [channel] };
    const library = { status: "ready", identities: [first] };
    let release = () => {};
    const refreshMembership = vi.fn(
      () =>
        new Promise<typeof channel>((resolve, reject) => {
          release = () =>
            outcome === "failed"
              ? reject(new Error("Could not refresh channel membership"))
              : resolve(channel);
        }),
    );
    const addAgents = vi.fn();
    const session = {
      ...view.session,
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: { snapshot: () => library, subscribe: () => () => {} },
      workSessions: { refreshMembership, addAgents },
    } as unknown as RelaySession;
    view.retarget({ session, sessionConversation: true });
    await view.user.click(screen.getByRole("button", { name: "First Honey" }));
    view.submit();
    await waitFor(() =>
      expect(refreshMembership).toHaveBeenCalledWith("channel"),
    );
    expect(view.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    if (outcome === "unmounted") view.unmount();
    await act(async () => release());
    expect(addAgents).not.toHaveBeenCalled();
    if (outcome === "ready") expect(view.messages.send).toHaveBeenCalledOnce();
    else expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "failed") {
      expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh");
      expect(view.input()).toHaveTextContent("Honey");
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled();
    }
  },
);

it("keeps retry submission available while a new-session draft is locked", () => {
  const submit = vi.fn();
  const h = mount({
    submission: {
      draftKey: "session-retry",
      initialDraft: "Keep this operation",
      locked: true,
      disabled: false,
      submit,
    },
  });
  expect(h.input()).toHaveAttribute("aria-disabled", "true");
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeEnabled();
  fireEvent.click(send);
  expect(submit).toHaveBeenCalledWith({
    text: "Keep this operation",
    recipients: [],
  });
  expect(h.messages.send).not.toHaveBeenCalled();
});

it.each([undefined, "root"])(
  "prefills only exact selected agents after an accepted send in %s",
  (threadRootId) => {
    const h = mount(threadRootId ? { threadRootId } : {});
    vi.spyOn(h.session.profiles, "snapshot").mockReturnValue(
      new Map([[second.pubkey, { name: "Honey", isAgent: true }]]),
    );
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertMention(second);
      h.commands().insertMention(second);
      h.commands().insertText("hello");
    });
    const send = threadRootId ? h.messages.reply : h.messages.send;
    send.mockImplementationOnce(() => {
      throw new Error("outbox full");
    });
    h.submit();
    expect(h.input()).toHaveValue("@Honey @Honey @Honey hello");
    h.submit();
    expect(send.mock.calls.at(-1)?.[threadRootId ? 3 : 2]).toEqual([
      first.pubkey,
      second.pubkey,
      second.pubkey,
    ]);
    expect(h.input()).toHaveValue("@Honey ");
    const recipients = screen.getByRole("region", {
      name: "Explicit mentions",
    });
    expect(within(recipients).getAllByRole("button")).toHaveLength(1);
    expect(
      within(recipients).getByRole("button", {
        name: `Remove mention Honey ${second.pubkey}`,
      }),
    ).toBeVisible();
    expect(
      within(h.input()).getAllByRole("img", { name: "Agent Honey" }),
    ).toHaveLength(1);
    expect(
      h.input().querySelector("button, a, [tabindex], [title]"),
    ).toBeNull();
    h.retarget({ channelId: "other" });
    expect(h.input()).toHaveValue("");
    h.retarget({ channelId: "channel" });
    expect(h.input()).toHaveValue("@Honey ");
    h.submit();
    expect(send.mock.calls.at(-1)?.[threadRootId ? 3 : 2]).toEqual([
      second.pubkey,
    ]);
    h.input().setSelectionRange(0, 6);
    act(() => {
      h.commands().insertText("Honey");
    });
    expect(h.input()).toHaveValue("Honey ");
    expect(within(h.input()).queryByRole("img")).not.toBeInTheDocument();
    h.submit();
    expect(send.mock.calls.at(-1)?.[threadRootId ? 3 : 2]).toEqual([]);
    expect(h.input()).toHaveValue("");
  },
);

it("opt-out changes future prefills, not the current draft, and re-enable revives nothing", () => {
  const h = mount();
  vi.spyOn(h.session.profiles, "snapshot").mockReturnValue(
    new Map([[second.pubkey, { name: "Honey", isAgent: true }]]),
  );
  act(() => {
    h.commands().insertMention(second);
  });
  h.submit();
  expect(h.input()).toHaveValue("@Honey ");
  setRememberAgentsPreference(false);
  expect(h.input()).toHaveValue("@Honey ");
  h.submit();
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([second.pubkey]);
  expect(h.input()).toHaveValue("");
  setRememberAgentsPreference(true);
  expect(h.input()).toHaveValue("");
});

it.each([
  {},
  { threadRootId: "thread" },
  { threadRootId: "thread", mediaTimeSeconds: 12 },
])(
  "disables nonmember channel/thread/media composers and follows membership changes: %j",
  (destination) => {
    const h = mount(destination);
    const listeners = new Set<() => void>();
    let list: ReturnType<RelaySession["channels"]["list"]> = {
      status: "ready",
      channels: [],
    };
    h.retarget({
      session: {
        ...h.session,
        channels: {
          window: () => {
            throw new Error("Unused fixture window");
          },
          subscribeWindow: () => () => {},
          ensureList() {},
          ensure() {},
          loadOlder() {},
          list: () => list,
          get: () => ({ id: "channel", name: "Public", readOnly: true }),
          subscribeList: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        } as RelaySession["channels"],
      },
    });
    expect(h.input()).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(h.input(), { key: "Enter" });
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(h.messages.reply).not.toHaveBeenCalled();
    act(() => {
      list = { status: "ready", channels: [{ id: "channel", name: "Joined" }] };
      for (const listener of listeners) listener();
    });
    expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
    act(() => {
      list = { status: "ready", channels: [] };
      for (const listener of listeners) listener();
    });
    expect(h.input()).toHaveAttribute("aria-disabled", "true");
  },
);

it("keeps inline recipient identity and source stable through directory collision changes", async () => {
  const h = mount();
  const listeners = new Set<() => void>();
  let identities = [first, second];
  const provider = createAgentDirectory();
  const names = bindNames(
    {
      profiles: h.session.profiles,
      agentLibrary: {
        snapshot: () => ({ status: "ready", definitions: [], identities }),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        refresh: async () => {},
        retain: () => () => {},
      },
    },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  h.retarget({ session: { ...h.session, names } });
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  const chips = () => within(h.input()).getAllByRole("img");
  const labels = () => chips().map((chip) => chip.textContent);
  expect(labels()).toEqual(["@Honey · rcaj", "@Honey · 04hu"]);
  const source = h.input().value;
  act(() => {
    identities = [first, { ...second, name: "Renamed Honey" }];
    for (const notify of listeners) notify();
  });
  // Labels follow live facts; authored source and recipients do not change.
  expect(names.resolve(second.pubkey)).toBe("Renamed Honey");
  expect(labels()).toEqual(["@Honey", "@Renamed Honey"]);
  expect(h.input()).toHaveValue(source);
  act(() => {
    identities = [first, second];
    for (const notify of listeners) notify();
  });
  expect(names.lookup(first.pubkey)?.qualifier).toBeTruthy();
  expect(labels()).toEqual(["@Honey · rcaj", "@Honey · 04hu"]);
  h.input().setSelectionRange(7, 13);
  act(() => h.commands().insertText(""));
  // Removing a selected chip does not remove the other channel member from naming scope.
  expect(labels()).toEqual(["@Honey · rcaj"]);
  h.submit();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
  h.unmount();
  names.dispose();
});

it.each([false, true])(
  "leaves removed-person rejection to the real session without enrolling anyone (mixed native=%s)",
  async (mixed) => {
    const viewer = keypair(),
      relay = keypair();
    const scope = `https://relay.example.test:${viewer.pubkey}`;
    const f = controlFixture();
    f.agent.pubkey = second.pubkey;
    const native = createAgentControl(f.host);
    await native.refresh();
    let members = [viewer.pubkey, first.pubkey];
    let time = 1700000000;
    const sign = vi.fn(async (template: EventTemplate) =>
      signed(viewer, template),
    );
    const publish = vi.fn(async () => {});
    const readLibrary = vi.fn(async () => ({
      definitions: [],
      identities: [],
    }));
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: "https://relay.example.test",
        media: () => undefined,
        query: async (filters) =>
          filters.flatMap((filter) =>
            filter.kinds?.includes(39002)
              ? [roster(relay, "channel", members, time)]
              : filter.kinds?.includes(39000)
                ? [metadata(relay, "channel", "General")]
                : [],
          ),
        readAgentLibrary: readLibrary,
        writer: { kinds: [9, 9000], sign, publish },
      },
      { outboxStorage: { load: () => [], save() {} }, agentChoices: native },
    );
    const refresh = () =>
      owner.session.read(
        [
          { kinds: [39002], "#d": ["channel"], limit: 1 },
          { kinds: [39000], "#d": ["channel"], limit: 1 },
        ],
        { fresh: true },
      );
    await refresh();
    const h = mount({ session: owner.session, scope }, native);
    try {
      fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
      if (mixed)
        fireEvent.click(screen.getByRole("button", { name: "Second Honey" }));
      const draft = h.input().value;
      members = [viewer.pubkey];
      time++;
      await act(refresh);
      // An ordinary removed recipient must reject synchronously. Awaiting an
      // async act here would hide a transient enrollment lock on the composer.
      h.submit();
      expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "no longer a channel member",
      );
      expect(h.input()).toHaveValue(draft);
      expect(sign).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(readLibrary).not.toHaveBeenCalled();
    } finally {
      h.unmount();
      owner.dispose();
      native.dispose();
    }
  },
);

it("retargets within a thread without losing its draft and sends the selected parent", () => {
  const h = mount({ threadRootId: "root" });
  h.fill("keep this draft");
  const input = h.input();
  h.retarget({ threadRootId: "root", replyParentId: "parent" });
  expect(h.input()).toBe(input);
  expect(h.input()).toHaveValue("keep this draft");
  fireEvent.keyDown(h.input(), { key: "Enter" });
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "keep this draft",
    [],
    [],
    "parent",
  );
});

it("toggles the whole draft spoiler with a collapsed caret and preserves selection/history", () => {
  const h = mount();
  h.fill("secret");
  act(() => h.input().toggleFormat("spoiler"));
  expect(h.input().querySelector("[data-spoiler]")).toHaveTextContent("secret");
  expect(h.input().selectionStart).toBe(6);
  expect(h.input().selectionEnd).toBe(6);
  act(() => h.input().undo(false));
  expect(h.input().querySelector("[data-spoiler]")).toBeNull();
  act(() => h.input().undo(true));
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith("channel", "||secret||", [], []);
});

const editableMessage = (
  overrides: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id: "c".repeat(64),
  channelId: "channel",
  authorId: first.pubkey,
  createdAt: 10,
  content: "Original message",
  replyCount: 0,
  participants: [],
  mentions: [],
  attachments: [],
  reactions: [],
  ...overrides,
});

it("edits in the same composer, cancels without persisting edit text, and restores draft undo history", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  h.fill("Unsent draft");
  h.fill("");
  const input = h.input();
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(h.input()).toBe(input);
  expect(input).toHaveAccessibleName("Edit message");
  expect(input).toHaveValue("Original message");
  h.fill("Temporary edit");
  expect(readView("scope", "draft:channel", null)).toMatchObject({ text: "" });
  fireEvent.keyDown(input, { key: "Escape", keyCode: 27 });
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: "z", ctrlKey: true });
  expect(input).toHaveValue("Unsent draft");
  expect(h.messages.edit).not.toHaveBeenCalled();
});

it.each(["cancel", "accepted"])(
  "restores rich draft history and mention provenance after an edit is %s",
  (finish) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    act(() => h.commands().insertMention(second));
    act(() => {
      h.input().setSelectionRange(0, 6);
      h.input().toggleFormat("bold");
    });
    const formatted = h.input().innerHTML;
    h.fill("");
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    // The temporary editor must not inherit the unsent draft's undo stack.
    act(() => h.input().undo(false));
    expect(h.input()).toHaveValue("Original message");
    h.fill("Temporary edit");
    if (finish === "cancel") fireEvent.keyDown(h.input(), { key: "Escape" });
    else {
      h.submit();
      h.setDelivery("accepted");
    }
    act(() => h.input().undo(false));
    expect(h.input().innerHTML).toBe(formatted);
    expect(
      screen.getByRole("region", { name: "Explicit mentions" }),
    ).toBeVisible();
    h.submit();
    expect(h.messages.send).toHaveBeenCalledWith(
      "channel",
      "**@Honey** ",
      [second.pubkey],
      [],
    );
  },
);

it.each([
  ["bold", "**Revised**"],
  ["spoiler", "||Revised||"],
  ["code", "`Revised`"],
  ["bullet_list", "- Revised"],
] as const)(
  "serializes %s formatting when saving an edit",
  (format, markdown) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill("Revised");
    act(() => {
      h.input().setSelectionRange(0, 7);
      h.input().toggleFormat(format);
    });
    h.submit();
    expect(h.messages.edit).toHaveBeenCalledExactlyOnceWith(
      "c".repeat(64),
      markdown,
      "c".repeat(64),
    );
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(readView("scope", "draft:channel", "")).toBe("");
  },
);

it.each(["bullet_list", "ordered_list", "code_block"] as const)(
  "does not save a whitespace-only %s edit through Enter",
  (format) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill(" ");
    act(() => h.input().toggleFormat(format));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.keyDown(h.input(), { key: "Enter", keyCode: 13 });
    expect(h.messages.edit).not.toHaveBeenCalled();
    expect(screen.getByText("Editing message")).toBeVisible();
  },
);

it("saves only once, locks until delivery, and restores the new-message composer on acceptance", () => {
  const h = mount({}, undefined, first.pubkey);
  const row = editableMessage();
  h.setRows([row]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  h.fill("Revised message");
  act(() => {
    h.submit();
    h.submit();
  });
  expect(h.messages.edit).toHaveBeenCalledExactlyOnceWith(
    row.id,
    "Revised message",
    row.id,
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input()).toHaveAttribute("contenteditable", "false");
  expect(screen.getByRole("button", { name: "Close edit" })).toBeDisabled();
  h.setDelivery("accepted");
  expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
  expect(h.input()).toHaveValue("");
  expect(h.input()).toHaveFocus();
  expect(h.onSend).not.toHaveBeenCalled();
});

it.each(["failed", "unknown"] as const)(
  "keeps a %s edit and retries the same operation, not a new message",
  (delivery) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill("Revised");
    h.submit();
    h.setDelivery(delivery);
    expect(h.input()).toHaveValue("Revised");
    expect(h.input()).toHaveAttribute("contenteditable", "false");
    fireEvent.click(screen.getByRole("button", { name: "Retry edit" }));
    expect(h.session.outbox?.retry).toHaveBeenCalledExactlyOnceWith("edit-id");
    expect(h.messages.edit).toHaveBeenCalledTimes(1);
    h.setDelivery("seen");
    expect(h.input()).toHaveValue("");
  },
);

it.each(["changed", "deleted"])(
  "preserves text and refuses to overwrite a %s target",
  (state) => {
    const h = mount({}, undefined, first.pubkey);
    const row = editableMessage();
    h.setRows([row]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill("My changes");
    h.setRows(
      state === "deleted"
        ? []
        : [{ ...row, content: "Another client edited this" }],
    );
    h.submit();
    expect(screen.getByRole("alert")).toHaveTextContent(
      state === "deleted"
        ? "no longer available"
        : "changed while you were editing",
    );
    expect(h.input()).toHaveValue("My changes");
    expect(h.messages.edit).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not publish blank or unchanged content and preserves attachment source (mention: %s)",
  (mention) => {
    const h = mount({}, undefined, first.pubkey);
    h.setProfiles(
      new Map([[second.pubkey, { id: second.pubkey, name: "Honey" }]]),
    );
    const caption = mention ? "@Honey Caption" : "Caption";
    const sourceContent = `${caption}\n\n[report.pdf](https://files.test/report.pdf)`;
    h.setRows([
      editableMessage({
        content: caption,
        sourceContent,
        mentions: mention ? [second.pubkey] : [],
      }),
    ]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    const seed = h.input().value;
    expect(seed).toBe(
      mention
        ? sourceContent.replace(
            "@Honey",
            `[@Honey](${profileTarget(second.pubkey)})`,
          )
        : sourceContent,
    );
    h.fill(" ");
    h.submit();
    expect(screen.getByText("Editing message")).toBeVisible();
    h.fill(seed);
    fireEvent.keyDown(h.input(), { key: "Enter", keyCode: 13 });
    expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
    expect(h.input()).toHaveValue("");
    expect(h.messages.edit).not.toHaveBeenCalled();
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it.each(["changed", "deleted"])(
  "keeps an unchanged mention edit open when the target is %s",
  (state) => {
    const h = mount({}, undefined, first.pubkey);
    h.setProfiles(
      new Map([[second.pubkey, { id: second.pubkey, name: "Honey" }]]),
    );
    const row = editableMessage({
      content: "@Honey hello",
      mentions: [second.pubkey],
    });
    h.setRows([row]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    const seed = h.input().value;
    h.setRows(
      state === "deleted"
        ? []
        : [{ ...row, content: "Another client edited this" }],
    );
    h.submit();
    expect(screen.getByRole("alert")).toHaveTextContent(
      state === "deleted"
        ? "no longer available"
        : "changed while you were editing",
    );
    expect(screen.getByText("Editing message")).toBeVisible();
    expect(h.input()).toHaveValue(seed);
    expect(h.messages.edit).not.toHaveBeenCalled();
  },
);

it.each([
  { shiftKey: true },
  { altKey: true },
  { ctrlKey: true },
  { metaKey: true },
  { repeat: true },
  { isComposing: true },
  { keyCode: 229 },
])("does not take over modified/repeated/composing ArrowUp: %j", (keys) => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp", ...keys });
  expect(h.input()).toHaveValue("");
  expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
});

it("does not replace a nonempty draft and confines channel/thread targets to their owner", () => {
  const h = mount({}, undefined, first.pubkey);
  const channelRow = editableMessage();
  const reply = editableMessage({
    id: "d".repeat(64),
    content: "Thread reply",
    threadRootId: channelRow.id,
  });
  h.setRows([channelRow, reply]);
  h.fill("Draft");
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("Draft");
  h.fill("");
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue(channelRow.content);
  h.retarget({
    threadRootId: channelRow.id,
    editMessages: [channelRow, reply],
  });
  expect(h.input()).toHaveValue("");
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue(reply.content);
  h.fill("Unsubmitted edit");
  h.retarget({ channelId: "other", threadRootId: "another", editMessages: [] });
  expect(h.input()).toHaveValue("");
  expect(h.messages.edit).not.toHaveBeenCalled();
});

it.each([false, true])(
  "renders preserved mention links as chips when editing (already edited: %s)",
  (edited) => {
    const h = mount({}, undefined, first.pubkey);
    h.setProfiles(
      new Map([[second.pubkey, { id: second.pubkey, name: "Honey" }]]),
    );
    const link = `[@Honey](${profileTarget(second.pubkey)})`;
    const content = `${edited ? link : "@Honey"} whats your name`;
    h.setRows([
      editableMessage({
        content,
        mentions: [second.pubkey],
        ...(edited ? { edited: true as const } : {}),
      }),
    ]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    expect(h.input()).toHaveTextContent("Honey whats your name");
    expect(h.input().textContent).not.toContain("nostr:");
    expect(h.input().value).toBe(`${link} whats your name`);
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).not.toBeInTheDocument();
    act(() => h.commands().insertText("?"));
    h.submit();
    expect(h.messages.edit).toHaveBeenCalledWith(
      "c".repeat(64),
      `${link} whats your name?`,
      "c".repeat(64),
    );
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it.each([
  (link: string) => `\`${link}\``,
  (link: string) => `\`\`\`\n${link}\n\`\`\``,
  () => "[@Honey](nostr:npub1invalid)",
  () => "@Honey without signed identity",
])("keeps literal or unbound edit text unchanged", (source) => {
  const h = mount({}, undefined, first.pubkey);
  const content = source(`[@Honey](${profileTarget(second.pubkey)})`);
  h.setRows([editableMessage({ content })]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input().textContent).toBe(content);
  expect(h.input().querySelector(".inline-chip")).toBeNull();
});

it("inserts mention links without new notification recipients during edits", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  act(() => {
    h.commands().insertMention(second);
  });
  expect(h.input().value).toContain("nostr:npub");
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).not.toBeInTheDocument();
  h.submit();
  expect(h.messages.edit).toHaveBeenCalledWith(
    "c".repeat(64),
    expect.stringContaining("nostr:npub"),
    "c".repeat(64),
  );
  expect(h.messages.send).not.toHaveBeenCalled();
});

it.each([
  { authorId: second.pubkey },
  { agentEnvelope: true as const },
  { diff: { filePath: "a.ts", truncated: false } },
  {
    membership: {
      type: "member_joined" as const,
      actor: first.pubkey,
      target: second.pubkey,
    },
  },
  { delivery: "sending" as const },
  { delivery: "failed" as const },
  { delivery: "unknown" as const },
])("skips a newer ineligible row: %j", (overrides) => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([
    editableMessage(),
    editableMessage({
      ...overrides,
      id: "d".repeat(64),
      content: "Ineligible",
    }),
  ]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("Original message");
});

it("does not start editing without a viewer or edit capability", () => {
  const h = mount();
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("");
  const outbox = h.session.outbox;
  if (!outbox) throw new Error("Missing fixture outbox");
  h.retarget({
    session: {
      ...h.session,
      viewer: first.pubkey,
      outbox: { ...outbox, supports: (kind) => kind === 9 },
    },
  });
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("");
});

it("does not reopen a target with an unresolved edit after closing it", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  h.fill("Waiting for delivery");
  h.submit();
  h.setDelivery("unknown");
  fireEvent.click(screen.getByRole("button", { name: "Close edit" }));
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("");
  expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
});

it.each(["archived", "readOnly"] as const)(
  "blocks edit entry and save when channel becomes %s",
  (flag) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    let channel = {
      id: "channel",
      name: "General",
      members: [first.pubkey],
      [flag]: true,
    };
    let list = { status: "ready" as const, channels: [channel] };
    const listeners = new Set<() => void>();
    h.retarget({
      session: {
        ...h.session,
        channels: {
          ...h.session.channels,
          get: () => channel,
          list: () => list,
          subscribeList: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
      },
    });
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    expect(h.input()).toHaveValue("");
    act(() => {
      channel = { ...channel, [flag]: false };
      list = { ...list, channels: [channel] };
      for (const listener of listeners) listener();
    });
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill("Changes");
    act(() => {
      channel = { ...channel, [flag]: true };
      list = { ...list, channels: [channel] };
      for (const listener of listeners) listener();
    });
    h.submit();
    expect(h.messages.edit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.keyDown(h.input(), { key: "Escape" });
    expect(h.input()).toHaveValue("");
  },
);

it.each([undefined, "thread-root"])(
  "does not edit a diff-only conversation (thread: %s)",
  (threadRootId) => {
    const h = mount({}, undefined, first.pubkey);
    const row = editableMessage({
      diff: { filePath: "a.ts", truncated: false },
      content: "raw patch",
      ...(threadRootId ? { threadRootId } : {}),
    });
    if (threadRootId) h.retarget({ threadRootId, editMessages: [row] });
    else h.setRows([row]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    expect(h.input()).toHaveValue("");
    expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
    expect(h.messages.edit).not.toHaveBeenCalled();
  },
);

it("uses the full channel choice set for one selected chip and follows membership and policy changes", () => {
  const h = mount();
  const profiles = new Map([
    [first.pubkey, { name: "Honey" }],
    [second.pubkey, { name: "Honey", isAgent: true as const }],
  ]);
  let list = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        name: "General",
        members: [first.pubkey, second.pubkey],
      },
    ],
  };
  const listeners = new Set<() => void>();
  let policyChanged = () => {};
  let providers = [createAgentDirectory()];
  const session = {
    ...h.session,
    profiles: { ...h.session.profiles, snapshot: () => profiles },
    channels: {
      ...h.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const names = bindNames(session, {
    snapshot: () => providers,
    subscribe: (listener) => {
      policyChanged = listener;
      return () => {};
    },
  });
  h.retarget({ session: { ...session, names } });
  act(() => h.commands().insertMention(second));
  const label = () => within(h.input()).getByRole("img").textContent;
  expect(label()).toBe("@Honey (agent)");
  const source = h.input().value;
  act(() => {
    list = {
      ...list,
      channels: [{ id: "channel", name: "General", members: [second.pubkey] }],
    };
    for (const notify of listeners) notify();
  });
  expect(label()).toBe("@Honey");
  act(() => {
    providers = [
      {
        ...createAgentDirectory(),
        scope: () => () => ({ name: "Alternative" }),
      },
    ];
    policyChanged();
  });
  expect(label()).toBe("@Alternative");
  act(() => {
    providers = [];
    policyChanged();
  });
  expect(label()).toBe("@Honey");
  expect(h.input()).toHaveValue(source);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    source,
    [second.pubkey],
    [],
  );
  h.unmount();
  names.dispose();
});

for (const channelType of ["stream", "forum"] as const)
  it.each([undefined, "f".repeat(64)])(
    `keeps mixed nonmember mentions as references after Send anyway in ${channelType}, root=%s`,
    async (threadRootId) => {
      const h = mount(threadRootId ? { threadRootId } : {});
      const add = vi.fn();
      const list = {
        status: "ready",
        channels: [
          {
            id: "channel",
            channelType,
            members: ["d".repeat(64), second.pubkey],
          },
        ],
      };
      Object.assign(h.session, {
        channels: { list: () => list, subscribeList: () => () => {} },
        memberAdditions: { add },
        outbox: { ...h.session.outbox, supports: (kind: number) => kind === 9 },
      });
      act(() => {
        h.commands().insertMention(first);
        h.commands().insertMention(second);
      });
      fireEvent.submit(screen.getByRole("form"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // block/buzz parity: without permission, Invite is absent, not disabled.
      expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Honey is not in this channel. You cannot add people to this channel. You can still send without inviting them.",
      );
      expect(add).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
      await act(async () => {});
      const send = threadRootId ? h.messages.reply : h.messages.send;
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[threadRootId ? 3 : 2]).toEqual([
        second.pubkey,
      ]);
      expect(send.mock.calls[0]?.at(-1)).toEqual([first.pubkey]);
      expect(add).not.toHaveBeenCalled();
    },
  );

it.each(["close", "escape"])(
  "%s preserves the captured draft and returns focus without adding or sending",
  async (action) => {
    const h = mount();
    const add = vi.fn();
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    Object.assign(h.session, {
      viewer: "d".repeat(64),
      channels: { list: () => list, subscribeList: () => () => {} },
      memberAdditions: { add },
    });
    act(() => {
      h.commands().insertMention(first);
    });
    const input = h.input();
    fireEvent.submit(screen.getByRole("form"));
    // block/buzz parity: one send action, one invite action, and no Cancel.
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Honey is not in this channel. Invite them to the channel, or send without inviting them.",
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Do nothing" })).toHaveFocus(),
    );
    if (action === "close")
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    else await userEvent.setup().keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(input).toHaveValue("@Honey ");
    await waitFor(() => expect(input).toHaveFocus());
    expect(add).not.toHaveBeenCalled();
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it.each(["retry", "unmount", "retarget", "disabled"])(
  "waits for confirmed addition and handles %s without duplicate sends",
  async (outcome) => {
    const h = mount();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    const add = vi.fn(async () => {
      await gate;
    });
    if (outcome === "retry")
      add.mockRejectedValueOnce(new Error("Membership not confirmed"));
    Object.assign(h.session, {
      viewer: "d".repeat(64),
      channels: { list: () => list, subscribeList: () => () => {} },
      memberAdditions: { add },
    });
    act(() => {
      h.commands().insertMention(first);
    });
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    try {
      if (outcome === "retry") {
        await screen.findByRole("alert");
        expect(h.messages.send).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Invite" }));
      }
      expect(screen.getByRole("button", { name: "Do nothing" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Inviting…" })).toBeDisabled();
      if (outcome === "unmount") h.unmount();
      else if (outcome === "retarget") h.retarget({ channelId: "other" });
      else if (outcome === "disabled") h.retarget({ disabled: true });
    } finally {
      await act(async () => release());
    }
    expect(add).toHaveBeenCalledTimes(outcome === "retry" ? 2 : 1);
    expect(h.messages.send).toHaveBeenCalledTimes(outcome === "retry" ? 1 : 0);
  },
);

it("disabled completion keeps the highlighted key and consumes Enter without sending", async () => {
  const h = mount();
  h.input().focus();
  h.fill("!Honey");
  const publish = h.completionRequests.at(-1);
  if (!publish) throw new Error("No completion request");
  act(() => {
    publish({
      items: [
        { id: first.pubkey, label: "First Honey", edit: { mention: first } },
        { id: second.pubkey, label: "Second Honey", edit: { mention: second } },
      ],
    });
  });
  fireEvent.keyDown(h.input(), { key: "ArrowDown" });
  act(() => {
    publish({
      items: [
        { id: first.pubkey, label: "First Honey", edit: { mention: first } },
        {
          id: second.pubkey,
          label: "Second Honey",
          edit: { mention: second },
          disabled: "Archived",
        },
      ],
    });
  });
  expect(screen.getByRole("option", { name: "Second Honey" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("option", { name: "Second Honey" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  fireEvent.keyDown(h.input(), { key: "Enter" });
  expect(h.input()).toHaveValue("!Honey");
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("rejects a known archived recipient at send entry without clearing the draft", () => {
  const h = mount();
  let archived = false;
  const snapshot = { status: "ready" as const, archived: [] as string[] };
  h.retarget({
    session: {
      ...h.session,
      archives: {
        snapshot: () => snapshot,
        subscribe: () => () => {},
        state: () => (archived ? "archived" : "not-archived"),
        ensure: async () => {},
        refresh: async () => {},
        writable: false,
        consent: vi.fn(),
        request: vi.fn(),
      },
    },
  });
  act(() => {
    expect(h.commands().insertMention(first)).toBe(true);
  });
  archived = true;
  h.submit();
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue(`@${first.name} `);
  expect(
    screen.getByText(
      "A selected recipient is archived. Remove it before sending.",
    ),
  ).toBeVisible();
});
