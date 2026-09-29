import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import {
  communityRequest,
  inspectProfile,
  publishProfile,
  type CommunityInfo,
} from "./api";
import { keypair, signed } from "../relay/testing";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const key = keypair();
const community = "https://native-admission.test";
const requests: Array<{ path: string; body: unknown }> = [];
let respond: (
  path: string,
  body: unknown,
) => { status?: number; body: unknown };
beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No development broker in this build");
    }),
  );
  respond = () => ({ body: {} });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return key.pubkey;
    if (command === "relay_sign")
      return signed(key, (args as { event: EventTemplate }).event);
    if (command !== "relay_http")
      throw new Error(`Unexpected command ${command}`);
    const {
      community: destination,
      path,
      body: encoded,
    } = args as { community: string; path: string; body: string | null };
    expect(destination).toBe(community);
    const body: unknown = encoded ? JSON.parse(encoded) : undefined;
    requests.push({ path, body });
    const result =
      path === "/"
        ? { body: { self: key.pubkey, name: "Native community" } }
        : respond(path, body);
    return {
      status: result.status ?? 200,
      headers: {},
      body: JSON.stringify(result.body),
    };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  {
    terms_markdown: "Terms",
    privacy_markdown: null,
    age_attestation_required: false,
  },
  {
    terms_markdown: null,
    privacy_markdown: "Privacy",
    age_attestation_required: false,
  },
  {
    terms_markdown: null,
    privacy_markdown: null,
    age_attestation_required: true,
  },
])(
  "accepts relay policy serialization with nullable documents: %j",
  async (fields) => {
    respond = () => ({ body: { policy: { version: "v1", ...fields } } });
    const info = await communityRequest<CommunityInfo>(community, "info");
    expect(info.policy).toEqual({
      version: "v1",
      ...fields,
      terms_markdown: fields.terms_markdown ?? undefined,
      privacy_markdown: fields.privacy_markdown ?? undefined,
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("mints only bounded invites on the captured community", async () => {
  respond = () => ({
    body: { code: "invite", url: `${community}/invite/invite` },
  });
  await expect(
    communityRequest(community, "invite", {
      ttl_secs: 3600,
      max_uses: 1,
      ignored: true,
    }),
  ).resolves.toMatchObject({ code: "invite" });
  expect(requests).toEqual([
    { path: "/api/invites", body: { ttl_secs: 3600, max_uses: 1 } },
  ]);
  for (const body of [
    { ttl_secs: 59 },
    { ttl_secs: 2592001 },
    { ttl_secs: 3600.5 },
    { ttl_secs: 3600, max_uses: 0 },
    { ttl_secs: 3600, max_uses: 10001 },
  ])
    await expect(communityRequest(community, "invite", body)).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

it("binds policy acceptance and invite redemption to the same community without implicit joins", async () => {
  respond = (path) => {
    if (path === "/api/join-policy") return { body: { policy: null } };
    if (path === "/api/invites/accept-policy")
      return { body: { receipt: "proof" } };
    return { body: { status: "joined" } };
  };
  await communityRequest(community, "info");
  expect(requests.map((r) => r.path)).toEqual(["/", "/api/join-policy"]);
  const { receipt } = await communityRequest<{ receipt: string }>(
    community,
    "accept-policy",
    { code: "v2.invite", policy_version: "v1", age_confirmed: true },
  );
  await communityRequest(community, "claim", {
    code: "v2.invite",
    policy_receipt: receipt,
  });
  expect(requests.slice(2)).toEqual([
    {
      path: "/api/invites/accept-policy",
      body: { code: "v2.invite", policy_version: "v1", age_confirmed: true },
    },
    {
      path: "/api/invites/claim",
      body: { code: "v2.invite", policy_receipt: "proof" },
    },
  ]);
});

it("surfaces known claim refusals and rejects unconfirmed policy acceptance", async () => {
  respond = () => ({ status: 403, body: { error: "invite_expired" } });
  await expect(
    communityRequest(community, "claim", { code: "v2.expired" }),
  ).rejects.toThrow("invite_expired");
  respond = () => ({ body: {} });
  await expect(
    communityRequest(community, "accept-policy", {
      code: "v2.invite",
      policy_version: "v1",
    }),
  ).rejects.toThrow("not confirmed");
  const before = requests.length;
  await expect(
    communityRequest(community, "claim", { code: "invalid invite" }),
  ).rejects.toThrow("Invalid invite code");
  expect(requests).toHaveLength(before);
});

it("restores a signed community profile and preserves extra fields when publishing", async () => {
  const event = signed(key, {
    kind: 0,
    tags: [],
    content: JSON.stringify({
      name: "Existing",
      about: "About",
      nip05: "person@example.test",
    }),
  });
  respond = (path, body) =>
    path === "/query"
      ? { body: [event] }
      : { body: { accepted: true, event_id: (body as { id: string }).id } };
  const found = await inspectProfile(community);
  expect(found.profile).toEqual({
    name: "Existing",
    picture: "",
    about: "About",
  });
  await publishProfile(
    community,
    { ...found.profile, name: "Updated" },
    found.existing,
  );
  const published = requests.find((r) => r.path === "/events")?.body as {
    content: string;
    pubkey: string;
  };
  expect(published.pubkey).toBe(key.pubkey);
  expect(JSON.parse(published.content)).toEqual({
    name: "Updated",
    display_name: "Updated",
    about: "About",
    picture: "",
    nip05: "person@example.test",
  });
  respond = () => ({ body: { accepted: true, event_id: "unrelated" } });
  await expect(
    publishProfile(community, found.profile, found.existing),
  ).rejects.toThrow("not confirmed");
});

it("keeps development requests on the existing broker even inside Tauri", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ name: "Development", policy: null }),
  );
  await communityRequest(community, "info");
  expect(fetch).toHaveBeenCalledWith(
    `/api/relay/${encodeURIComponent(community)}/info`,
    expect.anything(),
  );
  expect(invoke).not.toHaveBeenCalled();
});
