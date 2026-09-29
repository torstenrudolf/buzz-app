// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  agentSetupConfirmationAvailable,
  communityRequest,
} from "../../features/communities/api";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import { inventoryIdentities } from "./inventory-model";
import { InventoryView } from "./InventoryView";
import {
  agentSetupUnavailableMessage,
  LocalInventoryAction,
} from "./LocalInventoryAction";
import { ManagedAgentActions } from "./ManagedAgentActions";

// A packaged desktop connection: the real adapter selection, with no broker.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    throw new Error(`Unexpected native command ${command}`);
  }),
  isTauri: () => true,
}));
const destination = "https://relay.example.test";
const owner = "de".repeat(32);
const disposals: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No development broker in this build");
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(invoke).mockClear();
});

function incompleteImport() {
  const f = controlFixture();
  Object.assign(f.agent, {
    configured: false,
    enabled: false,
    status: "stopped",
    runningRevision: null,
  });
  const control = createAgentControl(f.host);
  disposals.push(() => control.dispose());
  return { f, control };
}

it("matches the packaged adapter, which cannot confirm agent setup", async () => {
  expect(agentSetupConfirmationAvailable()).toBe(false);
  await expect(
    communityRequest(destination, "resolve-agent-community", {
      pubkey: "ab".repeat(32),
      owner,
      confirmed: true,
    }),
  ).rejects.toThrow("This operation is unavailable on the packaged connection");
  expect(invoke).not.toHaveBeenCalled();
});

it("explains the missing confirmation instead of offering Use here in the dialog", async () => {
  const { f, control } = incompleteImport();
  await control.refresh();
  render(
    <LocalInventoryAction
      control={control}
      agent={f.agent}
      destination={destination}
      owner={owner}
      disabled={false}
      onPending={() => {}}
      onUsed={() => {}}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    agentSetupUnavailableMessage,
  );
  expect(screen.queryByRole("button", { name: "Use here" })).toBeNull();
});

it("does not offer Use here for an imported identity that needs setup", async () => {
  const { f, control } = incompleteImport();
  await control.refresh();
  const onUseHere = vi.fn();
  render(
    <ManagedAgentActions
      agent={f.agent}
      state={control.snapshot()}
      control={control}
      imported
      destination={destination}
      owner={owner}
      onUseHere={onUseHere}
    />,
  );
  expect(screen.queryByRole("button", { name: "Use here" })).toBeNull();
  expect(screen.getByText(agentSetupUnavailableMessage)).toBeVisible();
  expect(
    screen.queryByText(/Choose Use here to set up this identity/),
  ).toBeNull();
});

it("disables the inventory card's Use here and says why", async () => {
  const { f, control } = incompleteImport();
  await control.refresh();
  const owned = createRelaySession({
    viewer: owner,
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    query: async () => [],
    media: () => undefined,
  });
  disposals.push(() => owned.dispose());
  const onUseHere = vi.fn();
  render(
    <InventoryView
      state={{ ...control.snapshot(), status: "ready", data: f.data }}
      control={control}
      session={owned.session}
      destination={destination}
      rows={inventoryIdentities([], f.data, (_key, fallback) => fallback)}
      profiles={[]}
      publicProfiles={new Map()}
      edit={() => {}}
      importedId={null}
      onUseHere={onUseHere}
      onImport={() => {}}
    />,
  );
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(card).getByRole("button", { name: "Use here" })).toBeDisabled();
  expect(within(card).getByText(agentSetupUnavailableMessage)).toBeVisible();
  expect(onUseHere).not.toHaveBeenCalled();
});
