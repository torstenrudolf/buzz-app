import { nativeIdentityEnabled } from "../identity/service";
import { nativeCommunityRequest } from "./native-api";
import { connectCommunityTransport } from "./connection";
import type { RelaySession } from "../relay/session";
import type { PersonalProfile } from "./service";
export type CommunityInfo = {
  name?: string;
  icon?: string;
  policy: {
    version: string;
    terms_markdown?: string;
    privacy_markdown?: string;
    age_attestation_required: boolean;
  } | null;
};
export async function communityRequest<T>(
  id: string,
  route: string,
  body?: unknown,
): Promise<T> {
  if (nativeIdentityEnabled())
    return nativeCommunityRequest(id, route, body) as Promise<T>;
  const response = await fetch(
    `/api/relay/${encodeURIComponent(id)}/${route}`,
    {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(25000),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error ?? `Community request failed (${response.status})`,
    );
  return result as T;
}
export async function inspectProfile(id: string, session?: RelaySession) {
  // Existing-community editors use the captured session so confirmed reads also
  // update its shared profile directory. Joining uses the selected host adapter.
  const transport =
    session ??
    (await connectCommunityTransport(id, AbortSignal.timeout(12000)));
  if (!transport.viewer) throw new Error("Profile identity is unavailable");
  const filters = [
    {
      kinds: [0],
      authors: [transport.viewer],
      limit: 5,
      ...(nativeIdentityEnabled() ? { consistency: "strong" as const } : {}),
    },
  ];
  const events =
    "read" in transport
      ? await transport.read(filters, {
          signal: AbortSignal.timeout(12000),
          fresh: true,
        })
      : await transport.query(filters, AbortSignal.timeout(12000));
  const event = events
    .filter((e) => e.kind === 0 && e.pubkey === transport.viewer)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const parsed: unknown = event ? JSON.parse(event.content) : {};
  const existing: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const profile: PersonalProfile = {
    name: String(existing.display_name ?? existing.name ?? ""),
    picture: typeof existing.picture === "string" ? existing.picture : "",
    about: typeof existing.about === "string" ? existing.about : "",
  };
  return { existing, profile, exists: !!event };
}
export async function publishProfile(
  id: string,
  profile: PersonalProfile,
  existing: Record<string, unknown>,
) {
  const receipt = await communityRequest<{
    accepted: boolean;
    event_id: string;
    message?: string;
  }>(id, "profile", { ...profile, existing });
  if (!receipt.accepted || !receipt.event_id)
    throw new Error(receipt.message ?? "Profile publication was not confirmed");
}
