import type {
  AgentView,
  ControlSnapshot,
  ImportSource,
} from "../../features/agents/control";
import type { AgentLibrary } from "../../features/agents/library";
import { relayOrigin } from "../../features/communities/destination";

/** Canonical secure origin returned by relayOrigin, shared with community routing. */
export type CommunityUrl = string;
export type LocalSetup = AgentView;
type RelayMetadata = AgentLibrary["identities"][number];

export interface AgentInventoryIdentity {
  pubkey: string;
  displayName: string;
  avatar?: string | undefined;
  relayMetadata: RelayMetadata | null;
  /** Previously observed installations; actions must read the selected source again. */
  oldBuzzSources: readonly ImportSource[];
  /** Native record reference, not a private key or a community configuration. */
  localIdentity: { id: string } | null;
  knownCommunities: ReadonlySet<CommunityUrl>;
  localSetups: ReadonlyMap<CommunityUrl, LocalSetup>;
  /** Older imports need explicit setup, even when they have a saved community. */
  unconfiguredSetups: readonly AgentView[];
}

/** Configured setups, the destination's setup first: the card represents that first setup. */
export function localSetups(
  row: AgentInventoryIdentity,
  destination: CommunityUrl,
): LocalSetup[] {
  const here = row.localSetups.get(destination);
  return [
    ...(here ? [here] : []),
    ...[...row.localSetups.values()].filter((setup) => setup !== here),
  ];
}

/** Join public metadata and native-owned facts by key without changing storage. */
export function inventoryIdentities(
  relayIdentities: AgentLibrary["identities"],
  data: Pick<ControlSnapshot, "agents" | "parked">,
  resolveName: (pubkey: string, fallback: string) => string,
): Map<string, AgentInventoryIdentity> {
  const rows = new Map<string, AgentInventoryIdentity>();
  const identity = (pubkey: string, fallback = pubkey.slice(0, 12)) => {
    const key = pubkey.toLowerCase();
    let row = rows.get(key);
    if (!row) {
      row = {
        pubkey: key,
        displayName: resolveName(key, fallback),
        relayMetadata: null,
        oldBuzzSources: [],
        localIdentity: null,
        knownCommunities: new Set(),
        localSetups: new Map(),
        unconfiguredSetups: [],
      };
      rows.set(key, row);
    }
    return row;
  };
  for (const metadata of relayIdentities) {
    const row = identity(metadata.pubkey, metadata.name);
    row.relayMetadata = metadata;
    row.avatar = metadata.avatar;
  }
  // The native transport still calls historical old-Buzz inventory "parked".
  for (const source of data.parked ?? []) {
    const row = identity(source.pubkey, source.name);
    row.displayName = resolveName(row.pubkey, source.name);
    row.oldBuzzSources = [
      ...new Set([...row.oldBuzzSources, ...source.sources]),
    ];
  }
  for (const agent of data.agents) {
    const row = identity(agent.pubkey, agent.name);
    row.localIdentity ??= { id: agent.id };
    const community = agent.relayUrl ? relayOrigin(agent.relayUrl) : "";
    if (community)
      row.knownCommunities = new Set([...row.knownCommunities, community]);
    if (agent.configured === false) {
      row.unconfiguredSetups = [...row.unconfiguredSetups, agent];
      continue;
    }
    if (row.localSetups.has(community)) {
      throw new Error(
        "Duplicate local setup for the same identity and community.",
      );
    }
    row.localSetups = new Map([...row.localSetups, [community, agent]]);
  }
  return rows;
}
