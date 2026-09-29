import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// No broker, credentials or remote writes: real UI/session, ephemeral signed fixture events.
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { ConversationService } from "../../src/features/conversation/service";
import * as emojiPlugin from "../../src/bundled/emoji";
import emojiManifest from "../../src/bundled/emoji/manifest.json";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { MessageRow } from "../../src/features/messages/MessageRow";
import { createRelaySession } from "../../src/features/relay/session";
import { PublishRejected } from "../../src/features/relay/outbox";
import { foldMessages } from "../../src/features/relay/fold";
import { mediaUrl } from "../../src/features/relay/transport";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
} from "../../src/features/relay/testing";
import { matchesEvent } from "../../src/features/relay/projection";
import type { RelayEvent } from "../../src/features/relay/events";
import type { LiveCallbacks } from "../../src/features/relay/live";
import "../../src/shared/styles/globals.css";

const ctx = new Context();
const manager = createPluginManager(ctx, {
  bundled: [
    { manifest: { ...emojiManifest, apiVersion: 1 }, module: emojiPlugin },
  ],
});
const extensions = new ConversationService(ctx);
window.addEventListener("pagehide", () => {
  void manager.dispose();
  void ctx.fiber.dispose();
});
const viewer = keypair(),
  relay = keypair(),
  member = keypair();
const wrap = new URLSearchParams(location.search).has("wrap");
const long = new URLSearchParams(location.search).has("long");
const participantProfiles = new Map([
  [viewer.pubkey, { name: "Fixture Reader" }],
  [member.pubkey, { name: "Fixture Member" }],
]);
const report = {
  publications: [] as { community: string; event: RelayEvent }[],
  reads: [] as string[],
  reactionStarted: false,
};
const sessions = ["a", "b"].map((community) => {
  const origin = `https://${community}.test`;
  let time = 1,
    fail = false,
    rejectReaction = false,
    holdNextReaction: string | null = null;
  let releaseReaction: (() => void) | undefined;
  let live!: LiveCallbacks;
  let catalogRead: Promise<void> | undefined;
  let releaseCatalogRead: (() => void) | undefined;
  const makeSet = (empty = false) =>
    signed(member, {
      kind: 30030,
      created_at: time,
      content: "",
      tags: [
        ["d", "buzz:custom-emoji"],
        ...(empty
          ? []
          : [
              ["emoji", "party", `${origin}/media/${time}.png`],
              ...[62, 63, 64].map((length) => {
                const name = "a".repeat(length);
                return ["emoji", name, `${origin}/media/${name}.png`];
              }),
              ...(community === "a"
                ? [
                    ["emoji", "aonly", `${origin}/media/aonly.png`],
                    ["emoji", "smile", `${origin}/media/smile.png`],
                    ["emoji", "nosource", `${origin}/media/no-source.png`],
                    ["emoji", "broken", `${origin}/media/broken.png`],
                    ["emoji", "grinning", `${origin}/media/grinning.png`],
                    ["emoji", "enjoy", `${origin}/media/enjoy.png`],
                    ["emoji", "party-parrot", `${origin}/media/parrot.png`],
                    ["emoji", "party-parrot-wave", `${origin}/media/wave.png`],
                    [
                      "emoji",
                      "very-long-community-emoji-name-that-does-not-fit",
                      `${origin}/media/long.png`,
                    ],
                  ]
                : []),
            ]),
      ],
    });
  let catalog = makeSet();
  let archiveTime = 10;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: community,
      media: (url) =>
        url.includes("no-source")
          ? undefined
          : mediaUrl(
              url,
              (url) => `/emoji-media/${community}/${encodeURIComponent(url)}`,
              origin,
            ),
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      async query(filters) {
        if (filters[0]?.kinds?.includes(30030)) {
          report.reads.push(community);
          await catalogRead;
          if (fail) throw new Error("Fixture catalog offline");
          return [catalog];
        }
        return [
          roster(relay, "c", [viewer.pubkey], 1),
          metadata(relay, "c", "Test", 1),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      writer: {
        kinds: [5, 7, 9],
        async sign(template) {
          return signed(viewer, template);
        },
        async publish(event) {
          if (holdNextReaction === event.content) {
            holdNextReaction = null;
            report.reactionStarted = true;
            await new Promise<void>((resolve) => {
              releaseReaction = resolve;
            });
            releaseReaction = undefined;
          }
          if ([5, 7].includes(event.kind) && rejectReaction) {
            rejectReaction = false;
            throw new PublishRejected("Fixture reaction rejected");
          }
          report.publications.push({ community, event });
          live.receive([event]);
        },
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owner.session.channels.ensureList();
  const root = message(
    viewer,
    "c",
    "Historic :unknown:party: and https://example.test/:party:",
    1,
    [["emoji", "party", `${origin}/media/original.png`]],
  );
  const reaction = signed(member, {
    kind: 7,
    content: ":party:",
    created_at: 2,
    tags: [
      ["e", root.id],
      ["emoji", "party", `${origin}/media/reaction.png`],
    ],
  });
  const wrapReactions = [
    "👍",
    "❤️",
    "😂",
    "🎉",
    "👀",
    "🔥",
    "🙌",
    "😮",
    "🤔",
    "👏",
  ].map((content, index) =>
    signed(member, {
      kind: 7,
      content,
      created_at: 5 + index,
      tags: [["e", root.id]],
    }),
  );
  const ownReaction = signed(viewer, {
    kind: 7,
    content: "✅",
    created_at: 15,
    tags: [["e", root.id]],
  });
  const longReactions = long
    ? [
        signed(member, {
          kind: 7,
          content: "f".repeat(64),
          created_at: 16,
          tags: [["e", root.id]],
        }),
        signed(member, {
          kind: 7,
          content: `:${"a".repeat(64)}:`,
          created_at: 17,
          tags: [
            ["e", root.id],
            ["emoji", "a".repeat(64), `${origin}/media/no-source.png`],
          ],
        }),
      ]
    : [];
  const broken = message(viewer, "c", "Broken :missing:", 2, [
    ["emoji", "missing", "javascript:bad"],
  ]);
  const unloaded = message(viewer, "c", "Unloadable :broken:", 3, [
    ["emoji", "broken", `${origin}/media/broken.png`],
  ]);
  const single = message(viewer, "c", ":party:", 4, [
    ["emoji", "party", `${origin}/media/1.png`],
  ]);
  const table = message(
    viewer,
    "c",
    "| State | Owner | Count | Tail |\n| --- | --- | --- | --- |\n| :party: | | 12 | |\n| | lead | | end |",
    5,
    [["emoji", "party", `${origin}/media/table.png`]],
  );
  const blocks = message(
    viewer,
    "c",
    "> Quote :party:\n\n```text\ncode\n```",
    6,
    [["emoji", "party", `${origin}/media/blocks.png`]],
  );
  owner.session.channels.ensure("c");
  live.receive([root, broken, unloaded, single, table, blocks]);
  live.receive([
    reaction,
    ...(wrap ? [...wrapReactions, ownReaction] : []),
    ...longReactions,
  ]);
  return {
    ...owner,
    community,
    root,
    rows: foldMessages("c", relay.pubkey, [
      root,
      reaction,
      ...(wrap ? [...wrapReactions, ownReaction] : []),
      ...longReactions,
      broken,
      unloaded,
      single,
      table,
      blocks,
    ]),
    replace(empty = false) {
      time++;
      catalog = makeSet(empty);
      live.receive([catalog]);
    },
    fail(value: boolean) {
      fail = value;
    },
    holdCatalog() {
      if (catalogRead) throw new Error("Catalog read already held");
      catalogRead = new Promise<void>((resolve) => {
        releaseCatalogRead = resolve;
      });
    },
    releaseCatalog() {
      releaseCatalogRead?.();
      catalogRead = undefined;
      releaseCatalogRead = undefined;
    },
    rejectReaction() {
      rejectReaction = true;
    },
    holdNextReaction(content: string) {
      report.reactionStarted = false;
      holdNextReaction = content;
    },
    releaseReaction() {
      releaseReaction?.();
    },
    operations() {
      return owner.session.outbox?.snapshot().length ?? 0;
    },
    archive(value: boolean) {
      live.receive([
        signed(relay, {
          kind: 39002,
          created_at: archiveTime,
          content: "",
          tags: [
            ["d", "c"],
            ["p", viewer.pubkey],
          ],
        }),
        signed(relay, {
          kind: 39000,
          created_at: archiveTime++,
          content: "",
          tags: [["d", "c"], ...(value ? [["archived", "true"]] : [])],
        }),
      ]);
    },
  };
});
Object.assign(window, {
  emojiFixture: {
    report,
    replace: () => sessions[0]?.replace(),
    remove: () => sessions[0]?.replace(true),
    fail: (value: boolean) => sessions[0]?.fail(value),
    rejectReaction: () => sessions[0]?.rejectReaction(),
    holdNextReaction: (content: string) =>
      sessions[0]?.holdNextReaction(content),
    releaseReaction: () => sessions[0]?.releaseReaction(),
    operations: () => sessions[0]?.operations(),
    refresh: () => sessions[0]?.session.emoji.refresh(),
    holdCatalog: () => sessions[0]?.holdCatalog(),
    releaseCatalog: () => sessions[0]?.releaseCatalog(),
    remount: () => window.dispatchEvent(new Event("emoji-remount")),
    archive: (value: boolean) => sessions[0]?.archive(value),
    status: (community: string) =>
      sessions
        .find((item) => item.community === community)
        ?.session.emoji.snapshot().status,
  },
});
function Fixture() {
  const [selected, select] = useState(0),
    [thread, setThread] = useState(false),
    [messageRevision, setMessageRevision] = useState(0);
  useEffect(() => {
    const remount = () => setMessageRevision((revision) => revision + 1);
    window.addEventListener("emoji-remount", remount);
    return () => window.removeEventListener("emoji-remount", remount);
  }, []);
  const item = sessions[selected];
  const liveRows = useSyncExternalStore(
    (callback) =>
      item ? item.session.channels.subscribeWindow("c", callback) : () => {},
    () => item?.session.channels.window("c"),
  );
  if (!item) return null;
  return (
    <main
      style={{
        width: new URLSearchParams(location.search).has("narrow") ? 300 : 800,
        maxWidth: "100%",
        overflow: "hidden",
        margin: "20px auto",
      }}
    >
      <button type="button" onClick={() => select(selected === 0 ? 1 : 0)}>
        Switch community
      </button>
      <button type="button" onClick={() => setThread(!thread)}>
        Toggle thread
      </button>
      <h1>Community {item.community}</h1>

      <section key={`${selected}/${messageRevision}`}>
        {(new URLSearchParams(location.search).has("reactions")
          ? (liveRows?.rows ?? [])
          : item.rows
        ).map((row) => (
          <MessageRow
            extensions={extensions}
            key={row.id}
            row={row}
            session={item.session}
            scope={item.community}
            profile={{ name: "Fixture Reader" }}
            participantProfiles={participantProfiles}
            media={item.session.media}
            onOpenLink={() => false}
            day={false}
            retry={undefined}
          />
        ))}
      </section>
      <MessageComposer
        extensions={extensions}
        session={item.session}
        scope={item.community}
        channelId="c"
        channelName="general"
        {...(thread ? { threadRootId: item.root.id } : {})}
      />
    </main>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
createRoot(container).render(
  <ToastProvider>
    <Fixture />
  </ToastProvider>,
);
