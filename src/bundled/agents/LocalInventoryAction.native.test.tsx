// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { communityRequest } from "../../features/communities/api";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import { inventoryIdentities } from "./inventory-model";
import { InventoryView } from "./InventoryView";
import { LocalInventoryAction } from "./LocalInventoryAction";
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

it("offers native owner confirmation without a broker", async () => {
  const resolution = {
    pubkey: "ab".repeat(32),
    owner,
    relayUrl: "wss://relay.example.test",
    signature: "proof",
  };
  vi.mocked(invoke).mockResolvedValueOnce(resolution);
  expect(
    await communityRequest(destination, "resolve-agent-community", {
      pubkey: resolution.pubkey,
      owner,
      confirmed: true,
    }),
  ).toEqual(resolution);
  expect(invoke).toHaveBeenCalledWith("relay_agent_resolve", {
    community: destination,
    target: { pubkey: resolution.pubkey, owner, confirmed: true },
  });
});

it("offers Use here for an incomplete import in the dialog", async () => {
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
  expect(screen.getByRole("button", { name: "Use here" })).toBeEnabled();
});

it("offers Use here for an imported identity that needs setup", async () => {
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
  expect(screen.getByRole("button", { name: "Use here" })).toBeEnabled();
});

it("enables the inventory card's Use here", async () => {
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
  expect(within(card).getByRole("button", { name: "Use here" })).toBeEnabled();
  expect(onUseHere).not.toHaveBeenCalled();
});
