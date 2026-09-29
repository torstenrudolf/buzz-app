import type { AgentLibrary } from "../../features/agents/library";

export function identityTiles(
  library: AgentLibrary,
  archived: (key: string) => boolean,
) {
  const definitions = new Map(library.definitions.map((row) => [row.id, row]));
  const linked = new Set(library.identities.map((row) => row.definitionId));
  const identities = [
    ...new Map(
      library.identities.map((row) => [row.pubkey.toLowerCase(), row]),
    ).values(),
  ]
    .filter((row) => !archived(row.pubkey))
    .map((row) => {
      const avatar =
        row.avatar ?? definitions.get(row.definitionId ?? "")?.avatar;
      return { ...row, ...(avatar ? { avatar } : {}) };
    });
  return {
    identities,
    profiles: library.definitions.filter((row) => !linked.has(row.id)),
  };
}

/** Group visible tiles by explicit profile link, never by display-name equality. */
export function identityGroups(
  definitions: AgentLibrary["definitions"],
  identities: ReturnType<typeof identityTiles>["identities"],
) {
  const profiles = new Map(definitions.map((row) => [row.id, row]));
  const groups = new Map<
    string | undefined,
    {
      id: string | undefined;
      name: string;
      identities: ReturnType<typeof identityTiles>["identities"];
    }
  >();
  for (const identity of identities) {
    const id = identity.definitionId;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: id
          ? profiles.get(id)?.name || "Unavailable profile"
          : "No linked profile",
        identities: [],
      };
      groups.set(id, group);
    }
    group.identities.push(identity);
  }
  return [...groups.values()];
}
