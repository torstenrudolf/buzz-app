import { getLogger } from "../src/features/developer/logging.ts";
import { filterSummary, httpLabel } from "../src/features/developer/traffic.ts";

import { isWorkflowDefinitionBatch } from "../src/features/workflows/queries.ts";
import { validStatusTemplate } from "./user-status.mjs";
import { memoryFilter, decodeAgentMemory } from "./agent-memory.mjs";
import { memoryResponseText } from "../src/features/agents/memory.ts";
import {
  assertSidebarMuteIntent,
  mutateSidebarMute,
} from "./sidebar-mutes.mjs";
import { prepareMedia } from "./media-preparation.mjs";
import { assertSidebarSortIntent, mutateSidebarSort } from "./sidebar-sort.mjs";
import { readProjectGit } from "./project-git.mjs";
import { parseGitRead } from "../src/features/projects/git.ts";
import { validateLifecycleTemplate } from "../src/features/relay/channel-lifecycle-protocol.ts";
import { validateDetailsTemplate } from "../src/features/relay/channel-details-protocol.ts";
import { validateArchiveRequestTemplate } from "../src/features/relay/identity-archive-protocol.ts";
import {
  prepareChannelKit,
  decodeChannelKit,
  admitChannelKit,
  validCanvas,
} from "./channel-kit.mjs";
import { uploadAttachment, UploadError } from "./attachment-upload.mjs";
import { validateUploadResult } from "../src/features/relay/attachments.ts";
import { validChannelCommand } from "./session-commands.mjs";
import {
  adminReason,
  claimReason,
  inviteRequest,
  memberCommand,
} from "./community-admin.mjs";
import {
  directMessageEvent,
  directMessageReceipt,
} from "./direct-messages.mjs";
import { SocketRequestError } from "../src/features/relay/socket-requests.ts";
import {
  assertSidebarStarIntent,
  mutateSidebarStar,
} from "./sidebar-stars.mjs";
import {
  validateWorkflowEvent,
  WORKFLOW_KINDS,
} from "../src/features/workflows/protocol.ts";
import {
  workflowRunsPath,
  workflowReadText,
} from "../src/features/workflows/http.ts";
import { decodeAgentObserver } from "./agent-observer.mjs";
import { observerGeneration } from "../src/features/agents/observer.ts";
import {
  decodeReadState,
  signReadState,
  READ_STATE_DECODE_BYTES,
} from "./read-state.mjs";
import { READ_STATE_EVENT_BYTES } from "../src/features/relay/read-state-model.ts";
import {
  isReadSnapshotFilter,
  readSnapshotText,
  readSnapshotCommunity,
} from "../src/features/relay/read-state-snapshot.ts";
import { readAgentLibrary } from "./agent-library.mjs";
import { createBuilderlab } from "./builderlab.mjs";
import {
  decodeSidebarPreferences,
  assertSidebarAssignmentIntent,
  mutateSidebarAssignment,
  SIDEBAR_REQUEST_BYTES,
  SIDEBAR_UPLOAD_MS,
  SIDEBAR_UPLOAD_SLOTS,
} from "./sidebar-preferences.mjs";
import { createHostAdmission } from "../src/features/relay/host-admission.ts";
import { relayKlipySearchPath } from "../src/features/relay/gifs.ts";
import {
  validEmojiSetTemplate,
  validReactionContent,
} from "../src/features/relay/emoji.ts";
// Dev-only relay broker. Holds the local Buzz identity in this Node process and signs NIP-98 reads
// for the browser, so no key ever reaches page JavaScript. The dev server loads it whenever
// BUZZ_DEV_VIEWER is configured; production builds and tests never load it.
// Scoped writes support basic messages, profile setup and invite admission; signing remains here.
import {
  liveChannels,
  liveJoined,
  subscribeRelayTraffic,
  livePresenceAuthors,
} from "../src/features/relay/live.ts";
import {
  communityDestination,
  parseCommunityAliases,
  relayOrigin,
} from "../src/features/communities/destination.ts";
import {
  admittedApiRequest,
  ApiPaused,
  ApiCapacity,
  apiFailure,
  presenceFilter,
  presenceText,
} from "../src/features/relay/http-admission.ts";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  mediaByteLimit,
  UPLOAD_TIMEOUT_MS,
} from "../src/features/relay/attachment-limits.ts";
import dc from "node:diagnostics_channel";
import { finalizeEvent, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { Agent, fetch as upstreamHttp, interceptors } from "undici";
import { schnorr } from "@noble/curves/secp256k1.js";

function validProfilePicture(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const MAX_FILTERS = 4,
  MAX_LIMIT = 500,
  MAX_INFLIGHT = 6,
  SIDEBAR_HEAD_BYTES = SIDEBAR_REQUEST_BYTES + 4096,
  UPSTREAM_TIMEOUT_MS = 20000,
  KEEPALIVE_MS = 60000;

/** Warm, long-lived upstream connections. Node's default pool drops idle sockets after
 * four seconds, so every send after a short pause paid DNS + TCP + TLS again; a cold
 * connect is also the step most exposed to network stalls. DNS answers are cached too. */
export function createUpstream(base) {
  // A lost SYN costs 1 s, then 2 s, then 4 s before the OS retries, so a single unlucky
  // connect can hold a send for seven seconds. Fail the connect early and retry it
  // once. Only connection errors retry: relay responses, including 5xx, stay
  // authoritative for delivery status.
  const agent = new Agent({
    keepAliveTimeout: KEEPALIVE_MS,
    keepAliveMaxTimeout: KEEPALIVE_MS,
    connect: { timeout: 2500 },
  }).compose(
    interceptors.dns({ maxTTL: KEEPALIVE_MS }),
    interceptors.retry({
      maxRetries: 1,
      minTimeout: 50,
      maxTimeout: 250,
      methods: ["GET", "POST"],
      statusCodes: [],
      // Connect-phase failures only: the request was never sent, so a retry cannot duplicate it.
      errorCodes: [...CONNECT_FAILURES],
    }),
  );
  let connects = 0;
  let lastConnectMs = 0;
  let connectStart = 0;
  const subscriptions = {
    "undici:client:beforeConnect": () => {
      connectStart = performance.now();
    },
    "undici:client:connected": () => {
      connects++;
      lastConnectMs = performance.now() - connectStart;
    },
  };
  for (const [name, handler] of Object.entries(subscriptions))
    dc.subscribe(name, handler);
  const fetch = (url, init) =>
    upstreamHttp(url, { ...init, dispatcher: agent });
  return {
    fetch,
    /** Server-Timing `connect` when a request had to open a new upstream connection. */
    connectTiming(before) {
      return connects === before
        ? []
        : [`connect;dur=${lastConnectMs.toFixed(2)}`];
    },
    connects: () => connects,
    /** Establish the connection before the first user-visible request needs it. */
    warm: () =>
      base
        ? fetch(base, {
            headers: { Accept: "application/nostr+json" },
            signal: AbortSignal.timeout(10000),
          })
            .then((response) => response.arrayBuffer())
            .catch(() => {})
        : Promise.resolve(),
    close() {
      for (const [name, handler] of Object.entries(subscriptions))
        dc.unsubscribe(name, handler);
      return agent.close();
    },
  };
}

function loadIdentity(authorizedViewer) {
  // Validate the explicit public pin before prompting for any credential access.
  const configured = authorizedViewer?.trim() ?? "";
  let expected;
  if (/^[0-9a-f]{64}$/i.test(configured)) expected = configured.toLowerCase();
  else if (configured.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(configured);
      if (decoded.type === "npub") expected = decoded.data;
    } catch {
      // Report configuration guidance, never echo arbitrary input (possibly a secret).
    }
  }
  if (!expected)
    throw new Error(
      "Set BUZZ_DEV_VIEWER in .env.local to your existing Buzz public key (hex or npub, never nsec). See README.md#relay-channels.",
    );
  // The installed Buzz desktop keeps its secrets blob in the OS credential
  // store under service `buzz-desktop`, username `secrets`: the macOS Keychain,
  // or the freedesktop secret service on Linux (read through libsecret's
  // `secret-tool`). Both reads are the OS's own tools; there is no file or
  // environment fallback on any platform.
  const readers = {
    darwin: {
      command: "/usr/bin/security",
      args: [
        "find-generic-password",
        "-s",
        "buzz-desktop",
        "-a",
        "secrets",
        "-w",
      ],
      failure: "Keychain read unavailable or declined; no credential fallback",
    },
    linux: {
      command: "secret-tool",
      args: ["lookup", "service", "buzz-desktop", "username", "secrets"],
      failure:
        "Secret service read unavailable (needs libsecret-tools, an unlocked keyring in this desktop session, and Buzz desktop signed in); no credential fallback",
    },
  };
  const reader = readers[process.platform];
  if (!reader)
    throw new Error(
      `Live identity is read from the OS credential store on macOS or Linux only (this is ${process.platform}); no credential fallback`,
    );
  let raw;
  try {
    raw = execFileSync(reader.command, reader.args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    })
      .toString()
      .trim();
  } catch {
    throw new Error(reader.failure);
  }
  if (!raw) throw new Error(reader.failure);
  let decoded;
  try {
    decoded = nip19.decode(JSON.parse(raw).identity);
  } catch {
    throw new Error("Keychain identity invalid; no credential fallback");
  }
  if (decoded.type !== "nsec")
    throw new Error("Keychain identity must be nsec; no credential fallback");
  if (getPublicKey(decoded.data) !== expected) {
    decoded.data.fill(0);
    throw new Error(
      "Keychain identity does not match BUZZ_DEV_VIEWER. Check the public key of your existing Buzz account; do not replace or delete its credential.",
    );
  }
  return decoded.data;
}
async function relayAuthority(fetch, relay) {
  const response = await fetch(relay, {
    headers: { Accept: "application/nostr+json" },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Relay identity discovery failed");
  const nip11 = await response.json();
  if (!nip11 || typeof nip11 !== "object" || Array.isArray(nip11))
    throw new Error("Relay did not advertise its identity");
  const author = nip11.self ?? nip11.pubkey;
  if (typeof author !== "string" || !/^[0-9a-f]{64}$/.test(author))
    throw new Error("Relay did not advertise its identity");
  return {
    relayAuthor: author,
    channelCreation:
      Array.isArray(nip11.supported_nips) && nip11.supported_nips.includes(29),
    ...(readSnapshotCommunity(nip11.read_state_snapshot)
      ? { readStateCommunity: readSnapshotCommunity(nip11.read_state_snapshot) }
      : {}),
    // NIP-IA snapshots require the explicit relay signing identity. The NIP-11
    // contact-key fallback used by older channel reads cannot grant this authority.
    ...(nip11.self === author ? { archiveAuthority: author } : {}),
  };
}
export function validProductFeedback(event, mediaOrigin) {
  if (
    event?.kind !== 42000 ||
    typeof event.content !== "string" ||
    !event.content.trim() ||
    Buffer.byteLength(event.content) > 32 * 1024 ||
    !Number.isSafeInteger(event.created_at) ||
    !Array.isArray(event.tags)
  )
    return false;
  const allowed = new Set(["category", "client-id", "imeta"]);
  if (
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.every((part) => typeof part === "string") &&
        allowed.has(tag[0]) &&
        (tag[0] === "imeta" ? tag.length >= 6 : tag.length === 2),
    ) ||
    Buffer.byteLength(JSON.stringify(event.tags)) > 64 * 1024
  )
    return false;
  const categories = event.tags.filter((tag) => tag[0] === "category");
  const imeta = event.tags.filter((tag) => tag[0] === "imeta");
  return (
    imeta.every((tag) => {
      const fields = new Map();
      for (const part of tag.slice(1)) {
        const split = part.indexOf(" ");
        if (split <= 0 || fields.has(part.slice(0, split))) return false;
        fields.set(part.slice(0, split), part.slice(split + 1));
      }
      if (
        !mediaOrigin ||
        !["url", "m", "size", "x", "filename"].every((name) =>
          fields.has(name),
        ) ||
        !fields.get("filename") ||
        fields.get("filename").includes("/") ||
        fields.get("filename").includes("\\") ||
        Buffer.byteLength(fields.get("filename")) > 255 ||
        Array.from(fields.get("filename")).some((char) => {
          const code = char.charCodeAt(0);
          return code < 32 || code === 127;
        }) ||
        !/^[1-9][0-9]*$/.test(fields.get("size")) ||
        ![
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "application/octet-stream",
          "text/plain",
        ].includes(fields.get("m"))
      )
        return false;
      try {
        const result = validateUploadResult(
          {
            url: fields.get("url"),
            sha256: fields.get("x"),
            size: Number(fields.get("size")),
            type: fields.get("m"),
          },
          mediaOrigin,
          Number(fields.get("size")),
          "feedback",
        );
        const extension = result.url.match(/\.([a-z0-9]{1,8})$/)?.[1];
        const imageExtension = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/gif": "gif",
          "image/webp": "webp",
        }[result.type];
        return !imageExtension || extension === imageExtension;
      } catch {
        return false;
      }
    }) &&
    categories.length <= 1 &&
    (!categories.length ||
      ["bug", "praise", "needs-work"].includes(categories[0][1]))
  );
}

export function validMessageTemplate(event) {
  return (
    event &&
    [7, 9, 40003].includes(event.kind) &&
    typeof event.content === "string" &&
    event.content.trim().length > 0 &&
    Buffer.byteLength(event.content) <= 32000 &&
    Number.isSafeInteger(event.created_at) &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((value) => typeof value === "string"),
    ) &&
    event.tags.filter(
      (tag) =>
        tag[0] === "h" && typeof tag[1] === "string" && tag[1].length > 0,
    ).length === 1 &&
    (() => {
      const references = event.tags.filter((tag) => tag[0] === "e");
      if (event.kind === 40003)
        return (
          event.content === event.content.trim() &&
          references.length === 1 &&
          references[0].length === 2 &&
          /^[0-9a-f]{64}$/.test(references[0][1]) &&
          event.tags.every(([name]) =>
            ["h", "e", "emoji", "client-id", "imeta"].includes(name),
          )
        );
      if (event.kind === 7)
        return (
          event.content === event.content.trim() &&
          validReactionContent(event.content) &&
          references.length === 1 &&
          references[0].length === 2 &&
          /^[0-9a-f]{64}$/.test(references[0][1])
        );
      if (!references.length) return true;
      const canonical = (tag, marker) =>
        tag.length === 4 &&
        /^[0-9a-f]{64}$/.test(tag[1]) &&
        tag[2] === "" &&
        tag[3] === marker;
      return references.length === 1
        ? canonical(references[0], "reply")
        : references.length === 2 &&
            canonical(references[0], "root") &&
            canonical(references[1], "reply") &&
            references[0][1] !== references[1][1];
    })()
  );
}
/** NIP-56 message report: exactly one author and one typed message target. */
export function validReport(event) {
  if (
    event?.kind !== 1984 ||
    typeof event.content !== "string" ||
    event.content !== event.content.trim() ||
    Buffer.byteLength(event.content) > 32000 ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length !== 2
  )
    return false;
  const [author, target] = event.tags;
  return (
    Array.isArray(author) &&
    author.length === 2 &&
    author[0] === "p" &&
    /^[0-9a-f]{64}$/.test(author[1]) &&
    Array.isArray(target) &&
    target.length === 3 &&
    target[0] === "e" &&
    /^[0-9a-f]{64}$/.test(target[1]) &&
    [
      "spam",
      "profanity",
      "nudity",
      "impersonation",
      "malware",
      "illegal",
      "other",
    ].includes(target[2])
  );
}
/** Channel-local NIP-09 removal; the relay enforces authorship of each target. */
export function validMessageDeletion(event) {
  if (
    event?.kind !== 5 ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length > 106 ||
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length === 2 &&
        tag.every((value) => typeof value === "string") &&
        ["h", "e", "k", "client-id"].includes(tag[0]),
    )
  )
    return false;
  const channels = event.tags.filter(([name]) => name === "h");
  const targets = event.tags.filter(([name]) => name === "e");
  const kinds = event.tags.filter(([name]) => name === "k");
  return (
    channels.length === 1 &&
    channels[0][1].length > 0 &&
    channels[0][1].length <= 256 &&
    targets.length > 0 &&
    targets.length <= 100 &&
    targets.every(([, id]) => /^[0-9a-f]{64}$/.test(id)) &&
    new Set(targets.map(([, id]) => id)).size === targets.length &&
    kinds.length > 0 &&
    kinds.length <= 3 &&
    kinds.every(([, kind]) => ["7", "9", "40002"].includes(kind))
  );
}

/** Only explicit bot enrollment; never removal, role elevation or arbitrary kind-9000 tags. */
export function validAgentEnrollment(event) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    event?.kind !== 9000 ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length !== 4
  )
    return false;
  const validators = {
    h: uuid,
    p: /^[0-9a-f]{64}$/,
    role: /^bot$/,
    "client-id": uuid,
  };
  return (
    new Set(event.tags.map((tag) => tag?.[0])).size === 4 &&
    event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length === 2 &&
        typeof tag[1] === "string" &&
        Object.hasOwn(validators, tag[0]) &&
        validators[tag[0]].test(tag[1]),
    )
  );
}
/** Base Buzz agent delete: only removal of one member, relay-authorized. */
export function validAgentRemoval(event) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const [h, p, clientId, ...extra] = Array.isArray(event?.tags)
    ? event.tags
    : [];
  return (
    event?.kind === 9001 &&
    event.content === "" &&
    Number.isSafeInteger(event.created_at) &&
    event.created_at >= 0 &&
    !extra.length &&
    [h, p, clientId].every((tag) => Array.isArray(tag) && tag.length === 2) &&
    h[0] === "h" &&
    uuid.test(h[1]) &&
    p[0] === "p" &&
    /^[0-9a-f]{64}$/.test(p[1]) &&
    clientId[0] === "client-id" &&
    uuid.test(clientId[1])
  );
}
export function validChannelActivityFilters(filters) {
  return (
    Array.isArray(filters) &&
    filters.length >= 1 &&
    filters.length <= 128 &&
    filters.every(
      (filter) =>
        filter &&
        typeof filter === "object" &&
        filter.limit === 1 &&
        Array.isArray(filter.kinds) &&
        filter.kinds.length === 5 &&
        [9, 40002, 40008, 45001, 45003].every((kind) =>
          filter.kinds.includes(kind),
        ) &&
        Array.isArray(filter["#h"]) &&
        filter["#h"].length === 1 &&
        typeof filter["#h"][0] === "string" &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(filter["#h"][0]) &&
        Object.keys(filter).every((key) =>
          ["kinds", "#h", "limit"].includes(key),
        ),
    )
  );
}
export function validFilters(filters) {
  return (
    Array.isArray(filters) &&
    filters.length >= 1 &&
    (filters.length <= MAX_FILTERS || isWorkflowDefinitionBatch(filters)) &&
    filters.every(
      (filter) =>
        filter &&
        typeof filter === "object" &&
        ((Array.isArray(filter.kinds) &&
          filter.kinds.length > 0 &&
          filter.kinds.every(
            (kind) => Number.isInteger(kind) && kind >= 0 && kind <= 65535,
          )) ||
          (filter.kinds === undefined &&
            Array.isArray(filter.ids) &&
            filter.ids.length > 0)) &&
        Number.isInteger(filter.limit) &&
        filter.limit >= 1 &&
        filter.limit <= MAX_LIMIT,
    )
  );
}
const CONNECT_FAILURES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
export const isConnectFailure = (error) =>
  CONNECT_FAILURES.has(error?.code) || CONNECT_FAILURES.has(error?.cause?.code);
const NETWORK_FAILURES = new Set([
  ...CONNECT_FAILURES,
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
// Exception messages and stacks can contain response bodies or credentialed URLs.
// Keep diagnostic categories/codes without turning errors into payload dumps.
function failureSummary(error) {
  const category = [
    "TypeError",
    "SyntaxError",
    "RangeError",
    "AbortError",
    "TimeoutError",
  ].includes(error?.name)
    ? error.name
    : "Error";
  const code = [error?.code, error?.cause?.code].find((value) =>
    NETWORK_FAILURES.has(value),
  );
  return `${category}${code ? ` (${code})` : ""}`;
}
const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};

/** @returns {import('vite').Plugin} */
export function relayBrokerPlugin({
  authorizedViewer,
  relayUrl,
  communityAliases,
  identity = () => loadIdentity(authorizedViewer),
  authority = relayAuthority,
  upstreamFetch,
  socketFactory,
  agentLibrary = readAgentLibrary,
  builderlab: builderlabOptions = {},
} = {}) {
  const aliases = parseCommunityAliases(communityAliases);
  const defaultRelay = relayUrl?.trim() ? relayOrigin(relayUrl) : undefined;
  return {
    name: "buzz-relay-broker",
    async configureServer(server) {
      const log = getLogger("relay-broker");
      const key = identity();
      const viewer = getPublicKey(key);
      const upstream = createUpstream();
      // Injected fixtures bypass the pool; the live relay always uses the warm agent.
      const fetchUpstream = upstreamFetch ?? upstream.fetch;
      const readSidebarHead = async (response, label = "preference") => {
        if (!response.body)
          throw new Error(`Sidebar ${label} response missing`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0,
          text = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return JSON.parse(text + decoder.decode());
            bytes += value.byteLength;
            if (bytes > SIDEBAR_HEAD_BYTES)
              throw new Error(`Sidebar ${label} response exceeds capacity`);
            text += decoder.decode(value, { stream: true });
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };

      // Discovery is lazy and independent for each community; unavailable relays never block startup.
      const registered = new Map(Object.entries(aliases));
      const authorities = new Map();
      const gifSearchPaths = new Map();
      const getAuthority = (relay) => {
        if (!authorities.has(relay))
          authorities.set(
            relay,
            authority(fetchUpstream, relay).catch((error) => {
              authorities.delete(relay);
              throw error;
            }),
          );
        return authorities.get(relay);
      };
      const getGifSearchPath = (relay) => {
        if (!gifSearchPaths.has(relay))
          gifSearchPaths.set(
            relay,
            fetchUpstream(relay, {
              headers: { Accept: "application/nostr+json" },
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            })
              .then(async (response) => {
                if (!response.ok) throw new Error("GIF discovery failed");
                const path = relayKlipySearchPath(await response.json());
                // A relay can enable GIFs while this broker is still running.
                if (!path) gifSearchPaths.delete(relay);
                return path;
              })
              .catch((error) => {
                gifSearchPaths.delete(relay);
                throw error;
              }),
          );
        return gifSearchPaths.get(relay);
      };
      const stats = { queries: 0, errors: 0, media: 0, connects: 0 };
      let inflight = 0;
      let gitReads = 0;
      let presenceFlight = false;
      let sidebarUploads = 0;
      let attachmentUploads = 0;
      let libraryRead;
      const sidebarMutations = new Map();
      const streams = new Map();
      const admissions = createHostAdmission();
      const builderlab = createBuilderlab({
        key: () => key,
        ...builderlabOptions,
      });
      server.httpServer?.once("close", () => {
        for (const { close } of streams.values()) close();
        key.fill(0);

        void upstream.close();
      });
      log.info(
        `signing as ${viewer.slice(0, 8)}… for explicitly selected communities (lazy, scoped connections)`,
      );
      server.middlewares.use(async (req, res, next) => {
        if (
          !req.url?.startsWith("/api/relay/") &&
          !req.url?.startsWith("/api/builderlab/")
        )
          return next();
        const startedAt = Date.now();
        const route = new URL(req.url, "http://localhost").pathname;
        res.on("finish", () => {
          const severity =
            res.statusCode >= 500 ? 0 : res.statusCode >= 400 ? 1 : 4;
          if (log.level < severity) return;
          const line = `${req.method} ${httpLabel(route)} → ${res.statusCode} (${Date.now() - startedAt}ms)`;
          if (res.statusCode >= 500) log.error(line);
          else if (res.statusCode >= 400) log.warn(line);
          else log.debug(line);
        });
        const origin = `http://${req.headers.host ?? ""}`;
        // Same-origin browser access only; trusted plugins/local processes are not sandboxed.
        if (!/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host ?? ""))
          return json(res, 403, { error: "Host rejected" });
        if (
          (req.method === "POST" && req.headers.origin !== origin) ||
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] &&
            req.headers["sec-fetch-site"] !== "same-origin")
        ) {
          log.warn(
            `Rejected ${req.method} ${httpLabel(route)}: origin rejected`,
          );
          return json(res, 403, { error: "Origin rejected" });
        }
        const url = new URL(req.url, origin);
        // Own cancellation before awaiting the request body, signing or dispatch.
        const cancel = new AbortController();
        const release = () => cancel.abort();
        res.once("close", release);
        if (res.destroyed) release();
        try {
          if (url.pathname.startsWith("/api/builderlab/")) {
            // Hosted communities plugin only; the session credential never leaves Node.
            const action = url.pathname.slice("/api/builderlab/".length);
            try {
              if (action === "auth" && req.method === "GET")
                return json(res, 200, { auth: await builderlab.auth() });
              if (req.method !== "POST")
                return json(res, 404, { error: "Unknown Builderlab route" });
              let raw = "";
              for await (const part of req) {
                raw += part;
                if (raw.length > 4096)
                  return json(res, 413, { error: "Request too large" });
              }
              if (action === "login")
                return json(res, 200, {
                  auth: await builderlab.login(cancel.signal),
                });
              if (action === "sign-out") {
                builderlab.signOut();
                return json(res, 200, {});
              }
              if (action === "bind")
                return json(res, 200, await builderlab.bind());
              const result = await builderlab.call(
                action,
                raw ? JSON.parse(raw) : {},
              );
              return result
                ? json(res, 200, result)
                : json(res, 404, { error: "Unknown Builderlab route" });
            } catch (error) {
              return json(res, 502, {
                error:
                  error instanceof Error ? error.message : "Builderlab failed",
              });
            }
          }
          if (url.pathname === "/api/relay/register" && req.method === "POST") {
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (raw.length > 4096)
                return json(res, 413, { error: "Relay URL too large" });
            }
            try {
              const value = JSON.parse(raw).url;
              if (typeof value !== "string")
                throw new Error("Enter a relay URL");
              const destination = communityDestination(value, aliases);
              registered.set(destination.id, destination.url);
              return json(res, 200, destination);
            } catch (error) {
              return json(res, 400, {
                error:
                  error instanceof Error ? error.message : "Invalid relay URL",
              });
            }
          }
          if (url.pathname === "/api/relay/stats" && req.method === "GET")
            return json(res, 200, { ...stats, connects: upstream.connects() });
          if (url.pathname === "/api/relay/identity" && req.method === "GET")
            return json(res, 200, { viewer });
          const parts = url.pathname.split("/").filter(Boolean);
          const scoped = parts.length === 4;
          let id;
          try {
            id = scoped
              ? communityDestination(decodeURIComponent(parts[2]), aliases).id
              : undefined;
          } catch {
            return json(res, 400, { error: "Invalid community" });
          }
          const relay = scoped ? registered.get(id) : defaultRelay;
          if (!relay)
            return json(res, 400, {
              error: scoped
                ? "Register this community first"
                : "Select a community or configure BUZZ_RELAY_URL for unscoped requests",
            });
          const route = scoped ? `/api/relay/${parts[3]}` : url.pathname;
          if (route === "/api/relay/identity" && req.method === "GET")
            return json(res, 200, { viewer });
          if (route === "/api/relay/gif-info" && req.method === "GET") {
            const gifSearchPath = await getGifSearchPath(relay);
            return json(res, 200, {
              ...(gifSearchPath
                ? {
                    supported_extensions: ["buzz-gif"],
                    gif: { provider: "klipy", search: gifSearchPath },
                  }
                : {}),
            });
          }
          if (
            (route === "/api/relay/info" || route === "/api/relay/icon-info") &&
            req.method === "GET"
          ) {
            const response = await fetchUpstream(relay, {
              headers: { Accept: "application/nostr+json" },
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok)
              return json(res, response.status, {
                error: "Community discovery failed",
              });
            const info = await response.json();
            // Saved-community icons are public NIP-11 metadata, not join admission.
            if (route === "/api/relay/icon-info")
              return json(res, 200, { icon: info?.icon });
            const gifSearchPath = relayKlipySearchPath(info);
            if (gifSearchPath)
              gifSearchPaths.set(relay, Promise.resolve(gifSearchPath));
            else gifSearchPaths.delete(relay);
            const policyResponse = await fetchUpstream(
              `${relay}/api/join-policy`,
              { redirect: "error", signal: AbortSignal.timeout(10000) },
            );
            if (!policyResponse.ok && policyResponse.status !== 404)
              return json(res, policyResponse.status, {
                error: "Could not load join policy",
              });
            const policy =
              policyResponse.status === 404
                ? null
                : (await policyResponse.json()).policy;
            return json(res, 200, {
              name: info.name,
              icon: info.icon,
              policy: policy ?? null,
              ...(gifSearchPath
                ? {
                    supported_extensions: ["buzz-gif"],
                    gif: { provider: "klipy", search: gifSearchPath },
                  }
                : {}),
            });
          }
          if (
            [
              "/api/relay/sidebar-preferences",
              "/api/relay/read-state-decode",
              "/api/relay/channel-kit-decode",
            ].includes(route) &&
            req.method === "POST"
          ) {
            const readStateDecode = route === "/api/relay/read-state-decode";
            const kitDecode = route === "/api/relay/channel-kit-decode";
            if (sidebarUploads >= SIDEBAR_UPLOAD_SLOTS)
              return json(res, 429, { error: "Sidebar decoder is busy" });
            sidebarUploads++;
            // Whole-upload deadline, not an idle timeout that trickled bytes reset.
            const deadline = setTimeout(() => req.destroy(), SIDEBAR_UPLOAD_MS);
            deadline.unref();
            try {
              const chunks = [];
              let bytes = 0;
              for await (const part of req) {
                bytes += Buffer.byteLength(part);
                if (
                  bytes >
                  (readStateDecode || kitDecode
                    ? READ_STATE_DECODE_BYTES
                    : SIDEBAR_REQUEST_BYTES)
                )
                  return json(res, 413, {
                    error: "Sidebar records exceed the decode budget",
                  });
                chunks.push(part);
              }
              const events = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              return json(
                res,
                200,
                kitDecode
                  ? decodeChannelKit(events, key, relay)
                  : readStateDecode
                    ? decodeReadState(events, key)
                    : decodeSidebarPreferences(events, key),
              );
            } catch {
              if (!res.destroyed)
                return json(res, 400, {
                  error: readStateDecode
                    ? "Read state could not be decoded"
                    : "Sidebar preferences could not be decoded",
                });
            } finally {
              clearTimeout(deadline);
              sidebarUploads--;
            }
          }
          if (route === "/api/relay/sidebar-sort" && req.method === "POST") {
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (Buffer.byteLength(raw) > 32 * 1024)
                return json(res, 413, {
                  error: `Sidebar preference intent is too large`,
                });
            }
            let intent;
            try {
              intent = JSON.parse(raw);
              assertSidebarSortIntent(intent);
            } catch {
              return json(res, 400, {
                error: `Invalid sidebar preference intent`,
              });
            }
            const request = new AbortController();
            const close = () => request.abort();
            res.once("close", close);
            const previous = sidebarMutations.get(relay) ?? Promise.resolve();
            const mutation = previous
              .catch(() => {})
              .then(async () => {
                request.signal.throwIfAborted();
                const filter = [
                  {
                    kinds: [30078],
                    authors: [viewer],
                    "#d": ["channel-sort"],
                    limit: 1,
                  },
                ];
                const lane = admissions(relay, viewer).api;
                const requestSignal = AbortSignal.any([
                  request.signal,
                  AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
                ]);
                const dispatch = (path, body) =>
                  admittedApiRequest(
                    lane,
                    () => {
                      requestSignal.throwIfAborted();
                      const value = JSON.stringify(body);
                      const auth = finalizeEvent(
                        {
                          kind: 27235,
                          created_at: Math.floor(Date.now() / 1000),
                          content: "",
                          tags: [
                            ["u", `${relay}${path}`],
                            ["method", "POST"],
                            [
                              "payload",
                              createHash("sha256").update(value).digest("hex"),
                            ],
                            ["nonce", randomBytes(16).toString("hex")],
                          ],
                        },
                        key,
                      );
                      return fetchUpstream(`${relay}${path}`, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization:
                            "Nostr " +
                            Buffer.from(JSON.stringify(auth)).toString(
                              "base64",
                            ),
                        },
                        body: value,
                        redirect: "error",
                        signal: requestSignal,
                      });
                    },
                    requestSignal,
                  );
                const readHead = async () => {
                  const response = await dispatch("/query", filter);
                  if (!response.ok)
                    throw new Error(
                      `Sidebar preference query failed (${response.status})`,
                    );
                  return readSidebarHead(response);
                };
                const publishEvent = async (event) => {
                  const response = await dispatch("/events", event);
                  if (!response.ok)
                    throw new Error(
                      `Sidebar preference publish failed (${response.status})`,
                    );
                  const receipt = await readSidebarHead(
                    response,
                    "publication",
                  );
                  if (
                    receipt.event_id !== event.id ||
                    receipt.accepted !== true
                  )
                    throw new Error(
                      "Sidebar preference publication was not accepted",
                    );
                };
                return {
                  groups: await mutateSidebarSort(
                    intent,
                    key,
                    readHead,
                    publishEvent,
                  ),
                };
              });
            sidebarMutations.set(relay, mutation);
            try {
              return json(res, 200, await mutation);
            } catch (error) {
              if (error instanceof ApiPaused)
                return json(res, 429, {
                  error: error.message,
                  sent: false,
                  paused: true,
                  retryAfterMs: error.retryAfterMs,
                });
              return json(res, 502, {
                error:
                  error instanceof Error
                    ? error.message
                    : `Sidebar preference failed`,
              });
            } finally {
              res.off("close", close);
              if (sidebarMutations.get(relay) === mutation)
                sidebarMutations.delete(relay);
            }
          }
          if (route === "/api/relay/sidebar-mute" && req.method === "POST") {
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (Buffer.byteLength(raw) > 2048)
                return json(res, 413, {
                  error: `Sidebar preference intent is too large`,
                });
            }
            let intent;
            try {
              intent = JSON.parse(raw);
              assertSidebarMuteIntent(intent);
            } catch {
              return json(res, 400, {
                error: `Invalid sidebar preference intent`,
              });
            }
            const stream = streams.get(req.headers["x-buzz-live-id"]);
            if (!stream || stream.relay !== relay)
              return json(res, 503, {
                error: "Publication socket unavailable",
                sent: false,
              });
            const request = new AbortController();
            const close = () => request.abort();
            res.once("close", close);
            const previous = sidebarMutations.get(relay) ?? Promise.resolve();
            const mutation = previous
              .catch(() => {})
              .then(async () => {
                request.signal.throwIfAborted();
                const filter = [
                  {
                    kinds: [30078],
                    authors: [viewer],
                    "#d": ["channel-mutes"],
                    limit: 1,
                  },
                ];
                const lane = admissions(relay, viewer).api;
                const requestSignal = AbortSignal.any([
                  request.signal,
                  AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
                ]);
                const dispatch = (path, body) =>
                  admittedApiRequest(
                    lane,
                    () => {
                      requestSignal.throwIfAborted();
                      const value = JSON.stringify(body);
                      const auth = finalizeEvent(
                        {
                          kind: 27235,
                          created_at: Math.floor(Date.now() / 1000),
                          content: "",
                          tags: [
                            ["u", `${relay}${path}`],
                            ["method", "POST"],
                            [
                              "payload",
                              createHash("sha256").update(value).digest("hex"),
                            ],
                            ["nonce", randomBytes(16).toString("hex")],
                          ],
                        },
                        key,
                      );
                      return fetchUpstream(`${relay}${path}`, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization:
                            "Nostr " +
                            Buffer.from(JSON.stringify(auth)).toString(
                              "base64",
                            ),
                        },
                        body: value,
                        redirect: "error",
                        signal: requestSignal,
                      });
                    },
                    requestSignal,
                  );
                const readHead = async () => {
                  const response = await dispatch("/query", filter);
                  if (!response.ok)
                    throw new Error(
                      `Sidebar preference query failed (${response.status})`,
                    );
                  return readSidebarHead(response);
                };
                const publishEvent = (event) =>
                  stream.traffic.publish(event, requestSignal);
                return mutateSidebarMute(intent, key, readHead, publishEvent);
              });
            sidebarMutations.set(relay, mutation);
            try {
              return json(res, 200, await mutation);
            } catch (error) {
              if (error instanceof ApiPaused)
                return json(res, 429, {
                  error: error.message,
                  sent: false,
                  paused: true,
                  retryAfterMs: error.retryAfterMs,
                });
              return json(res, 502, {
                error:
                  error instanceof Error
                    ? error.message
                    : `Sidebar preference failed`,
              });
            } finally {
              res.off("close", close);
              if (sidebarMutations.get(relay) === mutation)
                sidebarMutations.delete(relay);
            }
          }
          if (
            [
              "/api/relay/sidebar-assignment",
              "/api/relay/sidebar-star",
            ].includes(route) &&
            req.method === "POST"
          ) {
            const starring = route === "/api/relay/sidebar-star";
            const chunks = [];
            let bytes = 0;
            for await (const part of req) {
              bytes += part.length;
              if (bytes > 2048)
                return json(res, 413, {
                  error: `Sidebar preference intent is too large`,
                });
              chunks.push(part);
            }
            let intent;
            try {
              intent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (starring) assertSidebarStarIntent(intent);
              else assertSidebarAssignmentIntent(intent);
            } catch {
              return json(res, 400, {
                error: `Invalid sidebar preference intent`,
              });
            }
            const request = new AbortController();
            const close = () => request.abort();
            res.once("close", close);
            const previous = sidebarMutations.get(relay) ?? Promise.resolve();
            const mutation = previous
              .catch(() => {})
              .then(async () => {
                request.signal.throwIfAborted();
                const filter = [
                  {
                    kinds: [30078],
                    authors: [viewer],
                    "#d": [starring ? "channel-stars" : "channel-sections"],
                    limit: 1,
                  },
                ];
                const lane = admissions(relay, viewer).api;
                const requestSignal = AbortSignal.any([
                  request.signal,
                  AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
                ]);
                const dispatch = (path, body) =>
                  admittedApiRequest(
                    lane,
                    () => {
                      requestSignal.throwIfAborted();
                      const value = JSON.stringify(body);
                      const auth = finalizeEvent(
                        {
                          kind: 27235,
                          created_at: Math.floor(Date.now() / 1000),
                          content: "",
                          tags: [
                            ["u", `${relay}${path}`],
                            ["method", "POST"],
                            [
                              "payload",
                              createHash("sha256").update(value).digest("hex"),
                            ],
                            ["nonce", randomBytes(16).toString("hex")],
                          ],
                        },
                        key,
                      );
                      return fetchUpstream(`${relay}${path}`, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization:
                            "Nostr " +
                            Buffer.from(JSON.stringify(auth)).toString(
                              "base64",
                            ),
                        },
                        body: value,
                        redirect: "error",
                        signal: requestSignal,
                      });
                    },
                    requestSignal,
                  );
                const readHead = async () => {
                  const response = await dispatch("/query", filter);
                  if (!response.ok)
                    throw new Error(
                      `Sidebar preference query failed (${response.status})`,
                    );
                  return readSidebarHead(response);
                };
                const publishEvent = async (event) => {
                  const response = await dispatch("/events", event);
                  if (!response.ok)
                    throw new Error(
                      `Sidebar preference publish failed (${response.status})`,
                    );
                  const receipt = await readSidebarHead(
                    response,
                    "publication",
                  );
                  if (
                    receipt.event_id !== event.id ||
                    receipt.accepted !== true
                  )
                    throw new Error(
                      "Sidebar preference publication was not accepted",
                    );
                };
                return (starring ? mutateSidebarStar : mutateSidebarAssignment)(
                  intent,
                  key,
                  readHead,
                  publishEvent,
                );
              });
            sidebarMutations.set(relay, mutation);
            try {
              return json(res, 200, await mutation);
            } catch (error) {
              if (error instanceof ApiPaused)
                return json(res, 429, {
                  error: error.message,
                  sent: false,
                  paused: true,
                  retryAfterMs: error.retryAfterMs,
                });
              return json(res, 502, {
                error:
                  error instanceof Error
                    ? error.message
                    : `Sidebar preference failed`,
              });
            } finally {
              res.off("close", close);
              if (sidebarMutations.get(relay) === mutation)
                sidebarMutations.delete(relay);
            }
          }
          if (route === "/api/relay/agent-library" && req.method === "GET") {
            try {
              // Share concurrent reads, never retain the local snapshot after completion.
              libraryRead ??= Promise.resolve()
                .then(() => agentLibrary())
                .finally(() => {
                  libraryRead = undefined;
                });
              return json(res, 200, await libraryRead);
            } catch {
              return json(res, 503, {
                error:
                  "Current Buzz agent library unavailable; no files were changed",
              });
            }
          }
          if (route === "/api/relay/session" && req.method === "GET") {
            return json(res, 200, {
              viewer,
              ...(await getAuthority(relay)),
              relayUrl: relay,
              // Display base for relay HTTP routes such as /hooks/{workflow_id}.
              relayHttpUrl: relay,
              directMessages: true,
              writeKinds: [
                30315,
                30030,
                7,
                9,
                40003,
                42000,
                9000,
                9001,
                30078,
                40100,
                1984,
                ...WORKFLOW_KINDS,
                ...((await getAuthority(relay)).channelCreation ? [9007] : []),
              ],
              channelLifecycle: true,
              channelDetails: true,
              identityArchives: true,
              workflowReads: true,
              projectGit: true,
              attachmentUploads: true,
              sidebarPreferences: true,
              sidebarSortWrites: true,
              channelActivity: true,
              sidebarMuteWrites: true,
              channelKit: true,
              readState: true,
              sidebarPreferenceWrites: true,
              sidebarStarWrites: true,
              agentLibrary: true,
              agentLogProof: true,
              agentMemories: true,
              live: true,
              presence: true,
              agentActivity: true,
            });
          }
          if (
            [
              "/api/relay/stream-retry",
              "/api/relay/stream-priority",
              "/api/relay/stream-interests",
              "/api/relay/stream-observer",
              "/api/relay/stream-presence",
              "/api/relay/stream-presence-authors",
            ].includes(route) &&
            req.method === "POST"
          ) {
            const publishingPresence = route === "/api/relay/stream-presence";
            const watchingPresence =
              route === "/api/relay/stream-presence-authors";
            const prioritizing = route === "/api/relay/stream-priority";
            const observing = route === "/api/relay/stream-observer";
            const updating = route === "/api/relay/stream-interests";
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (
                Buffer.byteLength(raw) >
                (updating
                  ? 450000
                  : watchingPresence
                    ? 20000
                    : prioritizing
                      ? 9000
                      : 256)
              )
                return json(res, 413, { error: "Live control too large" });
            }
            let streamId,
              presenceAuthors,
              priority,
              observer,
              status,
              interests,
              joined,
              removed,
              interestRevision;
            try {
              const body = JSON.parse(raw);
              streamId = body.streamId;
              if (publishingPresence) {
                status = body.status;
                if (
                  status !== "online" &&
                  status !== "away" &&
                  status !== "offline"
                )
                  throw new Error("Invalid presence");
              }
              if (observing) observer = observerGeneration(body.observer);
              if (watchingPresence)
                presenceAuthors = livePresenceAuthors(body.authors);
              if (updating) {
                interests = liveChannels(body.channels);
                joined = liveJoined(interests, body.joined ?? []);
                removed = liveChannels(body.removed ?? []);
                interestRevision = body.interestRevision;
                if (
                  !Number.isSafeInteger(interestRevision) ||
                  interestRevision < 0
                )
                  throw new Error("Invalid interest revision");
              }
              if (prioritizing) {
                liveChannels(body.channels);
                if (body.channels.length > 64)
                  throw new Error("Priority capacity reached");
                priority = [...new Set(body.channels)];
              }
            } catch {
              return json(res, 400, { error: "Invalid live control" });
            }
            if (
              typeof streamId !== "string" ||
              !/^[0-9a-f]{32}$/.test(streamId)
            )
              return json(res, 400, { error: "Invalid live control" });
            const stream = streams.get(streamId);
            if (
              (publishingPresence || watchingPresence) &&
              (!stream || stream.relay !== relay)
            )
              return json(res, 200, { accepted: null });
            if (!stream || stream.relay !== relay)
              return json(res, 404, {
                error: "Live stream no longer available",
              });
            if (publishingPresence) {
              const cancel = new AbortController();
              const abort = () => cancel.abort();
              res.once("close", abort);
              try {
                const accepted = await stream.traffic.publishPresence(
                  status,
                  cancel.signal,
                );
                if (!res.destroyed)
                  return json(
                    res,
                    200,
                    accepted && typeof accepted === "object"
                      ? { accepted: null, retryAfterMs: accepted.retryAfterMs }
                      : { accepted },
                  );
              } finally {
                res.off("close", abort);
              }
              return;
            }
            if (updating) {
              if (interestRevision <= stream.interestRevision)
                return json(res, 409, { error: "Stale interest control" });
              // Coalescing may hide a removal followed by re-add. Retire the old
              // wire before stamping the new revision; unchanged routes survive.
              if (removed.length) {
                stream.traffic.update(
                  stream.channels.filter((id) => !removed.includes(id)),
                  stream.joined.filter((id) => !removed.includes(id)),
                );
              }
              stream.interestRevision = interestRevision;
              stream.channels = interests;
              stream.joined = joined;
              stream.traffic.update(interests, joined);
            } else if (prioritizing) stream.traffic.prioritize(priority);
            else if (observing) stream.traffic.observe(observer);
            else if (watchingPresence)
              stream.traffic.watchPresence(presenceAuthors);
            else stream.traffic.retry();
            return json(res, 200, { accepted: true });
          }
          if (route === "/api/relay/stream" && req.method === "POST") {
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (Buffer.byteLength(raw) > 300000)
                return json(res, 413, { error: "Live interests too large" });
            }
            let channels,
              joined,
              priority,
              observer,
              interestRevision,
              presenceAuthors;
            try {
              const body = JSON.parse(raw);
              channels = liveChannels(body.channels);
              joined = liveJoined(channels, body.joined ?? []);
              interestRevision = body.interestRevision ?? 0;
              if (
                !Number.isSafeInteger(interestRevision) ||
                interestRevision < 0
              )
                throw new Error("Invalid interest revision");
              observer = observerGeneration(body.observer ?? null);
              presenceAuthors = livePresenceAuthors(body.presenceAuthors ?? []);
              liveChannels(body.priority ?? []);
              if (body.priority?.length > 64)
                throw new Error("Priority capacity reached");
              priority = [...new Set(body.priority ?? [])];
            } catch {
              return json(res, 400, {
                error: "Invalid live channel interests",
              });
            }
            if (streams.size >= 8)
              return json(res, 429, { error: "Live stream capacity reached" });
            const principal = admissions(relay, viewer);
            const streamId = randomBytes(16).toString("hex");
            // An SSE response lasts until disconnect and cannot be reused. Close
            // delimiting avoids WebKit buffering trailing HTTP chunks until a later
            // write (which can otherwise delay establishment until the heartbeat).
            res.useChunkedEncodingByDefault = false;
            res.writeHead(200, {
              "X-Buzz-Live-ID": streamId,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              Connection: "close",
            });
            res.flushHeaders();
            // Bound slow-client buffering rather than retaining unbounded traffic.
            const write = (kind, value) => {
              if (res.destroyed) return;
              if (res.writableLength > 2 * 1024 * 1024) {
                res.destroy();
                return;
              }
              res.write(
                `${kind ? `event: ${kind}\n` : ""}data: ${JSON.stringify(value)}\n\n`,
              );
            };
            // Coalesce setup progress, not invalidation: activity typing must see
            // channels leave live before recovery or subsequent traffic. Drain sends
            // the latest captured revision without a full roster for every EOSE.
            let pendingState;
            let lastStateStatus;
            let lastObserverStatus;
            let liveChannelIds = new Set();
            const flushState = () => {
              const state = pendingState;
              pendingState = undefined;
              if (state) write("state", state);
            };
            const writeState = (state) => {
              const observerStatus = state.routes.find(
                (route) => route.id === "observer",
              )?.status;
              const replaceable =
                state.status === "connected" &&
                lastStateStatus === "connected" &&
                observerStatus === lastObserverStatus &&
                !state.routes.some(
                  (route) =>
                    route.channelId &&
                    route.status !== "live" &&
                    liveChannelIds.has(route.channelId),
                );
              liveChannelIds = new Set(
                state.routes
                  .filter((route) => route.channelId && route.status === "live")
                  .map((route) => route.channelId),
              );
              lastStateStatus = state.status;
              lastObserverStatus = observerStatus;
              pendingState = undefined;
              if (replaceable && res.writableNeedDrain) pendingState = state;
              else write("state", state);
            };
            res.on("drain", flushState);
            const stream = {
              relay,
              channels,
              joined,
              interestRevision,
              traffic: undefined,
              close: undefined,
            };
            const traffic = subscribeRelayTraffic(
              relay.replace(/^http/, "ws"),
              async (event) => finalizeEvent(event, key),
              viewer,
              {
                receive: (events, provenance) => {
                  for (const event of events)
                    write("traffic", {
                      event,
                      provenance,
                      interestRevision: stream.interestRevision,
                    });
                },
                presence: (event) => write("presence", event),
                telemetry: (event, generation) => {
                  if (res.destroyed) return;
                  try {
                    write("observer", {
                      frame: decodeAgentObserver(event, key, viewer),
                      generation,
                    });
                  } catch {
                    // Rejected telemetry cannot break chat or leak payloads in logs.
                  }
                },
                state: (state) =>
                  writeState({
                    ...state,
                    interestRevision: stream.interestRevision,
                  }),
                established: (channelId) =>
                  write("established", {
                    ...(Array.isArray(channelId)
                      ? { channels: channelId }
                      : { channelId }),
                    interestRevision: stream.interestRevision,
                  }),
                recover: () => write("recover", {}),
                denied: (channelId, reason) =>
                  write("denied", {
                    channelId,
                    reason,
                    interestRevision: stream.interestRevision,
                  }),
              },
              socketFactory,
              principal.live,
            );
            principal.streams++;
            traffic.observe(observer);
            traffic.watchPresence(presenceAuthors);
            traffic.prioritize(priority);
            traffic.update(channels, joined);
            const keepAlive = setInterval(
              () => res.write(": keepalive\n\n"),
              15000,
            );
            let closed = false;
            const close = () => {
              if (closed) return;
              closed = true;
              principal.streams--;
              pendingState = undefined;
              res.off("drain", flushState);
              traffic.dispose();
              clearInterval(keepAlive);
              streams.delete(streamId);
              res.destroy();
            };
            Object.assign(stream, { traffic, close });
            streams.set(streamId, stream);
            res.once("close", close);
            if (res.destroyed) close();
            return;
          }
          if (route === "/api/relay/stats" && req.method === "GET")
            return json(res, 200, { ...stats, connects: upstream.connects() });
          if (
            ["/api/relay/upload", "/api/relay/prepare-media"].includes(route) &&
            req.method === "POST"
          ) {
            if (attachmentUploads >= 2)
              return json(res, 429, { code: "capacity" });
            attachmentUploads++;
            try {
              if (route === "/api/relay/prepare-media") {
                await prepareMedia(
                  req,
                  cancel.signal,
                  async (path, type, size, signal) => {
                    signal.throwIfAborted();
                    res.writeHead(200, {
                      "Content-Type": type,
                      "Content-Length": size,
                      "Cache-Control": "no-store",
                      "X-Content-Type-Options": "nosniff",
                    });
                    await pipeline(createReadStream(path), res, { signal });
                  },
                );
                return;
              }
              const result = await uploadAttachment(
                req,
                relay,
                key,
                fetchUpstream,
                cancel.signal,
              );
              return json(res, 200, result);
            } catch (error) {
              if (!res.destroyed)
                return json(
                  res,
                  error instanceof UploadError ? error.status : 502,
                  {
                    code: error instanceof UploadError ? error.code : "failed",
                  },
                );
            } finally {
              attachmentUploads--;
            }
            return;
          }
          if (route === "/api/relay/media" && req.method === "GET") {
            const target = new URL(url.searchParams.get("url") ?? "", relay);
            if (
              target.origin !== relay ||
              !target.pathname.startsWith("/media/")
            )
              return json(res, 403, { error: "Media target rejected" });
            const now = Math.floor(Date.now() / 1000);
            const auth = finalizeEvent(
              {
                kind: 24242,
                created_at: now,
                content: "Get buzz-media",
                tags: [
                  ["t", "get"],
                  [
                    "expiration",
                    String(now + Math.ceil(UPLOAD_TIMEOUT_MS / 1000) + 60),
                  ],
                  ["server", new URL(relay).host],
                ],
              },
              key,
            );
            const range = req.headers.range;
            if (
              range !== undefined &&
              (typeof range !== "string" || !/^bytes=\d+-\d*$/.test(range))
            )
              return json(res, 416, { error: "Media range rejected" });
            const mediaDeadline = AbortSignal.any([
              cancel.signal,
              AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
            ]);
            const upstream = await fetchUpstream(target, {
              headers: {
                Authorization:
                  "Nostr " +
                  Buffer.from(JSON.stringify(auth)).toString("base64url"),
                ...(range ? { Range: range } : {}),
              },
              redirect: "error",
              signal: mediaDeadline,
            });
            stats.media++;
            if (!upstream.ok) {
              await upstream.body?.cancel();
              return json(res, upstream.status, { error: "Media read failed" });
            }
            const type = upstream.headers.get("content-type") ?? "";
            const mediaType = type.split(";", 1)[0].trim().toLowerCase();
            const trustedType =
              /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
                mediaType,
              );
            const image =
              trustedType &&
              mediaType.startsWith("image/") &&
              mediaType !== "image/svg+xml";
            const video = trustedType && mediaType.startsWith("video/");
            const audio = trustedType && mediaType.startsWith("audio/");
            const streamable = video || audio;
            const download = !image && !streamable;
            const length = Number(upstream.headers.get("content-length"));
            // Audio is read-compatible, not part of attachment upload parity.
            const limit =
              audio && upstream.status !== 206
                ? 20 * 1024 * 1024
                : mediaByteLimit(mediaType);
            if (Number.isFinite(length) && length > limit) {
              await upstream.body?.cancel();
              return json(res, 413, { error: "Media budget exceeded" });
            }
            const headers = {
              "Content-Type": download ? "application/octet-stream" : mediaType,
              "Cache-Control": "private, max-age=3600",
              "X-Content-Type-Options": "nosniff",
              ...(download ? { "Content-Disposition": "attachment" } : {}),
              ...(upstream.headers.get("content-length")
                ? { "Content-Length": upstream.headers.get("content-length") }
                : {}),
              ...(upstream.headers.get("content-range")
                ? { "Content-Range": upstream.headers.get("content-range") }
                : {}),
              ...(upstream.headers.get("accept-ranges") || streamable
                ? {
                    "Accept-Ranges":
                      upstream.headers.get("accept-ranges") ?? "bytes",
                  }
                : {}),
            };
            res.writeHead(upstream.status, headers);
            if (!upstream.body) return res.end();
            let received = 0;
            const meter = new Transform({
              transform(chunk, _encoding, callback) {
                received += chunk.length;
                callback(
                  received > limit ? new Error("Media budget exceeded") : null,
                  chunk,
                );
              },
            });
            // All media/downloads use backpressure; failed streams cannot emit JSON after headers.
            try {
              await pipeline(Readable.fromWeb(upstream.body), meter, res, {
                signal: mediaDeadline,
              });
            } catch {
              res.destroy();
            }
            return;
          }
          if (
            ![
              "/api/relay/query",
              "/api/relay/agent-memories",
              "/api/relay/presence-snapshot",
              "/api/relay/channel-activity",
              "/api/relay/sign",
              "/api/relay/channel-details-sign",
              "/api/relay/channel-details-publish",
              "/api/relay/channel-lifecycle-sign",
              "/api/relay/channel-lifecycle-publish",
              "/api/relay/identity-archive-sign",
              "/api/relay/identity-archive-publish",
              "/api/relay/publish",
              "/api/relay/read-state-sign",
              "/api/relay/channel-kit-prepare",
              "/api/relay/read-state-publish",
              "/api/relay/profile",
              "/api/relay/direct-message",
              "/api/relay/authorize-agent",
              "/api/relay/agent-log-proof",
              "/api/relay/resolve-agent-community",
              "/api/relay/claim",
              "/api/relay/accept-policy",
              "/api/relay/invite",
              "/api/relay/member",
              "/api/relay/gifs",
              "/api/relay/workflow-runs",
              "/api/relay/project-git",
            ].includes(route) ||
            req.method !== "POST"
          )
            return json(res, 404, { error: "Unknown broker route" });
          const memory = route === "/api/relay/agent-memories";
          const presence = route === "/api/relay/presence-snapshot";
          let raw = "";
          const uploadDeadline = memory
            ? setTimeout(() => req.destroy(), 10000)
            : undefined;
          try {
            for await (const part of req) {
              raw += part;
              if (
                presence
                  ? Buffer.byteLength(raw) > 20 * 1024
                  : raw.length > 65536
              )
                return json(res, 413, { error: "Filter body too large" });
            }
          } finally {
            clearTimeout(uploadDeadline);
          }
          let filters;
          try {
            filters = JSON.parse(raw);
          } catch {
            return json(res, 400, { error: "Filter body is not JSON" });
          }
          let memoryAgent;
          if (memory) {
            try {
              if (!scoped)
                throw new Error("Memory reads need an explicit community");
              const query = memoryFilter(filters, viewer);
              memoryAgent = filters.agent;
              filters = query;
            } catch {
              return json(res, 400, { error: "Invalid memory target" });
            }
          }
          if (route === "/api/relay/channel-kit-prepare") {
            try {
              cancel.signal.throwIfAborted();
              return json(res, 200, {
                content: prepareChannelKit(filters, key, relay),
              });
            } catch {
              return json(res, 400, { error: "Invalid channel recipe" });
            }
          }
          if (route === "/api/relay/project-git") {
            let input;
            try {
              input = parseGitRead(filters);
            } catch {
              return json(res, 400, { error: "Invalid repository read" });
            }
            if (gitReads >= 2)
              return json(res, 429, { error: "Repository reads are busy" });
            gitReads++;
            try {
              const result = await admissions(relay, viewer).api.run(
                () =>
                  readProjectGit({
                    input,
                    relay,
                    key,
                    signal: AbortSignal.any([
                      cancel.signal,
                      AbortSignal.timeout(12000),
                    ]),
                  }),
                cancel.signal,
              );
              cancel.signal.throwIfAborted();
              return json(res, 200, result);
            } catch (error) {
              if (!res.destroyed)
                return json(res, error.status ?? 502, {
                  error: "Repository content could not be read",
                });
              return;
            } finally {
              gitReads--;
            }
          }
          if (route === "/api/relay/agent-log-proof") {
            // A proof never delegates the broker's key as a general signing API.
            // Native validates the saved attestation and consumes its challenge.
            let canonicalRelay;
            try {
              canonicalRelay = relayOrigin(filters?.relayUrl);
            } catch {
              return json(res, 400, {
                error: "Invalid harness log authorization",
              });
            }
            const wssRelay = canonicalRelay.replace(/^https:/, "wss:");
            if (
              !scoped ||
              !filters ||
              Object.keys(filters).length !== 4 ||
              typeof filters.id !== "string" ||
              !/^[0-9a-f]{64}-[0-9a-f]{64}$/.test(filters.id) ||
              !/^[0-9a-f]{64}$/.test(filters.pubkey ?? "") ||
              filters.id !==
                `${filters.pubkey}-${createHash("sha256").update(wssRelay).digest("hex")}` ||
              filters.pubkey === viewer ||
              canonicalRelay !== relay ||
              typeof filters.nonce !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                filters.nonce,
              )
            )
              return json(res, 400, {
                error: "Invalid harness log authorization",
              });
            cancel.signal.throwIfAborted();
            const message = `buzz-app:harness-log:v1:${filters.id}:${filters.pubkey}:${wssRelay}:${filters.nonce}`;
            const signature = Buffer.from(
              schnorr.sign(createHash("sha256").update(message).digest(), key),
            ).toString("hex");
            return json(res, 200, { signature });
          }
          if (route === "/api/relay/resolve-agent-community") {
            if (
              !scoped ||
              filters?.owner !== viewer ||
              !/^[0-9a-f]{64}$/.test(filters?.pubkey ?? "") ||
              filters.pubkey === viewer ||
              filters?.confirmed !== true ||
              Object.keys(filters).length !== 3
            )
              return json(res, 400, {
                error: "Explicit owner community resolution required",
              });
            // The signed account confirms setup intent. Native verifies it against
            // retained source-owner authorization; inventory is not permission.
            cancel.signal.throwIfAborted();
            const relayUrl = relay.replace(/^https:/, "wss:");
            const digest = createHash("sha256")
              .update(`nostr:agent-community:${filters.pubkey}:${relayUrl}`)
              .digest();
            return json(res, 200, {
              pubkey: filters.pubkey,
              relayUrl,
              owner: viewer,
              signature: Buffer.from(schnorr.sign(digest, key)).toString("hex"),
            });
          }
          if (route === "/api/relay/authorize-agent") {
            if (
              !scoped ||
              filters?.owner !== viewer ||
              !/^[0-9a-f]{64}$/.test(filters?.pubkey ?? "") ||
              filters.pubkey === viewer ||
              Object.keys(filters).length !== 2
            )
              return json(res, 400, {
                error: "Invalid agent owner authorization",
              });
            cancel.signal.throwIfAborted();
            const digest = createHash("sha256")
              .update(`nostr:agent-auth:${filters.pubkey}:`)
              .digest();
            const signature = Buffer.from(schnorr.sign(digest, key)).toString(
              "hex",
            );
            return json(res, 200, { auth: ["auth", viewer, "", signature] });
          }
          if (presence && !presenceFilter(filters))
            return json(res, 400, { error: "Invalid presence filter" });
          let workflowPath;
          if (route === "/api/relay/workflow-runs") {
            try {
              workflowPath = workflowRunsPath(filters);
            } catch {
              return json(res, 400, {
                error: "Invalid workflow read",
                sent: false,
              });
            }
          }
          const channelActivity = route === "/api/relay/channel-activity";
          if (channelActivity && !validChannelActivityFilters(filters))
            return json(res, 400, { error: "Activity filter rejected" });
          const profile = route === "/api/relay/profile";
          const directMessage = route === "/api/relay/direct-message";
          if (directMessage) {
            try {
              filters = directMessageEvent(filters, viewer, key);
            } catch {
              return json(res, 400, {
                error: "Choose between one and eight other people.",
                sent: false,
              });
            }
          }
          const claim = route === "/api/relay/claim";
          const policy = route === "/api/relay/accept-policy";
          const invite = route === "/api/relay/invite";
          const member = route === "/api/relay/member";
          const gifs = route === "/api/relay/gifs";
          // Only these routes may surface an exact, allowed relay refusal.
          const refusal =
            invite || member ? adminReason : claim ? claimReason : undefined;
          if (invite || member) {
            // Community-bound only; the relay remains the authority for roles.
            if (!scoped)
              return json(res, 400, { error: "Select a community first" });
            try {
              filters = invite
                ? inviteRequest(filters)
                : finalizeEvent(memberCommand(filters), key);
            } catch (error) {
              return json(res, 400, { error: error.message, sent: false });
            }
          }
          if (gifs) {
            if (
              typeof filters?.query !== "string" ||
              filters.query.length > 100 ||
              typeof filters?.customer_id !== "string" ||
              !/^[a-zA-Z0-9:_-]{1,128}$/.test(filters.customer_id) ||
              typeof filters?.locale !== "string" ||
              !/^[a-zA-Z0-9-]{2,35}$/.test(filters.locale)
            )
              return json(res, 400, { error: "Invalid GIF search" });
          }
          if (profile) {
            if (
              typeof filters?.name !== "string" ||
              !filters.name.trim() ||
              filters.name.length > 100 ||
              typeof filters?.picture !== "string" ||
              filters.picture.length > 2048 ||
              !validProfilePicture(filters.picture) ||
              (filters.about !== undefined &&
                (typeof filters.about !== "string" ||
                  filters.about.length > 500))
            )
              return json(res, 400, {
                error:
                  "Profile needs a name, an optional HTTPS picture URL, and a description of 500 characters or fewer",
              });
            // Preserve fields this small editor does not expose.
            const content = {
              ...(filters.existing ?? {}),
              name: filters.name.trim(),
              display_name: filters.name.trim(),
              picture: filters.picture,
              about:
                filters.about === undefined
                  ? typeof filters.existing?.about === "string"
                    ? filters.existing.about
                    : ""
                  : filters.about.trim(),
            };
            if (Buffer.byteLength(JSON.stringify(content)) > 16000)
              return json(res, 400, { error: "Profile too large" });
            filters = finalizeEvent(
              {
                kind: 0,
                content: JSON.stringify(content),
                tags: [],
                created_at: Math.floor(Date.now() / 1000),
              },
              key,
            );
          }
          if (claim || policy) {
            if (
              typeof filters?.code !== "string" ||
              // Relay codes are base64url segments joined by "." (v1 `payload.mac`, v2 `v2.secret`).
              !/^[a-zA-Z0-9._-]{1,256}$/.test(filters.code)
            )
              return json(res, 400, { error: "Invalid invite code" });
            filters = policy
              ? {
                  code: filters.code,
                  policy_version: filters.policy_version,
                  age_confirmed: filters.age_confirmed === true,
                }
              : { code: filters.code, policy_receipt: filters.policy_receipt };
          }
          const readSigning = route === "/api/relay/read-state-sign";
          const readPublishing = route === "/api/relay/read-state-publish";
          if (readSigning || readPublishing) {
            try {
              if (readSigning)
                return json(res, 200, signReadState(filters, key));
              // A valid own signature alone is not permission to publish arbitrary kind-30078 data.
              // Receive-only compatibility must not widen publication admission.
              decodeReadState([filters], key, READ_STATE_EVENT_BYTES);
            } catch {
              return json(res, 400, {
                error: "Read-state operation rejected",
                sent: false,
              });
            }
          }
          const snapshot = isReadSnapshotFilter(filters, viewer);
          if (
            Array.isArray(filters) &&
            filters.some(
              (filter) =>
                filter && Object.hasOwn(filter, "read_state_snapshot"),
            ) &&
            !snapshot
          )
            return json(res, 400, {
              error: "Invalid read-state snapshot filter",
              sent: false,
            });
          if (snapshot && !(await getAuthority(relay)).readStateCommunity)
            return json(res, 400, {
              error: "Complete read-state snapshots unsupported",
              sent: false,
            });
          const timings = [];
          const details =
            route === "/api/relay/channel-details-sign" ||
            route === "/api/relay/channel-details-publish";
          const lifecycle =
            route === "/api/relay/channel-lifecycle-sign" ||
            route === "/api/relay/channel-lifecycle-publish";
          const archive =
            route === "/api/relay/identity-archive-sign" ||
            route === "/api/relay/identity-archive-publish";
          const signing =
            route === "/api/relay/sign" ||
            route === "/api/relay/channel-details-sign" ||
            route === "/api/relay/channel-lifecycle-sign" ||
            route === "/api/relay/identity-archive-sign";
          const publishing =
            route === "/api/relay/publish" ||
            route === "/api/relay/channel-details-publish" ||
            route === "/api/relay/channel-lifecycle-publish" ||
            route === "/api/relay/identity-archive-publish";
          if (signing || publishing) {
            if (archive) {
              try {
                validateArchiveRequestTemplate(filters);
                if (!(await getAuthority(relay)).archiveAuthority)
                  throw new Error("Archive authority unavailable");
              } catch {
                return json(res, 400, {
                  error: "Invalid identity archive request",
                  sent: false,
                });
              }
            } else if (details) {
              try {
                validateDetailsTemplate(filters);
              } catch {
                return json(res, 400, {
                  error: "Invalid channel details command",
                  sent: false,
                });
              }
            } else if (lifecycle) {
              try {
                validateLifecycleTemplate(filters);
              } catch {
                return json(res, 400, {
                  error: "Invalid channel lifecycle command",
                  sent: false,
                });
              }
            } else if (filters?.kind === 30315) {
              if (!validStatusTemplate(filters))
                return json(res, 400, {
                  error: "Status rejected",
                  sent: false,
                });
            } else if (filters?.kind === 30030) {
              if (!validEmojiSetTemplate(filters))
                return json(res, 400, {
                  error: "Emoji set rejected",
                  sent: false,
                });
            } else if (filters?.kind === 9001) {
              if (!validAgentRemoval(filters))
                return json(res, 400, {
                  error: "Agent removal invalid",
                  sent: false,
                });
            } else if ([9000, 9007].includes(filters?.kind)) {
              const enrollment = validAgentEnrollment(filters);
              const authority = await getAuthority(relay);
              if (
                !enrollment &&
                !(
                  validChannelCommand(filters) &&
                  (filters.kind === 9000 || authority.channelCreation)
                )
              )
                return json(res, 400, {
                  error:
                    "Agent enrollment or channel operation unavailable or invalid",
                  sent: false,
                });
            } else if (filters?.kind === 42000) {
              if (!validProductFeedback(filters, relay))
                return json(res, 400, {
                  error: "Product feedback rejected",
                  sent: false,
                });
            } else if (filters?.kind === 30078 || filters?.kind === 40100) {
              try {
                if (
                  !Number.isInteger(filters.created_at) ||
                  Math.abs(filters.created_at - Date.now() / 1000) > 15 * 60
                )
                  throw new Error("Expired operation");
                if (filters.kind === 30078)
                  admitChannelKit(filters, key, relay);
                else if (!validCanvas(filters))
                  throw new Error("Invalid Canvas");
              } catch {
                return json(res, 400, {
                  error: "Channel recipe or Canvas rejected",
                  sent: false,
                });
              }
            } else if (filters?.kind === 1984) {
              if (!validReport(filters))
                return json(res, 400, {
                  error: "Report rejected",
                  sent: false,
                });
            } else if (
              ![7, 9, 40003].includes(filters?.kind) &&
              !validMessageDeletion(filters)
            ) {
              try {
                validateWorkflowEvent(
                  { ...filters, pubkey: signing ? viewer : filters.pubkey },
                  viewer,
                );
              } catch {
                cancel.signal.throwIfAborted();
                return json(res, 400, {
                  error: "Workflow operation unavailable or invalid",
                  sent: false,
                });
              }
            } else if (
              [7, 9, 40003].includes(filters?.kind) &&
              !validMessageTemplate(filters)
            )
              return json(res, 400, { error: "Message rejected" });
            // Never sign or publish after the requesting browser has left.
            cancel.signal.throwIfAborted();
            if (signing) {
              const started = performance.now();
              const event = finalizeEvent(
                {
                  kind: filters.kind,
                  content: filters.content,
                  created_at: filters.created_at,
                  tags: filters.tags,
                },
                key,
              );
              res.setHeader(
                "Server-Timing",
                `sign;dur=${(performance.now() - started).toFixed(2)}`,
              );
              return json(res, 200, event);
            }
            if (filters.pubkey !== viewer || !verifyEvent(filters))
              return json(res, 400, { error: "Invalid outgoing signature" });
          } else if (
            !profile &&
            !directMessage &&
            !claim &&
            !policy &&
            !invite &&
            !member &&
            !gifs &&
            !workflowPath &&
            !readPublishing &&
            !snapshot &&
            !channelActivity &&
            !validFilters(filters)
          )
            return json(res, 400, { error: "Read filter rejected" });
          if (publishing || readPublishing) {
            const stream = streams.get(req.headers["x-buzz-live-id"]);
            // This route has already validated the signed event. Do not log its
            // content, tags, signature, or the browser's private stream handle.
            const publication = `publication id=${filters.id} kind=${filters.kind}`;
            if (!stream || stream.relay !== relay) {
              log.warn(
                `${publication} stage=${stream ? "owner-mismatch" : "owner-missing"} sent=false`,
              );
              return json(res, 503, {
                error: "Publication socket unavailable",
                sent: false,
              });
            }
            try {
              const message = await stream.traffic.publish(
                filters,
                cancel.signal,
              );
              return json(res, 200, {
                accepted: true,
                event_id: filters.id,
                message,
              });
            } catch (error) {
              // SocketRequestError messages are local constants; arbitrary errors
              // and remote refusal text must never escape into terminal output.
              const failure =
                error instanceof SocketRequestError ? error : undefined;
              log.warn(
                `${publication} stage=socket sent=${failure ? failure.sent : "unknown"} reason=${failure?.message ?? "unclassified failure"}${failure?.refusal ? ` refusal=${failure.refusal}` : ""}`,
              );
              return json(res, 503, {
                error:
                  failure?.sent === false &&
                  failure.refusal?.startsWith("rate-limited:")
                    ? failure.refusal
                    : "Socket publication could not be confirmed",
                ...(error instanceof SocketRequestError && !error.sent
                  ? { sent: false }
                  : {}),
              });
            }
          }
          if (route === "/api/relay/query")
            if (log.level >= 5)
              log.debug(
                `query ${req.headers["x-buzz-read-priority"] === "background" ? "background" : "foreground"} ${filterSummary(filters)}`,
              );
          const gifSearchPath = gifs ? await getGifSearchPath(relay) : null;
          if (gifs && !gifSearchPath)
            return json(res, 404, { error: "GIF search is unavailable" });
          const upstreamPath =
            workflowPath ??
            (gifs
              ? gifSearchPath
              : profile || directMessage || member
                ? "/events"
                : claim
                  ? "/api/invites/claim"
                  : policy
                    ? "/api/invites/accept-policy"
                    : invite
                      ? "/api/invites"
                      : "/query");
          const method = workflowPath ? "GET" : "POST";
          const lane = admissions(relay, viewer).api;
          let releasePresence;
          if (presence) {
            releasePresence = !presenceFlight ? lane.tryPresence() : undefined;
            if (!releasePresence) {
              res.writeHead(204);
              return res.end();
            }
            presenceFlight = true;
          }
          if (!presence && inflight >= MAX_INFLIGHT)
            return json(res, 429, {
              error: "Query concurrency limit",
              sent: false,
            });
          if (!presence) inflight++;
          try {
            const body = workflowPath ? undefined : JSON.stringify(filters);
            const admissionStart = performance.now();
            let connectsBefore, upstreamStart;
            let response;
            const requestSignal = AbortSignal.any([
              cancel.signal,
              AbortSignal.timeout(
                presence || memory ? 10000 : UPSTREAM_TIMEOUT_MS,
              ),
            ]);
            const request = () => {
              // Auth freshness and network timings begin at dispatch, not queue entry.
              requestSignal.throwIfAborted();
              timings.push(
                `admission;dur=${(performance.now() - admissionStart).toFixed(2)}`,
              );
              const authStart = performance.now();
              const auth = finalizeEvent(
                {
                  kind: 27235,
                  created_at: Math.floor(Date.now() / 1000),
                  content: "",
                  tags: [
                    ["u", `${relay}${upstreamPath}`],
                    ["method", method],
                    ...(body === undefined
                      ? []
                      : [
                          [
                            "payload",
                            createHash("sha256").update(body).digest("hex"),
                          ],
                        ]),
                    ["nonce", randomBytes(16).toString("hex")],
                  ],
                },
                key,
              );
              timings.push(
                `auth;dur=${(performance.now() - authStart).toFixed(2)}`,
              );
              connectsBefore = upstream.connects();
              upstreamStart = performance.now();
              return fetchUpstream(`${relay}${upstreamPath}`, {
                method,
                headers: {
                  "Content-Type": "application/json",
                  Authorization:
                    "Nostr " +
                    Buffer.from(JSON.stringify(auth)).toString("base64"),
                },
                body,
                redirect: "error",
                signal: requestSignal,
              }).then((response) => {
                timings.push(
                  `ttfb;dur=${(performance.now() - upstreamStart).toFixed(2)}`,
                );
                return response;
              });
            };
            response = presence
              ? await request()
              : await admittedApiRequest(
                  lane,
                  request,
                  requestSignal,
                  channelActivity ||
                    (route === "/api/relay/query" &&
                      req.headers["x-buzz-read-priority"] === "background")
                    ? "background"
                    : "foreground",
                  refusal,
                );
            const text = memory
              ? await memoryResponseText(response)
              : presence
                ? await presenceText(response)
                : snapshot && response.ok
                  ? await readSnapshotText(response)
                  : workflowPath && response.ok
                    ? await workflowReadText(response)
                    : await response.text();
            // The relay's own service time separates server work from network time.
            const relayMs = Number(
              response.headers.get("x-envoy-upstream-service-time"),
            );
            timings.push(
              ...upstream.connectTiming(connectsBefore),
              ...(Number.isFinite(relayMs) &&
              response.headers.has("x-envoy-upstream-service-time")
                ? [`relay;dur=${relayMs}`]
                : []),
              `upstream;dur=${(performance.now() - upstreamStart).toFixed(2)}`,
            );
            res.setHeader("Server-Timing", timings.join(", "));
            stats.queries++;
            if (!response.ok) {
              stats.errors++;
              let failure, body;
              try {
                body = JSON.parse(text);
              } catch {}
              failure = apiFailure(response.status, body);
              // Admission already bounded the body and kept only an allowed refusal.
              const reason = refusal?.(body);
              if (reason) failure = { ...failure, error: reason };
              if (presence && failure.quota === "api")
                lane.pause(failure.retryAfterMs);
              return json(res, response.status, failure);
            }
            if (directMessage) {
              try {
                return json(res, 200, directMessageReceipt(text, filters.id));
              } catch {
                return json(res, 502, {
                  error: "The direct message could not be opened. Try again.",
                });
              }
            }
            if (memory) {
              try {
                const listing = await decodeAgentMemory(
                  JSON.parse(text),
                  key,
                  viewer,
                  memoryAgent,
                  requestSignal,
                );
                requestSignal.throwIfAborted();
                return json(res, 200, listing);
              } catch {
                return json(res, 502, {
                  error: "Memory listing could not be validated",
                });
              }
            }
            if (profile || member) {
              const receipt = JSON.parse(text);
              if (
                receipt.event_id !== filters.id ||
                typeof receipt.accepted !== "boolean"
              )
                return json(res, 502, {
                  error: member
                    ? "Member change could not be confirmed"
                    : "Profile publication could not be confirmed",
                });
            }
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            });
            res.end(text);
          } finally {
            if (presence) {
              presenceFlight = false;
              releasePresence();
            } else inflight--;
          }
        } catch (error) {
          if (res.destroyed) return; // The browser gave up first; nothing to answer.
          stats.errors++;
          if (error instanceof ApiPaused && !res.headersSent)
            return json(res, 429, {
              error: error.message,
              sent: false,
              paused: true,
              retryAfterMs: error.retryAfterMs,
            });
          if (error instanceof ApiCapacity && !res.headersSent)
            return json(res, 429, {
              error: "Query concurrency limit",
              sent: false,
            });
          log.error(
            `Request failed: ${req.method} ${httpLabel(url.pathname)}: ${failureSummary(error)}`,
          );
          if (res.headersSent) return;
          // The relay was never reached, so nothing was delivered: the client may
          // treat this as a definite failure rather than an unknown outcome.
          if (isConnectFailure(error))
            return json(res, 502, { error: "Relay unreachable", sent: false });
          json(res, 500, { error: "Local relay broker failed" });
        } finally {
          res.off("close", release);
        }
      });
    },
  };
}
