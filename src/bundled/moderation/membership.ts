import type { RelayData } from "../../features/relay/service";
import { communityFromScope } from "../../features/relay/gifs";
import {
  MEMBERSHIP_KIND,
  membersFromSnapshot,
  type Member,
  type Role,
} from "./api";

export type MembershipSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  members: readonly Member[] | null;
  role?: Role;
  refreshing: boolean;
  error?: string;
}>;

const initial: MembershipSnapshot = Object.freeze({
  status: "idle",
  members: null,
  refreshing: false,
});
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** One verified community roster owner shared by Settings navigation and content. */
export function createCommunityMembership(relay: RelayData) {
  let value = initial;
  let key = "";
  let controller: AbortController | undefined;
  let disposed = false;
  let demands = 0;
  let cancellationRetried = "";
  const listeners = new Set<() => void>();
  const publish = (next: MembershipSnapshot) => {
    value = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const current = () => {
    const connection = relay.snapshot();
    const nextKey = `${connection.generation}:${connection.status === "ready" ? (connection.scope ?? "") : ""}`;
    if (nextKey !== key) {
      key = nextKey;
      controller?.abort();
      value = initial;
    }
    return connection;
  };
  const load = async (fresh: boolean, reacquired = false) => {
    const connection = current();
    if (
      disposed ||
      connection.status !== "ready" ||
      !connection.scope ||
      !connection.viewer ||
      (!fresh &&
        (value.status === "loading" ||
          (value.status === "ready" && !reacquired)))
    )
      return;
    controller?.abort();
    const owner = new AbortController();
    controller = owner;
    const capturedKey = key;
    const retained = value.status === "ready" ? value.members : null;
    publish({
      status: retained ? "ready" : "loading",
      members: retained,
      ...(value.role ? { role: value.role } : {}),
      refreshing: true,
    });
    try {
      const community = communityFromScope(connection.scope);
      if (!community) throw new Error("Choose a connected community");
      const author = connection.session.relayAuthor;
      if (!author) throw new Error("Community authority unavailable");
      const events = await connection.session.read(
        [{ kinds: [MEMBERSHIP_KIND], authors: [author], limit: 1 }],
        { fresh: true, signal: owner.signal },
      );
      const latest = [...events].sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      )[0];
      const members = latest ? membersFromSnapshot(latest, author) : null;
      if (owner.signal.aborted || capturedKey !== key) return;
      const role = members?.find(
        (member) => member.pubkey === connection.viewer,
      )?.role;
      publish({
        status: "ready",
        members,
        ...(role ? { role } : {}),
        refreshing: false,
      });
    } catch (reason) {
      if (owner.signal.aborted || capturedKey !== key || disposed) return;
      if (
        reason instanceof DOMException &&
        reason.name === "AbortError" &&
        cancellationRetried !== capturedKey
      ) {
        cancellationRetried = capturedKey;
        void load(true);
        return;
      }
      publish({
        status: retained ? "ready" : "error",
        members: retained,
        ...(value.role ? { role: value.role } : {}),
        refreshing: false,
        error: `Could not load members: ${message(reason)}`,
      });
    }
  };
  const relayChanged = () => {
    const before = key;
    const connection = current();
    for (const listener of listeners) listener();
    if (before !== key && demands && connection.status === "ready")
      void load(false);
  };
  const stop = relay.subscribe(relayChanged);
  return {
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure() {
      const reacquired = demands === 0;
      demands++;
      void load(false, reacquired);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        demands--;
      };
    },
    refresh: () => load(true),
    dispose() {
      disposed = true;
      stop();
      controller?.abort();
      listeners.clear();
    },
  };
}

export type CommunityMembership = ReturnType<typeof createCommunityMembership>;
export const canManageMembership = (snapshot: MembershipSnapshot) =>
  snapshot.status === "ready" &&
  (snapshot.role === "owner" || snapshot.role === "admin");
