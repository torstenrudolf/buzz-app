import { expect, it } from "vitest";
import { identityTiles, identityGroups } from "./identity-tiles";
it("shows one tile per visible key and only truly identity-free profiles", () => {
  const library = {
    definitions: [
      { id: "shared", name: "Larry", avatar: "art" },
      { id: "archived", name: "Hidden" },
      { id: "empty", name: "Profile only" },
    ],
    identities: [
      { pubkey: "a", name: "One", definitionId: "shared" },
      { pubkey: "b", name: "Two", definitionId: "shared", avatar: "own" },
      { pubkey: "c", name: "Hidden", definitionId: "archived" },
      { pubkey: "d", name: "Missing", definitionId: "missing" },
      { pubkey: "e", name: "Custom" },
    ],
  };
  const tiles = identityTiles(library, (key) => key === "c");
  expect(tiles.identities.map((row) => row.pubkey)).toEqual([
    "a",
    "b",
    "d",
    "e",
  ]);
  expect(tiles.identities.map((row) => row.avatar)).toEqual([
    "art",
    "own",
    undefined,
    undefined,
  ]);
  expect(tiles.profiles).toEqual([library.definitions[2]]);
});
it("groups visible identities by profile ID, keeping namesakes and missing links distinct", () => {
  const definitions = [
    { id: "one", name: "Larry" },
    { id: "two", name: "Larry" },
    { id: "empty", name: "Empty" },
  ];
  const identities = [
    { pubkey: "a", name: "First", definitionId: "one" },
    { pubkey: "b", name: "Different", definitionId: "one" },
    { pubkey: "c", name: "First", definitionId: "two" },
    { pubkey: "d", name: "First", definitionId: "missing" },
    { pubkey: "e", name: "First", definitionId: "other-missing" },
    { pubkey: "f", name: "Larry" },
  ];
  const tiles = identityTiles(
    { definitions, identities },
    (key) => key === "b",
  );
  expect(identityGroups(definitions, tiles.identities)).toEqual([
    { id: "one", name: "Larry", identities: [identities[0]] },
    { id: "two", name: "Larry", identities: [identities[2]] },
    { id: "missing", name: "Unavailable profile", identities: [identities[3]] },
    {
      id: "other-missing",
      name: "Unavailable profile",
      identities: [identities[4]],
    },
    { id: undefined, name: "No linked profile", identities: [identities[5]] },
  ]);
  expect(identityGroups(definitions, [])).toEqual([]);
});
