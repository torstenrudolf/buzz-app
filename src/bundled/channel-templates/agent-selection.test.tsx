// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { npubEncode } from "nostr-tools/nip19";
import { formatPublicKey } from "../../shared/identity/public-key";
import { AgentSelection } from "./TemplateFields";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import {
  act,
  cleanup,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import { useState, useSyncExternalStore } from "react";
import { createRelaySession } from "../../features/relay/session";
import { connectBrokerTransport } from "../../features/relay/transport";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChannelSidebar } from "../../features/channel-navigation/ChannelSidebar";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { keypair, signed, roster } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { createOutbox, type OutgoingEvent } from "../../features/relay/outbox";
import type { EventTemplate } from "nostr-tools";
import type { KitRecord } from "../../features/channel-templates/model";
import {
  coordinate,
  emptyLineup,
  KIT_TAG,
} from "../../features/channel-templates/model";
import type {
  TemplateDraft,
  TemplateEditorProps,
  TemplateProvider,
  TemplateProviders,
} from "../../features/channel-templates/provider";
import type { Contribution } from "../../plugins/contributions";
import { CreateChannelDialog } from "../channels/CreateChannelDialog";
import { TemplateEditor } from "./TemplateEditor";
import { SaveAsTemplate } from "./TemplateSettings";
import { MentionPicker } from "../mentions/MentionPicker";
import { MentionCompletion } from "../mentions/MentionCompletion";
import type { CompletionResult } from "../../features/conversation/contracts";

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(ui, { wrapper: ToastProvider });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _key: string,
        _options: unknown,
        run: (lock: object) => unknown,
      ) => run({}),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
});

function harness(
  legacy?: () => Promise<{
    definitions: [];
    identities: { pubkey: string; name: string }[];
  }>,
  beforeChannelRead?: () => Promise<void>,
  managed = true,
  beforeNativeRead?: () => Promise<void>,
  beforePublish?: (event: RelayEvent) => Promise<void>,
  afterPublish?: (event: RelayEvent) => Promise<void>,
) {
  const viewer = keypair(),
    relay = keypair();
  const fixture = controlFixture();
  fixture.agent.name = "Calvin";
  fixture.agent.status = "stopped";
  fixture.agent.enabled = false;
  const native = createAgentControl({
    ...fixture.host,
    snapshot: async () => {
      await beforeNativeRead?.();
      return fixture.host.snapshot();
    },
  });
  const stored = new Map<string, KitRecord>();
  const published: RelayEvent[] = [];
  const sign = vi.fn(async (value: EventTemplate) => signed(viewer, value));
  let journal: readonly OutgoingEvent[] = [];
  const channels = new Map<string, string[]>([
    ["11111111-1111-4111-8111-111111111111", [viewer.pubkey]],
  ]);
  const preferences: SidebarPreferences = {
    sections: [{ id: "laptop", name: "Laptop", order: 0 }],
    assignments: {},
    starred: [],
    muted: [],
  };
  const assignment = vi.fn(
    async (intent: { channelId: string; sectionId?: string }) => {
      (preferences.assignments as Record<string, string>)[intent.channelId] =
        intent.sectionId ?? "";
      return preferences;
    },
  );
  const readPreferences = vi.fn(async () => preferences);
  let records: KitRecord[] = [];
  let clock = 1_700_000_000;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      decodeSidebarPreferences: readPreferences,
      writeSidebarAssignment: assignment,
      writeSidebarStar: async () => [],
      readAgentLibrary:
        legacy ??
        (async () => {
          throw new Error("Old Buzz unavailable");
        }),
      channelKit: {
        prepare: async (value) => {
          stored.set("fixture", value);
          return "fixture";
        },
        decode: async (events) =>
          events.map((event) => {
            const decoded =
              stored.get(event.content) ??
              records.find(
                (record) =>
                  coordinate(record) ===
                  event.tags.find(([tag]) => tag === "d")?.[1],
              );
            assert.exists(decoded);
            return { eventId: event.id, record: decoded };
          }),
      },
      writer: {
        kinds: [9007, 9000, 30078, 40100, 9],
        sign,
        publish: async (event) => {
          await beforePublish?.(event);
          published.push(event);
          const id = event.tags.find(([tag]) => tag === "h")?.[1];
          if (id && event.kind === 9007) channels.set(id, [viewer.pubkey]);
          if (id && event.kind === 9000) {
            const member = event.tags.find(([tag]) => tag === "p")?.[1];
            assert.exists(member);
            channels.get(id)?.push(member);
          }
          clock++;
          await afterPublish?.(event);
        },
      },
      query: async (filters) => {
        if (
          filters.some((filter) =>
            filter.kinds?.some((kind) => [39000, 39002].includes(kind)),
          )
        )
          await beforeChannelRead?.();
        const events = [
          signed(relay, { kind: 13535, tags: [["-"]], content: "" }),
          ...[...channels].flatMap(([id, members]) => [
            signed(relay, {
              kind: 39000,
              content: "",
              created_at: clock,
              tags: [
                ["d", id],
                ["name", "Test"],
                ["t", "stream"],
              ],
            }),
            roster(relay, id, members, clock),
          ]),
          ...published,
          ...records.map((record) =>
            signed(viewer, {
              kind: 30078,
              content: "saved",
              tags: [
                ["d", coordinate(record)],
                ["t", KIT_TAG],
              ],
            }),
          ),
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
    },
    {
      agentChoices: managed ? native : undefined,
      outboxStorage: {
        load: () => [],
        save: (records) => {
          journal = structuredClone(records);
        },
      },
      warm: false,
    },
  );
  return {
    owner,
    native,
    fixture,
    published,
    sign,
    viewer,
    journal: () => journal,
    preferences,
    assignment,
    readPreferences,
    stored,
    channels,
    setRecord: (...next: KitRecord[]) => {
      records = next;
    },
    dispose: () => {
      owner.dispose();
      native.dispose();
    },
  };
}

function Editor({
  test,
  initial,
  chosen,
}: {
  test: ReturnType<typeof harness>;
  initial?: TemplateDraft;
  chosen(value: TemplateDraft): void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TemplateEditor
      session={test.owner.session}
      value={value}
      initialDefault={initial?.templateId ?? ""}
      group={undefined}
      active={() => true}
      onChange={(next) => {
        setValue(next);
        chosen(next);
      }}
    />
  );
}

function savedTemplate(agents: string[], teamIds: string[] = []): KitRecord {
  return {
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: {
      type: "template",
      id: "saved",
      name: "Saved",
      description: "",
      agents,
      teamIds,
      canvas: "# Plan",
    },
  };
}
async function chooseSaved() {
  await userEvent.click(screen.getByRole("combobox", { name: "Template" }));
  await userEvent.click(await screen.findByRole("option", { name: "Saved" }));
}

it("reloads invalidated archive evidence when channel discovery completes after the mounted editor's archive read", async () => {
  let release = () => {};
  const discovery = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readingChannels = vi.fn(() => discovery);
  const test = harness(
    async () => ({ definitions: [], identities: [] }),
    readingChannels,
  );
  test.setRecord(savedTemplate([test.fixture.agent.pubkey]));
  const states: string[] = [];
  const archives = test.owner.session.archives;
  const stop = archives.subscribe(() =>
    states.push(archives.snapshot().status),
  );
  let draft: TemplateDraft | undefined;
  try {
    render(
      <Editor
        test={test}
        chosen={(next) => {
          draft = next;
        }}
      />,
    );
    await waitFor(() => {
      expect(readingChannels).toHaveBeenCalled();
      expect(archives.snapshot().status).toBe("ready");
    });
    states.length = 0;
    await act(async () => {
      release();
    });
    await waitFor(() => {
      expect(test.owner.session.channels.list().status).toBe("ready");
      expect(archives.snapshot().status).toBe("ready");
    });
    expect(states).toContain("idle");
    expect(states.slice(states.lastIndexOf("idle"))).toEqual([
      "idle",
      "loading",
      "ready",
    ]);
    await chooseSaved();
    expect(draft?.agents).toEqual([test.fixture.agent.pubkey]);
    expect(draft?.problem).toBeUndefined();
  } finally {
    release();
    stop();
    test.dispose();
  }
});

it("offers native-only stopped Calvin in real template/mention UI and creates with the same exact identity while old Buzz fails", async () => {
  const test = harness(),
    user = userEvent.setup();
  test.setRecord(savedTemplate([test.fixture.agent.pubkey]));
  let draft: TemplateDraft | undefined;
  try {
    const view = render(
      <Editor
        test={test}
        chosen={(next) => {
          draft = next;
        }}
      />,
    );
    await waitFor(() => {
      expect(test.owner.session.agentChoices.snapshot().templates.status).toBe(
        "ready",
      );
      expect(test.owner.session.archives.snapshot().status).toBe("ready");
    });
    await chooseSaved();
    expect(draft?.agents).toEqual([test.fixture.agent.pubkey]);
    expect(draft?.problem).toBeUndefined();
    expect(
      screen.queryByRole("button", { name: "Reload templates and agents" }),
    ).not.toBeInTheDocument();
    view.unmount();
    assert.exists(draft);
    const id = await test.owner.session.channelCreation.create({
      name: "Calvin test",
      visibility: "private",
      setup: { agents: draft.agents, canvas: "", groupId: "", templateId: "" },
    });
    await waitFor(() =>
      expect(test.channels.get(id)).toContain(test.fixture.agent.pubkey),
    );
    expect(test.published.filter((e) => e.kind === 9000)).toHaveLength(1);
    expect(test.published.some((e) => e.kind === 9)).toBe(false);
    expect(test.fixture.calls.every((call) => call.action === "snapshot")).toBe(
      true,
    );
    const parent = "11111111-1111-4111-8111-111111111111";
    const select = vi.fn(() => true);
    const picker = render(
      <MentionPicker
        session={test.owner.session}
        scope={test.owner.session.scope}
        channelId={parent}
        disabled={false}
        select={select}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mention a member" }));
    await user.click(
      await screen.findByRole("button", {
        name: `Calvin ${test.fixture.agent.pubkey}`,
      }),
    );
    expect(select).toHaveBeenCalledWith({
      pubkey: test.fixture.agent.pubkey,
      name: "Calvin",
    });
    picker.unmount();
    let result: CompletionResult | undefined;
    const publish = (next: CompletionResult) => {
      result = next;
      return () => {};
    };
    render(
      <MentionCompletion
        session={test.owner.session}
        scope={test.owner.session.scope}
        channelId={parent}
        query={{ query: "Calvin", start: 0, end: 7 }}
        observation={{ revision: 1, text: "@Calvin", start: 7, end: 7 }}
        publish={publish}
      />,
    );
    await waitFor(() =>
      expect(result?.items[0]?.id).toBe(test.fixture.agent.pubkey),
    );
  } finally {
    cleanup();
    test.dispose();
  }
});

it("does not consume a legacy group default while its required identity is still loading", async () => {
  const key = "cd".repeat(32);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const test = harness(
    async () => {
      await gate;
      return { definitions: [], identities: [{ pubkey: key, name: "Legacy" }] };
    },
    undefined,
    false,
  );
  const members = test.channels.get("11111111-1111-4111-8111-111111111111");
  assert.exists(members);
  members.push(key);
  test.setRecord({
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: {
      type: "template",
      id: "saved",
      name: "Saved",
      description: "",
      agents: [key],
      teamIds: [],
      canvas: "",
    },
  });
  const initial = {
    templateId: "saved",
    lineup: emptyLineup(),
    agents: [],
    problem: "Group default is awaiting selection.",
  };
  const chosen = vi.fn();
  try {
    render(<Editor test={test} initial={initial} chosen={chosen} />);
    await waitFor(() => {
      expect(test.owner.session.channelKit.snapshot().status).toBe("ready");
      expect(test.owner.session.archives.snapshot().status).toBe("ready");
    });
    expect(chosen).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await test.owner.session.agentChoices.refresh();
    });
    await waitFor(() =>
      expect(chosen).toHaveBeenCalledWith(
        expect.objectContaining({ agents: [key], problem: undefined }),
      ),
    );
  } finally {
    release();
    cleanup();
    test.dispose();
  }
});

it("copies a complete managed lineup without an unused legacy warning", async () => {
  const test = harness(),
    user = userEvent.setup();
  try {
    await test.owner.session.agentChoices.refresh();
    await test.owner.session.archives.ensure();
    render(
      <SaveAsTemplate
        session={test.owner.session}
        channel={{
          id: "11111111-1111-4111-8111-111111111111",
          name: "Partial",
          members: [test.fixture.agent.pubkey, "cd".repeat(32)],
        }}
        active={() => true}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Save as template…" }),
    );
    expect(
      await screen.findByRole("checkbox", {
        name: `Calvin Agent · ${formatPublicKey(test.fixture.agent.pubkey)}`,
      }),
    ).toBeChecked();
    expect(
      screen.queryByText(/Incomplete agent inventory/),
    ).not.toBeInTheDocument();
    expect(test.published).toEqual([]);
  } finally {
    cleanup();
    test.dispose();
  }
});

function providerFixture(editor = TemplateEditor) {
  const listeners = new Set<() => void>();
  const entry = (): Contribution<TemplateProvider> => ({
    id: "templates",
    key: "buzz.channel-templates/templates",
    title: "Templates",
    pluginId: "buzz.channel-templates",
    revision: "bundled",
    editor,
    groupDefault: () => null,
    saveAs: SaveAsTemplate,
  });
  let entries: readonly Contribution<TemplateProvider>[] = [entry()];
  const providers: TemplateProviders = {
    snapshot: () => entries,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register: () => {},
  };
  return {
    providers,
    toggle(enabled: boolean) {
      entries = enabled ? [entry()] : [];
      listeners.forEach((listener) => {
        listener();
      });
    },
  };
}

it("retains exact accepted team expansion and Canvas through provider replacement without exposing setup details", async () => {
  const test = harness(),
    registry = providerFixture(),
    user = userEvent.setup();
  const team = (agents: string[]): KitRecord => ({
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: { type: "team", id: "crew", name: "Crew", agents },
  });
  test.setRecord(
    savedTemplate([], ["crew"]),
    team([test.fixture.agent.pubkey]),
  );
  const created = vi.fn(async (input) => {
    await test.owner.session.channelCreation.create(input);
  });
  try {
    render(
      <CreateChannelDialog
        open
        onOpenChange={() => {}}
        onCreate={created}
        session={test.owner.session}
        providers={registry.providers}
        groups={undefined}
        initialGroup=""
        groupsReady
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Team test");
    await waitFor(() =>
      expect(test.owner.session.archives.snapshot().status).toBe("ready"),
    );
    await chooseSaved();
    expect(
      screen.queryByLabelText("Channel setup summary"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Review \/ customize|Hide setup details/,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Starting Canvas (Markdown)" }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(test.fixture.agent.pubkey);
    act(() => registry.toggle(false));
    expect(screen.getByLabelText("Channel setup summary")).toHaveTextContent(
      "1 selected agent.",
    );
    expect(
      screen.getByRole("button", { name: "Clear template setup (keep group)" }),
    ).toBeVisible();
    test.setRecord(savedTemplate([], ["crew"]), team([]));
    await act(async () => {
      await test.owner.session.channelKit.refresh();
      registry.toggle(true);
    });
    expect(
      screen.getByRole("combobox", { name: "Template" }),
    ).toHaveTextContent("Saved");
    act(() => registry.toggle(false));
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    await waitFor(() =>
      expect(test.published.filter((e) => e.kind === 9000)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(test.owner.session.channelCreation.snapshot()).toBeUndefined(),
    );
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: {
          agents: [test.fixture.agent.pubkey],
          canvas: "# Plan",
          groupId: "",
          templateId: "saved",
        },
      }),
    );
    expect(test.published.map((e) => e.kind)).toEqual([9007, 40100, 9000]);
    expect(test.published.find((e) => e.kind === 40100)?.content).toBe(
      "# Plan",
    );
    expect(test.fixture.calls.every((call) => call.action === "snapshot")).toBe(
      true,
    );
  } finally {
    cleanup();
    test.dispose();
  }
});

it("copies the saved Canvas and eligible member keys without silently creating a linked team", async () => {
  const test = harness(async () => ({ definitions: [], identities: [] })),
    user = userEvent.setup();
  const channel = "11111111-1111-4111-8111-111111111111";
  test.published.push(
    signed(keypair(), {
      kind: 40100,
      tags: [["h", channel]],
      content: "# Saved plan",
    }),
  );
  try {
    await test.owner.session.agentChoices.refresh();
    await test.owner.session.archives.ensure();
    render(
      <SaveAsTemplate
        session={test.owner.session}
        channel={{
          id: channel,
          name: "Copy me",
          members: [test.fixture.agent.pubkey, "ef".repeat(32)],
        }}
        active={() => true}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save as template…" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Save as template…" }));
    expect(
      await screen.findByRole("textbox", {
        name: "Starting Canvas (Markdown)",
      }),
    ).toHaveValue("# Saved plan");
    expect(
      screen.getByRole("checkbox", {
        name: `Calvin Agent · ${formatPublicKey(test.fixture.agent.pubkey)}`,
      }),
    ).toBeChecked();
    expect(
      within(screen.getByRole("group", { name: "Saved teams" })).queryAllByRole(
        "checkbox",
      ),
    ).toEqual([]);
    expect(test.published).toHaveLength(1);
  } finally {
    cleanup();
    test.dispose();
  }
});

it.each([false, true])(
  "keeps template selection compact without hiding validation (unavailable agent: %s)",
  async (unavailable) => {
    const test = harness(),
      registry = providerFixture(),
      user = userEvent.setup();
    const key = unavailable ? "cd".repeat(32) : test.fixture.agent.pubkey;
    test.setRecord({
      version: 1,
      community: "https://relay.example.test",
      deleted: false,
      value: {
        type: "template",
        id: "saved",
        name: "The Royal Court",
        description: "",
        agents: [key],
        teamIds: [],
        canvas: "# Plan",
      },
    });
    const created = vi.fn(async () => {});
    try {
      render(
        <CreateChannelDialog
          open
          onOpenChange={() => {}}
          onCreate={created}
          session={test.owner.session}
          providers={registry.providers}
          groups={{
            type: "groups",
            id: "personal",
            assignments: {},
            groups: [{ id: "work", name: "Work", defaultTemplateId: "saved" }],
          }}
          initialGroup="work"
          groupsReady
        />,
      );
      await waitFor(() => {
        expect(test.owner.session.channelKit.snapshot().status).toBe("ready");
        expect(
          test.owner.session.agentChoices.snapshot().templates.status,
        ).toBe("ready");
        expect(test.owner.session.archives.snapshot().status).toBe("ready");
        expect(
          screen.queryByText("Group default is awaiting selection."),
        ).not.toBeInTheDocument();
      });
      expect(
        screen.getByRole("combobox", { name: "Template" }),
      ).toHaveTextContent("The Royal Court");
      expect(
        screen.queryByLabelText("Channel setup summary"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", { name: "Find individual agents" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: /Review \/ customize|Hide setup details/,
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", { name: "Starting Canvas (Markdown)" }),
      ).not.toBeInTheDocument();
      if (unavailable) {
        expect(screen.getByRole("alert")).toHaveTextContent(
          `Agent ${npubEncode(key)} is unavailable in this community; remove or replace it`,
        );
      } else {
        expect(screen.queryByText("Setup details")).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        await user.type(screen.getByRole("textbox", { name: "Name" }), "Court");
        await user.click(
          screen.getByRole("button", { name: "Create channel" }),
        );
        await waitFor(() =>
          expect(created).toHaveBeenCalledWith({
            name: "Court",
            visibility: "open",
            setup: {
              agents: [key],
              canvas: "# Plan",
              groupId: "work",
              templateId: "saved",
            },
          }),
        );
      }
    } finally {
      cleanup();
      test.dispose();
    }
  },
);

it("keeps recovery and Clear reachable when the template editor crashes, without a technical dump", async () => {
  function CrashingEditor(props: TemplateEditorProps) {
    const [crash, setCrash] = useState(false);
    if (crash) throw new Error("synthetic editor failure");
    return (
      <>
        <TemplateEditor {...props} />
        <button type="button" onClick={() => setCrash(true)}>
          Break editor
        </button>
      </>
    );
  }
  const test = harness(),
    registry = providerFixture(CrashingEditor),
    user = userEvent.setup();
  test.setRecord(savedTemplate([test.fixture.agent.pubkey]));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <CreateChannelDialog
        open
        onOpenChange={() => {}}
        onCreate={async () => {}}
        session={test.owner.session}
        providers={registry.providers}
        groups={undefined}
        initialGroup=""
        groupsReady
      />,
    );
    await waitFor(() =>
      expect(test.owner.session.archives.snapshot().status).toBe("ready"),
    );
    await chooseSaved();
    expect(
      screen.queryByLabelText("Channel setup summary"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Break editor" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Template controls could not open.",
    );
    expect(screen.getByLabelText("Channel setup summary")).toHaveTextContent(
      "1 selected agent.",
    );
    expect(document.body.textContent).not.toContain(
      npubEncode(test.fixture.agent.pubkey),
    );
    await user.click(
      screen.getByRole("button", { name: "Clear template setup (keep group)" }),
    );
    expect(
      screen.queryByLabelText("Channel setup summary"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Template" }),
    ).toHaveTextContent("None");
  } finally {
    errors.mockRestore();
    cleanup();
    test.dispose();
  }
});

it.each([false, true])(
  "places a newly created channel in its legacy sidebar group (template: %s)",
  async (template) => {
    const test = harness();
    const input = {
      name: "Laptop channel",
      visibility: "private" as const,
      setup: {
        agents: template ? [test.fixture.agent.pubkey] : [],
        canvas: template ? "# Plan" : "",
        templateId: template ? "saved" : "",
        groupId: "laptop",
        groupSource: "legacy" as const,
      },
    };
    try {
      const id = await test.owner.session.channelCreation.create(input);
      await waitFor(() =>
        expect(test.assignment).toHaveBeenCalledWith(
          { channelId: id, sectionId: "laptop" },
          expect.any(AbortSignal),
        ),
      );
      expect(
        test.owner.session.sidebarPreferences.snapshot().data?.assignments[id],
      ).toBe("laptop");
      expect(test.owner.session.channelCreation.snapshot()).toBeUndefined();
      expect(
        test.published.filter((event) => event.kind === 9007),
      ).toHaveLength(1);
    } finally {
      test.dispose();
    }
  },
);

it("shows an avatar, searchable npub and removable unavailable keys without rendering hex", async () => {
  const key = "ab".repeat(32),
    missing = "cd".repeat(32);
  const avatar = "data:image/png;base64,AAAA";
  const change = vi.fn();
  render(
    <AgentSelection
      agents={[{ pubkey: key, name: "Calvin", avatar }]}
      selected={[missing]}
      onChange={change}
    />,
  );
  const row = screen
    .getByRole("checkbox", { name: `Calvin Agent · ${formatPublicKey(key)}` })
    .closest("label");
  assert.exists(row);
  expect(row.querySelector("img")).toHaveAttribute("src", avatar);
  expect(row).toHaveTextContent(formatPublicKey(key) ?? "");
  const user = userEvent.setup();
  await user.hover(row);
  const preview = await screen.findByRole("dialog", {
    name: "Calvin identity",
  });
  expect(preview).toHaveTextContent(npubEncode(key));
  await user.unhover(row);
  expect(document.body.textContent).not.toContain(key);
  expect(document.body.textContent).not.toContain(missing);
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: `Unavailable agent Agent · ${formatPublicKey(missing)}`,
    }),
  );
  expect(change).toHaveBeenCalledWith([]);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Find individual agents" }),
    npubEncode(key),
  );
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  await userEvent.click(screen.getByRole("checkbox"));
  expect(change).toHaveBeenLastCalledWith([missing, key]);
});

it.each(["loading", "error"])(
  "does not accept or copy a saved lineup while native is %s and legacy is ready",
  async (mode) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failed = mode === "error";
    const key = "ab".repeat(32);
    const test = harness(
      async () => ({
        definitions: [],
        identities: [{ pubkey: key, name: "Old Calvin" }],
      }),
      undefined,
      true,
      async () => {
        if (mode === "loading") await gate;
        if (failed) throw new Error("synthetic native read failure");
      },
    );
    test.setRecord({
      version: 1,
      community: "https://relay.example.test",
      deleted: false,
      value: {
        type: "template",
        id: "saved",
        name: "Saved",
        description: "",
        agents: [key],
        teamIds: [],
        canvas: "",
      },
    });
    const chosen = vi.fn();
    await test.owner.session.agentLibrary.refresh();
    try {
      render(
        <>
          <Editor
            test={test}
            initial={{
              templateId: "saved",
              lineup: emptyLineup(),
              agents: [],
              problem: "Group default is awaiting selection.",
            }}
            chosen={chosen}
          />
          <SaveAsTemplate
            session={test.owner.session}
            channel={{
              id: "11111111-1111-4111-8111-111111111111",
              name: "Test",
              members: [key],
            }}
            active={() => true}
          />
        </>,
      );
      await waitFor(() => {
        expect(test.owner.session.channelKit.snapshot().status).toBe("ready");
        expect(test.owner.session.agentChoices.snapshot().status).toBe("ready");
        expect(
          test.owner.session.agentChoices.snapshot().templates.status,
        ).toBe(mode);
        expect(test.owner.session.archives.snapshot().status).toBe("ready");
      });
      expect(chosen).not.toHaveBeenCalled();
      expect(screen.queryAllByRole("checkbox")).toEqual([]);
      expect(screen.queryByText(/remove or replace/)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save as template…" }),
      ).toBeDisabled();
      await act(async () => {
        failed = false;
        release();
        await test.native.refresh();
      });
      await waitFor(() =>
        expect(chosen).toHaveBeenCalledWith(
          expect.objectContaining({ agents: [key], problem: undefined }),
        ),
      );
      expect(
        screen.getByRole("button", { name: "Save as template…" }),
      ).toBeEnabled();
    } finally {
      release();
      cleanup();
      test.dispose();
    }
  },
);

it("creates with managed agents without waiting for the unused legacy inventory", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const legacy = vi.fn(async () => {
    await held;
    return { definitions: [] as [], identities: [] };
  });
  const test = harness(legacy);
  const run = test.owner.session.channelCreation.create({
    name: "Native only",
    visibility: "private",
    setup: {
      agents: [test.fixture.agent.pubkey],
      canvas: "",
      groupId: "",
      templateId: "",
    },
  });
  try {
    await waitFor(() =>
      expect(test.published.some((event) => event.kind === 9000)).toBe(true),
    );
    const id = await run;
    await waitFor(() =>
      expect(test.channels.get(id)).toContain(test.fixture.agent.pubkey),
    );
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.allSettled([run]);
    test.dispose();
  }
});

it("still refreshes the legacy library for creation when no native host exists", async () => {
  const key = "ab".repeat(32);
  const legacy = vi.fn(async () => ({
    definitions: [] as [],
    identities: [{ pubkey: key, name: "Legacy agent" }],
  }));
  const test = harness(legacy, undefined, false);
  test.channels.get("11111111-1111-4111-8111-111111111111")?.push(key);
  try {
    test.owner.session.channels.ensureList();
    await waitFor(() =>
      expect(test.owner.session.channels.list().status).toBe("ready"),
    );
    const id = await test.owner.session.channelCreation.create({
      name: "Legacy team",
      visibility: "private",
      setup: { agents: [key], canvas: "", groupId: "", templateId: "" },
    });
    expect(legacy).toHaveBeenCalledOnce();
    await waitFor(() => expect(test.channels.get(id)).toContain(key));
  } finally {
    test.dispose();
  }
});

it("does not fall back to a ready legacy identity when the native preflight refresh fails", async () => {
  const key = "ab".repeat(32);
  const legacy = vi.fn(async () => ({
    definitions: [] as [],
    identities: [{ pubkey: key, name: "Legacy agent" }],
  }));
  const test = harness(legacy, undefined, true, async () => {
    throw new Error("Native unavailable");
  });
  test.channels.get("11111111-1111-4111-8111-111111111111")?.push(key);
  try {
    test.owner.session.channels.ensureList();
    await test.owner.session.agentChoices.refresh();
    await waitFor(() =>
      expect(test.owner.session.channels.list().status).toBe("ready"),
    );
    legacy.mockClear();
    await expect(
      test.owner.session.channelCreation.create({
        name: "Wrong fallback",
        visibility: "private",
        setup: { agents: [key], canvas: "", groupId: "", templateId: "" },
      }),
    ).rejects.toThrow("Could not refresh local agents");
    expect(legacy).not.toHaveBeenCalled();
    expect(test.published).toHaveLength(0);
  } finally {
    test.dispose();
  }
});

it.each([
  "rate-limited: quota exceeded; retry in 17s",
  "rate-limited: shared admission unavailable",
])(
  "renders a template completion refusal from transport through Outbox without replay: %s",
  async (reason) => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/session")
        ? Response.json({
            viewer: "viewer",
            relayAuthor: "relay",
            writeKinds: [9000],
          })
        : Response.json({ error: reason, sent: false }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = await connectBrokerTransport();
    const test = harness(
      undefined,
      undefined,
      true,
      undefined,
      async (event) => {
        if (event.kind === 9000) {
          assert.exists(transport.writer);
          await transport.writer.publish(event, new AbortController().signal);
        }
      },
    );
    const emptyProviders: [] = [];
    const snapshot = {
      status: "ready" as const,
      scope: "https://relay.example.test:viewer",
      viewer: test.viewer.pubkey,
      generation: 1,
      session: test.owner.session,
    };
    const relay: RelayData = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry() {},
      disconnect() {},
      async clearCache() {},
    };
    try {
      const id = await test.owner.session.channelCreation.create({
        name: "Quota template",
        visibility: "private",
        setup: {
          agents: [test.fixture.agent.pubkey],
          canvas: "",
          groupId: "",
          templateId: "saved",
        },
      });
      render(
        <ToastProvider>
          <ChannelNavigationProvider relay={relay}>
            <ChannelSidebar
              relay={relay}
              navigator={{ open: vi.fn() } as unknown as Navigation}
              providers={{
                snapshot: () => emptyProviders,
                subscribe: () => () => {},
                register() {},
              }}
              target={{
                version: 1,
                kind: "conversation",
                channelId: id,
                scope: {
                  viewer: test.viewer.pubkey,
                  communityOrigin: "https://relay.example.test",
                },
              }}
              sessionsEnabled
            >
              {null}
            </ChannelSidebar>
          </ChannelNavigationProvider>
        </ToastProvider>,
      );
      const notice = await screen.findByRole("dialog", {
        name: "Channel setup couldn’t finish: Quota template",
      });
      expect(notice).toHaveTextContent(
        "Channel setup couldn’t finish: Quota template",
      );
      expect(notice).toHaveTextContent(reason);
      expect(notice).not.toHaveTextContent("Relay request failed (503)");
      expect(
        test.journal().find((item) => item.event.kind === 9000),
      ).toMatchObject({ delivery: "failed", error: reason });
      expect(test.channels.get(id)).toEqual([test.viewer.pubkey]);
      await userEvent
        .setup()
        .click(within(notice).getByRole("button", { name: "Dismiss" }));
      expect(test.owner.session.channelCreation.notices()).toEqual([]);
      expect(
        localStorage.getItem(
          `buzz-channel-setup.v2:https://relay.example.test:${test.viewer.pubkey}:${id}`,
        ),
      ).not.toBeNull();
      expect(
        fetcher.mock.calls.filter(([url]) => url.endsWith("/publish")),
      ).toHaveLength(1);
      expect(
        test.published.filter((event) => event.kind === 9007),
      ).toHaveLength(1);
    } finally {
      cleanup();
      test.dispose();
    }
  },
);

it("retains a failed group placement independently and permits another Create", async () => {
  const test = harness();
  try {
    test.assignment.mockRejectedValueOnce(new Error("placement offline"));
    const id = await test.owner.session.channelCreation.create({
      name: "Laptop channel",
      visibility: "private",
      setup: {
        agents: [],
        canvas: "",
        templateId: "",
        groupId: "laptop",
        groupSource: "legacy",
      },
    });
    await waitFor(() =>
      expect(test.owner.session.channelCreation.notices()).toEqual([
        { id, name: "Laptop channel", error: "Error: placement offline" },
      ]),
    );
    expect(test.owner.session.channelCreation.snapshot()).toBeUndefined();
    const next = await test.owner.session.channelCreation.create({
      name: "Independent",
      visibility: "open",
    });
    expect(next).not.toBe(id);
    expect(test.published.filter((event) => event.kind === 9007)).toHaveLength(
      2,
    );
    test.owner.session.channelCreation.dismissNotice(id);
    expect(test.owner.session.channelCreation.notices()).toEqual([]);
    expect(Object.keys(localStorage).some((key) => key.endsWith(id))).toBe(
      true,
    );
  } finally {
    test.dispose();
  }
});

it("does not create into a personal group while the shared sidebar placement owner is unreadable", async () => {
  const test = harness();
  test.setRecord({
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: {
      type: "groups",
      id: "personal",
      groups: [{ id: "work", name: "Work", defaultTemplateId: "" }],
      assignments: {},
    },
  });
  const input = {
    name: "Work channel",
    visibility: "private" as const,
    setup: { agents: [], canvas: "", templateId: "", groupId: "work" },
  };
  try {
    await test.owner.session.sidebarPreferences.refresh();
    test.readPreferences.mockRejectedValue(new Error("sidebar offline"));
    await expect(
      test.owner.session.channelCreation.create(input),
    ).rejects.toThrow(/destination group is unavailable/);
    expect(test.published).toEqual([]);
    expect(test.owner.session.channelCreation.snapshot()).toBeUndefined();
    test.readPreferences.mockResolvedValue(test.preferences);
    const id = await test.owner.session.channelCreation.create(input);
    await waitFor(() =>
      expect(
        test.owner.session.sidebarPreferences.snapshot().data?.assignments[id],
      ).toBe("work"),
    );
  } finally {
    test.dispose();
  }
});

it("preserves personal-group placement for receipts without a source", async () => {
  const test = harness();
  test.setRecord({
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: {
      type: "groups",
      id: "personal",
      groups: [{ id: "work", name: "Work", defaultTemplateId: "" }],
      assignments: {},
    },
  });
  try {
    const id = await test.owner.session.channelCreation.create({
      name: "Work channel",
      visibility: "private",
      setup: { agents: [], canvas: "", templateId: "", groupId: "work" },
    });
    await waitFor(() =>
      expect(
        test.owner.session.sidebarPreferences.snapshot().data?.assignments[id],
      ).toBe("work"),
    );
    expect(test.assignment).not.toHaveBeenCalled();
    expect(test.stored.get("fixture")?.value).toMatchObject({
      type: "groups",
      assignments: { [id]: "work" },
    });
  } finally {
    test.dispose();
  }
});

it("does not apply a personal group's template default to a same-ID legacy destination", async () => {
  const test = harness(),
    registry = providerFixture();
  test.setRecord(savedTemplate([test.fixture.agent.pubkey]));
  const created = vi.fn(async () => {});
  try {
    render(
      <CreateChannelDialog
        open
        onOpenChange={() => {}}
        onCreate={created}
        session={test.owner.session}
        providers={registry.providers}
        groups={{
          type: "groups",
          id: "personal",
          assignments: {},
          groups: [
            {
              id: "laptop",
              name: "Personal laptop",
              defaultTemplateId: "saved",
            },
          ],
        }}
        destinations={[{ id: "laptop", name: "Legacy laptop" }]}
        groupSource="legacy"
        initialGroup="laptop"
        groupsReady
      />,
    );
    await waitFor(() => {
      expect(test.owner.session.channelKit.snapshot().status).toBe("ready");
      expect(test.owner.session.agentChoices.snapshot().templates.status).toBe(
        "ready",
      );
      expect(test.owner.session.archives.snapshot().status).toBe("ready");
    });
    expect(
      screen.getByRole("combobox", { name: "Template" }),
    ).toHaveTextContent("None");
    expect(
      screen.queryByRole("button", { name: /Use this group’s default/ }),
    ).not.toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Name" }),
      "Laptop",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create channel" }),
    );
    await waitFor(() =>
      expect(created).toHaveBeenCalledWith({
        name: "Laptop",
        visibility: "open",
        setup: {
          agents: [],
          canvas: "",
          templateId: "",
          groupId: "laptop",
          groupSource: "legacy",
        },
      }),
    );
  } finally {
    cleanup();
    test.dispose();
  }
});

it("settings offers only the managed namesake and saves its exact key; creation never rebinds an unavailable saved identity", async () => {
  const old = { pubkey: "cd".repeat(32), name: "Calvin" };
  const test = harness(async () => ({ definitions: [], identities: [old] }));
  test.channels.get("11111111-1111-4111-8111-111111111111")?.push(old.pubkey);
  try {
    await test.owner.session.agentChoices.refresh();
    await test.owner.session.archives.ensure();
    const view = render(
      <SaveAsTemplate
        session={test.owner.session}
        channel={{
          id: "11111111-1111-4111-8111-111111111111",
          name: "Saved",
          members: [old.pubkey, test.fixture.agent.pubkey],
        }}
        active={() => true}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Save as template…" }),
    );
    const checkbox = await screen.findByRole("checkbox", {
      name: `Calvin Agent · ${formatPublicKey(test.fixture.agent.pubkey)}`,
    });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(checkbox).toBeChecked();
    await userEvent.click(
      screen.getByRole("button", { name: "Save template" }),
    );
    await waitFor(() =>
      expect(test.stored.get("fixture")?.value).toMatchObject({
        type: "template",
        agents: [test.fixture.agent.pubkey],
      }),
    );
    view.unmount();
    const before = [...test.published];
    await expect(
      test.owner.session.channelCreation.create({
        name: "Stale recipe",
        visibility: "private",
        setup: {
          agents: [old.pubkey],
          canvas: "",
          groupId: "",
          templateId: "saved",
        },
      }),
    ).rejects.toThrow(
      `Selected agents are unavailable in this community: ${npubEncode(old.pubkey)}`,
    );
    expect(test.published).toEqual(before);
  } finally {
    cleanup();
    test.dispose();
  }
});

it("receipt-save failure prevents real Outbox signing/publication and stays guarded after restoration", async () => {
  const test = harness();
  const original = Storage.prototype.setItem;
  let frozen: string | undefined;
  const writing = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("buzz-channel-setup.v2:")) {
        if (frozen) throw new Error("Setup receipt storage full");
        frozen = value;
      }
      original.call(this, key, value);
    });
  let restored: ReturnType<typeof createOutbox> | undefined;
  try {
    await expect(
      test.owner.session.channelCreation.create({
        name: "Stopped before signing",
        visibility: "private",
      }),
    ).rejects.toThrow("Setup receipt storage full");
    // Wait for the real Outbox's guarded attempt and durable journal to settle,
    // not just for the rejected form promise.
    await waitFor(() => expect(test.journal()).toHaveLength(1));
    await waitFor(() => expect(test.journal()[0]?.delivery).toBe("failed"));
    expect(test.sign).not.toHaveBeenCalled();
    expect(test.published).toEqual([]);
    const receiptKey = Object.keys(localStorage).find((key) =>
      key.startsWith("buzz-channel-setup.v2:"),
    );
    assert.exists(receiptKey);
    expect(localStorage.getItem(receiptKey)).toBe(frozen);
    const saved = structuredClone(test.journal());
    const operation = saved[0];
    assert.exists(operation);
    expect(operation.guarded).toBe(true);
    test.dispose();
    const publish = vi.fn(async () => {});
    restored = createOutbox(
      test.viewer.pubkey,
      { sign: test.sign, publish },
      { load: () => saved, save: () => {} },
    );
    await restored.ready;
    expect(() => restored?.outbox.retry(operation.event.id)).toThrow(
      "Channel addition cancelled",
    );
    expect(restored.outbox.snapshot()[0]?.delivery).toBe("failed");
    expect(test.sign).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(localStorage.getItem(receiptKey)).toBe(frozen);
  } finally {
    writing.mockRestore();
    restored?.dispose();
    test.dispose();
  }
});

it.each([
  ["lost ACK", false],
  ["missing membership", false],
  ["never landed", false],
  ["lost ACK", true],
  ["missing membership", true],
  ["never landed", true],
] as const)(
  "retries the same Create identity after %s without repeating template writes (template: %s)",
  async (failure, template) => {
    let unavailable = false;
    let dropping = failure === "never landed";
    const attempts: RelayEvent[] = [];
    const test = harness(
      undefined,
      async () => {
        if (unavailable) throw new Error("membership unavailable");
      },
      true,
      undefined,
      async (event) => {
        if (event.kind !== 9007) return;
        attempts.push(event);
        if (dropping) throw new Error("Connection lost before storage");
      },
      async (event) => {
        if (event.kind !== 9007 || failure === "never landed") return;
        unavailable = true;
        if (failure === "lost ACK") throw new Error("ACK lost");
      },
    );
    const user = userEvent.setup();
    const closed = vi.fn();
    const registry = providerFixture();
    if (template) test.setRecord(savedTemplate([test.fixture.agent.pubkey]));
    function Form() {
      const creation = test.owner.session.channelCreation;
      const pending = useSyncExternalStore(
        creation.subscribe,
        creation.snapshot,
      );
      return (
        <CreateChannelDialog
          open
          onOpenChange={closed}
          onCreate={async (input) => {
            await creation.create(input);
          }}
          pending={pending}
          session={test.owner.session}
          providers={registry.providers}
          groups={undefined}
          initialGroup=""
          groupsReady
        />
      );
    }
    try {
      render(<Form />);
      await user.type(
        screen.getByRole("textbox", { name: "Name" }),
        "Uncertain",
      );
      if (template) {
        await waitFor(() =>
          expect(test.owner.session.archives.snapshot().status).toBe("ready"),
        );
        await chooseSaved();
      }
      await user.click(screen.getByRole("button", { name: "Create channel" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /ACK lost|membership unavailable|Connection lost before storage/,
      );
      expect(closed).not.toHaveBeenCalled();
      const first = attempts[0];
      assert.exists(first);
      const id = first.tags.find(([tag]) => tag === "h")?.[1];
      expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Retry channel" }));
      await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
      expect(closed).not.toHaveBeenCalled();
      expect(test.published.filter((event) => event.kind === 9007)).toEqual(
        failure === "never landed" ? [] : [first],
      );
      expect(attempts).toEqual(
        failure === "never landed" ? [first, first] : [first],
      );
      // Closing and reopening must retain the same session-owned attempt.
      cleanup();
      render(<Form />);
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Uncertain",
      );
      unavailable = false;
      dropping = false;
      await user.click(screen.getByRole("button", { name: "Retry channel" }));
      await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
      expect(test.owner.session.channels.get?.(id ?? "")?.members).toContain(
        test.viewer.pubkey,
      );
      expect(
        test.sign.mock.calls.filter(([event]) => event.kind === 9007),
      ).toHaveLength(1);
      expect(test.published.filter((event) => event.kind === 9007)).toEqual([
        first,
      ]);
      expect(attempts).toEqual(
        failure === "never landed" ? [first, first, first] : [first],
      );
      expect(test.owner.session.channelCreation.snapshot()).toBeUndefined();
      if (template)
        await waitFor(() =>
          expect(
            test.owner.session.channelCreation.notices()[0]?.error,
          ).toContain("Template setup was not continued"),
        );
      expect(test.published.map((event) => event.kind)).toEqual([9007]);
    } finally {
      cleanup();
      test.dispose();
    }
  },
);
