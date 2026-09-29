// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import * as communityApi from "../../features/communities/api";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentControlPanel } from "./AgentControlPanel";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});

// Exercise the control panel callbacks before the replacement inventory mounts.
function setup(
  _mode: string,
  configure: (f: ReturnType<typeof controlFixture>) => void,
) {
  const f = controlFixture();
  configure(f);
  const control = createAgentControl(f.host);
  disposals.push(() => control.dispose());
  render(
    <AgentControlPanel
      control={control}
      importDestination="https://relay.example.test"
      createOwner={"de".repeat(32)}
    >
      {(
        state,
        _edit,
        _duplicate,
        _remove,
        _importedId,
        _label,
        onUseHere,
        onImport,
      ) =>
        state.status === "ready" && (
          <>
            <article aria-label="Agent Not imported">
              <button
                type="button"
                onClick={() => onImport("cd".repeat(32), "development")}
              >
                Import
              </button>
            </article>
            <article aria-label="Agent Fixture agent">
              <button type="button" onClick={() => onUseHere("ab".repeat(32))}>
                Use here
              </button>
            </article>
          </>
        )
      }
    </AgentControlPanel>,
  );
  return { f };
}

it.each(["retry", "source"])(
  "selected dialog import recovers through %s without changing the identity or destination",
  async (recovery) => {
    vi.spyOn(communityApi, "communityRequest").mockResolvedValue({
      identities: [],
    });
    let fail = true;
    const { f } = setup("connected", (fixture) => {
      fixture.data.parked = [
        {
          pubkey: "cd".repeat(32),
          name: "Not imported",
          sources: ["development"],
        },
      ];
      const preview = fixture.host.previewImport;
      fixture.host.previewImport = vi.fn(async (source, destination) => {
        if (fail) throw Error("Synthetic read failure");
        return preview(source, destination);
      });
    });
    const card = await screen.findByRole("article", {
      name: "Agent Not imported",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Import" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Import Not imported?",
    });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "We couldn’t load this agent",
    );
    expect(
      within(dialog).getByText("https://relay.example.test"),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Import agent" }),
    ).toBeDisabled();
    fail = false;
    if (recovery === "retry") {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    } else {
      fireEvent.click(within(dialog).getByText("Choose another source"));
      fireEvent.change(within(dialog).getByLabelText("Source library"), {
        target: { value: "installed" },
      });
    }
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Import agent" }),
      ).toBeEnabled(),
    );
    expect(within(dialog).queryByText("Choose another source")).toBeNull();
    expect(f.host.previewImport).toHaveBeenLastCalledWith(
      recovery === "retry" ? "development" : "installed",
      "https://relay.example.test",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(f.calls.some((call) => call.action === "import")).toBe(false);
  },
);

it("dialog actions choose the destination record when several local setups share a key", async () => {
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (_destination, route) =>
      route === "agent-inventory"
        ? { identities: [] }
        : {
            pubkey: "ab".repeat(32),
            relayUrl: "wss://relay.example.test",
            owner: "de".repeat(32),
            signature: "fixture",
          },
    );
  const { f } = setup("connected", (fixture) => {
    fixture.data.parked = [];
    fixture.agent.configured = false;
    fixture.agent.enabled = false;
    fixture.agent.status = "stopped";
    fixture.data.agents.unshift({
      ...structuredClone(fixture.agent),
      id: "first-other-community",
      relayUrl: "wss://elsewhere.example",
      name: "Other saved name",
      systemPrompt: "Other instructions",
    });
  });
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Use here" }));
  const setupDialog = await screen.findByRole("dialog", {
    name: "Set up agent here",
  });
  fireEvent.click(
    within(setupDialog).getByRole("button", { name: "Use here" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Set up agent here" }),
    ).toBeNull(),
  );
  expect(
    f.calls.find((call) => call.action === "configure")?.payload,
  ).toMatchObject({ id: "fixture-agent" });
  expect(request).toHaveBeenCalledWith(
    "https://relay.example.test",
    "resolve-agent-community",
    { pubkey: f.agent.pubkey, owner: "de".repeat(32), confirmed: true },
  );
  expect(
    f.data.agents.find((agent) => agent.id === "first-other-community")
      ?.configured,
  ).toBe(false);
  expect(f.agent.enabled).toBe(false);
});

it("keeps the installation browser available on an older host", async () => {
  const f = controlFixture();
  delete f.data.parked;
  const control = createAgentControl(f.host);
  disposals.push(() => control.dispose());
  render(
    <AgentControlPanel
      control={control}
      importDestination="https://relay.example.test"
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Import from another installation",
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Import Fixture agent" }),
  ).toBeEnabled();
});

it("does not expose installation browsing on a modern host", async () => {
  const f = controlFixture();
  f.data.parked = [];
  const control = createAgentControl(f.host);
  disposals.push(() => control.dispose());
  render(<AgentControlPanel control={control} />);
  await screen.findByRole("article", { name: "Agent Fixture agent" });
  expect(
    screen.queryByRole("button", { name: "Import from another installation" }),
  ).toBeNull();
});

it("keeps team import repair reachable on a modern host without offering ordinary imports", async () => {
  const f = controlFixture();
  f.data.parked = [];
  f.agent.needsTeamImport = true;
  f.host.previewImport = async () => ({
    token: "team-preview",
    sourcePath: "/fixture/installed/managed-agents.json",
    warnings: [],
    candidates: [
      {
        id: f.agent.id,
        name: f.agent.name,
        pubkey: f.agent.pubkey,
        relayUrl: f.agent.relayUrl,
      },
      {
        id: "second-fixture",
        name: "Other agent",
        pubkey: "cd".repeat(32),
        relayUrl: f.agent.relayUrl,
      },
    ],
  });
  const control = createAgentControl(f.host);
  disposals.push(() => control.dispose());
  render(
    <AgentControlPanel
      control={control}
      importDestination={f.agent.relayUrl}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Repair team import from another installation",
    }),
  );
  expect(
    await screen.findByRole("button", {
      name: "Repair team import for Fixture agent",
    }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Import Other agent" }),
  ).toBeNull();
});
