import { getEventHash, verifyEvent } from "nostr-tools";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";
import type { RelayEvent } from "./events";
import { PublishRejected } from "./outbox";
import { lifecycleChannelId } from "./channel-lifecycle-protocol";
import {
  detailsSettings,
  detailsTemplate,
  validateDetailsDraft,
  type ChannelDetails,
  type ChannelDetailsDraft,
} from "./channel-details-protocol";

export type DetailsAttempt = Readonly<{
  draft: ChannelDetailsDraft;
  status: "saving" | "unconfirmed";
}>;
export interface ChannelDetailsCapability {
  readonly available: boolean;
  load(id: string, signal?: AbortSignal): Promise<ChannelDetails>;
  save(
    base: ChannelDetails,
    draft: ChannelDetailsDraft,
    signal?: AbortSignal,
  ): Promise<void>;
  check(id: string, signal?: AbortSignal): Promise<void>;
  snapshot(id: string): DetailsAttempt | undefined;
  subscribe(listener: () => void): () => void;
}
const uncertain =
  "The change may have been saved. Check its status before trying again.";

/** Session owns uncertain intent through panel close/reopen; no automatic publication retry. */
export function createChannelDetails({
  reader,
  writer,
  viewer,
  relayAuthor,
  canAccess,
  acceptDiscovery,
}: {
  reader?: RelayReader | undefined;
  writer?: RelayWriter | undefined;
  viewer: string;
  relayAuthor: string;
  canAccess(id: string): boolean;
  acceptDiscovery(events: readonly RelayEvent[]): void;
}) {
  let closed = false;
  const attempts = new Map<string, DetailsAttempt>();
  const controllers = new Set<AbortController>();
  const listeners = new Set<() => void>();
  function emit() {
    for (const listener of listeners) listener();
  }
  function assertAccess(id: string) {
    if (closed || !canAccess(id))
      throw new Error("Channel access changed. Reopen channel settings.");
  }
  async function owned<T>(
    id: string,
    work: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ) {
    lifecycleChannelId(id);
    assertAccess(id);
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
  async function read(id: string, signal: AbortSignal) {
    if (!reader)
      throw new Error("Channel editing is unavailable on this connection.");
    assertAccess(id);
    const events = await reader.read(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
      })),
      { signal, fresh: true, priority: "foreground" },
    );
    signal.throwIfAborted();
    assertAccess(id);
    if (events.some((event) => ![39000, 39001, 39002].includes(event.kind)))
      throw new Error("Unexpected channel details response.");
    return detailsSettings(events, id, viewer, relayAuthor);
  }
  async function confirm(
    id: string,
    draft: ChannelDetailsDraft,
    signal: AbortSignal,
  ) {
    const { details, metadata } = await read(id, signal);
    acceptDiscovery([metadata]);
    signal.throwIfAborted();
    assertAccess(id);
    if (
      details.name !== draft.name ||
      details.description !== draft.description ||
      details.visibility !== draft.visibility
    )
      throw new Error(uncertain);
    attempts.delete(id);
    emit();
  }
  const capability: ChannelDetailsCapability = Object.freeze({
    available: !!reader && !!writer,
    snapshot: (id: string) => attempts.get(id),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load(id: string, caller?: AbortSignal) {
      return owned(
        id,
        async (signal) => {
          const { details, metadata } = await read(id, signal);
          acceptDiscovery([metadata]);
          signal.throwIfAborted();
          return details;
        },
        caller,
      );
    },
    check(id: string, caller?: AbortSignal) {
      return owned(
        id,
        async (signal) => {
          const attempt = attempts.get(id);
          if (attempt?.status !== "unconfirmed")
            throw new Error("No unconfirmed change to check.");
          await confirm(id, attempt.draft, signal);
        },
        caller,
      );
    },
    async save(
      base: ChannelDetails,
      input: ChannelDetailsDraft,
      caller?: AbortSignal,
    ) {
      const id = lifecycleChannelId(base.channelId);
      if (!writer || !reader)
        throw new Error("Channel editing is unavailable on this connection.");
      if (attempts.has(id))
        throw new Error("Check the previous change before saving again.");
      const draft = Object.freeze({ ...input });
      validateDetailsDraft(draft);
      let publicationStarted = false;
      attempts.set(id, Object.freeze({ draft, status: "saving" }));
      emit();
      try {
        await owned(
          id,
          async (signal) => {
            const authorize = async () => {
              const { details } = await read(id, signal);
              if (!details.canEdit)
                throw new Error(
                  "You no longer have permission to edit this channel.",
                );
              if (details.version !== base.version)
                throw new Error(
                  "Channel details changed. Reload details before saving your edits.",
                );
              if (
                details.visibility === "private" &&
                draft.visibility !== "private"
              )
                throw new Error("Private channels cannot be made public here.");
            };
            await authorize();
            const template = detailsTemplate(id, draft);
            const signed = await writer.sign(structuredClone(template), signal);
            signal.throwIfAborted();
            if (
              signed.pubkey !== viewer ||
              signed.kind !== template.kind ||
              signed.created_at !== template.created_at ||
              signed.content !== template.content ||
              JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
              getEventHash(signed) !== signed.id ||
              !verifyEvent(signed)
            )
              throw new Error("Signer changed the channel details command.");
            await authorize();
            signal.throwIfAborted();
            publicationStarted = true;
            await writer.publish(signed, signal);
            await confirm(id, draft, signal);
          },
          caller,
        );
      } catch (error) {
        if (publicationStarted && !(error instanceof PublishRejected)) {
          if (!closed)
            attempts.set(id, Object.freeze({ draft, status: "unconfirmed" }));
          throw new Error(uncertain);
        }
        attempts.delete(id);
        throw error;
      } finally {
        emit();
      }
    },
  });
  const cancel = () => {
    for (const controller of controllers) controller.abort();
  };
  return {
    capability,
    cancel,
    // Cache clearing cannot prove that an already sent command failed.
    clear: cancel,
    dispose() {
      closed = true;
      cancel();
      attempts.clear();
      listeners.clear();
    },
  };
}
