import { fixtureRelayUrl, fixtureAliases } from "../relay-config.ts";
import { test as base, expect } from "@playwright/test";
import { preview } from "vite";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { relayBrokerPlugin } from "../../dev/relay-broker.mjs";
import { policyRelay } from "./policy-relay.mjs";
import { buildApp } from "./build.mjs";
import { fixtureBody } from "./fixture-body.mjs";
import { watchPageErrors } from "./page-errors.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const channels = ["alpha", "beta"];
export const historySize = 640;

// The built app, React, services, verification, IndexedDB and Virtua stay real.
// Layout journeys use synthetic broker HTTP; live journeys retain the production
// broker/subscriber and model only the upstream relay policy with ephemeral keys.
export const test = base.extend({
  productionBroker: [false, { option: true }],
  actionProfile: [false, { option: true }],
  profilePicture: ["", { option: true }],
  readState: [false, { option: true }],
  threadUnread: [false, { option: true }],
  presenceThreadAuthors: [0, { option: true }],
  threadUnreadMentions: [false, { option: true }],
  exactMessages: [false, { option: true }],
  openSearch: [false, { option: true }],
  sessionChannels: [[], { option: true }],
  sessionParents: [{}, { option: true }],
  sidebarUnread: [false, { option: true }],
  savedSidebar: [false, { option: true }],
  personalSidebar: [false, { option: true }],
  sortingSidebar: [false, { option: true }],
  initialSidebarSort: [{}, { option: true }],
  channelLifecycle: [false, { option: true }],
  lifecycleRole: ["owner", { option: true }],
  lifecycleOwnerAgent: [false, { option: true }],
  lifecycleVisibility: [{ archived: [], hidden: [] }, { option: true }],
  sidebarIcons: [false, { option: true }],
  channelNames: [{}, { option: true }],
  expectedPageFailure: [false, { option: true }],
  largeSidebar: [false, { option: true }],
  iconCongestion: [false, { option: true }],
  dmLabels: [false, { option: true }],
  agentPeers: [false, { option: true }],
  tallMessages: [false, { option: true }],
  membershipActivity: [false, { option: true }],
  historyCounts: [{ alpha: 1, beta: 1 }, { option: true }],
  channelIds: [channels, { option: true }],
  developmentReact: [false, { option: true, scope: "worker" }],
  pluginFixtures: [false, { option: true, scope: "worker" }],
  compiledApp: [buildApp, { scope: "worker" }],
  app: async (
    {
      page,
      context,
      browserName,
      browser,
      productionBroker,
      actionProfile,
      profilePicture,
      readState,
      threadUnread,
      presenceThreadAuthors,
      threadUnreadMentions,
      exactMessages,
      openSearch,
      sessionChannels,
      sessionParents,
      sidebarUnread,
      savedSidebar,
      personalSidebar,
      sortingSidebar,
      initialSidebarSort,
      channelLifecycle,
      lifecycleRole,
      lifecycleOwnerAgent,
      lifecycleVisibility,
      sidebarIcons,
      channelNames,
      expectedPageFailure,
      largeSidebar,
      iconCongestion,
      dmLabels,
      agentPeers,
      tallMessages,
      membershipActivity,
      historyCounts,
      channelIds: channels,
      pluginFixtures,
      developmentReact,
      compiledApp,
    },
    use,
    testInfo,
  ) => {
    const key = (seed) =>
      actionProfile
        ? Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? seed : 0))
        : generateSecretKey();
    const relayKey = key(1);
    const typingKeys = [key(2), key(3)];
    const userKey = key(4);
    const viewer = getPublicKey(userKey);
    const membershipKeys = membershipActivity
      ? [generateSecretKey(), generateSecretKey()]
      : [];
    const membershipEvent = (
      type,
      targetIndex,
      time,
      actorIndex = -1,
      forged = false,
    ) =>
      sign(
        40099,
        [["h", channels[0]]],
        JSON.stringify({
          type,
          actor:
            actorIndex < 0 ? viewer : getPublicKey(membershipKeys[actorIndex]),
          target: getPublicKey(membershipKeys[targetIndex]),
        }),
        forged ? userKey : relayKey,
        time,
      );
    const peerKeys =
      dmLabels || readState || exactMessages || actionProfile
        ? [key(5), ...(dmLabels ? [key(6), key(7)] : [])]
        : [];
    const peerKey = peerKeys[0];
    const communityIds = {
      primary: "01234567-89ab-cdef-0123-456789abcdef",
      secondary: "11234567-89ab-cdef-0123-456789abcdef",
    };
    const readEvents = new Map([
      ["primary", new Map()],
      ["secondary", new Map()],
    ]);
    const sign = (
      kind,
      tags,
      content = "",
      key = relayKey,
      time = 1700000000,
    ) => finalizeEvent({ kind, tags, content, created_at: time }, key);
    const profiles = new Map(
      ["primary", "secondary"].map((community) => [
        community,
        sign(
          0,
          [],
          JSON.stringify({ name: "Fixture Reader", picture: profilePicture }),
          userKey,
        ),
      ]),
    );
    // Kind 0 by author for keys a test creates; served on later profile reads.
    const servedProfiles = new Map();
    const ownerAgentKey = lifecycleOwnerAgent ? generateSecretKey() : undefined;
    const ownerAgent = ownerAgentKey ? getPublicKey(ownerAgentKey) : undefined;
    const ownerAgentProfile = ownerAgentKey
      ? sign(
          0,
          [
            [
              "auth",
              viewer,
              "",
              bytesToHex(
                schnorr.sign(
                  createHash("sha256")
                    .update(`nostr:agent-auth:${ownerAgent}:`)
                    .digest(),
                  userKey,
                ),
              ),
            ],
          ],
          JSON.stringify({ name: "Owner Agent", is_agent: true }),
          ownerAgentKey,
        )
      : undefined;
    const participants = largeSidebar
      ? Array.from({ length: 1001 }, (_, i) =>
          (i + 1).toString(16).padStart(64, "0"),
        )
      : peerKeys.map(getPublicKey);
    const dmIds = largeSidebar
      ? Array.from(
          { length: 128 },
          (_, i) => `dm-${i.toString().padStart(3, "0")}`,
        )
      : dmLabels
        ? ["dm-peer", "dm-group"]
        : [];
    const personalChannel = "11111111-1111-4111-8111-111111111111";
    const sortingIds = sortingSidebar ? ["cedar", "maple", "willow"] : [];
    const renamedChannels = new Map();
    const lifecycleRows = channelLifecycle
      ? [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Lifecycle channel",
            type: "stream",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Lifecycle DM",
            type: "dm",
          },
        ]
      : [];
    const archivedIds = new Set(lifecycleVisibility.archived);
    const hiddenDmIds = new Set(lifecycleVisibility.hidden);
    let lifecycleTime = 1700000001;
    const rosterIds = [
      ...new Set([
        ...channels,
        ...(personalSidebar ? [personalChannel] : []),
        ...dmIds,
        ...sortingIds,
        ...lifecycleRows.map((row) => row.id),
        ...Object.values(sessionParents),
      ]),
    ];
    if (savedSidebar) {
      const key = nip44.v2.utils.getConversationKey(userKey, viewer);
      for (const community of ["primary", "secondary"]) {
        const records = readEvents.get(community);
        for (const [coordinate, value] of [
          [
            "channel-sections",
            {
              version: 1,
              sections: [
                {
                  id: "work",
                  name: "Work",
                  order: 0,
                  ...(sidebarIcons ? { icon: ":stamp:" } : {}),
                },
                ...(sidebarIcons
                  ? [
                      {
                        id: "missing",
                        name: "Unavailable",
                        order: 1,
                        icon: ":unavailable_icon:",
                      },
                      { id: "laptop", name: "Laptop", order: 2, icon: "👨‍💻" },
                    ]
                  : []),
              ],
              assignments: { beta: "work" },
            },
          ],
          [
            "channel-stars",
            {
              version: 1,
              channels: { alpha: { starred: true, updatedAt: 1 } },
            },
          ],
          ["channel-sort", { version: 1, groups: initialSidebarSort }],
        ]) {
          records.set(
            coordinate,
            sign(
              30078,
              [["d", coordinate]],
              nip44.v2.encrypt(JSON.stringify(value), key),
              userKey,
            ),
          );
        }
      }
    }
    if (personalSidebar) {
      for (const community of ["primary", "secondary"]) {
        const scope = JSON.parse(fixtureAliases)[community];
        const coordinate = `buzz-channel-kit-v1:${encodeURIComponent(scope)}:groups:personal`;
        const record = {
          version: 1,
          community: scope,
          deleted: false,
          value: {
            type: "groups",
            id: "personal",
            groups: [
              {
                id: "personal-work",
                name: "Personal work",
                defaultTemplateId: "template",
              },
            ],
            assignments: { [personalChannel]: "personal-work" },
          },
        };
        readEvents.get(community).set(
          coordinate,
          sign(
            30078,
            [
              ["d", coordinate],
              ["t", "buzz-channel-kit-v1"],
            ],
            nip44.v2.encrypt(
              JSON.stringify(record),
              nip44.v2.utils.getConversationKey(userKey, viewer),
            ),
            userKey,
          ),
        );
      }
    }
    const hiddenChannels = new Set();
    const streams = new Map();
    const streamOwners = new Map();
    // Tall histories leave room above the older-page prefetch threshold, even
    // with the compact message type and an extra upward resize-test gesture.
    const histories = new Map();
    for (const community of ["primary", "secondary"])
      for (const parent of Object.values(sessionParents))
        histories.set(`${community}/${parent}`, []);
    if (personalSidebar)
      for (const community of ["primary", "secondary"])
        histories.set(`${community}/${personalChannel}`, []);
    const historyStarted = performance.now();
    for (const community of ["primary", "secondary"])
      for (const channel of channels)
        histories.set(
          `${community}/${channel}`,
          Array.from({ length: historyCounts[channel] }, (_, i) =>
            sign(
              9,
              [["h", channel]],
              `${community} ${channel} message ${i}\n${"Mixed height message content. ".repeat((1 + (i % 7) * 3) * (tallMessages ? 5 : 1))}`,
              readState ? peerKey : userKey,
              1700000100 + i,
            ),
          ),
        );
    const historyDurationMs = performance.now() - historyStarted;
    for (const community of ["primary", "secondary"])
      for (const id of [...dmIds, ...lifecycleRows.map((row) => row.id)])
        histories.set(`${community}/${id}`, []);
    for (const community of ["primary", "secondary"])
      for (const [index, id] of sortingIds.entries())
        histories.set(`${community}/${id}`, [
          sign(
            9,
            [["h", id]],
            `Activity in ${id}`,
            userKey,
            1700000200 + index,
          ),
        ]);
    const targetEvents = [];
    let searchTarget;
    if (openSearch) {
      const root = sign(
        9,
        [["h", "open"]],
        "Public conversation root",
        userKey,
        1699999000,
      );
      searchTarget = sign(
        9,
        [
          ["h", "open"],
          ["e", root.id, "", "reply"],
        ],
        "crew-search exact public reply",
        userKey,
        1699999001,
      );
      histories.set("primary/open", [root]);
      targetEvents.push(searchTarget);
    }
    let exact;
    if (exactMessages) {
      const root = histories.get("primary/alpha")[2];
      const replies = Array.from({ length: 80 }, (_, i) =>
        sign(
          9,
          [
            ["h", "alpha"],
            ["e", root.id, "", "reply"],
            ["p", getPublicKey(peerKey)],
          ],
          `Old thread reply ${i} · Hello @Alice Fixture`,
          userKey,
          root.created_at + i + 1,
        ),
      );
      if (exactMessages === "nested") {
        const last = replies.at(-1);
        replies[replies.length - 1] = sign(
          9,
          [
            ["h", "alpha"],
            ["e", root.id, "", "root"],
            ["e", replies.at(-2).id, "", "reply"],
            ["p", getPublicKey(peerKey)],
          ],
          last.content,
          userKey,
          last.created_at,
        );
      }
      const target = replies.at(-1);
      const edit = sign(
        40003,
        [["e", target.id]],
        "**Exact reply edited** · Hello @Alice Fixture",
        userKey,
        target.created_at + 1,
      );
      const reaction = sign(
        7,
        [["e", target.id]],
        "+",
        userKey,
        target.created_at + 2,
      );
      const deletion = sign(
        5,
        [["e", reaction.id]],
        "",
        userKey,
        target.created_at + 3,
      );
      targetEvents.push(...replies, edit, reaction, deletion);
      exact = { root, target, replies, edit, reaction, deletion };
    }
    if (membershipActivity) {
      const history = histories.get(`primary/${channels[0]}`);
      history.push(
        membershipEvent("member_joined", 0, 1700000740),
        membershipEvent("member_joined", 1, 1700000741),
      );
    }
    if (sidebarUnread) {
      for (const id of ["dm-030", "dm-090"])
        histories.set(`primary/${id}`, [
          sign(9, [["h", id]], `Unread in ${id}`, peerKey, 1700000900),
        ]);
    }
    // Opt-in upstream thread evidence: no client cache/read-state injection.
    // Uppercase signed references exercise canonical thread/unread parity.
    const threadReplies = new Map(
      exact ? [[exact.root.id, exact.replies]] : [],
    );
    if (searchTarget)
      threadReplies.set(searchTarget.tags.find(([key]) => key === "e")[1], [
        searchTarget,
      ]);
    const threadSummaries = [];
    if (threadUnread) {
      const history = histories.get("primary/alpha");
      for (const [index, event] of history.slice(-2).entries()) {
        const root = sign(
          9,
          [["h", "alpha"]],
          `Thread root ${index}`,
          peerKey,
          event.created_at,
        );
        history[history.length - 2 + index] = root;
        const replies = [
          sign(
            9,
            [
              ["h", "alpha"],
              ["e", root.id.toUpperCase(), "", "reply"],
              ...(threadUnreadMentions && index === 1 ? [["p", viewer]] : []),
            ],
            `Unread reply ${index}`,
            peerKey,
            root.created_at + 10,
          ),
        ];
        threadReplies.set(root.id, replies);
        threadSummaries.push(
          sign(
            39005,
            [
              ["h", "alpha"],
              ["e", root.id],
              ["d", root.id],
            ],
            JSON.stringify({
              reply_count: 23,
              participants: [getPublicKey(peerKey)],
            }),
          ),
        );
      }
    }
    if (threadUnread) {
      const history = histories.get("primary/alpha");
      const root = history.at(-2);
      const broadcast = sign(
        9,
        [
          ["h", "alpha"],
          ["e", root.id.toUpperCase(), "", "reply"],
          ["broadcast", "1"],
        ],
        "Broadcast reply",
        peerKey,
        root.created_at + 2,
      );
      history.push(broadcast);
      const replies = threadReplies.get(root.id);
      replies.push(broadcast);
      replies.push(
        sign(
          9,
          [
            ["h", "alpha"],
            ["e", root.id.toUpperCase(), "", "root"],
            ["e", broadcast.id.toUpperCase(), "", "reply"],
          ],
          "Broadcast descendant",
          peerKey,
          root.created_at + 11,
        ),
      );
      threadSummaries.push(
        sign(
          39005,
          [
            ["h", "alpha"],
            ["e", broadcast.id],
            ["d", broadcast.id],
          ],
          JSON.stringify({
            reply_count: 23,
            participants: [getPublicKey(peerKey)],
          }),
        ),
      );
    }
    // Signed upstream-only stress data; production traversal and mounting stay real.
    let presenceThread;
    if (presenceThreadAuthors) {
      const threadRoot = histories
        .get("primary/alpha")
        .find((event) => event.content === "Thread root 0");
      if (!threadRoot) throw new Error("Presence thread requires threadUnread");
      const replies = Array.from({ length: presenceThreadAuthors }, (_, i) =>
        sign(
          9,
          [
            ["h", "alpha"],
            ["e", threadRoot.id, "", "reply"],
          ],
          `Distinct author reply ${i}`,
          generateSecretKey(),
          threadRoot.created_at + i + 20,
        ),
      );
      threadReplies.set(threadRoot.id, replies);
      // The ordinary unread fixture also broadcasts one reply into the timeline.
      // This stress case owns exactly the distinct replies above, not that extra row.
      histories.set(
        "primary/alpha",
        histories
          .get("primary/alpha")
          .filter(
            (event) =>
              !event.tags.some(
                ([key, value]) =>
                  key === "e" && value.toLowerCase() === threadRoot.id,
              ),
          ),
      );
      presenceThread = { root: threadRoot, replies };
    }
    if (actionProfile) {
      const root = histories
        .get("primary/alpha")
        .find((row) => row.content === "Thread root 1");
      targetEvents.push(
        sign(
          7,
          [
            ["h", "alpha"],
            ["e", root.id],
          ],
          "👍",
          peerKey,
        ),
      );
    }
    const report = {
      state: {
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }),
        browserName,
        developmentReact,
        pluginFixtures,
        compiledBuild: {
          worker: testInfo.workerIndex,
          durationMs: compiledApp.durationMs,
        },
        signedHistory: { counts: historyCounts, durationMs: historyDurationMs },
        largeSidebar,
        readState,
        sidebarUnread,
        savedSidebar,
        sortingSidebar,
        initialSidebarSort,
        dmLabels,
        agentPeers,
        tallMessages,
        browserVersion: browser.version(),
        node: process.version,
        platform: platform(),
        arch: arch(),
        viewport: testInfo.project.use.viewport,
        build: `${developmentReact ? "Vite production build with development React" : "production frontend"}; ${productionBroker ? "production broker; modeled upstream WS/HTTP policy" : "fixture broker HTTP"}; no native or real relay`,
      },
      queries: [],
      publications: [],
      readPublications: [],
      sessions: [],
      streamConnections: [],
      streamInterests: [],
      errors: [],
      consoleErrors: [],
      unexpected: [],
      cancelledRequests: [],
      measurements: [],
    };
    const pending = [];
    const retiredStreams = new Set();
    const observerFailures = [];
    const consoleLocations = new Map();
    const send = (response, body, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const answer = (community, filter) => {
      if (filter.kinds?.includes(13535)) {
        expect(filter).toEqual({
          kinds: [13535],
          authors: [getPublicKey(relayKey)],
          limit: 1,
        });
        return [sign(13535, [["-"]])];
      }
      if (filter.kinds?.includes(13534)) {
        // Relay-signed roster for archive consent; the viewer is a plain member.
        expect(filter).toEqual({
          kinds: [13534],
          authors: [getPublicKey(relayKey)],
          limit: 1,
        });
        return [sign(13534, [["member", viewer, "member"]])];
      }
      if (filter.kinds?.includes(30617) || filter.kinds?.includes(30621)) {
        expect(filter).toEqual({ kinds: [30617, 30621], limit: 100 });
        return [];
      }
      if (personalSidebar && filter.ids)
        return [...readEvents.get(community).values()].filter((event) =>
          filter.ids.includes(event.id),
        );
      if (filter.kinds?.includes(20001))
        return filter.authors.map((author) =>
          sign(
            20001,
            [["p", author]],
            report.presencePublications?.findLast(
              (entry) =>
                entry.community === community && entry.event.pubkey === author,
            )?.event.content ?? "online",
          ),
        );
      if (filter.kinds?.includes(30622))
        return channelLifecycle
          ? [
              sign(
                30622,
                [
                  ["d", viewer],
                  ["p", viewer],
                  ...[...hiddenDmIds].map((id) => ["h", id]),
                ],
                "",
                relayKey,
                lifecycleTime,
              ),
            ]
          : [];
      if (filter.kinds?.includes(13534)) {
        expect(filter).toEqual({
          authors: [getPublicKey(relayKey)],
          kinds: [13534],
          limit: 1,
        });
        return [sign(13534, [["member", viewer, "owner"]], "", relayKey)];
      }
      if (filter.kinds?.includes(39001))
        return rosterIds
          .filter((id) => !filter["#d"] || filter["#d"].includes(id))
          .map((id) =>
            sign(
              39001,
              [
                ["d", id],
                ...(lifecycleRows.some((row) => row.id === id) &&
                ["owner", "admin"].includes(lifecycleRole)
                  ? [["p", viewer, lifecycleRole]]
                  : []),
                ...(ownerAgent && lifecycleRows.some((row) => row.id === id)
                  ? [["p", ownerAgent, "owner"]]
                  : []),
              ],
              "",
              relayKey,
              lifecycleTime,
            ),
          );
      if (filter.kinds?.includes(39002))
        return rosterIds
          .filter((id) => !filter["#d"] || filter["#d"].includes(id))
          .map((id) =>
            sign(39002, [
              ["d", id],
              [
                "p",
                viewer,
                "",
                lifecycleRows.some((row) => row.id === id)
                  ? lifecycleRole
                  : "member",
              ],
              ...(ownerAgent && lifecycleRows.some((row) => row.id === id)
                ? [["p", ownerAgent, "", "owner"]]
                : []),
              ...(agentPeers && channels.includes(id)
                ? participants.map((pubkey) => ["p", pubkey, "", "member"])
                : dmLabels && id === "dm-peer"
                  ? [["p", participants[0], "", "member"]]
                  : dmLabels && id === "dm-group"
                    ? participants.map((pubkey) => ["p", pubkey, "", "member"])
                    : participants
                        .slice(
                          dmIds.indexOf(id) * 8,
                          (dmIds.indexOf(id) + 1) * 8,
                        )
                        .map((pubkey) => ["p", pubkey, "", "member"])),
            ]),
          );
      if (filter.kinds?.includes(39000))
        return [...rosterIds, ...(openSearch ? ["open"] : [])]
          .filter((id) => !filter["#d"] || filter["#d"].includes(id))
          .map((id) =>
            sign(
              39000,
              [
                ["d", id],
                [
                  "name",
                  renamedChannels.get(id) ??
                    channelNames[id] ??
                    lifecycleRows.find((row) => row.id === id)?.name ??
                    (id === "alpha" ? "Alpha" : id === "beta" ? "Beta" : id),
                ],
                [
                  "t",
                  lifecycleRows.find((row) => row.id === id)?.type ??
                    (dmIds.includes(id) ? "dm" : "stream"),
                ],
                ...(archivedIds.has(id) ? [["archived", "true"]] : []),
                // Ordinary channels are explicitly public; do not add a public
                // flag to private sessions or change the separate DM fixtures.
                ...(!sessionChannels.includes(id) &&
                !dmIds.includes(id) &&
                !lifecycleRows.some((row) => row.id === id && row.type === "dm")
                  ? [["public"]]
                  : []),
                ...(dmIds.includes(id) ? [["hidden"]] : []),
                ...(sessionChannels.includes(id)
                  ? [
                      ["private"],
                      [
                        "about",
                        `Buzz session (buzz.sessions/v1)${sessionParents[id] ? `\nparent:${sessionParents[id]}` : ""}`,
                      ],
                    ]
                  : []),
                ...(hiddenChannels.has(id) ? [["hidden"]] : []),
              ],
              "",
              relayKey,
              lifecycleTime,
            ),
          );
      if (filter.kinds?.includes(30078)) {
        const events = [...readEvents.get(community).values()];
        if (readState && filter.read_state_snapshot === 1)
          return {
            read_state_snapshot: 1,
            complete: true,
            community_id: communityIds[community],
            pubkey: viewer,
            snapshot_id: "a".repeat(64),
            events,
          };
        return events.filter(
          (event) =>
            event.tags.some(
              ([key, value]) => key === "t" && filter["#t"]?.includes(value),
            ) ||
            filter["#d"]?.includes(event.tags.find(([k]) => k === "d")?.[1]),
        );
      }
      if (filter.kinds?.includes(30315)) {
        expect(filter).toEqual({
          kinds: [30315],
          "#d": ["general"],
          authors: expect.any(Array),
          limit: filter.authors.length,
        });
        expect(filter.authors.length).toBeGreaterThan(0);
        expect(filter.authors.length).toBeLessThanOrEqual(100);
        return [];
      }
      if (filter.kinds?.includes(30175) || filter.kinds?.includes(30177)) {
        expect(filter).toEqual({
          authors: [viewer],
          kinds: [30175, 30177],
          limit: 200,
        });
        return [];
      }
      if (filter.kinds?.includes(30030)) {
        expect(filter).toEqual({
          kinds: [30030],
          "#d": ["buzz:custom-emoji"],
          limit: 500,
        });
        return sidebarIcons
          ? [
              sign(
                30030,
                [
                  ["d", "buzz:custom-emoji"],
                  [
                    "emoji",
                    "stamp",
                    `https://${community}.example/media/stamp.png`,
                  ],
                ],
                "",
                userKey,
              ),
            ]
          : [];
      }
      if (filter.kinds?.includes(10100)) {
        expect(filter).toEqual({
          kinds: [10100],
          authors: [expect.stringMatching(/^[0-9a-f]{64}$/)],
          limit: 1,
        });
        return [];
      }
      if (filter.kinds?.includes(30177)) {
        expect(filter).toEqual({
          kinds: [30177],
          authors: [expect.stringMatching(/^[0-9a-f]{64}$/)],
          "#d": [expect.stringMatching(/^[0-9a-f]{64}$/)],
          limit: 1,
        });
        return [];
      }
      if (filter.kinds?.includes(30315)) {
        expect(filter).toEqual({
          kinds: [30315],
          authors: [expect.any(String)],
          "#d": ["general"],
          limit: 1,
        });
        return [];
      }
      if (filter.kinds?.includes(0))
        return [
          ...[...servedProfiles.values()].filter((event) =>
            filter.authors?.includes(event.pubkey),
          ),
          ...(ownerAgentProfile && filter.authors?.includes(ownerAgent)
            ? [ownerAgentProfile]
            : []),
          ...(filter.authors?.includes(viewer)
            ? [profiles.get(community)]
            : []),
          ...membershipKeys
            .filter((key) => filter.authors?.includes(getPublicKey(key)))
            .map((key) =>
              sign(
                0,
                [],
                JSON.stringify({
                  name: key === membershipKeys[0] ? "Pinky" : "Brain",
                  ...(key === membershipKeys[1] ? { is_agent: true } : {}),
                }),
                key,
              ),
            ),
          ...peerKeys
            .filter((key) => filter.authors?.includes(getPublicKey(key)))
            .map((key) =>
              sign(
                0,
                [],
                JSON.stringify({
                  ...(agentPeers && key !== peerKey ? { is_agent: true } : {}),
                  display_name: [
                    "Alice Fixture",
                    "Bob Fixture",
                    "Carol Fixture",
                  ][peerKeys.indexOf(key)],
                }),
                key,
              ),
            ),
        ];
      if (filter.search !== undefined)
        return [...histories.entries()]
          .filter(([key]) => key.startsWith(`${community}/`))
          .flatMap(([, events]) => events)
          .concat(community === "primary" ? targetEvents : [])
          .filter(
            (event) =>
              filter.kinds.includes(event.kind) &&
              event.content.toLowerCase().includes(filter.search.toLowerCase()),
          )
          .slice(0, filter.limit);
      if (filter.ids)
        return [...histories.entries()]
          .filter(([key]) => key.startsWith(`${community}/`))
          .flatMap(([, events]) => events)
          .concat(community === "primary" ? targetEvents : [])
          .filter(
            (event) =>
              filter.ids.includes(event.id) &&
              (!filter["#h"] ||
                event.tags.some(
                  ([key, value]) => key === "h" && filter["#h"].includes(value),
                )),
          )
          .slice(0, filter.limit);
      if (
        filter["#e"] &&
        filter.kinds?.every((kind) => [5, 7, 9005, 39005, 40003].includes(kind))
      )
        return (community === "primary" ? targetEvents : [])
          .filter(
            (event) =>
              filter.kinds.includes(event.kind) &&
              event.tags.some(
                ([key, value]) => key === "e" && filter["#e"].includes(value),
              ),
          )
          .filter(
            (event) =>
              filter.until === undefined ||
              event.created_at < filter.until ||
              (event.created_at === filter.until &&
                event.id > filter.before_id),
          )
          .toSorted(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      if (filter.depth_limit) {
        const rootId = filter["#e"]?.[0];
        const candidates = [
          ...(community === "primary" ? (threadReplies.get(rootId) ?? []) : []),
          ...(histories.get(`${community}/${filter["#h"]?.[0]}`) ?? []),
        ].filter((event) => {
          const refs = event.tags.filter(([key]) => key === "e");
          const root =
            refs.find((tag) => tag[3] === "root") ??
            refs.find((tag) => tag[3] === "reply");
          return root?.[1]?.toLowerCase() === rootId;
        });
        const rows = [
          ...new Map(candidates.map((event) => [event.id, event])).values(),
        ]
          .filter(
            (event) =>
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor ||
              (event.created_at === filter.thread_cursor &&
                event.id > filter.thread_cursor_id),
          )
          .toSorted(
            (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
        const ids = new Set(rows.map((event) => event.id));
        const aux = [];
        if (filter.include_aux && community === "primary")
          for (let hop = 0; hop < 2; hop++)
            for (const event of targetEvents) {
              if (
                ids.has(event.id) ||
                ![5, 7, 9005, 39005, 40003].includes(event.kind)
              )
                continue;
              if (
                event.tags.some(([key, value]) => key === "e" && ids.has(value))
              ) {
                aux.push(event);
                ids.add(event.id);
              }
            }
        return [...rows, ...aux];
      }
      // Unread evidence is not a top-level window, even for a one-ID final batch.
      if (
        filter.kinds?.includes(9) &&
        !filter.top_level &&
        filter["#h"]?.length
      )
        return filter["#h"]
          .flatMap((channel) => [
            ...(histories.get(`${community}/${channel}`) ?? []),
            ...(threadUnread && community === "primary" && channel === "alpha"
              ? [...threadReplies.values()].flat()
              : []),
          ])
          .filter(
            (event) =>
              filter.until === undefined ||
              event.created_at < filter.until ||
              (event.created_at === filter.until &&
                event.id > filter.before_id),
          )
          .toSorted(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      const channel = filter["#h"]?.[0];
      const history = histories.get(`${community}/${channel}`);
      if (!history)
        throw new Error(`Unexpected query: ${JSON.stringify(filter)}`);
      const candidates = history
        .filter((event) => !filter.kinds || filter.kinds.includes(event.kind))
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until && event.id > filter.before_id),
        )
        .toSorted(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
      const events = candidates.slice(0, filter.limit);
      const hasMore = candidates.length > events.length;
      const last = events.at(-1);
      const suffix =
        filter.until === undefined
          ? "head"
          : `${filter.until}:${filter.before_id}`;
      return filter.include_aux
        ? [
            ...events,
            ...(actionProfile
              ? targetEvents.filter((aux) =>
                  aux.tags.some(
                    ([k, id]) =>
                      k === "e" && events.some((row) => row.id === id),
                  ),
                )
              : []),
            ...threadSummaries.filter((summary) =>
              events.some((event) =>
                summary.tags.some(
                  ([key, value]) => key === "e" && value === event.id,
                ),
              ),
            ),
            sign(
              39006,
              [
                ["h", channel],
                ["d", `${channel}:${suffix}`],
              ],
              JSON.stringify({
                has_more: hasMore,
                next_cursor: hasMore
                  ? { created_at: last.created_at, id: last.id }
                  : null,
              }),
            ),
          ]
        : events;
    };
    const acceptReadPublication = (community, event) => {
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(viewer);
      if (channelLifecycle && [9002, 9008, 9022, 41012].includes(event.kind)) {
        const id = event.tags.find(([key]) => key === "h")?.[1];
        expect(lifecycleRows.some((row) => row.id === id)).toBe(true);
        if (event.kind === 9002) archivedIds.add(id);
        if (event.kind === 41012) hiddenDmIds.add(id);
        if (event.kind === 9008 || event.kind === 9022)
          rosterIds.splice(rosterIds.indexOf(id), 1);
        lifecycleTime++;
        report.lifecyclePublications ??= [];
        report.lifecyclePublications.push(event);
        return;
      }
      if (event.kind === 9) {
        report.publications.push({ community, event });
        const channel = event.tags.find(([name]) => name === "h")?.[1];
        histories.get(`${community}/${channel}`).push(event);
        relay.publish(community, event);
        return;
      }
      if ([7, 5, 40003].includes(event.kind)) {
        const channel = event.tags.find(([name]) => name === "h")?.[1];
        const history = histories.get(`${community}/${channel}`);
        expect(history).toBeDefined();
        const ids = event.tags
          .filter(([name]) => name === "e")
          .map(([, id]) => id);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
          const target = [
            ...history,
            ...[...threadReplies.values()].flat(),
          ].find((row) => row.id === id);
          expect(target).toBeDefined();
          expect(target.tags).toContainEqual(["h", channel]);
          if (event.kind === 7) expect(target.kind).toBe(9);
          else {
            expect(target.pubkey).toBe(viewer);
            expect([7, 9]).toContain(target.kind);
            if (event.kind === 5)
              expect(event.tags).toContainEqual(["k", String(target.kind)]);
            else expect(target.kind).toBe(9);
          }
        }
        if ([7, 40003].includes(event.kind)) expect(ids).toHaveLength(1);
        if (!history.some((row) => row.id === event.id)) {
          history.push(event);
          targetEvents.push(event);
        }
        report.publications.push({ community, event });
        relay.publish(community, event);
        return;
      }
      expect(event.kind).toBe(30078);
      const sidebarCoordinate = event.tags.find(([name]) => name === "d")?.[1];
      if (
        [
          "channel-mutes",
          "channel-sections",
          "channel-stars",
          "channel-sort",
        ].includes(sidebarCoordinate) ||
        (personalSidebar &&
          sidebarCoordinate?.startsWith("buzz-channel-kit-v1:"))
      ) {
        expect(event.tags).toContainEqual([
          "t",
          sidebarCoordinate.startsWith("buzz-channel-kit-v1:")
            ? "buzz-channel-kit-v1"
            : sidebarCoordinate,
        ]);
        const blob = JSON.parse(
          nip44.v2.decrypt(
            event.content,
            nip44.v2.utils.getConversationKey(userKey, viewer),
          ),
        );
        readEvents.get(community).set(sidebarCoordinate, event);
        report.sidebarPublications ??= [];
        report.sidebarPublications.push({
          community,
          coordinate: sidebarCoordinate,
          event,
          blob,
        });
        return;
      }
      expect(event.tags).toContainEqual(["t", "read-state"]);
      const blob = JSON.parse(
        nip44.v2.decrypt(
          event.content,
          nip44.v2.utils.getConversationKey(userKey, viewer),
        ),
      );
      const coordinate = event.tags.find(([key]) => key === "d")?.[1];
      expect(coordinate).toMatch(/^read-state:[0-9a-f]{32}$/);
      const previous = readEvents.get(community).get(coordinate);
      if (
        !previous ||
        event.created_at > previous.created_at ||
        (event.created_at === previous.created_at && event.id < previous.id)
      )
        readEvents.get(community).set(coordinate, event);
      report.readPublications.push({ community, event, blob });
    };
    const relay = productionBroker
      ? policyRelay({
          viewer,
          relayAuthor: getPublicKey(relayKey),
          answer,
          report,
          pending,
          // The production broker advertises read-state writes for every session,
          // not only tests opting into complete snapshot reads.
          acceptPublication: acceptReadPublication,
          ...(actionProfile || channelLifecycle
            ? {
                latencyMs: 40,
                holdOlder: false,
                acceptPublication: (community, event) => {
                  expect(verifyEvent(event)).toBe(true);
                  expect(event.pubkey).toBe(viewer);
                  if (
                    channelLifecycle &&
                    [9002, 9008, 9022, 41012].includes(event.kind)
                  )
                    return acceptReadPublication(community, event);
                  if (event.kind === 30078)
                    return acceptReadPublication(community, event);
                  expect([9, 7]).toContain(event.kind);
                  const channel = event.tags.find(([k]) => k === "h")?.[1];
                  const history = histories.get(`${community}/${channel}`);
                  expect(history).toBeDefined();
                  if (!history.some((row) => row.id === event.id))
                    history.push(event);
                  if (event.kind === 7) targetEvents.push(event);
                  report.publications.push({
                    community,
                    event,
                    at: performance.now(),
                  });
                  // No live echo in this measurement lane: observe the receipt
                  // and finite-read reconciliation without echo cancellation.
                },
              }
            : {}),
          discovery: (community) => ({
            self: getPublicKey(relayKey),
            ...(readState
              ? {
                  read_state_snapshot: {
                    version: 1,
                    community_id: communityIds[community],
                    max_events: 4096,
                    max_bytes: 8388608,
                  },
                }
              : {}),
          }),
        })
      : undefined;
    const middleware = async (request, response, next) => {
      if (!request.url?.startsWith("/api/relay/")) return next();
      try {
        const parts = request.url.split("/");
        const route = parts.at(-1);
        const requestedCommunity = decodeURIComponent(parts[3]);
        const community =
          requestedCommunity.match(
            /^https:\/\/(primary|secondary)\.(?:example|fixture\.invalid)$/,
          )?.[1] ?? requestedCommunity;
        const parsed = await fixtureBody(request, report);
        if (!parsed) return; // The client disconnected; there is no response to send.
        const { body } = parsed;
        if (route === "identity") return send(response, { viewer });
        if (route === "register") return send(response, {});
        if (!["primary", "secondary"].includes(community))
          throw new Error(`Unexpected community: ${request.url}`);
        if (route === "gif-info" && request.method === "GET")
          return send(response, {});
        if (
          (route === "info" || route === "icon-info") &&
          request.method === "GET"
        )
          return send(response, { policy: null });
        if (route === "invite" && request.method === "POST")
          return send(response, {
            code: "fixture",
            url: `${JSON.parse(fixtureAliases)[community]}/invite/fixture`,
            expires_at: 1700003600,
            max_uses: body.max_uses ?? null,
            uses_remaining: body.max_uses ?? null,
          });
        if (route === "session") {
          report.sessions.push(community);
          return send(response, {
            viewer,
            relayAuthor: getPublicKey(relayKey),
            writeKinds: sessionChannels.length ? [9, 9007, 30315] : [9, 30315],
            relayUrl: JSON.parse(fixtureAliases)[community],
            live: true,
          });
        }
        if (sessionChannels.length && route === "sign") {
          expect(body.kind).toBe(9);
          return send(response, finalizeEvent(body, userKey));
        }
        if (sessionChannels.length && route === "publish") {
          expect(verifyEvent(body)).toBe(true);
          expect(body.pubkey).toBe(viewer);
          expect(body.kind).toBe(9);
          const channel = body.tags.find(([key]) => key === "h")?.[1];
          expect(sessionChannels).toContain(channel);
          histories.get(`${community}/${channel}`).push(body);
          return send(response, { accepted: true, event_id: body.id });
        }
        if (
          ["stream-interests", "stream-priority", "stream-observer"].includes(
            route,
          )
        ) {
          const owner = streamOwners.get(body.streamId);
          expect(owner?.community).toBe(community);
          if (route === "stream-interests") {
            expect(body.interestRevision).toBeGreaterThan(
              owner.interestRevision,
            );
            owner.channels = body.channels;
            owner.interestRevision = body.interestRevision;
            report.streamInterests.push({ community, channels: body.channels });
            owner.state();
          }
          return send(response, {});
        }
        if (route === "stream") {
          // Match the production broker: WebKit can buffer trailing HTTP chunks.
          // Close-delimited SSE must deliver each append without a later write.
          const streamId = randomBytes(16).toString("hex");
          response.useChunkedEncodingByDefault = false;
          response.writeHead(200, {
            "X-Buzz-Live-ID": streamId,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          response.flushHeaders();
          const owner = {
            community,
            response,
            channels: body.channels,
            interestRevision: body.interestRevision,
            state() {
              response.write(
                `event: state\ndata: ${JSON.stringify({ status: "connected", interestRevision: owner.interestRevision, routes: owner.channels.map((channelId) => ({ id: `channel:${channelId}`, channelId, status: "live", replay: "unknown" })) })}\n\n`,
              );
            },
          };
          streamOwners.set(streamId, owner);
          owner.state();
          const clients = streams.get(community) ?? new Set();
          streams.set(community, clients);
          clients.add(owner);
          report.streamConnections.push({ community, channels: body.channels });
          // The real broker pulses every 15s; the production reader expires
          // streams after 45s without bytes, even while history HTTP is active.
          const heartbeat = setInterval(
            () => response.write(": keepalive\n\n"),
            15000,
          );
          response.on("close", () => {
            clearInterval(heartbeat);
            clients.delete(owner);
            streamOwners.delete(streamId);
          });
          return;
        }
        if (route === "profile" && request.method === "POST") {
          const { existing, name, picture, about } = body;
          const event = sign(
            0,
            [],
            JSON.stringify({
              ...existing,
              name: name.trim(),
              display_name: name.trim(),
              picture,
              about,
            }),
            userKey,
            profiles.get(community).created_at + 1,
          );
          profiles.set(community, event);
          // Deliberately no live echo: Save must confirm through a signed read.
          return send(response, { accepted: true, event_id: event.id });
        }
        if (route !== "query" || request.method !== "POST")
          throw new Error(
            `Unexpected fixture request: ${request.method} ${request.url}`,
          );
        expect(body.length).toBeGreaterThan(0);
        expect(body.length).toBeLessThanOrEqual(3);
        const filter = body[0];
        const result = [
          ...new Map(
            body
              .flatMap((filter) => {
                report.queries.push({ community, filter });
                return answer(community, filter);
              })
              .map((event) => [event.id, event]),
          ).values(),
        ];
        if (filter.until !== undefined && filter["#h"]?.length) {
          pending.push({
            community,
            channel: filter["#h"][0],
            filter,
            events: result.filter((event) => event.kind === 9),
            release: () => send(response, result),
          });
        } else send(response, result);
      } catch (error) {
        report.unexpected.push(String(error));
        send(response, { error: String(error) }, 500);
      }
    };
    const heldIcons = [];
    const iconRequests = [];
    const foregroundRequests = [];
    let iconsReleased = false;
    let server;
    // Each watched page's errors; additional pages join through app.watchPageErrors.
    const watchedPages = [];
    try {
      server = await preview({
        ...compiledApp.config,
        plugins: [
          {
            name: "fixture-relay",
            async configurePreviewServer(server) {
              if (iconCongestion) {
                server.middlewares.use((req, res, next) => {
                  if (req.url?.includes("/icon-info")) {
                    iconRequests.push(req.url);
                    if (iconsReleased) return send(res, {});
                    heldIcons.push(res);
                    return;
                  }
                  if (req.url === "/foreground-probe") {
                    foregroundRequests.push(req.url);
                    return send(res, { reached: true });
                  }
                  next();
                });
              }
              if (relay) {
                report.brokerRequests = [];
                server.middlewares.use((req, res, next) => {
                  if (req.url?.startsWith("/api/relay/"))
                    report.brokerRequests.push({
                      url: req.url,
                      at: performance.now(),
                    });
                  // The broker has paused its lane by the time a relayed quota
                  // refusal finishes; this bounds that pause in fixture time.
                  if (/^\/api\/relay\/[^/]+\/query$/.test(req.url ?? ""))
                    res.once("finish", () => {
                      if (res.statusCode !== 429) return;
                      const rejection = relay.rejected.find(
                        (item) => item.relayed === undefined,
                      );
                      if (rejection) rejection.relayed = performance.now();
                    });
                  if (req.url?.endsWith("/stream"))
                    res.once("close", () => {
                      retiredStreams.add(res.getHeader("x-buzz-live-id"));
                    });
                  next();
                });
                const broker = relayBrokerPlugin({
                  relayUrl: fixtureRelayUrl,
                  communityAliases: fixtureAliases,
                  identity: () => userKey.slice(),
                  agentLibrary: () => ({ definitions: [], identities: [] }),
                  ...(readState || channelLifecycle
                    ? {}
                    : {
                        authority: async () => ({
                          relayAuthor: getPublicKey(relayKey),
                        }),
                      }),
                  upstreamFetch: relay.fetch,
                  socketFactory: relay.socket,
                });
                await broker.configureServer(server);
              } else server.middlewares.use(middleware);
            },
          },
        ],
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      await context.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin)
          return route.continue();
        report.unexpected.push(
          `Blocked external request: ${route.request().url()}`,
        );
        return route.abort();
      });
      await context.routeWebSocket("**/*", (socket) => {
        report.unexpected.push(`Blocked WebSocket: ${socket.url()}`);
        socket.close();
      });
      watchedPages.push(watchPageErrors(page));
      report.errors = watchedPages[0].errors;
      const unexplainedPageErrors = () =>
        watchedPages.flatMap((watched) => watched.unexplained());
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleLocations.set(
            report.consoleErrors.length,
            message.location().url,
          );
          report.consoleErrors.push(message.text());
        }
      });
      page.on("response", (response) => {
        if (
          response.url().endsWith("/stream-observer") &&
          response.status() === 404
        ) {
          const { streamId } = response.request().postDataJSON();
          observerFailures.push({
            streamId,
            url: response.url(),
            retired: retiredStreams.has(streamId),
          });
        }
      });
      await page.addInitScript(
        ({ viewer, profilePicture, iconCongestion }) => {
          const key = `buzz-client.v1:${viewer}`;
          if (!localStorage.getItem(key))
            localStorage.setItem(
              key,
              JSON.stringify({
                profile: { name: "Browser Fixture", picture: profilePicture },
                memberships: iconCongestion
                  ? [
                      { id: "primary", name: "Primary" },
                      { id: "secondary", name: "Secondary" },
                      ...Array.from({ length: 6 }, (_, index) => ({
                        id: `https://saved-${index}.example`,
                        name: `Saved ${index}`,
                      })),
                    ]
                  : [
                      { id: "primary", name: "Primary" },
                      { id: "secondary", name: "Secondary" },
                    ],
                selected: "primary",
              }),
            );
        },
        { viewer, profilePicture, iconCongestion },
      );
      await use({
        sign: (template) => finalizeEvent(template, userKey),
        membershipSnapshot(role) {
          expect(["owner", "admin", "member"]).toContain(role);
          return sign(13534, [["member", viewer, role]], "", relayKey);
        },
        origin,
        report,
        watchPageErrors(other) {
          const watched = watchPageErrors(other);
          watchedPages.push(watched);
          return watched;
        },
        iconCongestion: iconCongestion
          ? {
              iconRequests,
              foregroundRequests,
              release() {
                iconsReleased = true;
                for (const response of heldIcons)
                  if (!response.writableEnded) send(response, {});
              },
            }
          : undefined,
        pending,
        histories,
        // Signed device-cache input for the startup scale journey; same modeled
        // wire responses as a real roster/head read, without visiting every row.
        startupCache() {
          return {
            discovery: [
              ...answer("primary", { kinds: [39002] }),
              ...answer("primary", { kinds: [39000] }),
            ],
            heads: rosterIds.map((channelId) => ({
              channelId,
              savedAt: Date.now(),
              profiles: [],
              events: answer("primary", {
                kinds: [9, 40002, 40008],
                "#h": [channelId],
                limit: 20,
                top_level: true,
                include_aux: true,
                include_summaries: true,
              }),
            })),
          };
        },
        presenceThread,
        exact,
        searchTarget,
        membership(
          type,
          targetIndex,
          actorIndex = -1,
          forged = false,
          deliver = true,
        ) {
          const history = histories.get(`primary/${channels[0]}`);
          const event = membershipEvent(
            type,
            targetIndex,
            history.at(-1).created_at + 1,
            actorIndex,
            forged,
          );
          history.push(event);
          if (!deliver) return event;
          if (relay) relay.publish("primary", event);
          else
            for (const client of streams.get("primary") ?? [])
              if (client.channels.includes(channels[0]))
                client.response.write(`data: ${JSON.stringify(event)}\n\n`);
          return event;
        },
        presence(status, community = "primary") {
          const event = sign(
            20001,
            [],
            status,
            peerKey,
            Math.floor(Date.now() / 1000),
          );
          relay.presence(community, event);
          return event;
        },
        participants,
        viewer,
        relay,
        observer(raw, agentKey, community = "primary") {
          const agent = getPublicKey(agentKey);
          const plaintext = JSON.stringify(raw);
          const event = sign(
            24200,
            [
              ["p", viewer],
              ["agent", agent],
              ["frame", "telemetry"],
            ],
            nip44.v2.encrypt(
              plaintext,
              nip44.v2.utils.getConversationKey(agentKey, viewer),
            ),
            agentKey,
            Math.floor(Date.now() / 1000),
          );
          relay.observer(community, event);
          return { event, plaintext, agent };
        },
        // Answer later kind-0 reads for this key; no live delivery is modeled.
        serveProfile(key, body) {
          const event = sign(0, [], JSON.stringify(body), key);
          servedProfiles.set(event.pubkey, event);
          return event;
        },
        // Change only modeled relay state. The app must consume the next real
        // roster response; this does not call client purge/recovery internals.
        renameChannel(id, name) {
          expect(rosterIds).toContain(id);
          renamedChannels.set(id, name);
          lifecycleTime++;
        },
        hideChannel(id) {
          expect(rosterIds).toContain(id);
          hiddenChannels.add(id);
        },
        omitChannel(id) {
          expect(rosterIds).toContain(id);
          rosterIds.splice(rosterIds.indexOf(id), 1);
        },
        // Signed upstream-only simulations: never a browser publication or live relay.
        activity({
          channel = "alpha",
          root,
          author = 0,
          kind = 20002,
          age = 0,
        } = {}) {
          if (!relay)
            throw new Error("Typing fixture requires production broker");
          const event = sign(
            kind,
            [["h", channel], ...(root ? [["e", root, "", "reply"]] : [])],
            kind === 20002 ? "" : "Fixture completion",
            typingKeys[author],
            Math.floor(Date.now() / 1000) - age,
          );
          relay.publish("primary", event);
          return event;
        },
        edit(community, channel, target, content) {
          const event = sign(
            40003,
            [
              ["h", channel],
              ["e", target.id],
            ],
            content,
            userKey,
            target.created_at + 1,
          );
          report.publications.push({
            id: event.id,
            target: target.id,
            kind: event.kind,
            frameBytes: Buffer.byteLength(`data: ${JSON.stringify(event)}\n\n`),
          });
          if (relay) relay.publish(community, event);
          else {
            expect(streams.get(community)?.size).toBeGreaterThan(0);
            for (const client of streams.get(community))
              if (client.channels.includes(channel))
                client.response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          return event;
        },
        deleteTarget(target = exact.target) {
          const event = sign(
            5,
            [
              ["h", "alpha"],
              ["e", target.id],
            ],
            "",
            userKey,
            target.created_at + 100,
          );
          targetEvents.push(event);
          relay.publish("primary", event);
        },
        reply(rootId, own = false, deliver = true) {
          const replies = threadReplies.get(rootId);
          if (!replies) throw new Error("Unknown fixture thread");
          const event = sign(
            9,
            [
              ["h", "alpha"],
              ["e", rootId, "", "reply"],
            ],
            own ? "My reply" : "New peer reply",
            own ? userKey : peerKey,
            replies.at(-1).created_at + 1,
          );
          replies.push(event);
          if (deliver) relay.publish("primary", event);
          return event;
        },
        append(
          community,
          channel,
          content,
          deliver = true,
          own = true,
          root,
          parent,
          attachmentTags = [],
        ) {
          const history = histories.get(`${community}/${channel}`);
          const event = sign(
            9,
            [
              ["h", channel],
              ...attachmentTags,
              ...(root
                ? parent && parent !== root
                  ? [
                      ["e", root, "", "root"],
                      ["e", parent, "", "reply"],
                    ]
                  : [["e", root, "", "reply"]]
                : []),
            ],
            content ?? `Live append ${history.length}`,
            own ? userKey : peerKey,
            (history.at(-1)?.created_at ?? 1700000900) + 1,
          );
          history.push(event);
          if (relay && deliver) relay.publish(community, event);
          else if (relay) return event;
          else {
            expect(streams.get(community)?.size).toBeGreaterThan(0);
            for (const client of streams.get(community))
              if (client.channels.includes(channel))
                client.response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          return event;
        },
      });
      expect(report.unexpected).toEqual([]);
      // Aborted startup streams can race an already-dispatched observer control.
      // Permit only 404s whose exact stream was already closed by the real host;
      // a current/unknown stream failure still fails, and all errors stay recorded.
      report.retiredObserverControls = [...observerFailures];
      expect(observerFailures.every((failure) => failure.retired)).toBe(true);
      const retiredConsole = (message, index) => {
        if (
          !/^Failed to load resource: the server responded with a status of 404/.test(
            message,
          )
        )
          return false;
        const match = observerFailures.findIndex(
          (failure) => failure.url === consoleLocations.get(index),
        );
        if (match < 0) return false;
        observerFailures.splice(match, 1);
        return true;
      };
      // Recovery journeys inject specific failed host requests. Match
      // each exact URL once, not every 502 or every console error in the test.
      const sidebarFailures = [
        ...(report.sidebarSortFailures ?? []),
        ...(report.sidebarMuteFailures ?? []),
        ...(report.sidebarActivityFailures ?? []),
        ...(report.sidebarStarFailures ?? []),
        ...(report.sidebarAssignmentFailures ?? []),
        ...(report.sidebarPreferenceFailures ?? []),
        ...(report.startupFailures ?? []),
      ];
      const injectedSidebarFailure = (message, index) => {
        if (
          !/^Failed to load resource: the server responded with a status of 502/.test(
            message,
          )
        )
          return false;
        const match = sidebarFailures.indexOf(consoleLocations.get(index));
        if (match < 0) return false;
        sidebarFailures.splice(match, 1);
        return true;
      };
      expect(
        report.consoleErrors.filter(
          (message, index) =>
            !retiredConsole(message, index) &&
            !injectedSidebarFailure(message, index) &&
            !(
              expectedPageFailure &&
              message.includes("Fixture page render failure")
            ) &&
            !(
              relay?.expectedHttpErrors() &&
              /^Failed to load resource: the server responded with a status of 429/.test(
                message,
              )
            ),
        ),
      ).toEqual([]);
      // All page errors stay in the evidence; only known engine reports pass.
      expect(unexplainedPageErrors()).toEqual([]);
    } finally {
      if (iconCongestion)
        for (const response of heldIcons)
          if (!response.writableEnded) send(response, {});
      report.additionalPageErrors = watchedPages
        .slice(1)
        .flatMap((watched) => watched.errors);
      await writeFile(
        testInfo.outputPath("evidence.json"),
        JSON.stringify(report, null, 2),
      );
      await testInfo.attach("browser-evidence", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      await page.close();
      for (const clients of streams.values())
        for (const client of clients) client.response.end();
      if (server) {
        server.httpServer.closeAllConnections();
        await new Promise((resolve) => server.httpServer.close(resolve));
      }
    }
  },
});
export { expect };
