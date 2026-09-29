// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentDraft, agentEdit, type AgentDraft } from "./agent-edit";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";

afterEach(cleanup);

it("browses an own Databricks workspace before global defaults, and inherits when blank", async () => {
  const f = controlFixture();
  f.data.defaultSettings = {
    harness: "buzz-agent",
    provider: "databricks_v2",
    model: "",
    effort: "",
    sessionPolicy: "channel",
    environmentKeys: ["DATABRICKS_HOST", "DATABRICKS_MODEL_FILTER"],
  };
  f.data.databricksDefaults = {
    host: "https://compiled.example.com",
    filter: "compiled-*",
  };
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "endpoint-two", name: "Endpoint Two" }],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  const own = {
    ...agentDraft(f.agent),
    command: "/fixture/bin/buzz-agent",
    provider: "databricks_v2",
    databricks: { host: "https://agent.example.com", filter: "agent-*" },
  };
  const fields = (draft: AgentDraft) => (
    <AgentSettingsFields
      draft={draft}
      control={control}
      state={{ status: "ready", busy: false, error: null, data: f.data }}
      disabled={false}
      onChange={vi.fn()}
    />
  );
  const view = render(fields(own));
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenNthCalledWith(
      1,
      1,
      expect.objectContaining({
        host: "https://agent.example.com",
        filter: "agent-*",
        action: "connect",
      }),
    );
    expect(run).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ inheritWorkspace: true }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Model" }),
      ).not.toHaveAttribute("aria-busy", "true"),
    );
    view.rerender(fields({ ...own, databricks: null }));
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenNthCalledWith(
      2,
      1,
      expect.objectContaining({
        host: "",
        filter: "",
        inheritWorkspace: true,
        action: "connect",
      }),
    );
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("hides inherited Agent defaults hints when a selector override decides the launch", () => {
  const f = controlFixture();
  const control = createAgentControl(f.host);
  const base = {
    ...agentDraft(f.agent),
    command: "/opt/tools/goose",
    provider: "",
    model: "",
  };
  const cases: {
    draft?: Partial<AgentDraft>;
    keys?: string[];
    globalKeys?: string[];
    provider: boolean;
    model: boolean;
  }[] = [
    { provider: true, model: true },
    { keys: ["GOOSE_MODEL"], provider: true, model: false },
    { keys: ["GOOSE_PROVIDER"], provider: false, model: true },
    { globalKeys: ["GOOSE_MODEL"], provider: true, model: false },
    { globalKeys: ["GOOSE_PROVIDER"], provider: false, model: true },
    {
      globalKeys: ["GOOSE_MODEL"],
      draft: { environment: { GOOSE_MODEL: null } },
      provider: true,
      model: false,
    },
    {
      draft: { environment: { GOOSE_MODEL: "draft-model" } },
      provider: true,
      model: false,
    },
    {
      keys: ["GOOSE_MODEL"],
      draft: { environment: { GOOSE_MODEL: null } },
      provider: true,
      model: true,
    },
  ];
  const fields = (entry: (typeof cases)[number]) => (
    <AgentSettingsFields
      draft={{ ...base, ...entry.draft }}
      control={control}
      state={{
        status: "ready",
        busy: false,
        error: null,
        data: {
          ...f.data,
          harnessOptions: [
            {
              command: "/opt/tools/goose",
              label: "Goose",
              available: true,
              providers: [{ value: "anthropic", label: "Anthropic" }],
            },
          ],
          defaultSettings: {
            harness: "goose",
            provider: "anthropic",
            model: "default-model",
            effort: "",
            sessionPolicy: "channel",
            environmentKeys: entry.globalKeys ?? [],
          },
        },
      }}
      disabled={false}
      environmentKeys={entry.keys ?? []}
      onChange={vi.fn()}
    />
  );
  const view = render(fields(cases[0] as (typeof cases)[number]));
  try {
    for (const entry of cases) {
      view.rerender(fields(entry));
      expect(
        screen.getByRole("combobox", { name: "Model" }),
        JSON.stringify(entry),
      ).toHaveAttribute(
        "placeholder",
        entry.model
          ? "Use agent defaults (default-model)"
          : "Choose or enter a model",
      );
      expect(
        screen.queryAllByText("Use agent defaults (anthropic)").length > 0,
        JSON.stringify(entry),
      ).toBe(entry.provider);
    }
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("only hints the compiled model when the current provider and overrides can use it", () => {
  const f = controlFixture();
  const control = createAgentControl(f.host);
  const onChange = vi.fn();
  const base = {
    ...agentDraft(f.agent),
    command: "buzz-agent",
    provider: "",
    model: "",
  };
  const cases: {
    provider: string;
    globalProvider?: string;
    draft?: Partial<AgentDraft>;
    keys?: string[];
    globalKeys?: string[];
    hint: boolean;
  }[] = [
    { provider: "databricks_v2", hint: true },
    // The inherited provider wins over the compiled provider in both directions.
    { provider: "databricks_v2", globalProvider: "anthropic", hint: false },
    { provider: "anthropic", globalProvider: "databricks_v2", hint: true },
    { provider: "databricks-v2", hint: true },
    { provider: "databricks", hint: true },
    { provider: "openai", hint: false },
    { provider: "", hint: false },
    { provider: "databricks_v2", draft: { provider: "openai" }, hint: false },
    { provider: "openai", draft: { provider: "databricks_v2" }, hint: true },
    {
      provider: "databricks_v2",
      draft: { environment: { BUZZ_AGENT_PROVIDER: "openai" } },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { environment: { BUZZ_AGENT_PROVIDER: "" } },
      hint: false,
    },
    {
      provider: "openai",
      draft: { environment: { BUZZ_AGENT_PROVIDER: "databricks-v2" } },
      hint: true,
    },
    { provider: "databricks_v2", keys: ["BUZZ_AGENT_PROVIDER"], hint: false },
    {
      provider: "databricks_v2",
      keys: ["BUZZ_AGENT_PROVIDER"],
      draft: { environment: { BUZZ_AGENT_PROVIDER: null } },
      hint: true,
    },
    { provider: "databricks_v2", keys: ["BUZZ_AGENT_MODEL"], hint: false },
    { provider: "databricks_v2", keys: ["DATABRICKS_MODEL"], hint: false },
    {
      provider: "databricks_v2",
      globalKeys: ["DATABRICKS_MODEL"],
      hint: false,
    },
    {
      provider: "databricks_v2",
      globalKeys: ["BUZZ_AGENT_PROVIDER"],
      hint: false,
    },
    {
      provider: "databricks_v2",
      globalKeys: ["DATABRICKS_MODEL"],
      draft: { environment: { DATABRICKS_MODEL: null } },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { environment: { BUZZ_AGENT_MODEL: "" } },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { environment: { DATABRICKS_MODEL: "custom" } },
      hint: false,
    },
    {
      provider: "databricks_v2",
      keys: ["DATABRICKS_MODEL"],
      draft: { environment: { DATABRICKS_MODEL: null } },
      hint: true,
    },
    {
      provider: "databricks_v2",
      draft: { command: "goose", provider: "databricks_v2" },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { command: "/local/bin/buzz-pi-acp" },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { command: "/local/bin/buzz-pi-acp", provider: "databricks_v2" },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { command: "custom-acp" },
      hint: false,
    },
  ];
  const fields = (entry: (typeof cases)[number]) => (
    <AgentSettingsFields
      draft={{ ...base, ...entry.draft }}
      control={control}
      state={{
        status: "ready",
        busy: false,
        error: null,
        data: {
          ...f.data,
          agentDefaults: {
            provider: entry.provider,
            model: "build-model",
            ownerOnly: false,
          },
          defaultSettings: {
            harness: "buzz-agent",
            provider: entry.globalProvider ?? "",
            model: "",
            effort: "",
            sessionPolicy: "channel",
            environmentKeys: entry.globalKeys ?? [],
          },
        },
      }}
      disabled={false}
      environmentKeys={entry.keys ?? []}
      onChange={onChange}
    />
  );
  const view = render(fields({ provider: "databricks_v2", hint: true }));
  try {
    for (const entry of cases) {
      view.rerender(fields(entry));
      expect(
        screen.getByRole("combobox", { name: "Model" }),
        JSON.stringify(entry),
      ).toHaveAttribute(
        "placeholder",
        entry.hint
          ? "Use agent defaults (build-model)"
          : "Choose or enter a model",
      );
    }
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    control.dispose();
  }
});

function setup({
  savedKeys = [],
  environment = {},
  provider = "openai",
}: {
  savedKeys?: string[];
  environment?: AgentDraft["environment"];
  provider?: string;
} = {}) {
  const fixture = controlFixture();
  fixture.data.harnessOptions = [
    {
      command: "/usr/local/bin/goose",
      label: "Goose",
      defaultArgs: ["acp"],
      providers: [
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
        { value: "ollama", label: "Ollama" },
      ],
    },
  ];
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "gpt-4o", name: "gpt-4o" }],
    modelOverridden: false,
    disconnected: false,
  }));
  fixture.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(fixture.host);
  let draft!: AgentDraft;
  function Editor() {
    const [value, setValue] = useState(() => ({
      ...agentDraft(fixture.agent),
      command: "/usr/local/bin/goose",
      args: '["acp"]',
      provider,
      model: "",
      environment,
    }));
    draft = value;
    return (
      <AgentSettingsFields
        draft={value}
        control={control}
        state={{
          status: "ready",
          data: fixture.data,
          busy: false,
          error: null,
        }}
        disabled={false}
        environmentKeys={savedKeys}
        onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  return { draft: () => draft, run, view, control };
}

it("uses a masked OpenAI key for Goose model lookup and discards unsaved keys on provider change", async () => {
  const { draft, run, view, control } = setup();
  const user = userEvent.setup();
  try {
    const key = screen.getByLabelText("OpenAI API key");
    expect(key).toHaveAttribute("type", "password");
    await user.type(key, "test-openai-key");
    expect(agentEdit(draft(), true).environment).toEqual({
      OPENAI_API_KEY: "test-openai-key",
    });
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        edit: expect.objectContaining({
          environment: { OPENAI_API_KEY: "test-openai-key" },
        }),
      }),
    );
    await screen.findByRole("option", { name: "gpt-4o" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
    await user.click(await screen.findByRole("option", { name: "Anthropic" }));
    expect(screen.getByLabelText("Anthropic API key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(draft().environment).toEqual({});
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("adds a Pi provider API key for lookup and drops it when the provider changes", async () => {
  const fixture = controlFixture();
  fixture.data.harnessOptions = [
    {
      command: "/usr/local/bin/buzz-pi-acp",
      label: "Pi",
      defaultArgs: [],
      providers: [],
    },
  ];
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "databricks/model-a", name: "databricks/model-a" }],
    modelOverridden: false,
    disconnected: false,
  }));
  fixture.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(fixture.host);
  let draft!: AgentDraft;
  function Editor() {
    const [value, setValue] = useState(() => ({
      ...agentDraft(fixture.agent),
      command: "/usr/local/bin/buzz-pi-acp",
      args: "[]",
      provider: "",
      model: "",
      environment: {},
    }));
    draft = value;
    return (
      <AgentSettingsFields
        draft={value}
        control={control}
        state={{
          status: "ready",
          data: fixture.data,
          busy: false,
          error: null,
        }}
        disabled={false}
        onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  const user = userEvent.setup();
  try {
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    // The provider list stays disabled until Pi's catalog arrives.
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "LLM Provider" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
    await user.click(
      await screen.findByRole("option", {
        name: "Google Gemini (API key needed)",
      }),
    );
    const key = screen.getByLabelText("Google Gemini API key");
    expect(key).toHaveAttribute("type", "password");
    await user.type(key, "test-gemini-key");
    // Pi reads GEMINI_API_KEY for google, unlike Goose's GOOGLE_API_KEY.
    expect(agentEdit(draft, true).environment).toEqual({
      GEMINI_API_KEY: "test-gemini-key",
    });
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        edit: expect.objectContaining({
          environment: { GEMINI_API_KEY: "test-gemini-key" },
        }),
      }),
    );
    const model = screen.getByRole("combobox", { name: "Model" });
    // Catalog completion does not settle the popup's deferred input focus.
    await waitFor(() => expect(model).not.toHaveAttribute("aria-busy", "true"));
    await waitFor(() => {
      expect(model).toHaveFocus();
      expect(model).toHaveAttribute("aria-expanded", "true");
    });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(model).toHaveAttribute("aria-expanded", "false"),
    );
    await user.click(
      await screen.findByRole("combobox", { name: "LLM Provider" }),
    );
    await user.click(await screen.findByRole("option", { name: "Not set" }));
    expect(screen.queryByLabelText("Google Gemini API key")).toBeNull();
    expect(draft.environment).toEqual({});
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("reveals only a key typed for the current provider", async () => {
  const { view, control } = setup({ savedKeys: ["OPENAI_API_KEY"] });
  const user = userEvent.setup();
  try {
    const key = screen.getByLabelText("OpenAI API key");
    expect(screen.queryByRole("button", { name: "Show API key" })).toBeNull();
    await user.type(key, "typed-key");
    await user.click(screen.getByRole("button", { name: "Show API key" }));
    expect(key).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide API key" }));
    expect(key).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show API key" }));
    await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
    await user.click(await screen.findByRole("option", { name: "Anthropic" }));
    const next = screen.getByLabelText("Anthropic API key");
    await user.type(next, "other-key");
    expect(next).toHaveAttribute("type", "password");

    // Round trip: returning to the revealed provider must not re-expose a replacement.
    await user.click(screen.getByRole("button", { name: "Show API key" }));
    await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
    await user.click(await screen.findByRole("option", { name: "OpenAI" }));
    await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
    await user.click(await screen.findByRole("option", { name: "Anthropic" }));
    const returned = screen.getByLabelText("Anthropic API key");
    await user.type(returned, "replacement-key");
    expect(returned).toHaveAttribute("type", "password");

    // Clearing the revealed key withdraws consent for whatever is typed next.
    await user.click(screen.getByRole("button", { name: "Show API key" }));
    expect(returned).toHaveAttribute("type", "text");
    await user.clear(returned);
    await user.type(returned, "retyped-key");
    expect(returned).toHaveAttribute("type", "password");
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("preserves a saved key when blank and replaces it only when entered", async () => {
  const { draft, view, control } = setup({ savedKeys: ["OPENAI_API_KEY"] });
  const user = userEvent.setup();
  try {
    expect(screen.getByLabelText("OpenAI API key")).toHaveAttribute(
      "placeholder",
      "Saved key unchanged",
    );
    expect(agentEdit(draft()).environment).toEqual({});
    await user.type(screen.getByLabelText("OpenAI API key"), "replacement-key");
    expect(agentEdit(draft()).environment).toEqual({
      OPENAI_API_KEY: "replacement-key",
    });
    await user.clear(screen.getByLabelText("OpenAI API key"));
    expect(agentEdit(draft()).environment).toEqual({});
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("uses a draft Goose provider override for the API key and model lookup", async () => {
  const { draft, run, view, control } = setup({
    environment: { GOOSE_PROVIDER: "anthropic" },
  });
  const user = userEvent.setup();
  try {
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    await user.type(
      screen.getByLabelText("Anthropic API key"),
      "anthropic-key",
    );
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        edit: expect.objectContaining({
          harness: expect.objectContaining({ provider: "openai" }),
          environment: {
            GOOSE_PROVIDER: "anthropic",
            ANTHROPIC_API_KEY: "anthropic-key",
          },
        }),
      }),
    );
    expect(draft().environment).not.toHaveProperty("OPENAI_API_KEY");
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("shows the OpenAI key when a Databricks selector has an OpenAI override", () => {
  const { view, control } = setup({
    provider: "databricks_v2",
    environment: { GOOSE_PROVIDER: "openai" },
  });
  try {
    expect(screen.getByLabelText("OpenAI API key")).toHaveAttribute(
      "type",
      "password",
    );
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("keeps a pending key while the effective override stays fixed, then clears it on removal", async () => {
  const { draft, view, control } = setup({
    environment: { GOOSE_PROVIDER: "anthropic" },
  });
  const user = userEvent.setup();
  try {
    await user.type(
      screen.getByLabelText("Anthropic API key"),
      "anthropic-key",
    );
    await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
    await user.click(await screen.findByRole("option", { name: "Ollama" }));
    expect(draft().environment.ANTHROPIC_API_KEY).toBe("anthropic-key");
    await user.click(screen.getByRole("button", { name: "Environment" }));
    await user.click(
      screen.getByRole("button", { name: "Remove GOOSE_PROVIDER" }),
    );
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
    expect(draft().environment).toEqual({ GOOSE_PROVIDER: null });
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("hides the key for an unknown saved provider until its override is removed", async () => {
  const { draft, view, control } = setup({ savedKeys: ["GOOSE_PROVIDER"] });
  const user = userEvent.setup();
  try {
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    expect(
      screen.getByText(/saved GOOSE_PROVIDER override whose value is hidden/),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Environment" }));
    await user.click(
      screen.getByRole("button", { name: "Remove GOOSE_PROVIDER" }),
    );
    await user.type(screen.getByLabelText("OpenAI API key"), "openai-key");
    expect(draft().environment).toEqual({
      GOOSE_PROVIDER: null,
      OPENAI_API_KEY: "openai-key",
    });
    await user.click(
      screen.getByRole("button", { name: "Undo change to GOOSE_PROVIDER" }),
    );
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
    expect(draft().environment).toEqual({});
  } finally {
    view.unmount();
    control.dispose();
  }
});
