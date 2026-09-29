import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
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
import * as communityApi from "../../features/communities/api";
import { AgentsPage } from "./AgentsPage";
import type { PageNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dispose of disposals.splice(0)) dispose();
});
function setup(
  mode = "ready",
  configure?: (fixture: ReturnType<typeof controlFixture>) => void,
  navigation?: PageNavigation,
  open?: (
    target: OpenTarget,
    options?: { replace?: boolean },
  ) => Promise<{ status: "opened" }>,
) {
  const f = controlFixture();
  configure?.(f);
  f.data.agents.push({
    ...structuredClone(f.agent),
    id: "other-destination",
    relayUrl: "wss://second.example",
    revision: 7,
  });
  const read = vi.fn(async () => {
    if (mode === "error") throw Error("synthetic");
    return {
      definitions: [
        { id: "linked", name: "Library card" },
        { id: "unimported", name: "Not imported" },
      ],
      identities: [
        { pubkey: f.agent.pubkey, name: f.agent.name, definitionId: "linked" },
        {
          pubkey: "cd".repeat(32),
          name: "Not imported",
          definitionId: "unimported",
        },
      ],
    };
  });
  const owned = createRelaySession({
    viewer: "de".repeat(32),
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    ...(mode === "unavailable" ? {} : { readAgentLibrary: read }),
    query: async () => [],
    media: () => undefined,
  });
  disposals.push(() => owned.dispose());
  const session =
    mode === "archived"
      ? {
          ...owned.session,
          archives: {
            ...owned.session.archives,
            state: () => "archived" as const,
          },
        }
      : owned.session;
  let snapshot: RelaySnapshot = {
    status:
      mode === "disconnected"
        ? "disconnected"
        : mode === "connecting"
          ? "connecting"
          : "ready",
    scope:
      mode === "connected"
        ? `wss://relay.example.test:${"de".repeat(32)}`
        : "A",
    ...(mode === "connected" ? { viewer: "de".repeat(32) } : {}),
    generation: 1,
    session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const control = createAgentControl(mode === "browser" ? null : f.host);
  disposals.push(() => control.dispose());
  const names = bindNames(session, {
    snapshot: () => [createAgentDirectory(control)],
    subscribe: () => () => {},
  });
  snapshot = { ...snapshot, session: { ...session, names } };
  disposals.push(() => names.dispose());
  render(
    <AgentsPage
      relay={relay}
      control={control}
      navigation={navigation}
      {...(open ? { open } : {})}
    />,
  );
  return {
    f,
    read,
    control,
    changeScope(scope: string, generation: number) {
      snapshot = { status: "ready", scope, generation, session };
      for (const listener of listeners) listener();
    },
    connect() {
      snapshot = {
        status: "ready",
        scope: `wss://relay.example.test:${"de".repeat(32)}`,
        viewer: "de".repeat(32),
        generation: snapshot.generation,
        session: snapshot.session,
      };
      for (const listener of listeners) listener();
    },
  };
}
it("shows native controls per exact destination and separate read-only discovered identities", async () => {
  const { f } = setup();
  const cards = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(cards).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Use in channel" })).toBeNull();
  const card = cards.find((entry) =>
    entry.textContent?.includes("wss://second.example"),
  );
  if (!card) throw Error("Second destination missing");
  expect(
    within(
      screen.getByRole("region", { name: "Library identities" }),
    ).getByRole("article", { name: "Agent Not imported" }),
  ).toBeTruthy();
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit agent" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Technical details" }),
  );
  expect(within(dialog).getByText(npubEncode(f.agent.pubkey))).toBeVisible();
  expect(dialog.textContent).not.toContain(f.agent.pubkey);
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Exact destination" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect(f.calls.find((call) => call.action === "save")?.payload).toMatchObject(
    { id: "other-destination", expectedRevision: 7 },
  );
  // The synthetic host rejects this revision; failed save must retain the draft.
  await within(dialog).findByText(/Could not confirm/);
  expect(within(dialog).getByLabelText("Name")).toHaveValue(
    "Exact destination",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("article", { name: "Agent Not imported" }),
  ).toBeTruthy();
  expect(screen.queryByText("Old Buzz library", { exact: true })).toBeNull();
  expect(screen.getByText("Add agent", { exact: true })).toBeVisible();
  expect(f.calls.some((call) => call.action === "import")).toBe(false);
});
for (const mode of ["disconnected", "unavailable", "error", "archived"]) {
  it(`keeps native agents editable when the library is ${mode}`, async () => {
    const { f } = setup(mode);
    const cards = await screen.findAllByRole("article", {
      name: "Agent Fixture agent",
    });
    const card = cards[0];
    if (!card) throw Error("Native fallback card missing");
    fireEvent.click(
      within(card).getByRole("button", { name: "Actions for Fixture agent" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit agent" })).toBeVisible();
    expect(f.calls.some((call) => call.action === "import")).toBe(false);
  });
}
it("remounts records for equal-generation community switches and session replacements", async () => {
  const f = setup();
  await screen.findAllByRole("article", { name: "Agent Fixture agent" });
  expect(f.read).toHaveBeenCalledTimes(1);
  await act(async () => f.changeScope("B", 1));
  expect(f.read).toHaveBeenCalledTimes(2);
  await act(async () => f.changeScope("B", 2));
  expect(f.read).toHaveBeenCalledTimes(3);
});

for (const mode of ["absolute", "saved-override", "draft-override"]) {
  it(`leaves ${mode} model discovery to native validation`, async () => {
    const run = vi.fn(async () => ({
      host: "https://workspace.example.com",
      models: [],
      modelOverridden: false,
      disconnected: false,
    }));
    setup("ready", (f) => {
      Object.assign(f.agent.harness, {
        command: mode === "absolute" ? "/fixture/bin/buzz-agent" : "buzz-agent",
        provider: mode === "absolute" ? "databricks_v2" : "selector-other",
        args: [],
        databricks: { host: "https://workspace.example.com", filter: "" },
        environmentKeys:
          mode === "saved-override" ? ["BUZZ_AGENT_PROVIDER"] : [],
      });
      f.host.models = { begin: async () => 1, cancel: async () => {}, run };
    });
    const cards = await screen.findAllByRole("article", {
      name: "Agent Fixture agent",
    });
    const card = cards.find((entry) =>
      entry.textContent?.includes("wss://relay.example.test"),
    );
    if (!card) throw Error("Primary destination missing");
    fireEvent.click(
      within(card).getByRole("button", { name: "Actions for Fixture agent" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit agent" });
    if (mode === "draft-override") {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Environment" }),
      );
      fireEvent.change(within(dialog).getByLabelText("Variable name"), {
        target: { value: "BUZZ_AGENT_PROVIDER" },
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Add variable" }),
      );
      fireEvent.change(
        within(dialog).getByLabelText("Replacement for BUZZ_AGENT_PROVIDER"),
        {
          target: { value: "databricks_v2" },
        },
      );
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Model" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Refresh models" }),
    );
    await within(dialog).findByText(/No models found/);
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        action: "refresh",
        edit: expect.objectContaining({
          environment:
            mode === "draft-override"
              ? { BUZZ_AGENT_PROVIDER: "databricks_v2" }
              : {},
          harness: expect.objectContaining({
            command:
              mode === "absolute" ? "/fixture/bin/buzz-agent" : "buzz-agent",
            provider: mode === "absolute" ? "databricks_v2" : "selector-other",
          }),
        }),
      }),
    );
  });
}

it("checks Start failure and keeps lifecycle controls available", async () => {
  const { f, control } = setup();
  const [card] = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  if (!card) throw Error("Missing managed card");
  expect(
    within(card).getByText("Process running · relay readiness unverified"),
  ).toBeVisible();
  fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
  await within(card).findByRole("button", { name: "Start" });
  expect(f.calls.at(-1)).toEqual({
    action: "stop",
    payload: { id: "fixture-agent" },
  });
  f.host.action = async () => {
    throw "synthetic start failure";
  };
  fireEvent.click(within(card).getByRole("button", { name: "Start" }));
  const notice = await within(card).findByText(
    "The agent didn't start. synthetic start failure. Try again.",
  );
  expect(screen.queryByRole("button", { name: "Retry status" })).toBeNull();
  expect(within(card).getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(within(card).getByRole("button", { name: "Start" })).toBeEnabled();
  f.data.runtimeAvailable = false;
  await act(async () => control.refresh());
  expect(within(card).getByRole("button", { name: "Start" })).toBeDisabled();
  expect(
    within(card).getByText(/bundled agent runtime is unavailable/),
  ).toBeVisible();
  expect(notice).toBeVisible();
  // A later status change, such as a mention start, supersedes the notice.
  f.agent.status = "running";
  await act(async () => control.refresh());
  expect(within(card).queryByText(/The agent didn't start/)).toBeNull();
});
it("retires a card Start failure after the editor starts and stops the agent", async () => {
  const { f } = setup();
  const [card] = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  if (!card) throw Error("Missing managed card");
  fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
  await within(card).findByRole("button", { name: "Start" });
  const action = f.host.action;
  f.host.action = async () => {
    throw "synthetic start failure";
  };
  fireEvent.click(within(card).getByRole("button", { name: "Start" }));
  await within(card).findByText(/The agent didn't start/);
  f.host.action = action;
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit agent" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Runtime" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
  await within(card).findByText("Process running · relay readiness unverified");
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
  await within(card).findByText("Process stopped");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close editor" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(within(card).getByText("Process stopped")).toBeVisible();
  expect(within(card).queryByText(/The agent didn't start/)).toBeNull();
});
it("Add opens a focused creation dialog and retains a dirty draft on Escape", async () => {
  const { f } = setup();
  const add = await screen.findByRole("button", { name: "Add agent" });
  expect(add).toHaveAttribute("aria-haspopup", "dialog");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(add);
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "New helper" },
  });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(within(dialog).getByLabelText("Name")).toHaveValue("New helper");
  expect(f.calls.every((call) => call.action === "snapshot")).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("duplicates editable settings into a new identity without copying write-only secrets", async () => {
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const prepare = vi.fn(async () => ({
    id: "new-agent",
    pubkey: "cd".repeat(32),
  }));
  const commit = vi.fn(async (_requestId: string, edit: { name: string }) => {
    fixture.data.agents.push({
      ...structuredClone(fixture.agent),
      id: "new-agent",
      name: edit.name,
      enabled: false,
      status: "stopped",
    });
    return structuredClone(fixture.data);
  });
  let fixture!: ReturnType<typeof controlFixture>;
  setup("connected", (f) => {
    fixture = f;
    f.data.createAvailable = true;
    f.agent.harness.environmentKeys = ["API_KEY"];
    f.agent.harness.provider = "openai";
    f.agent.harness.model = "example-model";
    f.agent.systemPrompt = "Be concise";
    f.host.prepareCreate = prepare;
    f.host.commitCreate = commit;
    f.host.publishProfile = async () => structuredClone(f.data);
  });
  const card = (
    await screen.findAllByRole("article", { name: "Agent Fixture agent" })
  )[0];
  if (!card) throw Error("Missing managed card");
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
  const dialog = screen.getByRole("dialog", {
    name: "Duplicate Fixture agent",
  });
  expect(within(dialog).getByLabelText("Name")).toHaveValue(
    "Fixture agent copy",
  );
  expect(within(dialog).getByLabelText("Agent instructions")).toHaveValue(
    "Be concise",
  );
  expect(
    within(dialog).getByText(/Re-enter environment values for API_KEY/),
  ).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Create agent" }));
  await waitFor(() =>
    expect(prepare).toHaveBeenCalledWith(
      expect.any(String),
      "wss://relay.example.test",
      "de".repeat(32),
    ),
  );
  await waitFor(() => expect(commit).toHaveBeenCalled());
  expect(commit.mock.calls[0]?.[1]).toMatchObject({
    name: "Fixture agent copy",
    systemPrompt: "Be concise",
    harness: { provider: "openai", model: "example-model" },
    environment: {},
  });
});

it("confirms local deletion, keeps the card on failure, and removes it only after host success", async () => {
  let fail = true;
  const remove = vi.fn(async (id: string, revision: number) => {
    if (revision !== 1) throw "Saved settings changed";
    if (fail) throw "Could not remove the saved credential";
    fixture.data.agents = fixture.data.agents.filter(
      (agent) => agent.id !== id,
    );
    return structuredClone(fixture.data);
  });
  let fixture!: ReturnType<typeof controlFixture>;
  setup("ready", (f) => {
    fixture = f;
    f.host.delete = remove;
  });
  const card = (
    await screen.findAllByRole("article", { name: "Agent Fixture agent" })
  )[0];
  if (!card) throw Error("Missing managed card");
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = screen.getByRole("dialog", { name: "Delete Fixture agent?" });
  expect(
    within(dialog).getByText(/relay identity and past messages remain visible/),
  ).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "Delete Fixture agent?" }),
    ).getByRole("button", { name: "Delete agent" }),
  );
  await waitFor(() => expect(remove).toHaveBeenCalledWith("fixture-agent", 1));
  expect(card).toBeInTheDocument();
  expect(
    await within(
      screen.getByRole("dialog", { name: "Delete Fixture agent?" }),
    ).findByRole("alert"),
  ).toHaveTextContent(/Could not remove the saved credential/);
  fail = false;
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "Delete Fixture agent?" }),
    ).getByRole("button", { name: "Retry status" }),
  );
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("dialog", { name: "Delete Fixture agent?" }),
      ).getByRole("button", { name: "Delete agent" }),
    ).toBeEnabled(),
  );
  expect(
    within(
      screen.getByRole("dialog", { name: "Delete Fixture agent?" }),
    ).getByRole("alert"),
  ).toHaveTextContent("Could not remove the saved credential");
  expect(remove).toHaveBeenCalledTimes(1);
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "Delete Fixture agent?" }),
    ).getByRole("button", { name: "Delete agent" }),
  );
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(card).not.toBeInTheDocument());
});

it("keeps Duplicate and Delete on local cards in the unified inventory", async () => {
  setup("connected", (f) => {
    f.data.parked = [];
    f.host.delete = vi.fn(async () => structuredClone(f.data));
  });
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  // Unified inventory cards carry identity sources; legacy cards do not.
  expect(within(card).getByText("Identity & sources")).toBeInTheDocument();
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  // Both saved setups of this key keep exact controls, including the one outside this community.
  const duplicates = await screen.findAllByRole("menuitem", {
    name: /^Duplicate /,
  });
  expect(duplicates).toHaveLength(2);
  fireEvent.click(duplicates[0] as HTMLElement);
  const duplicate = screen.getByRole("dialog", {
    name: "Duplicate Fixture agent",
  });
  fireEvent.click(within(duplicate).getByRole("button", { name: "Cancel" }));
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  const deletes = await screen.findAllByRole("menuitem", { name: /^Delete / });
  expect(deletes).toHaveLength(2);
  fireEvent.click(deletes[0] as HTMLElement);
  expect(
    screen.getByRole("dialog", { name: "Delete Fixture agent?" }),
  ).toBeVisible();
});

it("focuses the imported managed identity without starting it", async () => {
  const { f } = setup();
  await screen.findAllByRole("article", { name: "Agent Fixture agent" });
  fireEvent.click(
    screen.getByRole("button", { name: "Import from another installation" }),
  );
  fireEvent.change(screen.getByLabelText("Destination community"), {
    target: { value: "wss://third.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load agents" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Import Fixture agent" }),
  );
  const notice = await screen.findByText(
    "Imported, not started. Start it when you are ready.",
  );
  const imported = notice.closest("article");
  if (!imported) throw Error("Imported card missing");
  expect(imported).toHaveTextContent("wss://third.example");
  expect(notice.parentElement).toHaveFocus();
  expect(within(imported).getByRole("button", { name: "Start" })).toBeEnabled();
  expect(f.calls.some((call) => call.action === "start")).toBe(false);
});

it("keeps the read-only library available when native management is unavailable", async () => {
  setup("browser");
  const card = await screen.findByRole("article", {
    name: "Agent Not imported",
  });
  expect(
    within(card).queryByRole("button", { name: /Actions|Start|Edit/ }),
  ).toBeNull();
  expect(screen.queryByText("Add agent", { exact: true })).toBeNull();
  expect(screen.getByText(/This browser cannot run/)).toBeVisible();
});
function expectAIFieldOrder(dialog: HTMLElement) {
  const fields = ["Harness", "Provider", "Model"].map((name) =>
    within(dialog).getByRole("combobox", { name }),
  );
  for (const [index, field] of fields.entries()) {
    expect(field).toBeVisible();
    const next = fields[index + 1];
    if (next)
      expect(field.compareDocumentPosition(next)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
  }
}

it("shows Harness, Provider and Model in that order when adding an agent", async () => {
  const { f } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  expectAIFieldOrder(dialog);
  expect(
    within(dialog).getByRole("group", { name: "AI configuration" }),
  ).toBeVisible();
  expect(within(dialog).getByLabelText("Workspace")).not.toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(f.calls.every((call) => call.action === "snapshot")).toBe(true);
});

it("selects installed Goose with ACP arguments and saves its provider and model", async () => {
  const { f } = setup("ready", (fixture) => {
    fixture.data.harnessOptions?.push({
      command: "/Users/test/.local/bin/goose",
      label: "Goose",
      available: true,
      defaultArgs: ["acp"],
      providers: [
        { value: "anthropic", label: "Anthropic" },
        { value: "openrouter", label: "OpenRouter" },
      ],
    });
  });
  const [card] = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  if (!card) throw Error("Missing managed card");
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit agent" });
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Goose" }));
  expect(within(dialog).getByLabelText("LLM Provider")).toBeVisible();
  expect(within(dialog).getByRole("combobox", { name: "Model" })).toHaveValue(
    "",
  );
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "LLM Provider" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "OpenRouter" }),
  );
  const model = within(dialog).getByRole("combobox", { name: "Model" });
  fireEvent.change(model, {
    target: { value: "anthropic/claude-sonnet-4" },
  });
  fireEvent.blur(model);
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "Conversation context" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Each thread" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await within(dialog).findByText("Saved.");
  expect(f.calls.find((call) => call.action === "save")?.payload).toMatchObject(
    {
      edit: {
        sessionPolicy: "thread",
        harness: {
          command: "/Users/test/.local/bin/goose",
          args: ["acp"],
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4",
        },
      },
    },
  );
});

for (const source of ["saved", "draft"] as const) {
  for (const provider of ["", "openai"] as const) {
    it(`passes a ${source} Goose provider override with a ${provider || "blank"} selector to native discovery`, async () => {
      const run = vi.fn(async () => ({
        host: "",
        models: [{ id: "catalog.schema.model", name: "catalog.schema.model" }],
        modelOverridden: false,
        disconnected: false,
      }));
      setup("ready", (fixture) => {
        Object.assign(fixture.agent.harness, {
          command: "/fixture/bin/goose",
          args: ["acp"],
          provider,
          environmentKeys: source === "saved" ? ["GOOSE_PROVIDER"] : [],
        });
        fixture.data.harnessOptions?.push({
          command: "/fixture/bin/goose",
          label: "Goose",
          available: true,
          defaultArgs: ["acp"],
          providers: [{ value: "databricks_v2", label: "Databricks v2" }],
        });
        fixture.host.models = {
          begin: async () => 1,
          cancel: async () => {},
          run,
        };
      });
      const [card] = await screen.findAllByRole("article", {
        name: "Agent Fixture agent",
      });
      if (!card) throw Error("Missing managed card");
      fireEvent.click(
        within(card).getByRole("button", { name: "Actions for Fixture agent" }),
      );
      fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
      const dialog = screen.getByRole("dialog", { name: "Edit agent" });
      if (source === "draft") {
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Environment" }),
        );
        fireEvent.change(within(dialog).getByLabelText("Variable name"), {
          target: { value: "GOOSE_PROVIDER" },
        });
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Add variable" }),
        );
        fireEvent.change(
          within(dialog).getByLabelText("Replacement for GOOSE_PROVIDER"),
          { target: { value: "databricks_v2" } },
        );
      }
      expect(
        within(dialog).queryByRole("button", { name: "Refresh models" }),
      ).not.toBeInTheDocument();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Browse models" }),
      );
      await waitFor(() =>
        expect(run).toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            action: "connect",
            edit: expect.objectContaining({
              harness: expect.objectContaining({ provider }),
              environment:
                source === "saved" ? {} : { GOOSE_PROVIDER: "databricks_v2" },
            }),
          }),
        ),
      );
    });
  }
}

it("keeps Goose model browsing available after a draft provider override", async () => {
  setup("ready", (fixture) => {
    Object.assign(fixture.agent.harness, {
      command: "/fixture/bin/goose",
      args: ["acp"],
      provider: "databricks_v2",
      environmentKeys: [],
    });
  });
  const [card] = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  if (!card) throw Error("Missing managed card");
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit agent" });
  expect(
    within(dialog).getByRole("button", { name: "Browse models" }),
  ).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Environment" }));
  fireEvent.change(within(dialog).getByLabelText("Variable name"), {
    target: { value: "GOOSE_PROVIDER" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add variable" }));
  fireEvent.change(
    within(dialog).getByLabelText("Replacement for GOOSE_PROVIDER"),
    { target: { value: "openai" } },
  );
  expect(
    within(dialog).getByRole("button", { name: "Browse models" }),
  ).toBeVisible();
  expect(within(dialog).getByRole("combobox", { name: "Model" })).toBeVisible();
});

it("creates and starts a Goose agent with the selected provider", async () => {
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const commit = vi.fn();
  const start = vi.fn();
  setup("connected", (fixture) => {
    fixture.data.createAvailable = true;
    fixture.data.defaultWorkspace = "/fixture/workspace";
    fixture.data.harnessOptions?.push({
      command: "/Users/test/.local/bin/goose",
      label: "Goose",
      available: true,
      defaultArgs: ["acp"],
      providers: [{ value: "openrouter", label: "OpenRouter" }],
    });
    fixture.host.prepareCreate = async () => ({
      id: "created-goose",
      pubkey: "cd".repeat(32),
    });
    fixture.host.commitCreate = commit.mockImplementation(async (_id, edit) => {
      fixture.data.agents.push({
        ...structuredClone(fixture.agent),
        id: "created-goose",
        name: edit.name,
        harness: { ...edit.harness, environmentKeys: [] },
        enabled: false,
        status: "stopped",
        runningRevision: null,
      });
      return structuredClone(fixture.data);
    });
    fixture.host.action = start.mockImplementation(async (id, action) => {
      const agent = fixture.data.agents.find((item) => item.id === id);
      if (!agent || action !== "start") throw Error("Unexpected agent action");
      agent.enabled = true;
      agent.status = "running";
      return structuredClone(fixture.data);
    });
    fixture.host.publishProfile = async () => structuredClone(fixture.data);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Goose helper" },
  });
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Goose" }));
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "LLM Provider" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "OpenRouter" }),
  );
  const model = within(dialog).getByRole("combobox", { name: "Model" });
  fireEvent.change(model, {
    target: { value: "anthropic/claude-sonnet-4" },
  });
  fireEvent.blur(model);
  fireEvent.click(within(dialog).getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(commit).toHaveBeenCalledOnce());
  expect(commit.mock.calls[0]?.[1].harness).toMatchObject({
    command: "/Users/test/.local/bin/goose",
    args: ["acp"],
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
  });
  expect(start).toHaveBeenCalledExactlyOnceWith("created-goose", "start");
  expect(
    await screen.findByRole("article", { name: "Agent Goose helper" }),
  ).toHaveTextContent("Process running");
});

it("keeps the saved agent when Start reports a process failure", async () => {
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const commit = vi.fn();
  const start = vi.fn();
  const profile = vi.fn();
  setup("connected", (fixture) => {
    fixture.data.createAvailable = true;
    fixture.data.defaultWorkspace = "/fixture/workspace";
    fixture.host.prepareCreate = async () => ({
      id: "created",
      pubkey: "cd".repeat(32),
    });
    fixture.host.commitCreate = commit.mockImplementation(async (_id, edit) => {
      fixture.data.agents.push({
        ...structuredClone(fixture.agent),
        id: "created",
        name: edit.name,
        enabled: false,
        status: "stopped",
        profilePending: true,
      });
      return structuredClone(fixture.data);
    });
    fixture.host.action = start.mockImplementation(async (id, action) => {
      const agent = fixture.data.agents.find((item) => item.id === id);
      if (!agent || action !== "start") throw Error("Unexpected agent action");
      if (start.mock.calls.length === 1) {
        await startGate;
        agent.status = "failed";
        agent.error = "Goose could not open.";
      } else {
        agent.status = "running";
        agent.error = null;
      }
      agent.enabled = true;
      return structuredClone(fixture.data);
    });
    fixture.host.publishProfile = profile.mockImplementation(async () => {
      const agent = fixture.data.agents.find((item) => item.id === "created");
      if (!agent) throw Error("Created agent missing");
      agent.profilePending = false;
      return structuredClone(fixture.data);
    });
  });
  const user = userEvent.setup();
  try {
    await user.click(await screen.findByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Create agent" });
    await user.type(within(dialog).getByLabelText("Name"), "Goose helper");
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(
      within(dialog).getByText(/Goose helper was created. Starting it/),
    ).toBeVisible();
    expect(profile).not.toHaveBeenCalled();
    await act(async () => releaseStart());
    await within(dialog).findByText(
      /Goose helper was created, but couldn't start/,
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(profile).toHaveBeenCalledOnce();
    await user.click(
      within(dialog).getByRole("button", { name: "Start agent" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(commit).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
    expect(profile).toHaveBeenCalledOnce();
  } finally {
    await act(async () => releaseStart());
  }
});

it("checks an unconfirmed Start without repeating it", async () => {
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const commit = vi.fn();
  const start = vi.fn();
  const profile = vi.fn();
  setup("connected", (fixture) => {
    fixture.data.createAvailable = true;
    fixture.data.defaultWorkspace = "/fixture/workspace";
    fixture.host.prepareCreate = async () => ({
      id: "created",
      pubkey: "cd".repeat(32),
    });
    fixture.host.commitCreate = commit.mockImplementation(async (_id, edit) => {
      fixture.data.agents.push({
        ...structuredClone(fixture.agent),
        id: "created",
        name: edit.name,
        enabled: false,
        status: "stopped",
        profilePending: true,
      });
      return structuredClone(fixture.data);
    });
    fixture.host.action = start.mockImplementation(async (id) => {
      const agent = fixture.data.agents.find((item) => item.id === id);
      if (!agent) throw Error("Created agent missing");
      agent.enabled = true;
      agent.status = "running";
      throw "Start confirmation was lost.";
    });
    fixture.host.publishProfile = profile.mockImplementation(async () => {
      const agent = fixture.data.agents.find((item) => item.id === "created");
      if (!agent) throw Error("Created agent missing");
      agent.profilePending = false;
      return structuredClone(fixture.data);
    });
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  await user.type(within(dialog).getByLabelText("Name"), "Goose helper");
  await user.click(
    within(dialog).getByRole("button", { name: "Create agent" }),
  );
  expect(
    await within(dialog).findByRole("button", { name: "Finish profile" }),
  ).toBeEnabled();
  expect(commit).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(profile).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", { name: "Finish profile" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(commit).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(profile).toHaveBeenCalledOnce();
});

it("shows an unavailable Goose harness without allowing selection", async () => {
  setup("ready", (fixture) => {
    fixture.data.harnessOptions?.push({
      command: "goose",
      label: "Goose",
      available: false,
      defaultArgs: ["acp"],
      providers: [{ value: "anthropic", label: "Anthropic" }],
    });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  );
  expect(
    await screen.findByRole("option", { name: "Goose (install first)" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).getByText(/Install the Goose CLI/)).toBeVisible();
});

it.each(["Create agent", "Edit agent"] as const)(
  "%s links a missing Harness to Settings › Agents",
  async (dialogName) => {
    const open = vi.fn(async () => ({ status: "opened" as const }));
    setup(
      "ready",
      (fixture) => {
        fixture.data.harnessOptions?.push({
          command: "goose",
          label: "Goose",
          available: false,
          status: "cli-needed",
          providers: [],
        });
      },
      undefined,
      open,
    );
    if (dialogName === "Create agent") {
      await userEvent.click(
        await screen.findByRole("button", { name: "Add agent" }),
      );
    } else {
      const [card] = await screen.findAllByRole("article", {
        name: "Agent Fixture agent",
      });
      if (!card) throw Error("Missing managed card");
      await userEvent.click(
        within(card).getByRole("button", { name: "Actions for Fixture agent" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    }
    const dialog = screen.getByRole("dialog", { name: dialogName });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Edited before setup" },
    });
    expect(
      within(dialog).getByText("Opening Settings discards unsaved edits."),
    ).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Open Harnesses in Settings",
      }),
    );
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "settings",
      section: "agents",
    });
  },
);

it("shows Harness, Provider and Model in order while preserving settings on Save", async () => {
  const { f } = setup();
  const original = structuredClone(f.agent.harness);
  const [card] = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  if (!card) throw Error("Missing managed card");
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit agent" });
  expect(within(dialog).getByLabelText("Name")).toBeVisible();
  expect(within(dialog).getByLabelText("Agent instructions")).toBeVisible();
  expectAIFieldOrder(dialog);
  expect(within(dialog).getByLabelText("Workspace")).not.toBeVisible();
  fireEvent.change(within(dialog).getByLabelText("Agent instructions"), {
    target: { value: "Focused everyday edit" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await within(dialog).findByText("Saved.");
  expect(f.agent.harness).toEqual(original);
  const advanced = within(dialog).getByRole("button", {
    name: "Environment",
  });
  fireEvent.click(advanced);
  fireEvent.change(within(dialog).getByLabelText("Variable name"), {
    target: { value: "UNFINISHED_KEY" },
  });
  fireEvent.click(advanced);
  expect(advanced).toHaveAttribute("aria-expanded", "false");
  expect(within(dialog).getByLabelText("Variable name")).not.toBeVisible();
  fireEvent.click(advanced);
  expect(within(dialog).getByLabelText("Variable name")).toHaveValue(
    "UNFINISHED_KEY",
  );
  expect(
    within(dialog).getByLabelText("Harness", { exact: true }),
  ).toBeVisible();
  expect(
    within(dialog).getByLabelText("Provider", { exact: true }),
  ).toBeVisible();
});

it("does not offer an identity for import when its key is already set up in another community", async () => {
  setup("ready", (fixture) => {
    fixture.data.agents.push({
      ...structuredClone(fixture.agent),
      id: "held-elsewhere",
      pubkey: "CD".repeat(32),
      relayUrl: "wss://elsewhere.example",
      enabled: false,
      status: "stopped",
      runningRevision: null,
    });
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Import from another installation",
    }),
  );
  fireEvent.change(screen.getByLabelText("Destination community"), {
    target: { value: "wss://third.example" },
  });
  for (let load = 0; load < 2; load++) {
    fireEvent.click(screen.getByRole("button", { name: "Load agents" }));
    expect(
      await screen.findByText(
        "No agents left to import or repair from this library for this community.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Import Fixture agent" }),
    ).toBeNull();
  }
});
it("credential import keeps real Stop controls reachable without trapping the editor", async () => {
  let releaseImport!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  const { f, control } = setup("ready", (fixture) => {
    const commit = fixture.host.commitImport;
    fixture.host.commitImport = async (...args) => {
      await gate;
      return commit(...args);
    };
    fixture.host.action = async (id, action) => {
      fixture.calls.push({ action, payload: { id } });
      const agent = fixture.data.agents.find((agent) => agent.id === id);
      if (!agent) throw Error("Missing action target");
      agent.enabled = action !== "stop";
      agent.status = action === "stop" ? "stopped" : "running";
      return structuredClone(fixture.data);
    };
  });
  try {
    const cards = await screen.findAllByRole("article", {
      name: "Agent Fixture agent",
    });
    const [first, other] = cards;
    if (!first || !other) throw Error("Missing managed cards");
    fireEvent.click(
      screen.getByRole("button", { name: "Import from another installation" }),
    );
    fireEvent.change(screen.getByLabelText("Destination community"), {
      target: { value: "wss://third.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load agents" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Import Fixture agent" }),
    );
    expect(control.snapshot().busy).toBe(true);
    expect(within(first).getByRole("button", { name: "Stop" })).toBeEnabled();
    fireEvent.click(
      within(first).getByRole("button", { name: "Actions for Fixture agent" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Runtime" }));
    expect(within(dialog).getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: "Restart" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    for (const name of [
      "Name",
      "Agent instructions",
      "Harness",
      "Provider",
      "Model",
      "Model ID (custom or blank)",
    ]) {
      expect(
        within(dialog).getByLabelText(name, {
          exact: true,
          selector: "input, textarea, button",
        }),
      ).toBeDisabled();
    }
    expect(within(dialog).getByRole("button", { name: "Model" })).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: "Close editor" }),
    ).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    // Stop leaves the independent launch preference on.
    await within(dialog).findByText("Start on launch enabled");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close editor" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // Recovery for a different exact identity stays accessible behind the dialog.
    fireEvent.click(within(other).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(f.calls.filter((call) => call.action === "stop")).toEqual([
        { action: "stop", payload: { id: "fixture-agent" } },
        { action: "stop", payload: { id: "other-destination" } },
      ]),
    );
    await act(async () => {
      releaseImport();
      await gate;
    });
    await waitFor(() => expect(control.snapshot().busy).toBe(false));
    expect(
      screen.queryByText("Imported, not started. Start it when you are ready."),
    ).toBeNull();
    await act(async () => control.refresh());
    const imported = control
      .snapshot()
      .data?.agents.find((agent) => agent.id === "second-fixture");
    expect(imported).toMatchObject({ enabled: false, status: "stopped" });
  } finally {
    await act(async () => {
      releaseImport();
      await gate;
    });
  }
});

for (const stage of ["create", "profile"] as const) {
  for (const recoverStop of [false, true]) {
    it(`${stage} wait: dismiss Create, recovery Stop=${recoverStop}, no late UI replay`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const create = vi.fn();
      const profile = vi.fn();
      vi.spyOn(communityApi, "communityRequest").mockResolvedValue({
        auth: [],
      });
      const { f, control } = setup("connected", (fixture) => {
        fixture.data.createAvailable = true;
        fixture.data.defaultWorkspace = "/fixture/workspace";
        fixture.host.prepareCreate = async () => ({
          id: "created",
          pubkey: "cd".repeat(32),
        });
        fixture.host.commitCreate = create.mockImplementation(
          async (_requestId, edit) => {
            if (stage === "create") await gate;
            fixture.data.agents.push({
              ...structuredClone(fixture.agent),
              id: "created",
              name: edit.name,
              enabled: false,
              status: "stopped",
              runningRevision: null,
              profilePending: true,
            });
            return structuredClone(fixture.data);
          },
        );
        fixture.host.action = async (id, action) => {
          const agent = fixture.data.agents.find((item) => item.id === id);
          if (!agent) throw Error("Agent missing");
          fixture.calls.push({ action, payload: { id } });
          agent.enabled = action !== "stop";
          agent.status = action === "stop" ? "stopped" : "running";
          return structuredClone(fixture.data);
        };
        fixture.host.publishProfile = profile.mockImplementation(async () => {
          await gate;
          const created = fixture.data.agents.find(
            (agent) => agent.id === "created",
          );
          if (!created) throw Error("Created fixture missing");
          created.profilePending = false;
          return structuredClone(fixture.data);
        });
      });
      const user = userEvent.setup();
      try {
        await user.click(
          await screen.findByRole("button", { name: "Add agent" }),
        );
        const dialog = screen.getByRole("dialog", { name: "Create agent" });
        await user.type(within(dialog).getByLabelText("Name"), "New helper");
        await user.click(
          within(dialog).getByRole("button", { name: "Create agent" }),
        );
        await waitFor(() =>
          expect(stage === "create" ? create : profile).toHaveBeenCalledOnce(),
        );
        expect(control.snapshot().busy).toBe(true);
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).toBeNull();
        const card = screen.getAllByRole("article", {
          name: "Agent Fixture agent",
        })[0];
        if (!card) throw Error("Running fixture card missing");
        const stop = within(card).getByRole("button", { name: "Stop" });
        expect(stop).toBeVisible();
        expect(stop).toBeEnabled();
        if (recoverStop) {
          await user.click(stop);
          await waitFor(() =>
            expect(f.calls).toContainEqual({
              action: "stop",
              payload: { id: "fixture-agent" },
            }),
          );
          expect(
            within(card).getByRole("button", { name: "Start" }),
          ).toBeDisabled();
        }
        // A later dialog must not be closed by the dismissed operation's callback.
        await user.click(screen.getByRole("button", { name: "Add agent" }));
        const newer = screen.getByRole("dialog", { name: "Create agent" });
        await act(async () => {
          release();
          await gate;
        });
        await waitFor(() => expect(control.snapshot().busy).toBe(false));
        expect(newer).toBeVisible();
        await user.click(within(newer).getByRole("button", { name: "Cancel" }));
        await act(async () => control.refresh());
        expect(
          control
            .snapshot()
            .data?.agents.find((agent) => agent.id === "created"),
        ).toMatchObject({
          enabled: stage === "profile" || !recoverStop,
          profilePending: stage === "create" && recoverStop,
        });
        if (recoverStop)
          expect(control.snapshot().data?.agents[0]).toMatchObject({
            enabled: false,
            status: "stopped",
          });
        expect(create).toHaveBeenCalledOnce();
        expect(profile).toHaveBeenCalledTimes(
          stage === "profile" || !recoverStop ? 1 : 0,
        );
      } finally {
        await act(async () => {
          release();
          await gate;
        });
      }
    });
  }
}

it("blocks creation before native writes when the runtime is missing and preserves the draft for recovery", async () => {
  const prepare = vi.fn(async () => ({
    id: "created",
    pubkey: "cd".repeat(32),
  }));
  const commit = vi.fn();
  const { f, control } = setup("connected", (fixture) => {
    fixture.data.createAvailable = true;
    fixture.data.runtimeAvailable = false;
    fixture.data.runtimeMessage =
      "Agent runtime is not packaged; build its resources first";
    fixture.host.prepareCreate = prepare;
    fixture.host.commitCreate = commit;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Calvin" },
  });
  const create = within(dialog).getByRole("button", { name: "Create agent" });
  expect(create).toBeDisabled();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "agent runtime is unavailable",
  );
  const form = create.closest("form");
  if (!form) throw Error("Missing create form");
  await act(async () => fireEvent.submit(form));
  expect(prepare).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  f.data.runtimeAvailable = true;
  await act(async () => control.refresh());
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Calvin");
  expect(create).toBeEnabled();
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

it("retries the same saved profile even if the runtime becomes unavailable", async () => {
  const prepare = vi.fn(async () => ({
    id: "created",
    pubkey: "cd".repeat(32),
  }));
  const commit = vi.fn();
  const profile = vi.fn();
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const { f, control } = setup("connected", (fixture) => {
    fixture.data.createAvailable = true;
    fixture.data.defaultWorkspace = "/fixture/workspace";
    fixture.host.prepareCreate = prepare;
    fixture.host.commitCreate = commit.mockImplementation(
      async (_request, edit) => {
        fixture.data.agents.push({
          ...structuredClone(fixture.agent),
          id: "created",
          name: edit.name,
          enabled: false,
          status: "stopped",
          profilePending: true,
        });
        return structuredClone(fixture.data);
      },
    );
    fixture.host.action = async (id, action) => {
      const agent = fixture.data.agents.find((item) => item.id === id);
      if (!agent || action !== "start") throw Error("Unexpected agent action");
      agent.enabled = true;
      agent.status = "running";
      return structuredClone(fixture.data);
    };
    fixture.host.publishProfile = profile
      .mockRejectedValueOnce("Synthetic profile failure")
      .mockImplementation(async () => {
        const created = fixture.data.agents.find(
          (agent) => agent.id === "created",
        );
        if (!created) throw Error("Missing created fixture");
        created.profilePending = false;
        return structuredClone(fixture.data);
      });
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  await user.type(within(dialog).getByLabelText("Name"), "Calvin");
  await user.click(
    within(dialog).getByRole("button", { name: "Create agent" }),
  );
  await within(dialog).findByText(/Calvin was saved and started/);
  expect(profile).toHaveBeenCalledExactlyOnceWith("created");
  f.data.runtimeAvailable = false;
  await act(async () => control.refresh());
  const retry = within(dialog).getByRole("button", { name: "Finish profile" });
  expect(control.snapshot().error).toBeNull();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Synthetic profile failure",
  );
  expect(retry).toBeEnabled();
  await user.click(retry);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(prepare).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledOnce();
  expect(profile.mock.calls).toEqual([["created"], ["created"]]);
});

it("shows agents without manual Retry after native startup", async () => {
  vi.useFakeTimers();
  let snapshot!: ReturnType<typeof vi.spyOn>;
  setup("ready", (f) => {
    snapshot = vi
      .spyOn(f.host, "snapshot")
      .mockRejectedValueOnce("Agent runtime is initializing; retry shortly");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("Reading local agent status…")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry status" })).toBeNull();
  expect(snapshot).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(
    screen.getAllByRole("article", { name: "Agent Fixture agent" }),
  ).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Retry status" })).toBeNull();
  expect(snapshot).toHaveBeenCalledTimes(2);
});
it("keeps persistent read failures visible and recovers on the next periodic read", async () => {
  vi.useFakeTimers();
  const { f } = setup("ready", (f) => {
    vi.spyOn(f.host, "snapshot").mockRejectedValue(
      "Agent runtime is initializing; retry shortly",
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByRole("button", { name: "Retry status" })).toBeVisible();
  expect(screen.getByText(/Could not refresh local agents/)).toBeVisible();
  expect(f.host.snapshot).toHaveBeenCalledTimes(21);
  vi.mocked(f.host.snapshot).mockRejectedValue("Store is unreadable");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4999);
  });
  expect(f.host.snapshot).toHaveBeenCalledTimes(21);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(f.host.snapshot).toHaveBeenCalledTimes(22);
  expect(screen.getByRole("button", { name: "Retry status" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(f.host.snapshot).toHaveBeenCalledTimes(23);
  expect(screen.queryByText("Reading local agent status…")).toBeNull();
  vi.mocked(f.host.snapshot).mockResolvedValue(structuredClone(f.data));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(f.host.snapshot).toHaveBeenCalledTimes(24);
  expect(screen.queryByRole("button", { name: "Retry status" })).toBeNull();
  expect(screen.queryByText(/Could not refresh local agents/)).toBeNull();
  expect(
    screen.getAllByRole("article", { name: "Agent Fixture agent" }),
  ).toHaveLength(2);
});

it.each(["running", "failed"] as const)(
  "recovers Start status to %s without replay or cross-agent errors",
  async (status) => {
    const { f, control } = setup("ready", (f) => {
      f.agent.enabled = false;
      f.agent.status = "stopped";
    });
    const [card] = await screen.findAllByRole("article", {
      name: "Agent Fixture agent",
    });
    if (!card) throw Error("Missing managed card");
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const snapshot = vi
      .spyOn(f.host, "snapshot")
      .mockImplementationOnce(async () => {
        await readGate;
        return structuredClone(f.data);
      });
    const action = vi
      .spyOn(f.host, "action")
      .mockRejectedValueOnce("Synthetic start failure.");
    try {
      fireEvent.click(within(card).getByRole("button", { name: "Start" }));
      expect(
        await within(card).findByText("Checking agent status…"),
      ).toBeVisible();
      expect(snapshot).toHaveBeenCalledOnce();
      expect(
        within(card).getByRole("button", { name: "Start" }),
      ).toBeDisabled();
      f.agent.enabled = true;
      f.agent.status = status;
      f.agent.error = status === "failed" ? "Synthetic start failure." : null;
      await act(async () => releaseRead());
      await waitFor(() => expect(control.snapshot().status).toBe("ready"));
      expect(control.snapshot().error).toBeNull();
      if (status === "failed") {
        expect(within(card).getByRole("alert")).toHaveTextContent(
          "Synthetic start failure.",
        );
        expect(screen.getAllByRole("alert")).toHaveLength(1);
      } else {
        expect(
          within(card).getByText(
            "Process running · relay readiness unverified",
          ),
        ).toBeVisible();
        expect(screen.queryByRole("alert")).toBeNull();
      }
      expect(screen.queryByRole("button", { name: "Retry status" })).toBeNull();
      expect(action).toHaveBeenCalledExactlyOnceWith(f.agent.id, "start");
      const other = screen.getAllByRole("article", {
        name: "Agent Fixture agent",
      })[1];
      if (!other) throw Error("Missing other agent");
      expect(within(other).queryByRole("alert")).toBeNull();
      fireEvent.click(
        within(other).getByRole("button", {
          name: "Actions for Fixture agent",
        }),
      );
      fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
      expect(
        within(screen.getByRole("dialog", { name: "Edit agent" })).queryByRole(
          "alert",
        ),
      ).toBeNull();
    } finally {
      await act(async () => releaseRead());
    }
  },
);

it("pauses error polling while hidden and clears the timer on unmount", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const { f } = setup("ready", (f) => {
    vi.spyOn(f.host, "snapshot").mockRejectedValue("Store is unreadable");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole("button", { name: "Retry status" })).toBeVisible();
  expect(f.host.snapshot).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("hidden");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(f.host.snapshot).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(f.host.snapshot).toHaveBeenCalledTimes(2);
  cleanup();
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.host.snapshot).toHaveBeenCalledTimes(2);
});

for (const mode of ["edit", "create"] as const) {
  it(`${mode} saves no untouched build defaults after the native defaults change`, async () => {
    const create = vi.fn();
    vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
    const { f, control } = setup("connected", (fixture) => {
      Object.assign(fixture.agent.harness, {
        command: "buzz-agent",
        provider: "",
        model: "",
        args: [],
      });
      fixture.data.agentDefaults = {
        provider: "databricks_v2",
        model: "first-model",
        ownerOnly: true,
      };
      fixture.data.databricksDefaults = {
        host: "https://first.example.com",
        filter: "first-*",
      };
      fixture.data.createAvailable = true;
      fixture.data.defaultWorkspace = "/fixture/workspace";
      fixture.host.models = {
        begin: async () => 1,
        cancel: async () => {},
        run: async () => {
          throw Error("Untouched defaults must not request models");
        },
      };
      fixture.host.prepareCreate = async () => ({
        id: "created",
        pubkey: "cd".repeat(32),
      });
      fixture.host.commitCreate = create.mockImplementation(
        async (_requestId, edit) => {
          fixture.data.agents.push({
            ...structuredClone(fixture.agent),
            ...edit,
            id: "created",
            profilePending: true,
          });
          return structuredClone(fixture.data);
        },
      );
      fixture.host.publishProfile = async () => structuredClone(fixture.data);
    });
    if (mode === "create") {
      fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
    } else {
      const cards = await screen.findAllByRole("article", {
        name: "Agent Fixture agent",
      });
      const card = cards[0];
      if (!card) throw Error("Missing agent");
      fireEvent.click(
        within(card).getByRole("button", { name: "Actions for Fixture agent" }),
      );
      fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    }
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Model" }));
    expect(
      within(dialog).getByLabelText("Databricks workspace (HTTPS origin)"),
    ).toHaveValue("https://first.example.com");
    expect(
      within(dialog).getByLabelText("Model", {
        exact: true,
        selector: "input",
      }),
    ).toHaveAttribute("placeholder", "Use agent defaults (first-model)");
    expect(
      within(dialog).getByText(
        "Editing either field saves both displayed values.",
      ),
    ).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Name-only change" },
    });
    f.data.agentDefaults = {
      provider: "databricks",
      model: "next-model",
      ownerOnly: true,
    };
    f.data.databricksDefaults = {
      host: "https://next.example.com",
      filter: "next-*",
    };
    await act(async () => control.refresh());
    expect(
      within(dialog).getByLabelText("Databricks workspace (HTTPS origin)"),
    ).toHaveValue("https://next.example.com");
    expect(
      within(dialog).getByLabelText("Model filter (optional)"),
    ).toHaveValue("next-*");
    expect(
      within(dialog).getByLabelText("Model", {
        exact: true,
        selector: "input",
      }),
    ).toHaveAttribute("placeholder", "Use agent defaults (next-model)");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: mode === "create" ? "Create agent" : "Save changes",
      }),
    );
    if (mode === "create")
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    else await within(dialog).findByText("Saved.");
    const edit =
      mode === "create"
        ? create.mock.calls[0]?.[1]
        : (
            f.calls.find((call) => call.action === "save")?.payload as
              | {
                  edit: unknown;
                }
              | undefined
          )?.edit;
    expect(edit).toMatchObject({
      name: "Name-only change",
      environment: {},
      harness: { command: "buzz-agent", provider: "", model: "" },
    });
    expect(edit.harness.databricks).toBeUndefined();
  });
}
it("create copies only the default harness and shows inherited defaults", async () => {
  const user = userEvent.setup();
  const create = vi.fn();
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  setup("connected", (fixture) => {
    fixture.data.harnessOptions?.push({
      command: "/opt/tools/goose",
      label: "Goose",
      available: true,
      status: "ready",
      defaultArgs: ["acp"],
      providers: [{ value: "anthropic", label: "Anthropic" }],
    });
    fixture.data.defaultSettings = {
      harness: "goose",
      provider: "anthropic",
      model: "default-model",
      effort: "high",
      sessionPolicy: "thread",
      environmentKeys: ["SHARED_TOKEN"],
    };
    fixture.data.createAvailable = true;
    fixture.data.defaultWorkspace = "/fixture/workspace";
    fixture.host.prepareCreate = async () => ({
      id: "created",
      pubkey: "cd".repeat(32),
    });
    fixture.host.commitCreate = create.mockImplementation(async () => {
      fixture.data.agents.push({
        ...structuredClone(fixture.agent),
        id: "created",
      });
      return structuredClone(fixture.data);
    });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Defaults agent" },
  });
  expect(
    within(dialog).getByLabelText("Model", { exact: true, selector: "input" }),
  ).toHaveAttribute("placeholder", "Use agent defaults (default-model)");
  expect(
    within(dialog).getByText("Use agent defaults (anthropic)"),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("combobox", { name: "Conversation context" }),
  ).toHaveTextContent("Use agent defaults (Each thread)");
  await user.click(
    within(dialog).getByRole("combobox", { name: "Conversation context" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "Entire channel" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  // Only the harness is copied; provider, model, effort and env stay blank
  // so they are looked up at each start.
  expect(create.mock.calls[0]?.[1]).toMatchObject({
    harness: {
      command: "/opt/tools/goose",
      args: ["acp"],
      provider: "",
      model: "",
    },
    environment: {},
    sessionPolicy: "channel",
  });
});
it("qualifies management identities while keeping configured names and edit targets exact", async () => {
  const { f } = setup("ready", (fixture) => {
    fixture.data.agents.push({
      ...structuredClone(fixture.agent),
      id: "namesake",
      pubkey: "bb".repeat(32),
    });
  });
  await waitFor(() =>
    expect(
      screen.getAllByRole("article", { name: /^Agent Fixture agent · / }),
    ).toHaveLength(3),
  );
  const cards = screen.getAllByRole("article", {
    name: /^Agent Fixture agent · /,
  });
  expect(cards).toHaveLength(3);
  // The complete public key remains in technical details, not the display heading.
  expect(
    new Set(cards.map((entry) => entry.getAttribute("aria-label"))).size,
  ).toBe(2);
  const user = userEvent.setup();
  const firstCard = cards[0];
  if (!firstCard) throw Error("Missing managed card");
  await user.click(
    within(firstCard).getByRole("button", {
      name: /^Actions for Fixture agent · /,
    }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/^Fixture agent · /)).toBeVisible();
  expect(within(dialog).getByLabelText("Name")).toHaveValue(f.agent.name);
});

it("keeps collisions across different cross-community aliases and edits the exact configuration", async () => {
  const { f } = setup("ready", (fixture) => {
    fixture.agent.name = "Honey";
    fixture.data.agents.push(
      {
        ...structuredClone(fixture.agent),
        id: "namesake",
        pubkey: "bb".repeat(32),
      },
      {
        ...structuredClone(fixture.agent),
        id: "alias-a",
        name: "Juniper",
        relayUrl: "wss://aliases.example",
      },
      {
        ...structuredClone(fixture.agent),
        id: "alias-b",
        pubkey: "bb".repeat(32),
        name: "Juniper",
        relayUrl: "wss://aliases.example",
      },
    );
  });
  await waitFor(() =>
    expect(
      screen.getAllByRole("article", { name: /^Agent Honey · / }),
    ).toHaveLength(3),
  );
  const honey = screen.getAllByRole("article", { name: /^Agent Honey · / });
  const juniper = screen.getAllByRole("article", { name: /^Agent Juniper · / });
  expect(juniper).toHaveLength(2);
  expect(
    new Set(honey.map((card) => card.getAttribute("aria-label"))).size,
  ).toBe(2);
  expect(
    new Set(juniper.map((card) => card.getAttribute("aria-label"))).size,
  ).toBe(2);
  const user = userEvent.setup();
  const aliasCard = juniper[0];
  if (!aliasCard) throw Error("Missing alias card");
  await user.click(
    within(aliasCard).getByRole("button", {
      name: /^Actions for Juniper · /,
    }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Juniper");
  await user.clear(within(dialog).getByLabelText("Name"));
  await user.type(within(dialog).getByLabelText("Name"), "Updated alias");
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  await waitFor(() =>
    expect(f.calls).toContainEqual(
      expect.objectContaining({
        action: "save",
        payload: expect.objectContaining({
          id: "alias-a",
          edit: expect.objectContaining({ name: "Updated alias" }),
        }),
      }),
    ),
  );
});

function routed(pubkey: string) {
  const complete = vi.fn(() => true);
  const target: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: {
      viewer: "de".repeat(32),
      communityOrigin: "https://relay.example.test",
    },
    route: { version: 1, params: { pubkey } },
  };
  const navigation = {
    target,
    signal: new AbortController().signal,
    complete,
    forSession() {
      return this;
    },
  } as unknown as PageNavigation;
  return { navigation, complete };
}

it("opens the exact native agent editor on the routed page and acknowledges its presentation", async () => {
  const { navigation, complete } = routed("ab".repeat(32));
  const { f } = setup("connected", undefined, navigation);
  const dialog = await screen.findByRole("dialog", { name: "Edit agent" });
  expect(within(dialog).getByLabelText("Agent instructions")).toBeVisible();
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith({ status: "opened" }),
  );
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Targeted" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(
      f.calls.find((call) => call.action === "save")?.payload,
    ).toMatchObject({ id: "fixture-agent" }),
  );
});

it("rejects missing and ambiguous route targets instead of choosing a namesake", async () => {
  const { navigation, complete } = routed("ab".repeat(32));
  setup(
    "connected",
    (f) => f.data.agents.push({ ...structuredClone(f.agent), id: "duplicate" }),
    navigation,
  );
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith({
      status: "failed",
      reason: "not-found",
    }),
  );
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
});

it("rejects an edit route for a different community", async () => {
  const { navigation, complete } = routed("ab".repeat(32));
  setup(
    "connected",
    (f) => {
      f.agent.relayUrl = "wss://other.example";
    },
    navigation,
  );
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith({
      status: "failed",
      reason: "not-found",
    }),
  );
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
});

it("closes a routed editor back to the unrouted Agents page", async () => {
  const { navigation } = routed("ab".repeat(32));
  const open = vi.fn(
    async (_target: OpenTarget, _options?: { replace?: boolean }) => ({
      status: "opened" as const,
    }),
  );
  setup("connected", undefined, navigation, open);
  const dialog = await screen.findByRole("dialog", { name: "Edit agent" });
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Close editor" }));
  expect(open).toHaveBeenCalledWith(
    {
      version: 1,
      kind: "page",
      pluginId: "buzz.agents",
      pageId: "agents",
      scope: {
        viewer: "de".repeat(32),
        communityOrigin: "https://relay.example.test",
      },
    },
    { replace: true },
  );
});

it("retains a routed draft and its save error after status recovery only in that editor", async () => {
  const { navigation } = routed("ab".repeat(32));
  const { f, control } = setup(
    "connected",
    (fixture) => fixture.failSave(true),
    navigation,
  );
  const dialog = await screen.findByRole("dialog", { name: "Edit agent" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Unsaved draft" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await within(dialog).findByText(/Your edits are retained/);
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Unsaved draft");
  await act(() => control.refresh());
  expect(control.snapshot()).toMatchObject({ status: "ready", error: null });
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "The host could not save settings.",
  );
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Unsaved draft");
  expect(f.calls.filter((call) => call.action === "save")).toHaveLength(1);
  // Include the dialog-inert page so a leaked global banner cannot hide.
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
});

it("waits for a connecting relay before opening a routed editor", async () => {
  const { navigation, complete } = routed("ab".repeat(32));
  const page = setup("connecting", undefined, navigation);
  expect(complete).not.toHaveBeenCalled();
  await waitFor(() => expect(page.control.snapshot().status).toBe("ready"));
  expect(complete).not.toHaveBeenCalled();
  act(() => page.connect());
  await screen.findByRole("dialog", { name: "Edit agent" });
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith({ status: "opened" }),
  );
  expect(complete).not.toHaveBeenCalledWith({
    status: "failed",
    reason: "unavailable",
  });
});

it("acknowledges the unrouted Agents page", async () => {
  const { navigation, complete } = routed("ab".repeat(32));
  const target = navigation.target as Extract<OpenTarget, { kind: "page" }>;
  const unrouted = {
    ...navigation,
    target: { ...target, route: undefined },
  } as unknown as PageNavigation;
  setup("connected", undefined, unrouted);
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith({ status: "opened" }),
  );
});

it("clears an obsolete route before editing another card", async () => {
  const { navigation } = routed("ab".repeat(32));
  const open = vi.fn(
    async (_target: OpenTarget, _options?: { replace?: boolean }) => ({
      status: "opened" as const,
    }),
  );
  setup(
    "connected",
    (f) => {
      f.data.agents.splice(0, 1);
    },
    navigation,
    open,
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull(),
  );
  const cards = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  const other = cards.find((card) =>
    card.textContent?.includes("wss://second.example"),
  );
  if (!other) throw Error("Second destination missing");
  fireEvent.click(
    within(other).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  expect(open).toHaveBeenCalledWith(
    expect.not.objectContaining({ route: expect.anything() }),
    { replace: true },
  );
});

it("offers explicit repair for an existing team import without replacing or starting it", async () => {
  let finish: (() => void) | undefined;
  let commit = vi.fn();
  const { f } = setup("ready", (fixture) => {
    fixture.agent.needsTeamImport = true;
    fixture.host.previewImport = async () => ({
      token: "team-preview",
      sourcePath: "/fixture/installed/managed-agents.json",
      warnings: [],
      candidates: [
        {
          id: fixture.agent.id,
          pubkey: fixture.agent.pubkey,
          name: fixture.agent.name,
          relayUrl: fixture.agent.relayUrl,
        },
      ],
    });
    commit = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      fixture.agent.needsTeamImport = false;
      fixture.agent.revision++;
      return structuredClone(fixture.data);
    });
    fixture.host.commitImport = commit;
  });
  await screen.findAllByRole("article", { name: "Agent Fixture agent" });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Import or repair from another installation",
    }),
  );
  fireEvent.change(screen.getByLabelText("Destination community"), {
    target: { value: f.agent.relayUrl },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load agents" }));
  const button = await screen.findByRole("button", {
    name: "Repair team import for Fixture agent",
  });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(commit).toHaveBeenCalledWith("team-preview", [f.agent.id]),
  );
  expect(button).toBeDisabled();
  await act(async () => finish?.());
  expect(
    await screen.findByText(/Team instructions imported for Fixture agent/),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", {
      name: "Repair team import for Fixture agent",
    }),
  ).toBeNull();
  expect(f.data.agents).toHaveLength(2);
  expect(f.calls.some((call) => call.action === "start")).toBe(false);
});

it("refreshes the consumed preview after a repair so the next agent can be repaired", async () => {
  let token: string | undefined;
  let previews = 0;
  const commits: string[] = [];
  const { f } = setup("ready", (fixture) => {
    fixture.agent.needsTeamImport = true;
    fixture.data.agents.push({
      ...structuredClone(fixture.agent),
      id: "second-agent",
      pubkey: "cd".repeat(32),
      name: "Second agent",
    });
    fixture.host.previewImport = async () => {
      token = `team-preview-${++previews}`;
      return {
        token,
        sourcePath: "/fixture/installed/managed-agents.json",
        warnings: [],
        candidates: fixture.data.agents.filter(
          (agent) => agent.relayUrl === fixture.agent.relayUrl,
        ),
      };
    };
    fixture.host.commitImport = async (selected, ids) => {
      if (!token || selected !== token) throw "Import preview expired";
      token = undefined;
      commits.push(selected);
      for (const agent of fixture.data.agents) {
        if (ids.includes(agent.id)) {
          agent.needsTeamImport = false;
          agent.revision++;
        }
      }
      return structuredClone(fixture.data);
    };
  });
  await screen.findAllByRole("article", { name: "Agent Fixture agent" });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Import or repair from another installation",
    }),
  );
  fireEvent.change(screen.getByLabelText("Destination community"), {
    target: { value: f.agent.relayUrl },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load agents" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Repair team import for Fixture agent",
    }),
  );
  await screen.findByText(/Team instructions imported for Fixture agent/);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Repair team import for Second agent",
    }),
  );
  await screen.findByText(/Team instructions imported for Second agent/);
  expect(commits).toEqual(["team-preview-1", "team-preview-2"]);
  expect(f.calls.some((call) => call.action === "start")).toBe(false);
});

it.each([
  {
    name: "mismatched source library",
    rejection:
      "Source team binding differs from the imported agent; choose its original library",
    expected: "choose its original library",
    fromControl: false,
  },
  {
    name: "changed saved revision",
    rejection: "Agent settings changed; preview the team import again",
    expected: "Agent settings changed; preview the team import again",
    fromControl: false,
  },
  {
    name: "unknown native failure",
    rejection: new Error("raw private diagnostic"),
    expected: "Could not confirm the operation.",
    fromControl: false,
  },
  {
    name: "unknown control failure",
    rejection: { detail: "raw private diagnostic" },
    expected: "Import didn’t finish. Reload the source before trying again.",
    fromControl: true,
  },
])(
  "retains safe repair recovery after status refresh: $name",
  async ({ rejection, expected, fromControl }) => {
    const commit = vi.fn().mockRejectedValue(rejection);
    const { f, control } = setup("ready", (fixture) => {
      fixture.agent.needsTeamImport = true;
      fixture.host.previewImport = async () => ({
        token: "team-preview",
        sourcePath: "/fixture/installed/managed-agents.json",
        warnings: [],
        candidates: [fixture.agent],
      });
      if (!fromControl) fixture.host.commitImport = commit;
    });
    // Unexpected control-level failures retain the fallback; native failures go
    // through the real projection's sanitized error boundary.
    if (fromControl)
      vi.spyOn(control, "commitImport").mockImplementation(commit);
    await screen.findAllByRole("article", { name: "Agent Fixture agent" });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Import or repair from another installation",
      }),
    );
    fireEvent.change(screen.getByLabelText("Destination community"), {
      target: { value: f.agent.relayUrl },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load agents" }));
    const panel = within(
      screen.getByRole("region", { name: "Import from old Buzz" }),
    );
    fireEvent.click(
      await panel.findByRole("button", {
        name: "Repair team import for Fixture agent",
      }),
    );
    expect(await panel.findByRole("alert")).toHaveTextContent(expected);
    await act(async () => control.refresh());
    expect(control.snapshot()).toMatchObject({ status: "ready", error: null });
    expect(panel.getByRole("alert")).toHaveTextContent(expected);
    expect(screen.queryByText(/raw private diagnostic/)).toBeNull();
    expect(f.agent.needsTeamImport).toBe(true);
    expect(commit).toHaveBeenCalledExactlyOnceWith("team-preview", [
      f.agent.id,
    ]);
    expect(f.calls.some((call) => call.action === "start")).toBe(false);
    fireEvent.click(panel.getByRole("button", { name: "Retry" }));
    await panel.findByRole("button", {
      name: "Repair team import for Fixture agent",
    });
    expect(panel.queryByRole("alert")).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  },
);

it("shows native waiting, recovery Stop and one explicit Retry without polling a Start", async () => {
  const { f, control } = setup("ready", (f) => {
    f.agent.status = "waiting";
    f.agent.enabled = false;
    f.agent.startOnAppLaunch = true;
  });
  const cards = await screen.findAllByRole("article", {
    name: `Agent ${f.agent.name}`,
  });
  const card = cards.find((entry) =>
    entry.textContent?.includes(f.agent.relayUrl),
  );
  if (!card) throw Error("Exact destination card missing");
  expect(
    within(card).getByText("Waiting to start · unlock Keychain if prompted"),
  ).toBeVisible();
  expect(within(card).queryByRole("button", { name: "Start" })).toBeNull();
  expect(within(card).getByRole("button", { name: "Stop" })).toBeEnabled();
  expect(within(card).getByText("Starts with this app.")).toBeVisible();
  f.agent.status = "failed";
  f.agent.error =
    "Secure storage access was denied; allow access explicitly and retry";
  await act(() => control.refresh());
  await act(() => control.refresh());
  expect(within(card).getByRole("alert")).toHaveTextContent(
    "Secure storage access was denied",
  );
  expect(f.calls.filter((call) => call.action === "start")).toHaveLength(0);
  await userEvent.click(
    within(card).getByRole("button", { name: "Retry start" }),
  );
  await waitFor(() =>
    expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1),
  );
});

it("Use here retries owner confirmation and keeps setup stopped until a separate Start", async () => {
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockRejectedValueOnce(new Error("Confirmation unavailable"))
    .mockResolvedValueOnce({
      pubkey: "ab".repeat(32),
      relayUrl: "wss://relay.example.test",
      owner: "de".repeat(32),
      signature: "fixture",
    });
  const { f } = setup("connected", (fixture) => {
    Object.assign(fixture.agent, {
      configured: false,
      enabled: false,
      status: "stopped",
      runningRevision: null,
    });
  });
  const cards = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  const card = cards.find((entry) =>
    entry.textContent?.includes("wss://relay.example.test"),
  );
  if (!card) throw Error("Imported card missing");
  expect(within(card).getByRole("button", { name: "Start" })).toBeDisabled();
  fireEvent.click(within(card).getByRole("button", { name: "Use here" }));
  const dialog = screen.getByRole("dialog", { name: "Set up agent here" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Use here" }));
  await within(dialog).findByText("Confirmation unavailable");
  expect(f.calls.some((call) => call.action === "configure")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Use here" }));
  await waitFor(() =>
    expect(within(card).getByRole("button", { name: "Start" })).toBeEnabled(),
  );
  expect(request).toHaveBeenLastCalledWith(
    "https://relay.example.test",
    "resolve-agent-community",
    { pubkey: f.agent.pubkey, owner: "de".repeat(32), confirmed: true },
  );
  expect(f.agent.enabled).toBe(false);
  expect(
    f.calls.some((call) => call.action === "start" || call.action === "import"),
  ).toBe(false);
  fireEvent.click(within(card).getByRole("button", { name: "Start" }));
  await waitFor(() =>
    expect(f.calls.some((call) => call.action === "start")).toBe(true),
  );
});

it("browses both local libraries without a community and requires a destination preview to import", async () => {
  const { f, read } = setup("disconnected");
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Import from another installation",
    }),
  );
  const section = screen.getByRole("region", { name: "Import from old Buzz" });
  expect(
    await within(section).findByRole("button", {
      name: "Import Fixture agent",
    }),
  ).toBeDisabled();
  expect(f.calls).toContainEqual({
    action: "preview",
    payload: { source: "installed", destination: "" },
  });
  expect(read).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByLabelText("Source library"));
  await userEvent.click(
    await screen.findByRole("option", { name: "Development Buzz" }),
  );
  await waitFor(() =>
    expect(f.calls).toContainEqual({
      action: "preview",
      payload: { source: "development", destination: "" },
    }),
  );
  expect(
    await within(section).findByRole("button", {
      name: "Import Fixture agent",
    }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Destination community"), {
    target: { value: "wss://chosen.example" },
  });
  expect(
    within(section).queryByRole("button", { name: "Import Fixture agent" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load agents" }));
  await waitFor(() =>
    expect(
      within(section).getByRole("button", { name: "Import Fixture agent" }),
    ).toBeEnabled(),
  );
  expect(
    f.calls.filter((call) =>
      ["import", "start", "restart"].includes(call.action),
    ),
  ).toEqual([]);
  expect(read).toHaveBeenCalledTimes(1);
});

it("clones reviewed text through fresh identity creation without importing source credentials", async () => {
  const prepare = vi.fn(async () => ({
    id: "fresh-clone",
    pubkey: "ba".repeat(32),
  }));
  const cloneSettings = vi.fn(async () => ({
    name: "Source helper",
    systemPrompt: "Reviewed instructions",
  }));
  const authorization = vi
    .spyOn(communityApi, "communityRequest")
    .mockResolvedValue({ auth: ["auth"] });
  const start = vi.fn();
  const { f } = setup("connected", (fixture) => {
    fixture.data.createAvailable = true;
    fixture.data.defaultWorkspace = "/new/workspace";
    fixture.host.cloneSettings = cloneSettings;
    fixture.host.prepareCreate = prepare;
    fixture.host.commitCreate = vi.fn(async (_request, edit) => {
      fixture.calls.push({ action: "create", payload: edit });
      fixture.data.agents.push({
        ...structuredClone(fixture.agent),
        ...edit,
        id: "fresh-clone",
        pubkey: "ba".repeat(32),
        harness: { ...edit.harness, environmentKeys: [] },
        status: "stopped",
        enabled: false,
      });
      return structuredClone(fixture.data);
    });
    fixture.host.publishProfile = vi.fn(async () =>
      structuredClone(fixture.data),
    );
    fixture.host.action = start.mockImplementation(async (id, action) => {
      const agent = fixture.data.agents.find((item) => item.id === id);
      if (!agent || action !== "start") throw Error("Unexpected agent action");
      agent.enabled = true;
      agent.status = "running";
      return structuredClone(fixture.data);
    });
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Import from another installation",
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Clone Fixture agent" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Clone agent" });
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Source helper");
  expect(within(dialog).getByLabelText("Agent instructions")).toHaveValue(
    "Reviewed instructions",
  );
  expect(prepare).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Clone agent" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(prepare).toHaveBeenCalledWith(
    expect.any(String),
    "https://relay.example.test",
    "de".repeat(32),
  );
  expect(authorization).toHaveBeenCalledWith(
    "https://relay.example.test",
    "authorize-agent",
    { pubkey: "ba".repeat(32), owner: "de".repeat(32) },
  );
  expect(
    f.calls.find((call) => call.action === "create")?.payload,
  ).toMatchObject({
    name: "Source helper",
    systemPrompt: "Reviewed instructions",
    workspace: "/new/workspace",
    environment: {},
  });
  expect(f.calls.filter((call) => call.action === "import")).toEqual([]);
  // Create now starts the new agent; the clone starts only its fresh identity.
  expect(start).toHaveBeenCalledExactlyOnceWith("fresh-clone", "start");
  expect(
    f.data.agents.find((agent) => agent.id === "fresh-clone"),
  ).toMatchObject({
    pubkey: "ba".repeat(32),
    enabled: true,
    status: "running",
  });
});

it("uses snapshot capabilities rather than JS wrappers and retains older-host import", async () => {
  const { f } = setup("connected", (fixture) => {
    delete fixture.data.localInventoryActions;
    const commit = fixture.host.commitImport;
    fixture.host.commitImport = async (...args) => {
      const result = await commit(...args);
      for (const agent of result.agents) delete agent.configured;
      return result;
    };
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Import from another installation",
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Import Fixture agent" }),
  );
  const notice = await screen.findByText(
    "Imported, not started. Start it when you are ready.",
  );
  const card = notice.closest("article");
  if (!card) throw Error("Imported card missing");
  expect(within(card).getByRole("button", { name: "Start" })).toBeEnabled();
  expect(within(card).queryByRole("button", { name: "Use here" })).toBeNull();
  expect(f.calls.filter((call) => call.action === "import")).toHaveLength(1);
});

it("unified card Import selects exact identity and development source, then moves to local community stopped", async () => {
  vi.spyOn(communityApi, "communityRequest").mockImplementation(
    async (_destination, route) =>
      route === "agent-inventory"
        ? { identities: [] }
        : {
            pubkey: "cd".repeat(32),
            relayUrl: "wss://relay.example.test",
            owner: "de".repeat(32),
            signature: "fixture",
          },
  );
  const { f } = setup("connected", (fixture) => {
    fixture.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Not imported",
        sources: ["development"],
      },
    ];
  });
  const card = await screen.findByRole("article", {
    name: "Agent Not imported",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Import" }));
  const form = await screen.findByRole("dialog", {
    name: "Import Not imported?",
  });
  const submit = await within(form).findByRole("button", {
    name: "Import agent",
  });
  await waitFor(() => expect(submit).toBeEnabled());
  expect(within(form).getByText("Development Buzz")).toBeVisible();
  expect(within(form).getByText("https://relay.example.test")).toBeVisible();
  expect(within(form).queryByLabelText("Source library")).toBeNull();
  expect(
    within(form).queryByRole("button", { name: /Clone|Load agents/ }),
  ).toBeNull();
  expect(within(form).queryByText("Identity")).toBeNull();
  expect(f.calls.some((call) => call.action === "import")).toBe(false);
  fireEvent.click(submit);
  await waitFor(() =>
    expect(f.calls.filter((call) => call.action === "import")).toHaveLength(1),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Import Not imported?" }),
    ).toBeNull(),
  );
  const localSection = screen.getByRole("region", {
    name: "Local agents in this community",
  });
  expect(
    within(localSection).getByRole("article", {
      name: `Agent Fixture agent · ${npubEncode("cd".repeat(32)).slice(-4)}`,
    }),
  ).toBeVisible();
  expect(
    screen.getAllByRole("article", {
      name: `Agent Fixture agent · ${npubEncode("cd".repeat(32)).slice(-4)}`,
    }),
  ).toHaveLength(1);
  expect(f.calls.some((call) => call.action === "configure")).toBe(false);
  expect(
    f.data.agents.find((agent) => agent.id === "second-fixture")?.enabled,
  ).toBe(false);
  const configuredCard = await screen.findByRole("article", {
    name: `Agent Fixture agent · ${npubEncode("cd".repeat(32)).slice(-4)}`,
  });
  expect(
    within(configuredCard).getByRole("button", { name: "Start" }),
  ).toBeEnabled();
  expect(f.calls.some((call) => call.action === "start")).toBe(false);
});

it("card Import without a selected community asks for a destination before importing", async () => {
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({
    identities: [],
  });
  const { f } = setup("disconnected", (fixture) => {
    fixture.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Not imported",
        sources: ["development"],
      },
    ];
  });
  const card = await screen.findByRole("article", {
    name: "Agent Not imported",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Import" }));
  const form = await screen.findByRole("dialog", {
    name: "Import Not imported?",
  });
  const submit = within(form).getByRole("button", { name: "Import agent" });
  await waitFor(() =>
    expect(f.calls.some((call) => call.action === "preview")).toBe(true),
  );
  expect(submit).toBeDisabled();
  fireEvent.change(within(form).getByLabelText("Destination community"), {
    target: { value: "https://typed.example" },
  });
  fireEvent.click(
    within(form).getByRole("button", { name: "Use destination" }),
  );
  await waitFor(() => expect(submit).toBeEnabled());
  expect(
    f.calls.filter((call) => call.action === "preview").at(-1)?.payload,
  ).toEqual({ source: "development", destination: "https://typed.example" });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(f.calls.filter((call) => call.action === "import")).toHaveLength(1),
  );
  expect(
    f.calls.find((call) => call.action === "import")?.payload,
  ).toMatchObject({ token: "fixture-preview" });
});
