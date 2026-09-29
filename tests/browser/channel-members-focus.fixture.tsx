import { useState } from "react";
import { AgentSelection } from "../../src/bundled/channel-templates/TemplateFields";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import { Button } from "../../src/shared/design-system/ui/Button";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { createRoot } from "react-dom/client";
import { ChannelMembersButton } from "../../src/bundled/channels/ChannelMembersDialog";
import { createRelaySession } from "../../src/features/relay/session";
import { matchesEvent } from "../../src/features/relay/projection";
import {
  keypair,
  profile,
  roster,
  signed,
} from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";

const viewer = keypair();
const relay = keypair();
const person = keypair();
const candidates = new URLSearchParams(location.search).has("multiple")
  ? [1, 2, 3].map((index) => ({
      key: keypair(),
      name: `Morgan Field Tester ${index}`,
    }))
  : [{ key: person, name: "Morgan" }];
const candidateProfiles = candidates.map(({ key, name }) =>
  profile(key, { name }),
);
const additions: string[] = [];
const channelId = "11111111-1111-4111-8111-111111111111";
const members = [viewer.pubkey];
let clock = 1700000000;
let publishStarted = () => {};
let releasePublish = () => {};
const published = new Promise<void>((resolve) => {
  publishStarted = resolve;
});
const held = new Promise<void>((resolve) => {
  releasePublish = resolve;
});
const { session } = createRelaySession(
  {
    viewer: viewer.pubkey,
    scope: "https://relay.example.test",
    relayAuthor: relay.pubkey,
    media: () => undefined,
    readAgentLibrary: async () => ({ definitions: [], identities: [] }),
    query: async (filters) => {
      if (filters.some((filter) => filter.search)) return candidateProfiles;
      return [
        roster(relay, channelId, members, clock),
        signed(relay, {
          kind: 39000,
          content: "",
          tags: [
            ["d", channelId],
            ["t", "stream"],
            ["private"],
            ["name", "Design"],
          ],
        }),
        profile(viewer, { name: "Carl" }),
        ...candidateProfiles,
      ].filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
    writer: {
      kinds: [9000],
      sign: async (template) => signed(viewer, template),
      publish: async (event) => {
        const key = event.tags.find(([tag]) => tag === "p")?.[1];
        if (!key) throw new Error("Missing added identity");
        additions.push(key);
        publishStarted();
        await held;
        members.push(key);
        clock++;
      },
    },
  },
  { outboxStorage: { load: () => [], save: () => {} } },
);
session.channels.ensureList();
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
function Fixture() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <ToastProvider>
      <ChannelMembersButton session={session} channelId={channelId} />
      <Button onClick={() => setOpen(true)}>Edit team</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Team">
        <AgentSelection
          session={session}
          selected={selected}
          onChange={setSelected}
          agents={[{ pubkey: person.pubkey, name: "Morgan" }]}
        />
      </Dialog>
    </ToastProvider>
  );
}
createRoot(root).render(<Fixture />);
// The test controls when confirmation arrives; no relay or member is contacted.
Object.assign(window, {
  focusFixture: { published, additions, confirm: () => releasePublish() },
});
