import { getEventHash } from "nostr-tools";
import { attestedOwner } from "../agents/owner-attestation";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";
import { PublishRejected } from "./outbox";
import { newer, type RelayEvent } from "./events";
import {
  DM_VISIBILITY_KIND,
  exactLifecycleTag,
  lifecycleChannelId,
  lifecycleRecord,
  lifecycleSettings,
  lifecycleTemplate,
  type ChannelLifecycleAction,
  type ChannelLifecycleSettings,
} from "./channel-lifecycle-protocol";

/** No automatic or same-dialog retry after a request may have reached the relay. */
export class ChannelLifecycleUnconfirmed extends Error {
  constructor(reason: unknown) {
    super(
      `The request may have taken effect. Close this dialog and refresh channels before trying again. ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    this.name = "ChannelLifecycleUnconfirmed";
  }
}

export type DmVisibility = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  hidden: readonly string[];
  error?: string;
}>;
export interface ChannelLifecycleCapability {
  readonly available: boolean;
  load(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<ChannelLifecycleSettings>;
  run(
    action: ChannelLifecycleAction,
    channelId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  snapshot(): DmVisibility;
  subscribe(listener: () => void): () => void;
  refreshVisibility(): Promise<void>;
}

export function createChannelLifecycle({
  reader,
  writer,
  viewer,
  relayAuthor,
  canAccess,
  acceptDiscovery,
  removed,
}: {
  reader?: RelayReader | undefined;
  writer?: RelayWriter | undefined;
  viewer: string;
  relayAuthor: string;
  canAccess(id: string): boolean;
  acceptDiscovery(events: readonly RelayEvent[]): void;
  removed(id: string): void;
}) {
  let closed = false;
  let busy = false;
  let epoch = 0;
  const controllers = new Set<AbortController>();
  const listeners = new Set<() => void>();
  let snapshot: DmVisibility = Object.freeze({
    status: "idle",
    hidden: Object.freeze([]),
  });
  let visibility: RelayEvent | undefined;
  let refresh: Promise<void> | undefined;
  const available = !!reader && !!writer;
  const emit = (next: DmVisibility) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  function assertAccess(id: string) {
    if (closed) throw new DOMException("Relay session closed", "AbortError");
    if (!canAccess(id))
      throw new Error("Channel access unavailable; refresh membership");
  }
  async function owned<T>(
    work: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    if (closed) throw new DOMException("Relay session closed", "AbortError");
    const controller = new AbortController();
    controllers.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
      ...(caller ? [caller] : []),
    ]);
    try {
      signal.throwIfAborted();
      return await work(signal);
    } finally {
      controllers.delete(controller);
    }
  }
  async function read(
    kinds: readonly number[],
    id: string,
    signal: AbortSignal,
    member = false,
  ) {
    if (!reader)
      throw new Error("Channel actions are unavailable on this connection");
    const events = await reader.read(
      kinds.map((kind) => ({
        kinds: [kind],
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
        ...(member ? { "#p": [viewer] } : {}),
      })),
      { signal, fresh: true, priority: "foreground" },
    );
    signal.throwIfAborted();
    if (events.some((event) => !kinds.includes(event.kind)))
      throw new Error("Unexpected channel state response");
    return events;
  }
  async function load(id: string, signal: AbortSignal, checkOwnedAgent = true) {
    assertAccess(id);
    const events = await read([39000, 39001, 39002], id, signal);
    assertAccess(id);
    const settings = lifecycleSettings(events, id, viewer, relayAuthor);
    const metadata = lifecycleRecord(events, 39000, id, relayAuthor);
    if (
      !reader ||
      !checkOwnedAgent ||
      settings.canDelete ||
      settings.canHide ||
      (metadata && exactLifecycleTag(metadata, "archived") === "true")
    )
      return settings;
    // lifecycleSettings validated every owner against the signed member roster.
    const owners =
      lifecycleRecord(events, 39001, id, relayAuthor)?.tags.flatMap(
        ([name, pubkey, role]) =>
          name === "p" && role === "owner" && pubkey ? [pubkey] : [],
      ) ?? [];
    if (!owners.length) return settings;
    // Bound the whole optional lookup, not each batch: it must not consume the
    // lifecycle deadline and erase independently established Archive/Leave.
    const profileSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    try {
      for (let start = 0; start < owners.length; start += 4) {
        const batch = owners.slice(start, start + 4);
        const profiles = await reader.read(
          batch.map((pubkey) => ({ kinds: [0], authors: [pubkey], limit: 1 })),
          { signal: profileSignal, fresh: true, priority: "foreground" },
        );
        profileSignal.throwIfAborted();
        assertAccess(id);
        if (
          profiles.some(
            (event) => event.kind !== 0 || !batch.includes(event.pubkey),
          )
        )
          throw new Error("Unexpected channel owner profile response");
        for (const pubkey of batch) {
          const profile = profiles
            .filter((event) => event.pubkey === pubkey)
            .reduce<RelayEvent | undefined>(newer, undefined);
          // This verifies profile provenance, NOT the relay's persisted ownership
          // mapping. The viewer signs; the relay still authorizes every Delete.
          const owner = profile && (await attestedOwner(profile));
          profileSignal.throwIfAborted();
          assertAccess(id);
          if (owner === viewer)
            return Object.freeze({ ...settings, canDelete: true });
        }
      }
      return settings;
    } catch {
      // Optional read failures affect only Delete. Cancellation/access loss still
      // invalidate the whole result, including late replies from an old session.
      signal.throwIfAborted();
      assertAccess(id);
      return Object.freeze({ ...settings, deleteUnavailable: true });
    }
  }
  async function readVisibility(signal: AbortSignal) {
    const events = await read([DM_VISIBILITY_KIND], viewer, signal, true);
    const record = lifecycleRecord(
      events,
      DM_VISIBILITY_KIND,
      viewer,
      relayAuthor,
    );
    if (record) {
      if (exactLifecycleTag(record, "p") !== viewer || record.content !== "")
        throw new Error("Invalid DM visibility snapshot");
      const hidden = record.tags
        .filter(([key]) => key === "h")
        .map((entry) => {
          if (entry.length !== 2) throw new Error("Invalid hidden DM");
          return lifecycleChannelId(entry[1] ?? "");
        });
      if (newer(visibility, record) === record) {
        visibility = record;
        emit({ status: "ready", hidden: Object.freeze([...new Set(hidden)]) });
      }
    } else if (!visibility)
      emit({ status: "ready", hidden: Object.freeze([]) });
    if (snapshot.status !== "ready")
      emit({ status: "ready", hidden: snapshot.hidden });
    return snapshot.hidden;
  }
  const capability: ChannelLifecycleCapability = Object.freeze({
    available,
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshVisibility() {
      if (refresh) return refresh;
      if (!reader || closed) return Promise.resolve();
      const started = epoch;
      emit({ status: "loading", hidden: snapshot.hidden });
      const operation = owned(async (signal) => {
        await readVisibility(signal);
      })
        .catch((error: unknown) => {
          if (started === epoch && !closed)
            emit({
              status: "error",
              hidden: snapshot.hidden,
              error: error instanceof Error ? error.message : String(error),
            });
        })
        .finally(() => {
          if (refresh === operation) refresh = undefined;
        });
      refresh = operation;
      return operation;
    },
    load(value: string, signal?: AbortSignal) {
      return owned((signal) => load(lifecycleChannelId(value), signal), signal);
    },
    async run(
      action: ChannelLifecycleAction,
      value: string,
      caller?: AbortSignal,
    ) {
      if (!available || !writer)
        throw new Error("Channel actions are unavailable on this connection");
      if (busy) throw new Error("Another channel action is still in progress");
      const id = lifecycleChannelId(value);
      busy = true;
      let publicationStarted = false;
      try {
        await owned(async (signal) => {
          const authorize = async () => {
            const settings = await load(id, signal, action === "delete");
            if (action === "delete" && settings.deleteUnavailable)
              throw new Error(
                "Delete check unavailable. Retry channel permissions.",
              );
            const permitted = {
              archive: settings.canArchive,
              delete: settings.canDelete,
              leave: settings.canLeave,
              hide: settings.canHide,
            }[action];
            if (!permitted)
              throw new Error(
                action === "leave" && settings.leaveReason
                  ? settings.leaveReason
                  : "This action is no longer permitted. Refresh channel permissions.",
              );
          };
          await authorize();
          const template = lifecycleTemplate(action, id);
          const signed = await writer.sign(structuredClone(template), signal);
          signal.throwIfAborted();
          if (
            signed.pubkey !== viewer ||
            signed.kind !== template.kind ||
            signed.created_at !== template.created_at ||
            signed.content !== template.content ||
            JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
            getEventHash(signed) !== signed.id
          )
            throw new Error("Signer changed the channel lifecycle command");
          await authorize();
          signal.throwIfAborted();
          publicationStarted = true;
          await writer.publish(signed, signal);
          // An accepted write may precede its relay-owned side effects. Do not
          // optimistically revoke membership or confuse a failed read with absence.
          for (const delay of [0, 250, 750, 1500]) {
            signal.throwIfAborted();
            if (delay)
              await new Promise<void>((resolve, reject) => {
                const abort = () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                };
                const timer = setTimeout(() => {
                  signal.removeEventListener("abort", abort);
                  resolve();
                }, delay);
                signal.addEventListener("abort", abort, { once: true });
              });
            if (action === "hide") {
              if ((await readVisibility(signal)).includes(id)) return;
            } else {
              const kind = action === "leave" ? 39002 : 39000;
              const events = await read([kind], id, signal, action === "leave");
              const record = lifecycleRecord(events, kind, id, relayAuthor);
              if (action === "archive") {
                if (
                  record &&
                  exactLifecycleTag(record, "archived") === "true"
                ) {
                  acceptDiscovery([record]);
                  return;
                }
              } else if (!record) {
                removed(id);
                return;
              }
            }
          }
          throw new Error(
            "The relay accepted the request, but the change is not confirmed. Refresh channels before trying again.",
          );
        }, caller);
      } catch (error) {
        if (publicationStarted && !(error instanceof PublishRejected))
          throw new ChannelLifecycleUnconfirmed(error);
        throw error;
      } finally {
        busy = false;
      }
    },
  });
  return {
    capability,
    cancel() {
      for (const controller of controllers) controller.abort();
    },
    clear() {
      epoch++;
      for (const controller of controllers) controller.abort();
      refresh = undefined;
      visibility = undefined;
      emit({ status: "idle", hidden: Object.freeze([]) });
    },
    dispose() {
      closed = true;
      epoch++;
      for (const controller of controllers) controller.abort();
      listeners.clear();
    },
  };
}
