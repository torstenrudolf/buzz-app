import { expect, it } from "vitest";
import {
  profileAgentHint,
  profileKey,
  profilePanelKey,
  profileTarget,
} from "./target";
it("round-trips only exact public identity locators", () => {
  const key = "ab".repeat(32);
  const target = profileTarget(key);
  expect(target).toMatch(/^nostr:npub1/);
  expect(profileKey(target ?? "")).toBe(key);
  expect(profilePanelKey(target ?? "")).toBe(key);
  expect(profileTarget(key.toUpperCase())).toBe(target);
  for (const invalid of ["", "author", "a".repeat(63), "g".repeat(64)])
    expect(profileTarget(invalid)).toBeUndefined();
  for (const invalid of [
    "nostr:nsec1abc",
    `${target}?relay=wss://evil.test`,
    `${target}/`,
    `${target}x`,
    key,
    "nostr:npub1abc",
  ])
    expect(profileKey(invalid)).toBeUndefined();
});

it("keeps agent appearance in an exact app-local target without changing public links", () => {
  const key = "ab".repeat(32);
  const target = profileTarget(key.toUpperCase(), { agent: true });
  expect(target).toBe(`buzz:agent-profile:${key}`);
  expect(profilePanelKey(target ?? "")).toBe(key);
  expect(profileKey(target ?? "")).toBeUndefined();
  expect(profileAgentHint(target ?? "")).toBe(true);
  expect(profileAgentHint(profileTarget(key) ?? "")).toBe(false);
  expect(profileTarget(key, { agent: false })).toBe(profileTarget(key));
  for (const invalid of [
    "buzz:agent-profile:",
    `${target}?owner=true`,
    `${target}/`,
    `${target}x`,
    `buzz:agent-profile:${"g".repeat(64)}`,
  ]) {
    expect(profileKey(invalid)).toBeUndefined();
    expect(profilePanelKey(invalid)).toBeUndefined();
    expect(profileAgentHint(invalid)).toBe(false);
  }
});
