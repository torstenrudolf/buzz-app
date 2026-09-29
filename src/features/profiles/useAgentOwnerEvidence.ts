import { useEffect, useState, useSyncExternalStore } from "react";
import { attestedOwner } from "../agents/owner-attestation";
import { type EventData, newer } from "../relay/events";
import type { EventViewSnapshot, RelaySession } from "../relay/session";

type ProfileView = ReturnType<RelaySession["observe"]>;
const noSubscribe = () => () => {};
const pendingView = (): EventViewSnapshot => pendingSnapshot;
const pendingSnapshot: EventViewSnapshot = Object.freeze({
  status: "loading",
  events: [],
});

/** Verified NIP-OA owner of the winning signed kind 0, or none. Agent hints
 * decide whether to mount this view; they never establish ownership.
 * Private admission must inspect readiness as well as signed-head ownership.
 * Public identity attribution may still display its retained signed evidence. */
export function useAgentOwnerEvidence(
  session: RelaySession,
  pubkey: string | undefined,
  attempt = 0,
): {
  status: "loading" | "ready" | "error" | "unavailable";
  owner: string | undefined;
  failed: boolean;
  settled: boolean;
} {
  // A session-owned view: live events, reconnect refresh and purge, no polling.
  // Capacity or a closed session leaves no view; profile recovery retries.
  const [view, setView] = useState<ProfileView | null>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries view admission.
  useEffect(() => {
    if (!pubkey) {
      setView(null);
      return;
    }
    let owned: ProfileView;
    try {
      owned = session.observe([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    } catch {
      setView(null);
      return;
    }
    setView(owned);
    return owned.dispose;
  }, [session, pubkey, attempt]);
  const events = useSyncExternalStore(
    view?.subscribe ?? noSubscribe,
    view?.snapshot ?? pendingView,
    view?.snapshot ?? pendingView,
  );
  // Provenance belongs to the winning signed kind 0 alone, never a display projection.
  // The directory's retained head outlives this view, so a reopened pane cannot
  // accept an older response than the profile the rest of the session shows.
  // Subscribed, so any head change (live, read or disk restore) re-renders.
  // Without a live view nothing can signal an auth-only change, so show nothing.
  const directoryHead = useSyncExternalStore(
    session.profiles.subscribe,
    () => (pubkey ? session.profiles.event?.(pubkey) : undefined),
    () => (pubkey ? session.profiles.event?.(pubkey) : undefined),
  );
  const head = view && pubkey ? directoryHead : undefined;
  const latest = events.events
    .filter(
      (event) =>
        event.kind === 0 &&
        event.pubkey === pubkey &&
        event.delivery !== "failed",
    )
    .reduce<EventData | undefined>(newer, head);
  const [verified, setVerified] = useState<{ id: string; owner?: string }>();
  useEffect(() => {
    if (!latest) return;
    let active = true;
    void attestedOwner(latest).then((owner) => {
      if (active) setVerified({ id: latest.id, ...(owner ? { owner } : {}) });
    });
    return () => {
      active = false;
    };
  }, [latest]);
  useEffect(() => {
    if (events.status === "idle") void view?.refresh();
  }, [view, events.status]);
  const settled = !!(verified && latest && verified.id === latest.id);
  const owner = settled ? verified?.owner : undefined;
  // Only an already admitted result from this observation may survive a
  // background read. New heads, purges and failed reads must establish it anew.
  const [admitted, setAdmitted] = useState<{
    view: ProfileView;
    id: string;
  }>();
  useEffect(() => {
    setAdmitted((previous) => {
      if (
        events.status === "ready" &&
        view &&
        latest &&
        latest.id === verified?.id
      ) {
        return previous?.view === view && previous.id === latest.id
          ? previous
          : { view, id: latest.id };
      }
      return events.status === "loading" &&
        previous?.view === view &&
        previous?.id === latest?.id
        ? previous
        : undefined;
    });
  }, [events.status, view, latest, verified]);
  const refreshingAdmittedHead =
    !!admitted &&
    events.status === "loading" &&
    admitted?.view === view &&
    admitted?.id === latest?.id;
  const status =
    view === null
      ? "unavailable"
      : events.status === "error"
        ? "error"
        : !view ||
            (events.status !== "ready" && !refreshingAdmittedHead) ||
            (latest && verified?.id !== latest.id)
          ? "loading"
          : "ready";
  return {
    status,
    owner,
    failed: !!pubkey && (view === null || events.status === "error"),
    // An absent event is conclusive only after its read completed. Failure or
    // exhausted capacity must not unlock unverified legacy fallback.
    settled:
      !pubkey || settled || (!!view && !latest && events.status === "ready"),
  };
}
