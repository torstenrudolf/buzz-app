// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentModelPicker } from "./AgentModelPicker";
import { agentDraft } from "./agent-edit";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { ModelCatalog } from "../../features/agents/models";

afterEach(cleanup);

it("Goose Databricks v2 browses live IDs and flags an unlisted short name", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [
      {
        id: "data_workflow_tools.goose.goose-glm-5-3",
        name: "data_workflow_tools.goose.goose-glm-5-3",
      },
    ],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = {
    begin: async () => 1,
    run,
    cancel: async () => {},
  };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  function Editor() {
    const [draft, setDraft] = useState({
      ...agentDraft(f.agent),
      command: "/usr/local/bin/goose",
      provider: "databricks_v2",
      model: "goose-glm-5-3",
    });
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={{ host: "", filter: "" }}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await screen.findByText(/not in Goose’s current provider list/);
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        host: "",
        filter: "",
        action: "connect",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await user.click(
      screen.getByRole("option", {
        name: /data_workflow_tools\.goose\.goose-glm-5-3/,
      }),
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "data_workflow_tools.goose.goose-glm-5-3",
    );
    expect(
      screen.queryByText(/not in Goose’s current provider list/),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("shows ten Goose models at a time and searches the full provider catalog", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: Array.from({ length: 30 }, (_, index) => ({
      id: `model-${String(index).padStart(2, "0")}`,
      name: `model-${String(index).padStart(2, "0")}`,
    })),
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  function Editor() {
    const [draft, setDraft] = useState({
      ...agentDraft(f.agent),
      command: "/usr/local/bin/goose",
      provider: "anthropic",
      model: "",
    });
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={{ host: "", filter: "" }}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await screen.findByText("Showing up to 10 models. Type to search all 30.");
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        action: "connect",
        edit: expect.objectContaining({
          harness: expect.objectContaining({ provider: "anthropic" }),
        }),
      }),
    );
    const input = screen.getByRole("combobox", { name: "Model" });
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getAllByRole("option")).toHaveLength(10);
    expect(screen.getByRole("option", { name: /^model-00$/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /model-25/ })).toBeNull();
    await user.type(input, "model-25");
    await user.click(await screen.findByRole("option", { name: /model-25/ }));
    expect(input).toHaveValue("model-25");
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("shows a loading row while Goose fetches models for the selected provider", async () => {
  const f = controlFixture();
  let finish: (catalog: ModelCatalog) => void = () => {};
  const run = vi.fn(
    () =>
      new Promise<ModelCatalog>((resolve) => {
        finish = resolve;
      }),
  );
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const draft = {
    ...agentDraft(f.agent),
    command: "/usr/local/bin/goose",
    provider: "anthropic",
    model: "previous-model",
  };
  const view = render(
    <AgentModelPicker
      draft={draft}
      control={control}
      defaults={{ host: "", filter: "" }}
      onChange={() => {}}
    />,
  );
  try {
    await userEvent.click(
      screen.getByRole("button", { name: "Browse models" }),
    );
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "previous-model",
    );
    expect(screen.getByText("Loading Goose models…")).toBeVisible();
    expect(screen.queryByRole("option", { name: /previous-model/ })).toBeNull();
    finish({
      host: "",
      models: [{ id: "claude-model", name: "claude-model" }],
      modelOverridden: false,
      disconnected: false,
    });
    expect(
      await screen.findByRole("option", { name: /^claude-model$/ }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Model" }),
      ).not.toHaveAttribute("aria-busy"),
    );
  } finally {
    finish({
      host: "",
      models: [],
      modelOverridden: false,
      disconnected: false,
    });
    view.unmount();
    control.dispose();
  }
});

it("shows Goose authentication errors while keeping manual model entry available", async () => {
  const f = controlFixture();
  f.host.models = {
    begin: async () => 1,
    run: async () => {
      throw "Goose needs authentication for this provider. Enter its API key in Buzz if it uses one, then retry";
    },
    cancel: async () => {},
  };
  const control = createAgentControl(f.host);
  const draft = {
    ...agentDraft(f.agent),
    command: "/usr/local/bin/goose",
    provider: "openai",
  };
  const view = render(
    <AgentModelPicker
      draft={draft}
      control={control}
      defaults={{ host: "", filter: "" }}
      onChange={() => {}}
    />,
  );
  try {
    await userEvent.click(
      screen.getByRole("button", { name: "Browse models" }),
    );
    expect(await screen.findByText(/Goose needs authentication/)).toBeVisible();
    const input = screen.getByRole("combobox", { name: "Model" });
    await waitFor(() => expect(input).not.toHaveAttribute("aria-busy"));
    // Authentication can finish before Base UI's next-frame trigger opens the
    // popup. Escape must follow that opening, not just the request completion.
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-expanded", "false"),
    );
    expect(
      await screen.findByRole("button", { name: "Retry models" }),
    ).toBeVisible();
    await userEvent.clear(input);
    await userEvent.type(input, "custom-model");
    expect(input).toHaveValue("custom-model");
  } finally {
    view.unmount();
    control.dispose();
  }
});

for (const opening of ["typing", "ArrowDown", "closed"] as const) {
  it(`${opening}: only explicit Browse or Retry may connect the actual combobox`, async () => {
    const f = controlFixture();
    const begin = vi.fn(async () => 1);
    const run = vi.fn(async () => {
      throw "Synthetic sign-in failure";
    });
    const cancel = vi.fn(async () => {});
    f.host.models = { begin, run, cancel };
    const control = createAgentControl(f.host);
    const user = userEvent.setup();
    function Editor() {
      const [draft, setDraft] = useState(agentDraft(f.agent));
      return (
        <AgentModelPicker
          draft={draft}
          control={control}
          defaults={{ host: "https://workspace.example.com", filter: "" }}
          onChange={(patch) =>
            setDraft((current) => ({ ...current, ...patch }))
          }
        />
      );
    }
    const view = render(<Editor />);
    try {
      const input = screen.getByRole("combobox", { name: "Model" });
      // Base UI intentionally aria-hides controls outside the open list from
      // virtual cursors; pointer/Tab access remains. Capture the real trigger.
      const browse = screen.getByRole("button", { name: "Browse models" });
      if (opening === "typing") {
        await user.clear(input);
        await user.type(input, "custom-model");
      } else if (opening === "ArrowDown") {
        await user.click(input);
        await user.keyboard("{ArrowDown}");
      }
      if (opening !== "closed")
        expect(input).toHaveAttribute("aria-expanded", "true");
      expect(begin).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      if (opening === "ArrowDown") {
        await user.tab();
        expect(browse).toHaveFocus();
        await user.keyboard("{Enter}");
      } else await user.click(browse);
      // Base UI defers the trigger's mousedown toggle to the next frame. Assert
      // only after that callback, not whichever side of it userEvent happened to finish.
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      await screen.findByText("Synthetic sign-in failure");
      expect(begin).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledExactlyOnceWith(
        1,
        expect.objectContaining({ action: "connect" }),
      );
      expect(input).toHaveAttribute("aria-expanded", "true");
      if (opening === "typing") expect(input).toHaveValue("custom-model");
      await user.keyboard("{Escape}");
      await user.click(input);
      await user.keyboard("{ArrowDown}");
      expect(run).toHaveBeenCalledOnce();
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Retry models" }));
      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    } finally {
      view.unmount();
      control.dispose();
    }
  });
}

it("Pi discovers extension providers before start and selects the exact provider/model pair with one Browse", async () => {
  const f = controlFixture();
  let release!: (value: {
    host: string;
    models: { id: string; name: string }[];
    modelOverridden: boolean;
    disconnected: boolean;
  }) => void;
  const run = vi.fn(
    () =>
      new Promise<Parameters<typeof release>[0]>((resolve) => {
        release = resolve;
      }),
  );
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const providers = vi.fn();
  const user = userEvent.setup();
  let current = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    args: "[]",
    provider: "",
    model: "saved-custom",
  };
  function Editor() {
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={undefined}
        onPiProviders={providers}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("status", { name: "Model lookup" }),
    ).toHaveTextContent("Loading Pi models…");
    // The open popup marks outside content aria-hidden on its own schedule,
    // which removes the button's accessible name. Cancel stays visible.
    expect(
      screen.getByText("Cancel model lookup").closest("button"),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await act(async () =>
      release({
        host: "",
        models: [
          {
            id: "extension/namespace/model.v1",
            name: "extension/namespace/model.v1",
          },
        ],
        modelOverridden: false,
        disconnected: false,
      }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: /extension\/namespace\/model.v1/,
      }),
    );
    expect(
      screen.queryByRole("status", { name: "Model lookup" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Model" })).not.toHaveAttribute(
      "aria-busy",
    );
    expect(current.provider).toBe("extension");
    expect(current.model).toBe("namespace/model.v1");
    expect(providers).toHaveBeenCalledWith(["extension"]);
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    expect(
      await screen.findByRole("option", {
        name: /extension\/namespace\/model.v1/,
      }),
    ).toBeVisible();
    expect(run).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi loads its signed-in providers when selected, without Browse", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [
      { id: "databricks/model-a", name: "databricks/model-a" },
      { id: "ds4/model-b", name: "ds4/model-b" },
    ],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const providers = vi.fn();
  const renderPicker = (command: string) => (
    <AgentModelPicker
      draft={{ ...agentDraft(f.agent), command, provider: "", model: "" }}
      control={control}
      defaults={{ host: "", filter: "" }}
      onPiProviders={providers}
      onChange={() => {}}
    />
  );
  const view = render(renderPicker("/local/goose"));
  try {
    // Goose may start OAuth, so it still waits for an explicit Browse.
    expect(run).not.toHaveBeenCalled();
    view.rerender(renderPicker("/local/buzz-pi-acp"));
    await waitFor(() =>
      expect(providers).toHaveBeenLastCalledWith(["databricks", "ds4"]),
    );
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ action: "connect" }),
    );
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi's automatic lookup survives a StrictMode remount under single native admission", async () => {
  const f = controlFixture();
  let pending: number | null = null;
  let next = 0;
  const started = new Set<number>();
  const begin = vi.fn(async () => {
    if (pending !== null)
      throw "Another model connection request is in progress; cancel it first";
    pending = ++next;
    return pending;
  });
  f.host.models = {
    begin,
    run: async (ticket) => {
      started.add(ticket);
      pending = null;
      return {
        host: "",
        models: [{ id: "databricks/model-a", name: "databricks/model-a" }],
        modelOverridden: false,
        disconnected: false,
      };
    },
    cancel: async (ticket) => {
      if (pending === ticket && !started.has(ticket)) pending = null;
    },
  };
  const control = createAgentControl(f.host);
  const providers = vi.fn();
  const view = render(
    <StrictMode>
      <AgentModelPicker
        draft={{
          ...agentDraft(f.agent),
          command: "/local/buzz-pi-acp",
          provider: "",
          model: "",
        }}
        control={control}
        defaults={undefined}
        onPiProviders={providers}
        onChange={() => {}}
      />
    </StrictMode>,
  );
  try {
    await waitFor(() =>
      expect(providers).toHaveBeenLastCalledWith(["databricks"]),
    );
    // The remount's lookup waited for the first ticket instead of being refused.
    expect(begin).toHaveBeenCalledTimes(2);
    expect(providers).toHaveBeenCalledWith(null);
    expect(screen.queryByText(/Another model connection/)).toBeNull();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("explains an empty Pi provider in the open model list without discarding other providers", async () => {
  const f = controlFixture();
  const message =
    "No Pi models for this provider. Buzz doesn’t use API keys exported in your shell profile. Add this provider’s API key for this agent, then browse models again.";
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "openai/model", name: "openai/model" }],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = {
    begin: async () => 1,
    run,
    cancel: async () => {},
  };
  const control = createAgentControl(f.host);
  let provider = "google";
  const renderPicker = () => (
    <AgentModelPicker
      draft={{
        ...agentDraft(f.agent),
        command: "/local/buzz-pi-acp",
        provider,
        model: "",
      }}
      control={control}
      defaults={undefined}
      onChange={() => {}}
    />
  );
  const view = render(renderPicker());
  try {
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() =>
      expect(document.querySelector(".buzz-select-popup")).toHaveTextContent(
        message,
      ),
    );
    provider = "openai";
    view.rerender(renderPicker());
    expect(document.querySelector(".buzz-select-popup")).not.toHaveTextContent(
      message,
    );
    expect(
      await screen.findByRole("option", { name: /openai\/model/ }),
    ).toBeVisible();
    expect(run).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi cancellation and workspace changes reject late catalogs; explicit retry recovers", async () => {
  const f = controlFixture();
  let release!: (value: {
    host: string;
    models: { id: string; name: string }[];
    modelOverridden: boolean;
    disconnected: boolean;
  }) => void;
  const run = vi.fn(
    () =>
      new Promise<Parameters<typeof release>[0]>((resolve) => {
        release = resolve;
      }),
  );
  const cancel = vi.fn(async () => {});
  f.host.models = { begin: async () => 1, run, cancel };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  let draft = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    args: "[]",
    provider: "custom",
    model: "kept",
  };
  const renderPicker = () => (
    <AgentModelPicker
      draft={draft}
      control={control}
      defaults={undefined}
      onChange={() => {}}
    />
  );
  const view = render(renderPicker());
  const result = {
    host: "",
    models: [{ id: "custom/new", name: "custom/new" }],
    modelOverridden: false,
    disconnected: false,
  };
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Cancel model lookup" }),
    );
    await act(async () => release(result));
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("kept");
    await user.click(screen.getByRole("button", { name: "Retry models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    draft = { ...draft, workspace: "/different/workspace" };
    view.rerender(renderPicker());
    await act(async () => release(result));
    expect(
      screen.queryByRole("option", { name: /custom\/new/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    await act(async () => release(result));
    expect(
      await screen.findByRole("option", { name: /custom\/new/ }),
    ).toBeVisible();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("reopened Pi editor accepts a pasted qualified ID without doubling its provider", async () => {
  const control = createAgentControl(controlFixture().host);
  const user = userEvent.setup();
  let current = {
    ...agentDraft(controlFixture().agent),
    command: "/local/buzz-pi-acp",
    args: "[]",
    provider: "custom",
    model: "old",
  };
  function Editor() {
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={undefined}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    const input = screen.getByRole("combobox", { name: "Model" });
    await user.clear(input);
    await user.type(input, "custom/namespace/model.v1");
    await user.tab();
    expect(current.model).toBe("namespace/model.v1");
    await user.clear(input);
    await user.type(input, "namespace/other.v2");
    await user.tab();
    expect(current.model).toBe("namespace/other.v2");
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi warns about incomplete or unlisted selections and preserves literal Advanced IDs", async () => {
  const f = controlFixture();
  f.host.models = {
    begin: async () => 1,
    cancel: async () => {},
    run: async () => ({
      host: "",
      models: [{ id: "custom/listed", name: "custom/listed" }],
      modelOverridden: false,
      disconnected: false,
    }),
  };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  let current = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    provider: "custom",
    model: "",
    args: "[]",
  };
  function Editor() {
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={undefined}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    expect(
      screen.getByText(/Choose a model for this provider before starting/),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Model" }));
    const literal = screen.getByLabelText("Model ID (custom or blank)");
    await user.type(literal, "custom/");
    expect(literal).toHaveValue("custom/");
    await user.type(literal, "real-model");
    await user.tab();
    expect(current.model).toBe("custom/real-model");
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await screen.findByText(/This model ID is not in Pi’s available catalog/);
    expect(current.model).toBe("custom/real-model");
    await user.click(
      await screen.findByRole("option", { name: /custom\/listed/ }),
    );
    expect(current.model).toBe("listed");
    expect(
      screen.queryByText(/This model ID is not in Pi’s available catalog/),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi clears discovered providers when catalog context changes or the picker unmounts", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "extension/exact", name: "extension/exact" }],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, cancel: async () => {}, run };
  const control = createAgentControl(f.host),
    providers = vi.fn();
  const user = userEvent.setup();
  let draft = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    provider: "",
    model: "",
    args: "[]",
  };
  const picker = () => (
    <AgentModelPicker
      draft={draft}
      control={control}
      defaults={undefined}
      onPiProviders={providers}
      onChange={() => {}}
    />
  );
  const view = render(picker());
  try {
    for (const patch of [
      { workspace: "/new/workspace" },
      { environment: { PI_CODING_AGENT_DIR: "/new/config" } },
      { command: "buzz-agent" },
    ]) {
      await user.click(screen.getByRole("button", { name: "Browse models" }));
      await waitFor(() =>
        expect(providers).toHaveBeenLastCalledWith(["extension"]),
      );
      await screen.findByRole("option", { name: /extension\/exact/ });
      await user.keyboard("{Escape}");
      draft = { ...draft, ...patch };
      view.rerender(picker());
      await waitFor(() => expect(providers).toHaveBeenLastCalledWith([]));
    }
    view.unmount();
    expect(providers).toHaveBeenLastCalledWith([]);
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi Test connection prompts the draft selection and reports each result", async () => {
  const f = controlFixture();
  const tests: { resolve(): void; reject(error: string): void }[] = [];
  const run = vi.fn(
    async (_ticket: number, request: { action: string }) =>
      new Promise<ModelCatalog>((resolve, reject) => {
        const catalog = {
          host: "",
          models: [{ id: "openai/gpt", name: "openai/gpt" }],
          modelOverridden: false,
          disconnected: false,
        };
        if (request.action !== "test") resolve(catalog);
        else tests.push({ resolve: () => resolve(catalog), reject });
      }),
  );
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  let draft = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    args: "[]",
    provider: "openai",
    model: "gpt",
  };
  const picker = () => (
    <AgentModelPicker
      draft={draft}
      control={control}
      defaults={undefined}
      onChange={() => {}}
    />
  );
  const view = render(picker());
  const button = () => screen.getByRole("button", { name: "Test connection" });
  try {
    await waitFor(() => expect(button()).toBeEnabled());
    await user.click(button());
    expect(run).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        action: "test",
        edit: expect.objectContaining({
          harness: expect.objectContaining({
            provider: "openai",
            model: "gpt",
          }),
        }),
      }),
    );
    expect(screen.getByText(/Sending a short test message/)).toBeVisible();
    await act(async () =>
      tests.at(-1)?.reject("The provider rejected the API key."),
    );
    expect(
      await screen.findByText("The provider rejected the API key."),
    ).toBeVisible();
    await user.click(button());
    await act(async () => tests.at(-1)?.resolve());
    expect(
      await screen.findByText("Connected. The model replied."),
    ).toBeVisible();
    // An edit retires the in-flight test; returning must not strand its spinner.
    await user.click(button());
    draft = { ...draft, model: "other" };
    view.rerender(picker());
    draft = { ...draft, model: "gpt" };
    view.rerender(picker());
    await waitFor(() => expect(button()).toBeEnabled());
    expect(
      screen.queryByText(/Sending a short test message|cancelled/i),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Goose Test connection checks the unsaved provider and model", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const view = render(
    <AgentModelPicker
      draft={{
        ...agentDraft(f.agent),
        command: "/local/goose",
        provider: "openai",
        model: "gpt",
      }}
      control={control}
      defaults={undefined}
      onChange={() => {}}
    />,
  );
  try {
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Test connection" }));
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        action: "test",
        edit: expect.objectContaining({
          harness: expect.objectContaining({
            provider: "openai",
            model: "gpt",
          }),
        }),
      }),
    );
    expect(
      await screen.findByText("Connected. The model replied."),
    ).toBeVisible();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("browses an inherited Agent defaults workspace without repeating it in the form", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "endpoint-two", name: "Endpoint Two" }],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  const draft = {
    ...agentDraft(f.agent),
    command: "buzz-agent",
    provider: "databricks_v2",
    model: "",
  };
  delete draft.databricks;
  render(
    <AgentModelPicker
      draft={draft}
      control={control}
      // A compiled floor that differs from the hidden inherited values.
      defaults={{ host: "https://compiled.example.com", filter: "compiled-*" }}
      inheritedWorkspace={{ host: true, filter: true }}
      onChange={() => {}}
    />,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          host: "",
          filter: "",
          action: "connect",
          inheritWorkspace: true,
        }),
      ),
    );
    expect(screen.queryByText(/Set your Databricks workspace/)).toBeNull();
    // Browse opens the model list once the catalog renders; its popup makes
    // the rest of the form inert, so close it before opening Advanced.
    await screen.findByRole("option", { name: /Endpoint Two/ });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(
      screen.getByLabelText("Databricks workspace (HTTPS origin)"),
    ).toHaveAttribute("placeholder", "Use agent defaults");
    // Disconnect names the same hidden workspace for native to resolve.
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(run).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({
          host: "",
          action: "disconnect",
          inheritWorkspace: true,
          edit: undefined,
        }),
      ),
    );
  } finally {
    control.dispose();
  }
});
