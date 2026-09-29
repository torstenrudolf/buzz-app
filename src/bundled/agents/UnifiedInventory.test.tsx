// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
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
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import type { ReadTransport } from "../../features/relay/transport";
import type { RelaySnapshot } from "../../features/relay/service";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { UnifiedInventory } from "./UnifiedInventory";
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});
function setup(
  mode: string,
  configure: (f: ReturnType<typeof controlFixture>) => void,
  definitions: { id: string; name: string }[] = [],
  transport: Partial<ReadTransport> = {},
  naming = false,
) {
  const f = controlFixture();
  configure(f);
  const owned = createRelaySession({
    viewer: "de".repeat(32),
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    readAgentLibrary: async () => ({
      definitions,
      identities: [
        {
          pubkey: "cd".repeat(32),
          name: "Not imported",
          definitionId: "linked",
        },
      ],
    }),
    query: async () => [],
    media: () => undefined,
    ...transport,
  });
  const control = createAgentControl(f.host);
  disposals.push(() => {
    owned.dispose();
    control.dispose();
  });
  const boundNames = naming
    ? bindNames(owned.session, {
        snapshot: () => [createAgentDirectory(control)],
        subscribe: () => () => {},
      })
    : undefined;
  if (boundNames) disposals.push(() => boundNames.dispose());
  const session = {
    ...owned.session,
    names: boundNames ?? owned.session.names,
  };
  let connection: RelaySnapshot = {
    status: mode === "disconnected" ? "disconnected" : "ready",
    viewer: "de".repeat(32),
    ...(mode === "disconnected"
      ? {}
      : { scope: `wss://relay.example.test:${"de".repeat(32)}` }),
    generation: 1,
    session:
      mode === "archived"
        ? {
            ...session,
            archives: {
              ...owned.session.archives,
              state: () => "archived" as const,
            },
          }
        : session,
  };
  const view = () => (
    <UnifiedInventory
      state={{ ...control.snapshot(), status: "ready", data: f.data }}
      control={control}
      connection={connection}
      edit={() => {}}
      importedId={null}
      onUseHere={() => {}}
      onImport={() => {}}
    />
  );
  const mounted = render(view());
  return {
    f,
    library: owned.session.agentLibrary,
    changeScope(scope: string, generation: number) {
      connection = { ...connection, scope, generation };
      mounted.rerender(view());
    },
  };
}
it("filters archived identities after all discovery joins while retaining local controls", async () => {
  setup("archived", (f) => {
    f.data.parked = [
      { pubkey: "cd".repeat(32), name: "Hidden", sources: ["installed"] },
    ];
  });
  await waitFor(() =>
    expect(
      screen.queryByText("No agents yet. Add an agent to get started."),
    ).toBeNull(),
  );
  await screen.findByRole("button", { name: "Stop" });
  expect(screen.queryByRole("article", { name: "Agent Hidden" })).toBeNull();
  expect(
    screen.queryByRole("article", { name: "Agent Not imported" }),
  ).toBeNull();
  expect(
    screen.getByRole("article", { name: "Agent Fixture agent" }),
  ).toBeVisible();
});
it("omits redundant profile text and uses configured names for native WSS setups in an HTTPS session", async () => {
  const { changeScope } = setup(
    "connected",
    (f) => {
      f.agent.pubkey = "cd".repeat(32);
      f.agent.name = "Raw local fallback";
    },
    [{ id: "linked", name: "Reusable profile" }],
  );
  act(() => changeScope(`https://relay.example.test:${"de".repeat(32)}`, 1));
  const card = await screen.findByRole("article", {
    name: "Agent Raw local fallback",
  });
  expect(within(card).queryByText(/^Profile:/)).toBeNull();
  expect(within(card).getByText(npubEncode("cd".repeat(32)))).not.toBeVisible();
  fireEvent.click(
    within(card).queryByText("Identity & sources") ??
      within(card).getByLabelText(/^Details for /),
  );
  expect(within(card).getByText(npubEncode("cd".repeat(32)))).toBeVisible();
  expect(within(card).getByRole("button", { name: "Stop" })).toBeEnabled();
  expect(
    screen.queryByRole("article", { name: "Agent Not imported" }),
  ).toBeNull();
});
it("keeps exact local controls while disconnected and after switching to another community", async () => {
  const { changeScope } = setup("disconnected", (f) => {
    f.data.parked = [];
  });
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(card).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  ).toBeVisible();
  act(() => changeScope(`wss://other.example.test:${"de".repeat(32)}`, 2));
  const switched = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(switched).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(
    within(switched).getByRole("button", { name: "Actions for Fixture agent" }),
  ).toBeVisible();
});
