// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import { inventoryIdentities } from "./inventory-model";
import { InventoryView } from "./InventoryView";
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});
function setup(
  mode: string,
  configure: (f: ReturnType<typeof controlFixture>) => void,
  identities = ["cd".repeat(32)],
  definitions: { id: string; name: string }[] = [],
) {
  const f = controlFixture();
  configure(f);
  const owned = createRelaySession({
    viewer: "de".repeat(32),
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    query: async () => [],
    media: () => undefined,
  });
  const control = createAgentControl(f.host);
  disposals.push(() => {
    owned.dispose();
    control.dispose();
  });
  const rows = inventoryIdentities(
    mode === "disconnected"
      ? []
      : [
          {
            pubkey: "cd".repeat(32),
            name: "Not imported",
            definitionId: "linked",
          },
        ],
    f.data,
    (_key, fallback) => fallback,
  );
  if (mode !== "disconnected") {
    for (const key of identities) {
      const row = rows.get(key);
      if (row)
        row.knownCommunities = new Set([
          ...row.knownCommunities,
          "https://relay.example.test",
        ]);
    }
  }
  const onImport = vi.fn();
  const onUseHere = vi.fn();
  const view = () => (
    <InventoryView
      state={{ ...control.snapshot(), status: "ready", data: f.data }}
      control={control}
      session={owned.session}
      destination={mode === "disconnected" ? "" : "https://relay.example.test"}
      rows={rows}
      profiles={definitions}
      publicProfiles={new Map()}
      edit={() => {}}
      importedId={null}
      onUseHere={onUseHere}
      onImport={onImport}
    />
  );
  const mounted = render(view());
  return {
    f,
    onImport,
    onUseHere,
    rows,
    redraw: () => mounted.rerender(view()),
  };
}
it("keeps parked discovery community unknown without claiming saved setup", async () => {
  setup(
    "connected",
    (fixture) => {
      fixture.data.parked = [
        { pubkey: "cd".repeat(32), name: "Saved", sources: ["installed"] },
        { pubkey: "ee".repeat(32), name: "Unresolved", sources: ["installed"] },
      ];
    },
    [],
  );
  const group = await screen.findByRole("region", {
    name: "Available to import",
  });
  expect(
    await within(group).findByRole("article", { name: "Agent Saved" }),
  ).toBeVisible();
  expect(
    within(
      screen.getByRole("region", { name: "Available to import" }),
    ).getByRole("article", { name: "Agent Unresolved" }),
  ).toBeVisible();
});

it("sorts displayed names within groups and profile cards without merging equal names", async () => {
  const keys = ["11", "22", "33", "44"].map((s) => s.repeat(32));
  setup(
    "connected",
    (f) => {
      f.data.agents = [];
      f.data.parked = keys.map((pubkey, i) => ({
        pubkey,
        name: ["Zebra", "beta", "Alpha", "Alpha"][i] ?? "",
        sources: ["installed"],
      }));
    },
    keys,
    [
      { id: "z", name: "Zebra profile" },
      { id: "a", name: "alpha profile" },
    ],
  );
  const group = await screen.findByRole("region", {
    name: "Available to import",
  });
  const cards = within(group).getAllByRole("article");
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
    "Agent Alpha",
    "Agent Alpha",
    "Agent beta",
    "Agent Zebra",
  ]);
  expect(
    cards.map((card) => card.querySelector("[data-public-key]")?.textContent),
  ).toEqual(["33", "44", "22", "11"].map((key) => npubEncode(key.repeat(32))));
  const profiles = await screen.findByRole("region", {
    name: "Profiles without identities",
  });
  expect(
    within(profiles)
      .getAllByRole("article")
      .map((card) => card.getAttribute("aria-label")),
  ).toEqual(["Agent alpha profile", "Agent Zebra profile"]);
  expect(within(group).getAllByRole("article")).toHaveLength(4);
});

it("renders four exclusive sections with all setups on one exact-key card", async () => {
  setup("connected", (f) => {
    const here = { ...f.agent };
    f.data.agents.push({
      ...here,
      id: "same-key-other",
      relayUrl: "wss://second.example",
    });
    f.data.agents.push({
      ...here,
      id: "other-key",
      pubkey: "ee".repeat(32),
      relayUrl: "wss://third.example",
    });
    f.data.parked = [
      {
        pubkey: here.pubkey.toUpperCase(),
        name: "Shared",
        sources: ["installed", "development"],
      },
      {
        pubkey: "ff".repeat(32),
        name: "Importable",
        sources: ["installed", "development"],
      },
    ];
  });
  const local = await screen.findByRole("region", {
    name: "Local agents in this community",
  });
  const card = within(local).getByRole("article", { name: "Agent Shared" });
  expect(screen.getAllByRole("article", { name: "Agent Shared" })).toHaveLength(
    1,
  );
  // Each saved setup keeps its own controls, including the one in another community.
  expect(within(card).getAllByRole("button", { name: "Stop" })).toHaveLength(2);
  expect(
    within(card).getByText("Installed Buzz · Development Buzz"),
  ).not.toBeVisible();
  fireEvent.click(
    within(card).queryByText("Identity & sources") ??
      within(card).getByText("Identity & sources"),
  );
  expect(
    within(card).getByText("Installed Buzz · Development Buzz"),
  ).toBeVisible();
  expect(
    within(
      screen.getByRole("region", { name: "Local agents in other communities" }),
    ).getAllByRole("article"),
  ).toHaveLength(1);
  expect(
    within(
      screen.getByRole("region", { name: "Available to import" }),
    ).getByRole("article", { name: "Agent Importable" }),
  ).toBeVisible();
  expect(
    within(
      await screen.findByRole("region", { name: "Relay-only agents" }),
    ).getByRole("article", { name: "Agent Not imported" }),
  ).toBeVisible();
});

it("retains the chosen source when an identity card unmounts and returns", () => {
  const { rows, redraw, onImport } = setup("connected", (f) => {
    f.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Shared source",
        sources: ["installed", "development"],
      },
    ];
  });
  const key = "cd".repeat(32);
  const row = rows.get(key);
  if (!row) throw Error("Missing fixture identity");
  fireEvent.change(screen.getByLabelText("Old Buzz installation"), {
    target: { value: "development" },
  });
  rows.delete(key);
  redraw();
  expect(
    screen.queryByRole("article", { name: "Agent Shared source" }),
  ).toBeNull();
  rows.set(key, row);
  redraw();
  expect(screen.getByLabelText("Old Buzz installation")).toHaveValue(
    "development",
  );
  fireEvent.click(
    within(
      screen.getByRole("article", { name: "Agent Shared source" }),
    ).getByRole("button", { name: "Import" }),
  );
  expect(onImport).toHaveBeenCalledWith(key, "development");
});
