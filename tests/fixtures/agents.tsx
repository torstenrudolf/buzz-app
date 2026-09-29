import { bindNames } from "../../src/features/identity-names/service";
import { agentDirectory } from "../../src/features/identity-names/testing";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentsPage } from "../../src/bundled/agents/AgentsPage";
import { createRelaySession } from "../../src/features/relay/session";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import { keypair, signed } from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";

const fixtureOptions = new URLSearchParams(location.search);
const externalAvatar = fixtureOptions.has("external-avatar");
let artwork = "https://images.example/avatar.png";
const offscreenAvatar = fixtureOptions.has("offscreen-avatar");
const viewer = keypair(),
  relayKey = keypair(),
  agent = keypair(),
  second = keypair();
let archived = false,
  archiveMissing = false,
  clock = 1,
  empty = false,
  fail = false,
  hold = false,
  reads = 0;
const held: (() => void)[] = [];
function owner(scope: string) {
  return createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      archiveAuthority: relayKey.pubkey,
      scope,
      media: (url) =>
        url.startsWith("https://images.example/") ? url : undefined,
      async readAgentLibrary() {
        reads++;
        if (hold) await new Promise<void>((resolve) => held.push(resolve));
        if (fail) throw new Error("fixture failure");
        return empty
          ? { definitions: [], identities: [] }
          : {
              definitions: [
                {
                  id: "brain",
                  name: `${scope} Brain`,
                  avatar: externalAvatar
                    ? artwork
                    : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=",
                },
                { id: "second", name: `${scope} Brain` },
              ],
              identities: [agent, second].map((key) => ({
                pubkey: key.pubkey,
                name: `${scope} Brain identity`,
                definitionId: "brain",
              })),
            };
      },
      async query(filters) {
        reads++;
        if (hold) await new Promise<void>((resolve) => held.push(resolve));
        if (fail) throw new Error("fixture failure");
        if (filters[0]?.kinds?.includes(30177)) return [];
        if (filters[0]?.kinds?.[0] !== 13535)
          throw new Error("Unexpected fixture read");
        return archiveMissing
          ? []
          : [
              signed(relayKey, {
                kind: 13535,
                created_at: ++clock,
                content: "",
                tags: [["-"], ...(archived ? [["p", agent.pubkey]] : [])],
              }),
            ];
      },
    },
    {
      identityNames: {
        register() {},
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [agentDirectory],
            subscribe: () => () => {},
          }),
      },
    },
  );
}
const listeners = new Set<() => void>();
let current = owner("A");
let snapshot: RelaySnapshot = {
  status: "ready",
  scope: "A",
  generation: 1,
  viewer: viewer.pubkey,
  session: current.session,
};
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry() {},
  disconnect() {},
  clearCache: () => current.clearCache(),
};
function change(scope: string) {
  current.dispose();
  current = owner(scope);
  snapshot = {
    ...snapshot,
    scope,
    session: current.session,
    generation: snapshot.generation + 1,
  };
  for (const listener of listeners) listener();
}
function Fixture() {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <nav>
        <button
          type="button"
          onClick={() => {
            archived = !archived;
          }}
        >
          Toggle archive
        </button>
        <button
          type="button"
          onClick={() => {
            archiveMissing = !archiveMissing;
          }}
        >
          Toggle missing archive
        </button>
        <button type="button" onClick={() => setVisible(!visible)}>
          Toggle page
        </button>
        <button
          type="button"
          onClick={() => {
            empty = !empty;
          }}
        >
          Toggle empty
        </button>
        <button
          type="button"
          onClick={() => {
            fail = !fail;
          }}
        >
          Toggle error
        </button>
        <button
          type="button"
          onClick={() => {
            hold = !hold;
          }}
        >
          Toggle hold
        </button>
        <button
          type="button"
          onClick={() => {
            hold = false;
            for (const resolve of held.splice(0)) resolve();
          }}
        >
          Release reads
        </button>
        <button type="button" onClick={() => change("A")}>
          Community A
        </button>
        <button type="button" onClick={() => change("B")}>
          Community B
        </button>
        <button type="button" onClick={() => void current.clearCache()}>
          Clear cache
        </button>
      </nav>
      {offscreenAvatar && <div style={{ height: "20000px" }} />}
      {visible && (
        <main style={{ height: "50vh" }}>
          <AgentsPage relay={relay} />
        </main>
      )}
    </>
  );
}
Object.assign(window, {
  agentFixture: {
    reads: () => reads,
    agents: [agent.pubkey, second.pubkey],
    setArtwork: (url: string) => {
      artwork = url;
    },
  },
});
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
