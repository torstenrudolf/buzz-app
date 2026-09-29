import { expect, it } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import { inventoryIdentities } from "./inventory-model";

const name = (_key: string, fallback: string) => fallback;
const here = "https://relay.example.test";

it("joins sources by key, not name, and keeps relay metadata distinct", () => {
  const key = "ab".repeat(32);
  const other = "cd".repeat(32);
  const metadata = {
    pubkey: key,
    name: "Relay",
    definitionId: "profile",
    avatar: "avatar",
  };
  const rows = inventoryIdentities(
    [metadata],
    {
      agents: [],
      parked: [
        { pubkey: key, name: "Same name", sources: ["installed"] },
        {
          pubkey: key.toUpperCase(),
          name: "Same name",
          sources: ["development", "installed"],
        },
        { pubkey: other, name: "Same name", sources: ["development"] },
      ],
    },
    name,
  );
  expect(rows.size).toBe(2);
  expect(rows.get(key)).toMatchObject({
    relayMetadata: metadata,
    avatar: "avatar",
    localIdentity: null,
  });
  expect(rows.get(key)?.oldBuzzSources).toEqual(["installed", "development"]);
  expect(rows.get(key)?.knownCommunities).toEqual(new Set());
  expect(rows.get(other)?.relayMetadata).toBeNull();
});

it("keeps local custody without inventing a setup for an unconfigured import", () => {
  const { agent } = controlFixture();
  const rows = inventoryIdentities(
    [],
    { agents: [{ ...agent, configured: false }] },
    name,
  );
  const row = rows.get(agent.pubkey);
  expect(row?.localIdentity).toEqual({ id: agent.id });
  expect(row?.localSetups.size).toBe(0);
  expect(row?.unconfiguredSetups).toEqual([{ ...agent, configured: false }]);
  // The saved association is evidence, not a configured setup.
  expect(row?.knownCommunities).toEqual(new Set([here]));
});

it("keys configured setups by canonical community while retaining each setup", () => {
  const { agent } = controlFixture();
  const second = { ...agent, id: "second", relayUrl: "https://other.example/" };
  const rows = inventoryIdentities(
    [],
    {
      agents: [
        { ...agent, configured: false },
        { ...agent, id: "configured", relayUrl: "wss://relay.example.test/" },
        second,
      ],
    },
    name,
  );
  expect([...(rows.get(agent.pubkey)?.localSetups.keys() ?? [])]).toEqual([
    here,
    "https://other.example",
  ]);
  expect(rows.get(agent.pubkey)?.localSetups.get("https://other.example")).toBe(
    second,
  );
});

it("does not silently overwrite duplicate normalized community setups", () => {
  const { agent } = controlFixture();
  expect(() =>
    inventoryIdentities(
      [],
      {
        agents: [
          agent,
          { ...agent, id: "duplicate", relayUrl: "wss://relay.example.test/" },
        ],
      },
      name,
    ),
  ).toThrow("Duplicate local setup");
});

it("retains an older local record without silently assigning a missing community", () => {
  const { agent } = controlFixture();
  const legacy = { ...agent, configured: false, relayUrl: "" };
  const row = inventoryIdentities([], { agents: [legacy] }, name).get(
    agent.pubkey,
  );
  expect(row?.unconfiguredSetups).toEqual([legacy]);
  expect(row?.knownCommunities.size).toBe(0);
  expect(row?.localIdentity).toEqual({ id: agent.id });
});
