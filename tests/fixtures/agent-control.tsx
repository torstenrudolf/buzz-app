import { finalizeEvent, getPublicKey } from "nostr-tools";
import { Context } from "@deepseek-ai/cordis";
import { createCommunities } from "../../src/features/communities/service";
import { ProfileButton } from "../../src/app/shell/ProfileButton";
import type { AccountActionsService } from "../../src/features/account-actions/service";
import { ProfileSettings } from "../../src/app/ProfileSettings";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { communityDestination } from "../../src/features/communities/destination";
import { avatarMediaFixture } from "./avatar-media";
import { useState, useSyncExternalStore } from "react";
import { createNavigationController } from "../../src/features/navigation/controller";
import { createMemoryHistory } from "../../src/features/navigation/history";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { createRoot } from "react-dom/client";
import { AgentsPage } from "../../src/bundled/agents/AgentsPage";
import { createRelaySession } from "../../src/features/relay/session";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import { createAgentControl } from "../../src/features/agents/control";
import { controlFixture } from "../../src/features/agents/control-testing";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

const avatarPreviewMode = new URLSearchParams(location.search).has("avatars");
// Deliberately public test key, never an account credential.
const profileKey = new Uint8Array(32).fill(7);
const profileViewer = getPublicKey(profileKey);
const profiles = new Map<string, ReturnType<typeof finalizeEvent>>();
for (const id of ["https://relay.example.test", "https://other.example.test"]) {
  profiles.set(
    id,
    finalizeEvent(
      {
        kind: 0,
        tags: [],
        created_at: 1,
        content: JSON.stringify({
          name: "Fixture human",
          about: "This field must survive avatar editing.",
          picture: "",
        }),
      },
      profileKey,
    ),
  );
}
if (avatarPreviewMode)
  localStorage.setItem(
    `buzz-client.v1:${profileViewer}`,
    JSON.stringify({
      profile: { name: "Local default", picture: "" },
      memberships: [
        { id: "https://relay.example.test", name: "Fixture community" },
        { id: "https://other.example.test", name: "Other community" },
      ],
      selected: "https://relay.example.test",
    }),
  );
const media = avatarMediaFixture();
const networkFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  const upload = await media.request(url, init);
  if (upload) return upload;
  if (url.endsWith("/register"))
    return Response.json(
      communityDestination(JSON.parse(String(init?.body)).url),
    );
  const id = decodeURIComponent(url.split("/")[3] ?? "");
  if (url.endsWith("/identity"))
    return Response.json({ viewer: profileViewer });
  if (url.endsWith("/info")) return Response.json({ name: id, policy: null });
  if (url.endsWith("/session"))
    return Response.json({
      viewer: profileViewer,
      relayAuthor: "ef".repeat(32),
      relayUrl: id,
      attachmentUploads: true,
    });
  if (url.endsWith("/query")) {
    const filters = JSON.parse(String(init?.body)) as { kinds?: number[] }[];
    return Response.json(
      filters.some((filter) => filter.kinds?.includes(0)) && profiles.has(id)
        ? [profiles.get(id)]
        : [],
    );
  }
  if (url.endsWith("/profile")) {
    const { name, picture, about, existing } = JSON.parse(String(init?.body));
    const event = finalizeEvent(
      {
        kind: 0,
        tags: [],
        created_at: (profiles.get(id)?.created_at ?? 0) + 1,
        content: JSON.stringify({
          ...existing,
          name,
          display_name: name,
          picture,
          about,
        }),
      },
      profileKey,
    );
    profiles.set(id, event);
    return Response.json({ accepted: true, event_id: event.id });
  }
  // Inventory reads stay on the network so browser tests can route them.
  if (url.endsWith("/agent-inventory")) return networkFetch(input, init);
  throw new Error(`Unexpected fixture request: ${url}`);
};
// Only this fixture rewrites image display to local blobs; production stores raw URLs.
const imageObserver = new MutationObserver(() => {
  for (const image of document.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (!src.startsWith("/api/relay/")) continue;
    const file = media.display(
      new URL(src, location.origin).searchParams.get("url") ?? "",
    );
    if (file) image.src = URL.createObjectURL(file);
  }
});
imageObserver.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["src"],
});
const fixture = controlFixture();
// Browser journeys start with an explicitly manual-start agent. The shared
// control fixture remains explicit-on for the profile preference tests.
fixture.agent.startOnAppLaunch = false;
const modelCalls: string[] = [];
let modelMode = "success";
let releaseModels: (() => void) | undefined;
fixture.host.models = {
  begin: async () => {
    modelCalls.push("begin");
    return modelCalls.length;
  },
  cancel: async () => {
    modelCalls.push("cancel");
    releaseModels?.();
  },
  run: async (_ticket, request) => {
    modelCalls.push(request.action);
    if (modelMode === "wait")
      await new Promise<void>((resolve) => {
        releaseModels = resolve;
      });
    if (modelMode === "error") throw "Synthetic connection failure.";
    return {
      host: request.host,
      models:
        modelMode === "empty" || request.action === "disconnect"
          ? []
          : [
              { id: "catalog.schema.real-model", name: "Friendly Model" },
              { id: "endpoint-two", name: "Other Model" },
              ...(modelMode === "many"
                ? Array.from({ length: 18 }, (_, index) => ({
                    id: `endpoint-${index + 3}`,
                    name: `Catalog Model ${index + 3}`,
                  }))
                : []),
            ],
      modelOverridden: false,
      disconnected: request.action === "disconnect",
    };
  },
};
const control = createAgentControl(fixture.host);
const noActions: readonly [] = [];
const accountActions = {
  subscribe: () => () => {},
  snapshot: () => noActions,
} as unknown as AccountActionsService;
const communities = avatarPreviewMode
  ? createCommunities(new Context(), true)
  : undefined;
Object.assign(window, { avatarProfileFixture: { profiles, communities } });
const viewer = "de".repeat(32);
const scope = `https://relay.example.test:${viewer}`;
const channelId = "11111111-1111-4111-8111-111111111111";
const session = createRelaySession({
  viewer: "de".repeat(32),
  relayAuthor: "ef".repeat(32),
  scope: "https://relay.example.test",
  writer: {
    kinds: [9],
    async sign() {
      throw new Error("This preview cannot sign or send messages.");
    },
    async publish() {
      throw new Error("This preview cannot publish messages.");
    },
  },
  async readAgentLibrary() {
    return {
      definitions: [
        { id: "fixture", name: fixture.agent.name },
        { id: "unlinked", name: "Library only" },
      ],
      identities: [
        {
          pubkey: fixture.agent.pubkey,
          name: fixture.agent.name,
          definitionId: "fixture",
        },
      ],
    };
  },
  async query(filters) {
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      return [
        {
          id: "12".repeat(32),
          pubkey: "ef".repeat(32),
          kind: 39002,
          created_at: 1,
          content: "",
          tags: [
            ["d", channelId],
            ["p", viewer],
            ["p", fixture.agent.pubkey],
          ],
        },
        {
          id: "13".repeat(32),
          pubkey: "ef".repeat(32),
          kind: 39000,
          created_at: 1,
          content: JSON.stringify({ name: "shared-fixture" }),
          tags: [
            ["d", channelId],
            ["t", "stream"],
          ],
        },
      ];
    return [];
  },
  media: () => undefined,
});
const relaySnapshot: RelaySnapshot = {
  status: "ready",
  scope,
  viewer,
  generation: 1,
  session: session.session,
};
const relay: RelayData = {
  snapshot: () => relaySnapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: async () => {},
};
Object.assign(window, {
  agentModelsFixture: {
    calls: modelCalls,
    mode: (value: string) => {
      modelMode = value;
    },
    release: () => releaseModels?.(),
  },
});
Object.assign(window, { agentControlFixture: { ...fixture, control } });
const navigationHost = createNavigationController(createMemoryHistory());
navigationHost.complete(navigationHost.navigation.snapshot().attempt, {
  status: "opened",
});
navigationHost.navigation.subscribe(() => {
  const state = navigationHost.navigation.snapshot();
  if (state.status === "opening")
    navigationHost.complete(state.attempt, { status: "opened" });
});
function Fixture() {
  useKeyboardFocusVisibility();
  const [shown, setShown] = useState(true);
  const [human, setHuman] = useState(false);
  const route = useSyncExternalStore(
    navigationHost.navigation.subscribe,
    navigationHost.navigation.snapshot,
  );
  const inChannel = route.entry.target.kind === "conversation";
  const [failure, setFailure] = useState(false);
  const [uploadFailure, setUploadFailure] = useState(false);
  const [profileFailure, setProfileFailure] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [unavailable] = useState(() => createAgentControl(null));
  return (
    <main
      data-buzz-ui=""
      className="mx-auto max-w-4xl space-y-4 p-4 text-body text-primary"
    >
      <header className="space-y-3 rounded-xl bg-panel p-4">
        {communities && (
          <ProfileButton
            communities={communities}
            accountActions={accountActions}
            settingsSelected={human}
            onSettings={() => setHuman(true)}
          />
        )}
        <h1 className="text-heading">Agent editor · Isolated fixture</h1>
        <p className="text-secondary">
          Temporary, in-memory identities only. No Keychain, real libraries,
          relay connection, or agent processes. All Start/Stop and import
          actions here are simulated. Reload resets changes; use sample values
          only.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setShown(!shown)}>Toggle page</Button>
          {communities && (
            <Button onClick={() => setHuman(!human)}>
              {human ? "Edit agents" : "Edit human profile"}
            </Button>
          )}
          <Button
            onClick={() => {
              media.reject(!uploadFailure);
              setUploadFailure(!uploadFailure);
            }}
          >
            {uploadFailure ? "Allow uploads" : "Reject uploads"}
          </Button>
          <Button
            onClick={() => {
              fixture.failProfile(!profileFailure);
              setProfileFailure(!profileFailure);
            }}
          >
            {profileFailure ? "Allow publication" : "Reject publication"}
          </Button>
          <Button
            onClick={() => {
              fixture.failSave(!failure);
              setFailure(!failure);
            }}
          >
            {failure ? "Allow saves" : "Reject saves"}
          </Button>
          <Button
            onClick={() => {
              fixture.agent.revision++;
              void control.refresh();
            }}
          >
            Simulate newer revision
          </Button>
          <Button
            onClick={() => {
              fixture.data.runtimeAvailable = !fixture.data.runtimeAvailable;
              void control.refresh();
            }}
          >
            Toggle runtime availability
          </Button>
          <Button onClick={() => setBrowser(!browser)}>
            Toggle browser-only mode
          </Button>
          <Button
            onClick={() => {
              const root = document.documentElement;
              root.dataset.colorMode =
                root.dataset.colorMode === "dark" ? "light" : "dark";
            }}
          >
            Toggle appearance
          </Button>
        </div>
      </header>
      {human && communities ? (
        <section className="rounded-xl bg-surface-panel p-6">
          <ProfileSettings
            key={communities.snapshot().selected ?? "local"}
            communities={communities}
            community={communities
              .snapshot()
              .memberships.find(
                (item) => item.id === communities.snapshot().selected,
              )}
          />
        </section>
      ) : shown && inChannel ? (
        <section aria-label="Fixture channel" className="space-y-3 p-4">
          <Button
            onClick={() =>
              void navigationHost.navigation.open({ version: 1, kind: "home" })
            }
          >
            Back to Agents
          </Button>
          <h2>#shared-fixture · No publication transport</h2>
          <MessageComposer
            session={session.session}
            scope={scope}
            channelId={channelId}
            channelName="shared-fixture"
            disabled
          />
        </section>
      ) : (
        shown && (
          <AgentsPage
            relay={relay}
            key={browser ? "browser" : "native"}
            control={browser ? unavailable : control}
          />
        )
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <ToastProvider>
      <Fixture />
    </ToastProvider>,
  );
