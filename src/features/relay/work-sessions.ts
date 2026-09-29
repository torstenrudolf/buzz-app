import { sessionDescription } from "../sessions/metadata";
import type { Outbox } from "./outbox";
import type { ChannelQueries } from "./contracts";
import type { RelayReader } from "./reader";

export const DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Work-session commands use the same durable outbox and connection lifetime. */
export function createWorkSessions(
  outbox: Outbox | undefined,
  channels: ChannelQueries,
  reader: RelayReader,
  signal: AbortSignal,
  receipts?: Pick<Outbox, "snapshot" | "subscribe">,
  confirmCreation?: (id: string) => Promise<boolean>,
  agentKeys?: () => readonly string[],
  relayAuthor?: string,
  /** Signed roster discovery, including channels this viewer cannot open. */
  discovery: RelayReader = reader,
) {
  const available = !!outbox?.supports(9007);
  function writer(addition = false) {
    if (signal.aborted || !available || !outbox)
      throw new Error(
        addition
          ? "This community cannot add agents to channels right now. Check the connection and retry."
          : "This community does not support channel creation yet. Your draft is kept here.",
      );
    return outbox;
  }
  function identifier(id: string) {
    if (!uuid.test(id)) throw new Error("Invalid session identifier");
  }
  async function delivered(
    id: string,
    active?: () => boolean,
    addition = false,
    retry = true,
  ) {
    const check = () => {
      if (active?.() === false)
        throw new DOMException("Channel addition cancelled", "AbortError");
    };
    check();
    // Recipe and Canvas saves share delivery, not channel-creation authority.
    if (signal.aborted || !outbox)
      throw new Error(
        "The community connection cannot confirm this operation.",
      );
    const source = addition ? writer(true) : outbox;
    const journal = receipts ?? source;
    const existing = journal.snapshot().find((item) => item.event.id === id);
    if (!existing) {
      if (await confirmCreation?.(id)) {
        check();
        return;
      }
      const events = await reader.read([{ ids: [id], limit: 1 }], { signal });
      if (events.some((event) => event.id === id)) {
        check();
        return;
      }
      throw new Error(
        "The saved operation could not be confirmed. Reconnect and retry.",
      );
    }
    if (existing.delivery === "failed" || existing.delivery === "unknown") {
      // Ordinary channel creation rejects a repeated channel UUID. An exact,
      // verified creation event can confirm an earlier lost acknowledgment.
      if (existing.event.kind === 9007) {
        if (await confirmCreation?.(id)) {
          check();
          return;
        }
        const channelId = existing.event.tags.find(
          ([name]) => name === "h",
        )?.[1];
        if (!channelId)
          throw new Error("The saved channel creation is invalid.");
        // A missed membership notification must not leave the readback hidden
        // by a stale roster. The verified reader applies signed discovery first.
        const events = await reader.read(
          [
            { kinds: [39000, 39002], "#d": [channelId], limit: 2 },
            { ids: [id], limit: 1 },
          ],
          { signal },
        );
        if (
          events.some(
            (event) =>
              event.id === id && event.pubkey === existing.event.pubkey,
          )
        ) {
          check();
          return;
        }
      }
      check();
      if (!retry) {
        const events = await reader.read([{ ids: [id], limit: 1 }], { signal });
        if (events.some((event) => event.id === id)) return;
        throw new Error(
          existing.error ?? "The operation could not be confirmed.",
        );
      }
      if (active) source.retry(id, active);
      else source.retry(id);
    }
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const aborted = () =>
        finish(
          new Error(
            addition
              ? "The community connection changed. Check channel membership before adding again."
              : "The community connection changed. Your draft is kept.",
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              addition
                ? "Agent addition is unconfirmed. Check channel membership before retrying; the request may already have reached the relay."
                : "Still waiting for confirmation. Retry without starting another session.",
            ),
          ),
        15000,
      );
      const inspect = () => {
        const item = journal.snapshot().find((item) => item.event.id === id);
        if (item?.delivery === "accepted" || item?.delivery === "seen")
          finish();
        else if (item?.delivery === "failed" || item?.delivery === "unknown")
          finish(
            new Error(
              item.error ??
                (addition
                  ? "Agent addition could not be confirmed. Check membership before retrying."
                  : "The operation could not be confirmed."),
            ),
          );
      };
      unsubscribe = journal.subscribe(inspect);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else inspect();
    });
    check();
  }
  /** Resolves once the channel list shows `id` with the expected membership.
   * Admission never comes from the command's acknowledgment: the list must
   * carry a relay-signed roster. When discovery has already made the list
   * ready, that evidence arrives by an exact one-channel read first; otherwise,
   * or when that read leaves the gate unsatisfied, the full viewer-roster
   * discovery runs. Both apply through the same discovery path. */
  async function refresh(
    id: string,
    expected: {
      member?: string;
      members?: readonly string[];
      parent?: string;
    } = {},
    sessionOnly = true,
  ) {
    writer(!sessionOnly);
    let settled = false;
    // Aborted once the gate decides, so a still-running exact read releases
    // its reader slot instead of holding it until the connection closes.
    const exact = new AbortController();
    const wait = new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const done = (error?: Error) => {
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        exact.abort();
        error ? reject(error) : resolve();
      };
      const abort = () => done(new Error("The community connection changed."));
      const timer = setTimeout(
        () =>
          done(
            new Error(
              sessionOnly
                ? "Session saved, but its membership is still loading. Retry to continue."
                : "Agent addition is unconfirmed. Check channel membership before retrying; the request may already have reached the relay.",
            ),
          ),
        15000,
      );
      const inspect = (reportError = true) => {
        const list = channels.list();
        if (reportError && list.status === "error")
          done(new Error(list.error ?? "Session membership could not load."));
        else if (
          list.status === "ready" &&
          list.channels.some(
            (channel) =>
              channel.id === id &&
              (!sessionOnly || channel.channelType === "session") &&
              (!expected.member ||
                channel.members?.includes(expected.member)) &&
              (!expected.members ||
                expected.members.every((key) =>
                  channel.members?.includes(key),
                )) &&
              (!expected.parent || channel.parentChannelId === expected.parent),
          )
        )
          done();
      };
      unsubscribe = channels.subscribeList(inspect);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else inspect(false); // An earlier roster error does not decide this retry.
    });
    // The gate may time out or abort while a read is in flight; its rejection
    // stays observed here and is rethrown below.
    const gate = wait.catch(() => {});
    // The exact read extends a list discovery has already made ready. Any other
    // status (idle, loading, error) needs the full pass to become ready at all,
    // and that pass carries the new channel; the store's resolve would otherwise
    // commit a ready list holding only this channel and, after a failed initial
    // discovery, hide the error the user still needs to retry. The store also
    // skips ids it already authorizes, so agent additions to a joined channel
    // go straight to the full discovery below.
    if (!settled && channels.list().status === "ready")
      await Promise.race([
        gate,
        (async () => {
          try {
            await channels.resolve?.([id], {
              signal: AbortSignal.any([signal, exact.signal]),
            });
          } catch {
            // A failed or stale exact read leaves the decision to discovery.
          }
        })(),
      ]);
    if (!settled) channels.refreshList?.();
    await wait;
  }
  async function refreshMembership(id: string) {
    if (signal.aborted || (!outbox?.supports(9007) && !outbox?.supports(9000)))
      throw new Error("Channel membership is unavailable.");
    if (!relayAuthor) throw new Error("Channel membership is unavailable.");
    const events = await reader.read(
      [{ kinds: [39002], authors: [relayAuthor], "#d": [id], limit: 1 }],
      { signal, fresh: true, priority: "foreground" },
    );
    const channel =
      channels.list().channels.find((item) => item.id === id) ??
      channels.get?.(id);
    if (
      !events.some(
        (event) =>
          event.kind === 39002 &&
          event.pubkey === relayAuthor &&
          event.tags.some(([name, value]) => name === "d" && value === id),
      ) ||
      !channel?.members ||
      channel.archived
    )
      throw new Error(
        "Could not refresh channel membership. Retry to continue.",
      );
    return channel;
  }
  /** Channel IDs whose relay-signed roster lists `pubkey`, as far as this viewer
   * may read. Throws rather than return a possibly truncated set. */
  async function memberChannels(pubkey: string, caller: AbortSignal) {
    if (!relayAuthor) throw new Error("Channel membership is unavailable.");
    const limit = 500;
    const events = await discovery.read(
      [{ kinds: [39002], authors: [relayAuthor], "#p": [pubkey], limit }],
      {
        signal: AbortSignal.any([signal, caller]),
        fresh: true,
        priority: "foreground",
      },
    );
    if (events.length >= limit)
      throw new Error("Too many channels to confirm. Retry later.");
    const ids = new Set<string>();
    for (const event of events) {
      const id = event.tags.find(([name]) => name === "d")?.[1];
      if (
        id &&
        event.kind === 39002 &&
        event.pubkey === relayAuthor &&
        event.tags.some(([name, value]) => name === "p" && value === pubkey)
      )
        ids.add(id);
    }
    return [...ids];
  }
  /** Whether this channel's current relay-signed roster lists `pubkey`. Throws
   * when no roster is readable, so missing evidence never counts as absence. */
  async function listsMember(id: string, pubkey: string, caller: AbortSignal) {
    if (!relayAuthor) throw new Error("Channel membership is unavailable.");
    const events = await discovery.read(
      [{ kinds: [39002], authors: [relayAuthor], "#d": [id], limit: 1 }],
      {
        signal: AbortSignal.any([signal, caller]),
        fresh: true,
        priority: "foreground",
      },
    );
    const roster = events.find(
      (event) =>
        event.kind === 39002 &&
        event.pubkey === relayAuthor &&
        event.tags.some(([name, value]) => name === "d" && value === id),
    );
    if (!roster)
      throw new Error(
        "Could not refresh channel membership. Retry to continue.",
      );
    return roster.tags.some(
      ([name, value]) => name === "p" && value === pubkey,
    );
  }
  async function addAgents(
    id: string,
    keys: readonly string[],
    active?: () => boolean,
  ) {
    const find = () => channels.list().channels.find((item) => item.id === id);
    if (active?.() === false)
      throw new DOMException("Channel addition cancelled", "AbortError");
    const original = await refreshMembership(id);
    if (active?.() === false)
      throw new DOMException("Channel addition cancelled", "AbortError");
    const unique = [...new Set(keys)].filter(
      (key) =>
        original.channelType !== "session" || !original.members?.includes(key),
    );
    if (!unique.length) return;
    const parentId = original.parentChannelId ?? id;
    const parent =
      parentId === id ? original : await refreshMembership(parentId);
    if (
      !parentId ||
      !parent?.members ||
      parent.archived ||
      !["stream", "forum", "session"].includes(parent.channelType ?? "")
    )
      throw new Error("Refresh the parent channel before adding agents.");
    const known = new Set(agentKeys?.() ?? []);
    if (unique.some((key) => !parent.members?.includes(key) && !known.has(key)))
      throw new Error("Choose an agent from your agent library.");
    // Parent metadata organizes the UI; both channels keep their own rosters.
    const targets = parentId !== id ? [parentId, id] : [parentId];
    for (const targetId of targets) {
      for (const key of unique) {
        if (active?.() === false)
          throw new DOMException("Channel addition cancelled", "AbortError");
        writer(!!active);
        if (find()?.parentChannelId !== original?.parentChannelId)
          throw new Error("This session moved. Refresh and retry.");
        const current = channels
          .list()
          .channels.find((item) => item.id === targetId);
        if (!current?.members || current.archived)
          throw new Error("Channel membership is unavailable.");
        if (current.members.includes(key)) continue;
        const previous = (receipts ?? outbox)
          ?.snapshot()
          .find(
            (item) =>
              item.event.kind === 9000 &&
              !item.acknowledged &&
              !["accepted", "seen"].includes(item.delivery) &&
              item.event.tags.some(
                ([name, value]) => name === "h" && value === targetId,
              ) &&
              item.event.tags.some(
                ([name, value]) => name === "p" && value === key,
              ) &&
              !item.event.tags.some(([name]) => name === "role"),
          );
        if (
          previous &&
          Date.now() / 1000 - previous.event.created_at >= 15 * 60
        )
          throw new Error(
            `This agent-add request expired. Open Outbox, remove the “Add agent ${key.slice(0, 12)}” item, then add the agent again. Check channel membership first if the request was unconfirmed.`,
          );
        const operation =
          previous?.event.id ??
          writer(!!active).send(
            {
              kind: 9000,
              content: "",
              tags: [
                ["h", targetId],
                ["p", key],
              ],
            },
            undefined,
            active,
          );
        await delivered(operation, active, true);
        if (active?.() === false)
          throw new DOMException("Channel addition cancelled", "AbortError");
        await refresh(targetId, { member: key }, false);
      }
    }
    if (original?.channelType === "session")
      await refresh(id, {
        members: unique,
        ...(original.parentChannelId ? { parent: parentId } : {}),
      });
  }
  return Object.freeze({
    available,
    addAgents,
    refreshMembership,
    memberChannels,
    listsMember,
    createChannel(
      id: string,
      title: string,
      visibility: "open" | "private",
      description?: string,
      ttlSeconds?: number,
      active?: () => boolean,
    ) {
      writer();
      identifier(id);
      const name = title.trim();
      const about = description?.trim();
      if (!name || [...name].length > 120)
        throw new Error("Use a channel name between 1 and 120 characters.");
      if (about && [...about].length > 1000)
        throw new Error("Keep the channel description under 1,000 characters.");
      if (about?.includes("Buzz session ("))
        throw new Error("Choose a different channel description.");
      if (
        ttlSeconds !== undefined &&
        (!Number.isInteger(ttlSeconds) ||
          ttlSeconds <= 0 ||
          ttlSeconds > 2_147_483_647)
      )
        throw new Error("Choose a valid temporary channel duration.");
      return writer().send(
        {
          kind: 9007,
          content: "",
          tags: [
            ["h", id],
            ["name", name],
            ["visibility", visibility],
            ["channel_type", "stream"],
            ...(about ? [["about", about]] : []),
            ...(ttlSeconds ? [["ttl", String(ttlSeconds)]] : []),
          ],
        },
        undefined,
        active,
      );
    },
    create(id: string, title: string, parentId?: string) {
      writer();
      identifier(id);
      if (parentId) identifier(parentId);
      if (!title.trim() || [...title].length > 120)
        throw new Error("Use a session title between 1 and 120 characters.");
      if (parentId === id)
        throw new Error("A session cannot be its own parent.");
      return writer().send({
        kind: 9007,
        content: "",
        tags: [
          ["h", id],
          ["name", title],
          ["visibility", "private"],
          ["channel_type", "stream"],
          ["about", sessionDescription(parentId)],
        ],
      });
    },
    invite(id: string, pubkey: string) {
      identifier(id);
      const target = channels
        .list()
        .channels.find((channel) => channel.id === id);
      if (target?.channelType !== "session" || target.parentChannelId)
        throw new Error(
          "Manage this session’s participants in its parent channel.",
        );
      if (!/^[0-9a-f]{64}$/.test(pubkey))
        throw new Error("Choose a valid participant.");
      if (!new Set(agentKeys?.() ?? []).has(pubkey))
        throw new Error("Choose an agent from your agent library.");
      return writer().send({
        kind: 9000,
        content: "",
        tags: [
          ["h", id],
          ["p", pubkey],
        ],
      });
    },
    failed(id: string) {
      return (
        (receipts ?? outbox)
          ?.snapshot()
          .some((item) => item.event.id === id && item.delivery === "failed") ??
        false
      );
    },
    async discardFailed(id: string) {
      const source = writer();
      if (
        !(receipts ?? source)
          .snapshot()
          .some((item) => item.event.id === id && item.delivery === "failed")
      )
        throw new Error(
          "This operation is still unconfirmed. Retry to confirm it first.",
        );
      await source.dismiss(id);
    },
    delivered,
    refresh,
  });
}
