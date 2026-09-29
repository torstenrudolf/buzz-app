# Unified relay session

`features/relay/session.ts` composes one session per connected community and viewer.
Plugins inject **only `relay`**. Reads, reactive views and the optional outbox are
capabilities on that same session; sent-versus-seen reconciliation is internal.

The relay service exists before its connection is ready. Subscribe to connection
replacement; do not capture `ctx.relay.snapshot().session` once during plugin startup.
The Channels page uses this pattern:

```tsx
const connection = useRelayConnection(relay);
if (connection.status !== "ready") return <ConnectionState connection={connection} />;
return <Feature key={`${connection.scope}:${connection.generation}`} session={connection.session} />;
```

Scope includes community and viewer; generation distinguishes replacement sessions
within that scope. Both belong in the remount key. A local-first cached session
and its live successor intentionally share that generation: this is one startup,
not a reconnect reset. The channel timeline retains its parent-bound presentation
lifetime while rebinding readers; other session-owned controls still reset. Persist
drafts/navigation under scope alone so reconnecting does not lose local intent.
See [local-first launch](channels.md#local-first-launch) for cache authority rules.

Inside a feature bound to the current session:

```ts
session.channels.ensure(channelId);
const window = session.channels.window(channelId);
await session.profiles.ensure([authorId]);

// A plugin's filtered view includes matching local operations immediately.
const view = session.observe([{ kinds: [9], "#h": [channelId], limit: 80 }]);
ctx.effect(() => {
  const unsubscribe = view.subscribe(render);
  return () => { unsubscribe(); view.dispose(); };
});
void view.refresh();

// The same interface supplies write operations when supported by the host.
const outbox = session.outbox;
if (outbox?.supports(9)) {
  const id = outbox.send({ kind: 9, content: "Hello", tags: [["h", channelId]] });
  // id is already stable; signing and publishing proceed asynchronously.
}
```

`session.read(filters, { signal })` is a finite read merged with matching local
operations at completion. `session.observe(filters)` additionally subscribes to
outbox changes, exposing immutable `{ status, events, error }` snapshots. Own the
view with the plugin's Cordis scope and use `useSyncExternalStore` in React. The
Channels plugin uses the existing channel-specific hooks over the same local
operations. The composer holds draft text, not a private message list.

`observe()` retains a bounded union of matching events across reads and live
traffic; refresh does not replace that collection or remove events omitted by a
later response. Filter `limit` bounds each relay request, not the visible collection.
It rejects any filter containing `search` or `feed_types`, including mixed filter
requests. Use finite `session.read()` for those server-ranked results; it preserves
the response order. A feature needing reactive ranked results must own its refresh
and replacement semantics.

Visible events contain `EventData` and optional `delivery`/`error` metadata. A
locally authored event is **not proof of relay acceptance**. Signature-verified
`RelayEvent` records remain the private transport boundary used for authoritative
membership, bounds and persistence. Domain folds can consume local payloads, but
must not let them manufacture relay-authored authority.

## Community emoji

`session.emoji` owns the current community's kind-30030 `d=buzz:custom-emoji`
member sets. `snapshot()` / `subscribe()` provide an immutable catalog; `ensure()`
is lazy and background-priority, and `refresh()` explicitly retries. The shared
composer warms it on mount. Each author's newest complete set replaces their old
one (including empty removal sets); the union picks newer sets, then smaller URLs,
for shortcode conflicts. The directory retains at most 500 member sets / 2 MiB;
read caps and overflow expose errors rather than silently evicting replacements.
An explicit retry after overflow starts a fresh bounded catalog read.

`snapshot().mine` lists the viewer's own set. When the session has an attachment
uploader and its writer admits kind 30030, the directory also exposes `upload()`
(the session uploader, fenced by session lifetime) and `add(name, url)`. `add`
normalizes the shortcode, freshly reads the viewer's own set, replaces that
shortcode, and republishes the whole set with a strictly newer `created_at`.
Adds within a session run one at a time, so a stale read cannot drop an earlier
add. The signed echo must match the template before publishing, the accepted set
joins the palette immediately, and failures surface as the reference
`Failed to add emoji.` / `Timed out while adding emoji.` copy. The development
broker admits kind 30030 only for the canonical own-set template
(`validEmojiSetTemplate`).

Live kind-30030 updates share the existing profile route, not another socket or
subscription slot. Global establishment repairs an already requested catalog;
cache/access clearing and disposal cancel its reads and fence stale results.
The development broker imports the live subscription code at startup: an already
running broker needs one coordinated restart to gain the new filter. Reopening
the picker reuses its ready catalog; it is not a manual refresh fallback for an
older broker.

`session.messages.send`, `reply`, `edit`, and `react` resolve referenced `:shortcodes:`
into original-URL emoji tags **before** the outbox assigns identity or signs. Text
without shortcode candidates does not wait. A cold/unavailable catalog throws
synchronously, so a composer retains its draft; plugins can await `ensure()` or
explicitly retry `refresh()`. Unknown codes in a ready catalog remain literal.
Retries retain the exact original event and URL even if the palette changes.
Low-level `outbox.send` remains raw intent; callers supply its tags themselves.

Text edits use `session.messages.edit(row.id, content, row.attachmentSourceId ?? row.id)`
with the current folded row. Attachment provenance selects the latest surviving
same-author edit carrying `imeta`, otherwise the original message. A missing
source fails before enqueueing rather than restoring obsolete attachments.

Message and reaction rendering uses only each event's own emoji tags, never the
current palette. Tagged edits replace mappings; legacy tagless edits preserve the
original message's mappings. All thumbnails use the captured session's media
resolver; unsupported or unloadable images fall back to literal shortcodes.
Reaction authoring uses the existing outbox: kind 7, the loaded message's channel
(`h`) and target (`e`), and event-local custom emoji tags. The development broker
admits bounded reactions with exactly one canonical target and preserves kind 7
through signing. Uploads and emoji management remain outside this slice.

## Thread views

`session.thread(channelId, messageId)` returns an owned `ThreadView` with immutable
`{ status, root, replies, error, canLoadMore, limited }` snapshots, `subscribe`,
`refresh`, `loadMore`, and `dispose`. Allocate in a React effect (not render or
`useMemo`) and dispose with the panel. Selection/layout belong to the consuming page; reusable UI lives in
`features/messages`. Verified evidence, access, live reconciliation and repair
belong to the session.

The owner resolves marked NIP-10 ancestry to the actual root, fetches that root by
ID, and traverses with explicit content kinds, `#h`, one root `#e`, depth 100 and
`include_aux`. Canonical UUID channels probe `thread_window: true` separately from
the root lookup. Strict windows request kinds 9 and 40002 only: the relay's
window row allowlist rejects legacy diff kind 40008, so strict threads omit diff
replies until the relay accepts that kind; legacy traversal still includes it. The existing verified reader validates exactly one kind-39007
bounds event, relay signer, exact tags, version/direction and full host/viewer/request
binding before any page enters session reconciliation. The destination's authority,
not the local broker host, supplies the binding. Both shipped transports provide
this authority through `ReadTransport.scope`; its absence is a configuration error,
not evidence of an old relay, and does not permit legacy fallback. Strict
continuation echoes signed `until`/`before_id`; only bounds establish exhaustion,
including empty pages whose raw scan cursor does not occur among delivered events.

Strict root admission/validation runs once before each load or refresh traversal,
not between the pages of a retained-range repair: repairing N pages uses one root
read plus N independently verified window reads. Each separate scrollback load
still reads the root. Root deletion observed live and access revocation retain their
existing session paths; a later refresh/load revalidates the root. Neither the root
lookup nor the page sequence provides an atomic snapshot.

A first probe returning verified replies but no bounds is discarded and restarted
with clean legacy `thread_cursor`/`thread_cursor_id` state. Empty unsigned responses
cannot distinguish old empty history from denied access, so remain unavailable.
Other failures, invalid bounds and missing bounds after a strict page never trigger
fallback. Non-UUID channels retain the legacy path. No capability cache persists
across owners or connections.

Each strict thread starts with 10 traversal rows plus their auxiliary events; later pages
request 50 traversal rows, with at most ten pages per repair/load range. Legacy
mode still requests 50 rows per page. The shared panel positions after the first
strict page and demand-loads older pages on scrollback. Legacy mode still
automatically walks its bounded oldest-first range and cannot promise the newest
tail. Media review retains eager bounded traversal.
Refresh re-reads the retained page range from the beginning while preserving known
rows/edits/deletes: omitted events are not retractions. Live channel traffic feeds
this same view without another subscription. Channel establishment triggers repair
independently from finite channel-head invalidation. Author deletion of a retained
edit/reaction removes that overlay. Unknown or denied auxiliary targets remain
invisible; active thread target evidence survives shared-cache eviction but still
passes the existing recursive access check.

Threads share the 64 owned-handle ceiling. Each retains at most 2,000 events / 4 MiB;
overflow clears display evidence and exposes an explicit recoverable limit rather
than silently evicting a tombstone. Cache clear, access loss and session disposal
cancel pending work and purge owned state. A missing finite root hides the display
but retains bounded tombstones for safe retry. Short/empty pages mean only what the
relay returned; depth, serving-time filtering and retention can leave history unseen.

`session.messages.reply(channelId, resolvedRootId, text)` submits kind 9 through
the existing outbox with `["h", channelId]` and `["e", resolvedRootId, "", "reply"]`.
Use the resolved root, not the selected nested reply. It does not require that root
to remain in the shared recent cache; the relay enforces channel membership and
same-channel ancestry. There is no extra root lookup, signer or delivery owner.

Local replies appear immediately in the thread but do not leak into the top-level
channel timeline. Failed content rows stay visible for same-event retry; failed
auxiliary edits/reactions stop affecting the fold. Verified echo reconciliation and
persisted signed-event retry remain the same outbox operations as channel sends.

## Exact message navigation

`session.thread(channelId, messageId, { exact: true })` retains the selected
`target` and `targetStatus` inside the existing thread owner. At most three bounded
reads fetch the target ID, reference overlays and deletions of those overlays
before exposing it. The root is resolved from signed ancestry, never a navigation
hint. Normal bounded thread traversal provides surrounding context; its cursor
never comes from the selected row. An accessible selected reply remains available
even if the original root is missing or the reply lies beyond the traversal cap.

Reference queries omit `#h` for legacy edits/deletes but retain session visibility
checks. Raw target/overlay responses reaching 500 events fail before filtering.
Evidence shares the thread's 2,000-event / 4 MiB budget and 64-view ceiling.
Known tombstones survive sparse refreshes and shared-cache eviction. Exact reads
share verification, admission, access epochs and live reconciliation without
inserting isolated rows into channel history. Explicit denial revokes the owning
channel; access loss, cache clear and disposal purge the view. There is no separate
reader owner, subscription or persistence.

## Global message search and public previews

Global message searches (`kinds: [9, 40002]`, no `#h`) keep the relay's order.
Before admitting hits, the session resolves only their distinct nonmember channel
IDs through the existing verified reader. The palette requests 20 hits; resolution
accepts at most 128 IDs in one bounded request for signed metadata and
viewer-scoped membership. This also resolves members omitted from a capped roster. Missing/forged metadata
cannot grant a preview; read/capacity failures remain visible rather than becoming
an empty successful page. Other search entities and feed queries retain their
existing finite-read behavior.

Only relay-authored explicit `public` metadata without `private`, `hidden`, or
DM type grants nonmember reading. Signed membership still owns the joined roster.
`channels.get(id)` exposes separately resolved summaries (`readOnly: true`), while
`channels.list()` remains joined-only. Opening a nonmember destination revalidates
its metadata and reuses the existing channel window/exact thread owners. It does
not join, persist a public head, warm all search results, or add sidebar/unread
membership. Only demanded retained previews enter the existing live interest set.
Shared composers and reactions remain unavailable for nonmembers; message helpers
and workflows do not acquire write eligibility from public metadata. The relay
remains the final write authority, including low-level outbox intent.

Public-to-private metadata, membership loss and explicit denial purge retained
content through the existing coordinated revocation boundary. An access-revoked
live CLOSED suspends and revalidates the affected preview ID: nonmembers may never
receive the private metadata EVENT. Failed/cancelled revalidation keeps content
hidden and exposes deliberate retry through existing live status. Suspension is
not signed denial: successful resolution can restore the same public version
without resurrecting purged content. Authority-only changes replace the subscribed snapshot
even when joined rows are unchanged; search drops copied hits on loss. Signed evidence is
bounded by discovery's existing capacity and retained for the session, including
across fetched-cache clearing; clearing cancels reads and drops content/windows,
not authority evidence. Every later search/open revalidates nonmember metadata.
An older metadata replay cannot undo a newer private event or an explicit denial.
A newer signed public event can regrant a never-joined preview; membership loss
still requires fresh signed membership, not metadata, to reverse it.

## Ownership and reconciliation

| Internal owner | Responsibility |
| --- | --- |
| `service.ts` | Connection state, replacement, root lifecycle; provides `ctx.relay` |
| `session.ts` | One plugin interface; coordinates access-loss cancellation and purges every retained read owner before reconciling new evidence |
| `reader.ts` | Request sharing, priority, cancellation and deadlines; no result cache |
| `outbox.ts` | Durable local intent, signing, publishing, retry, delivery status |
| `projection.ts` | Merge ordinary filtered reads with local events by stable event ID |
| `profile-directory.ts` | Shared signed profiles plus optimistic profile changes |
| `store.ts` / `discovery.ts` | Authoritative channel access policy, retained windows, domain folding and persistence |
| `event-access.ts` | Resolves event/reference visibility against that policy; no parallel membership cache |
| `transport.ts` | Host signer/broker access and validated publish receipts |

A send registers its local payload synchronously and notifies all views. Its ID is
computed from the viewer, timestamp, content and tags before signing. A unique
client tag distinguishes intentional duplicate messages within one second.

The outbox saves intent before signing and the exact signed event before publishing.
A storage failure prevents publishing. An explicit relay rejection becomes `failed`;
a lost response or publish timeout becomes `unknown`, because it may have committed.
A later rejected/failed retry cannot erase earlier `unknown` or `accepted` evidence;
its error describes the retry, not proof the original event was unsent.
Retries reuse the signed event and event ID. Live sessions use connection-bound
NIP-42 authentication; the separate direct signed HTTP adapter uses a fresh request-bound
NIP-98 event. Event-ID deduplication does not promise exactly-once command side effects.

An accepted receipt becomes `accepted`; a verified read containing the ID becomes
`seen`. Observation wins over a later failed/missing acknowledgement. The session
performs one foreground ID read for the just-published event, then up to four
background retries with bounded backoff. Optional profile enrichment cannot block
that first confirmation; later retries yield to current user work.
Exhausting those attempts leaves the delivery state visible and retryable. Ordinary
later reads can also complete reconciliation.

Confirmed operations leave the pending outbox automatically. Their verified events
remain in bounded confirmed retention and in active views. This is
what prevents a lagging query or stale channel refresh from erasing a successful
send. Remote echoes and local operations merge by ID, never by matching text or
an approximate timestamp. Channel windows retain verified event inputs so local
edits can fold against the original message; rejected edits stop contributing.
The timeline, channel-list preview and filtered plugin views share that operation.

## Bounds and lifecycle

- Reads: three active slots, at most one background request, 128 pending distinct
  requests, ten-second deadlines including queue time, four filters per request,
  500 per-filter limit, 64 KiB keys, and an 8 MiB result budget.
- Outbox: at most 256 operations / 2 MiB persisted, 32 KiB per submitted payload,
  three concurrent deliveries, ten-second delivery deadlines including queue time. Only outstanding
  operations count toward capacity; completed events move to a separate 2,048-event /
  8 MiB confirmed journal. Capacity failures
  are visible; unconfirmed operations are never silently evicted. Plugins can
  explicitly `dismiss(id)` to remove an operation's local contribution.
- Reactive filtered views: at most 64 owned handles; dispose with the plugin.
- Existing fetched channel history, profile, media and disk budgets remain in place.
  Local overlays have their separate journal budget and can extend a visible window.
  Shared verified observations retain up to 4,096 events / 8 MiB; owned filtered views
  retain up to 2,000 remote events / 8 MiB each. Channel tails retain 256 events
  per channel within 64 channels / 4 MiB, keeping inactive previews and revisits
  consistent. Retention is bounded, not permanent history.

Storage is partitioned by community endpoint and viewer; no private keys are
stored. Restored pending operations become `unknown` unless previously failed. Confirmed
  records remain confirmed and do not re-enter the pending outbox.
They do not publish automatically after restart. Explicit retry reuses the saved
signed event. The Channels timeline exposes retries for failed/unknown messages. Its Outbox
control also exposes restored pending operations and explicit removal. Removing an item
stops retaining its local overlay; it is not a relay deletion.
Session disposal cancels work and blocks late state changes. Cache clearing keeps
the outbox: clearing fetched data is not cancelling a user's write.

### Authoritative access loss

A signed membership exclusion, omission from a complete viewer-scoped roster, or
explicit channel denial removes inaccessible data from existing **and newly opened**
host read views. A generic read returning denial with exactly one explicit `#h`
channel also revokes that channel. An ambiguous multi-channel/broad error does not
prove which membership was lost; a denied complete-roster request invalidates all
channel access. Partial discovery and transport failures never revoke by omission.
A successful complete roster is applied immediately, independently of the optional
metadata/name read: a later name-fetch error does not discard membership evidence.
Completeness cannot erase a newer signed roster received after that request began;
metadata completion cannot replay the older membership snapshot.

The session cancels all pending reads on revocation, because broad/ID/reference
filters cannot establish event ownership before results arrive. Completion epochs
also fence already-resolved requests. Directory browsing/searching retries one
access-epoch invalidation through the same verified scheduler, without admitting
its results into shared conversation profiles. Caller cancellation, cache clear,
disconnect and disposal stop that recovery; a second invalidation surfaces an error
for explicit Retry, rather than starting a UI retry timer. Channel-content reads do
not inherit this directory-specific retry. The session defers subscription callbacks
until every owned projection and the final channel list have been purged; a callback
reading another view cannot observe its pre-revocation snapshot. Unrelated retained
channel content survives, but in-flight reads may need refresh. A newer signed roster can regrant access;
replaying the last retained pre-revocation roster cannot restore it. Read grants/removals reach the
store's authority boundary even when their raw events are hidden from plugin views.

Visibility uses each event's `h` tags, channel-metadata `d` tags, and auxiliary
references. For edits, deletes, reactions and summaries (kinds 40003, 5, 9005, 7,
39005), **every `e` target must be available and visible**, including targets in the
same response. A reference-only orphan is omitted rather than assumed public;
cycles/deep reference chains fail closed. Explicit `h` does not authorize an unknown
second target. Ordinary non-channel entities remain readable, and auxiliaries for
retained non-channel targets still work. Fetch target evidence with an auxiliary
when needed. This is a deliberate narrowing of raw standalone auxiliary reads, not
a generic Nostr authorization implementation or a new external SDK promise.

Revocation purges fetched/confirmed read evidence, not pending intent. The outbox
retains pending/unknown operation IDs and exact signed bytes for explicit recovery;
its management snapshot still exposes those operations, while read overlays hide
them until access returns. Confirmed evidence is not pending intent and is dropped
when inaccessible. If revocation races initial outbox hydration, that load's entire
confirmed cache is discarded conservatively; pending signed records are preserved.
Shared signed profile projections and already-opened disk-head caches are also
cleared conservatively because they can include cross-channel evidence. Disk-cache
failure does not reauthorize in-memory views. This does not erase copies already
made by trusted plugins, cancel/re-sign durable writes, or replace relay-side checks.

A plugin unloading does not dispose the session or its writes. Reconnection creates
a new session and restores the same community/viewer's durable outbox. Distinct
community/viewer storage partitions never share outgoing intent.

Server-ranked search/feed eligibility is not inferred from local text. Ordinary
NIP-01 ID/kind/author/tag/time filters receive local overlays; features with special
server semantics must define their own domain projection. Reads stay bounded and
do not claim complete history merely because they returned successfully.

## Evidence from the current Buzz desktop

Inspected [Block Buzz](https://github.com/block/buzz) on 2026-09-07. Paths below are
relative to that repository. This is an inventory of read contracts, not a port of its UI.

| Desktop use | Source | Contract supported by the core |
| --- | --- | --- |
| Channel history and auxiliary overlays | `desktop/src/shared/api/relayChannelFilters.ts`, `relayClientSession.ts` | Kinds, `#h`, time bounds; `#e` for edits/reactions/deletions. Foundation retains its stronger NIP-CW bounds/closure contract. |
| Profiles and user directory | `desktop/src/shared/api/tauriProfiles.ts` | Shared kind-0 directory; ID-independent author batches. Search remains a finite filtered read. |
| Relay membership | `desktop/src/shared/api/relayMembers.ts` | Kind 13534 snapshot; feature must preserve “no membership snapshot” separately from denial. |
| Custom emoji | `desktop/src/shared/api/customEmoji.ts` | Kind 30030 with `#d`, optionally an author; feature folds member sets. |
| User status | `desktop/src/features/user-status/hooks.ts` | Kind 30315, authors, `#d=general`; expiry semantics belong to the status feature. |
| Stars, mutes, sections, sorting, project membership | `desktop/src/features/sidebar/lib/*Sync.ts`, `desktop/src/features/projects/lib/projectSidebarMembershipSync.ts` | Kind 30078, author, `#d`; encryption and merge rules stay outside the reader. |
| Read markers | `desktop/src/features/channels/readState/readStateManager.ts` | Kind 30078, author, `#t=read-state`, `since`; multiple device slots must be merged by the feature. |
| Hidden DMs | `desktop/src/features/channels/useHiddenDmIds.ts` | Kind 30622 scoped by viewer `#p`; result interpretation remains domain-owned. |
| Repositories, issues, PRs and assignment history | `desktop/src/features/projects/hooks.ts`, `assignmentOperationFetch.ts` | Authors, `#d`, repository addresses `#a`, event references `#e`; limit and completeness decisions remain explicit. |
| Entity links | `desktop/src/shared/lib/useResolvedLinkPreviews.ts` | Event IDs and address-based lookups without loading a channel. |
| Thread traversal, Home feed, search | `desktop/src/shared/api/tauri.ts`; `crates/buzz-relay/src/api/bridge.rs` | Bridge `depth_limit` and composite thread cursor, ordered `feed_types`, `search`, `search_mode`, `page`. These return events; native response metadata is not fabricated. |
| Persona/team catalogs, reminders, community themes | `desktop/src/features/agents/lib/usePersonaSync.ts`, `desktop/src/features/reminders/lib/reminderService.ts`, `desktop/src/shared/theme/communityThemeSync.ts` | Ordinary kind/author/tag reads through the same finite reader. |

The HTTP bridge supports these finite filter shapes and enforces authorization
server-side. The opt-in dev broker accepts bounded Nostr kinds and event-ID reads. No live credentials are used by tests.


## Current scope and validation

Channels supports top-level text messages and direct thread replies, Enter to send,
Shift+Enter for a newline,
immediate rows and shared preview data (not currently rendered in the sidebar),
delivery status, and retry. The dev broker
advertises kind 9 writes and signs bounded channel messages, including exactly one
canonical direct-reply reference. Both sign and publish endpoints reject malformed
or arbitrary references before upstream I/O. The
signed transport can supply additional event kinds to other plugins. No separate
plugin signer or writer service is exposed.

The signed host and opt-in broker subscribe to authenticated Nostr traffic. Verified
incoming events, finite reads and own echoes enter the same session reconciliation
path. Reconnect performs bounded replay and revalidates retained channel heads and
filtered views. History bounds still come from finite channel reads; replay does
not claim complete history. Decryption, uploads and server-derived aggregate calculations remain domain capabilities.

`session.messages.send(channelId, text)`, `.reply(channelId, resolvedRootId, text)`,
`.edit(messageId, text)` and `.retry(id)`
are domain conveniences over the same outbox. Editing requires a retained message
owned by the viewer and a transport that supports kind 40003. The dev broker
advertises edits and validates one canonical target reference before signing or
publishing. Generic plugins can use `outbox.send` directly.

`session.messages.report(messageId, type, note?)` is the one exception: the relay
queues NIP-56 reports (kind 1984) for moderators and never stores or echoes them,
so the session signs and publishes directly and resolves on the relay's accepted
receipt, as Buzz desktop does. Nothing is persisted or restored; a rejection or
10-second timeout rejects the call and the dialog keeps its input for retry. The
method is undefined unless the writer supports kind 1984.

In an empty composer, unmodified Up arrow opens the latest eligible own message
from that channel or thread in the same editor. Enter/the send arrow saves;
Escape or × cancels. Edits retain raw attachment Markdown and leave original
notification recipients unchanged. Edit text never overwrites the new-message
draft or its undo history. Pending edits lock the editor until delivery; failed
or unknown outcomes offer retry of the same outbox event. Missing or concurrently
changed targets are rejected without losing the user's input.

Persistence uses incremental asynchronous IndexedDB transactions partitioned by
community and viewer. Only changed records are written; the earlier localStorage
journal is migrated on first commit. Restored signatures are verified in batches
that yield to rendering. Local insertion is
synchronous; intent and then the exact signed event must commit before publication.
Queued intent is still saved when a session is disposed before storage finishes
loading. Restored operations are never published automatically.

Delivery status changes preserve unaffected row/event identities. Per-window event
and overlay indexes fold only affected message content; signing and ACK transitions
never refold history. Incoming traffic updates the same channel preview and views.
When live traffic fills a retained history budget, oldest remote inputs are trimmed
and history is marked limited; new traffic continues to arrive.

`outbox.test.ts` covers immediate views, stale reads, echo-before-ACK, explicit
rejection, exact-event retry, persistence failures, restart, timeout/unknown outcomes,
optimistic profile changes and edit rollback. `transport.test.ts` covers request-bound
HTTP publishing and receipt validation. Existing history/revocation tests still run
through the unified session. `tests/fixtures/relay-composer.html` is a local-only browser
fixture using ephemeral signing keys and an in-memory relay; messages containing
`reject` fail once, allowing the real composer/retry UI to be exercised safely.

## Profiling and integration checks

`session.profiling.snapshot()` returns the latest 2,048 completed samples plus active
spans. Samples contain stage, event/request ID, start, duration, outcome and optional
work count. They never contain message content, filters, credentials or signatures.
Open **Outbox → Relay timings → Capture timings** while a send is stuck; active
spans show elapsed time. **Export timings** downloads JSON for comparison.

- `send.local`: synchronous insertion and view propagation.
- `outbox.load`, `outbox.queue`, `outbox.persist`: hydration, queueing and durable transactions.
- `send.sign`, `send.verify`: host signing and verification of the returned event.
- `send.publish`: publication through receipt validation.
- `http.auth`, `http.fetch`: signed host authentication and HTTP request latency.
- `broker.sign`, `broker.auth`, `broker.connect`, `broker.ttfb`, `broker.relay`, `broker.upstream`:
  dev broker Server-Timing measurements. `connect` appears only when a request had to open a
  new upstream connection; `relay` is the relay's own reported service time, so
  `upstream − relay` is network and edge time.
- `read.queue`, `read.fetch`, `read.verify`: scheduling, transport, and response verification.
- `events.reconcile`, `view.reconcile`, `view.fold`: shared evidence propagation and affected-message work.

`pnpm exec vitest run src/features/relay/traffic.integration.test.ts --silent=false`
exercises first-versus-subsequent send latency, 2,400 retained rows, echo-before-ACK,
stale-read races, edit rejection, automatic retirement, restart, and asynchronous
storage disposal. It asserts exact fold work, subscriber counts and unaffected
identities. Synchronous-send time is diagnostic, not an enforced latency guarantee;
elapsed measurements are machine dependent.
`live.test.ts` exercises authenticated subscriptions, signature rejection, reconnect
and disposal. These tests use ephemeral keys and local transports; no live messages
are posted by validation.

For reusable JSON artifacts, set `RELAY_PROFILE_DIR`:

```sh
RELAY_PROFILE_DIR=/tmp/relay-profiles pnpm exec vitest run src/features/relay/traffic.integration.test.ts src/features/relay/broker.integration.test.ts
```

This writes `history.json` (elapsed send time and exact work counts) and
`broker.json` (real local HTTP through signing, broker authentication, deliberately
slow first upstream publish, receipt validation and ID read-back). Upstream calls
are injected local fixtures, so these integration tests cannot post to the live relay.
`tests/fixtures/relay-storage.html` additionally exercises actual browser IndexedDB migration,
incremental status updates, deletion after restart and partition isolation.


### Repeatable thread-read profile

The app-local `ThreadPanel.profile.test.tsx` mounts the real panel over the real
session and broker HTTP client, with signed synthetic loopback responses. The
fixture uses the same `prepared`/`warm` options as `service.ts`, explicit memory
storage, and a completed authorization/head-warming barrier. It observes the
panel's own paging and profile effects rather than driving those operations on
its behalf. Composer emoji demand and reading dwell are excluded.

```sh
# Choose a new output path for every run; existing artifacts are never overwritten.
BUZZ_ENGINE_PROFILE_OUT=/tmp/thread-before.json BUZZ_ENGINE_PROFILE_SAMPLES=7 \
  bin/pnpm exec vitest run src/features/messages/ThreadPanel.profile.test.tsx
# Make the bounded engine change, leaving the harness/fixture/dependencies unchanged.
BUZZ_ENGINE_PROFILE_OUT=/tmp/thread-after.json BUZZ_ENGINE_PROFILE_SAMPLES=7 \
  bin/pnpm exec vitest run src/features/messages/ThreadPanel.profile.test.tsx
```

Each measurement run discards two warmups, then captures cold/reopen pairs for
128 replies and eight authors. Artifacts include source hashes, fixture/harness
and lock hashes, runtime/host metadata, request traces, work counts, CPU time,
engine completion and jsdom DOM completion. Before comparing, require matching
workload, compatibility, warmup/sample counts and request/work shapes. Inspect
source hashes to attribute the difference to the intended edit. Alternate
before/after controls when host load varies; do not infer UI speedup from a
verification-stage reduction. Without the output variable, the ordinary test
suite runs one correctness pair and writes no artifact.

For a separate diagnostic run, also set
`BUZZ_ENGINE_CPU_OUT=/tmp/thread.cpuprofile`. Profiling affects timing; compare
profiled runs only with profiled runs. `read.verify` includes JSON parsing and
cooperative batch yields, not just signature CPU. These development-React/jsdom
measurements prove neither startup nor browser paint, native performance, actual
IndexedDB durability or live relay latency.

The HTTP verifier retains at most 2,048 event-ID/signature pairs per transport
using the existing byte-bounded LRU. A hit requires fresh envelope validation,
a fresh hash of signed fields and the exact previously verified signature. It
still returns newly owned frozen data and performs every HTTP read and access
check. It is not an event/query cache or authorization proof; WebSocket and other
`eventDto` callers remain uncached. `event-proof.test.ts` covers tampering,
connection isolation, eviction and actual HTTP wiring. `events.ts` also belongs
to the dev broker's native-config import graph: new runtime imports there must
retain explicit extensions and pass `dev/vite-config.test.mjs`.

## WebSocket-first publication

The matched development frontend/broker publishes signed events on its
existing authenticated live socket once the session subscribes. This includes
messages, reactions, workflow commands and purpose-bound encrypted read-state
writes admitted by the existing broker. The host still validates signature,
viewer, purpose, origin and community before sending. There is no second socket,
outbox or reconnect replay. Publication and live REQ setup share WS admission;
queued foreground publications precede bulk subscription setup.

`socket-requests.ts` only correlates EVENT with its matching OK. It bounds pending
IDs to 32, sent/in-flight events to three, outgoing frames to 64 KiB, and receipt
text to 16 KiB. Its ten-second deadline includes queued/authentication time.
Disconnect, cancellation or timeout after dispatch, throwing sends, malformed
receipts and internal/unknown negative receipts remain uncertain. Only a proven
unsent operation or documented validation/admission rejection proves non-delivery.
NIP-01 rejection does not guarantee rollback of Buzz command side effects. Accepted
command receipt text stays ephemeral; it is never journaled or replaced by an echo.

### HTTP boundaries retained in this slice

- **All finite reads**, including publication ID confirmation, roster authority,
  search, channel windows, recursive threads and workflow history, retain their
  current HTTP paths. EOSE is a stored-to-live transition, not a complete snapshot
  certificate. Cutover requires truthful relay errors and equivalent bounds,
  ordering, authorization and partial-failure behavior. The relay historical-query
  EOSE-on-error repair alone does not certify search or specialized reads.
- **Setup profile publication** retains its separate `/profile` HTTP route; profile
  inspection remains read-only and allocates no socket. `/publish` and
  `/read-state-publish` require the live owner: absent, reconnecting or disposed
  owners never trigger upstream HTTP fallback. Missing identity is definite
  non-delivery. Frontend and broker versions must match; old brokers are not a
  supported compatibility path. The pre-existing direct signed adapter is unchanged.
- **Browser to local host** still uses HTTP for signing, publication control and
  SSE delivery. `X-Buzz-Live-ID` selects the existing owner, not upstream `/events`.
  Private keys remain host-local.
- Media, relay metadata, Git/external services and local OS capabilities keep their
  appropriate existing protocols. Presence polling/lease semantics are not changed
  by this publication slice; moving a periodic query onto WS would not make it reactive.

`live.test.ts`, `broker-live.test.ts` and `dev/relay-broker-live.test.mjs` cover
AUTH/OK correlation, admission, bounded failures, no replay, in-place interests,
owner fencing, real broker/session-outbox reconciliation, workflow receipts and
encrypted read-state publication with ephemeral keys and injected sockets. These
are local protocol/integration fixtures, not deployed-relay or native acceptance.

### Upstream HTTP connections

For retained HTTP operations, the dev broker uses a long-lived connection pool
(60 s keep-alive) with cached DNS. Community discovery is lazy; production does not schedule periodic warm-up
requests. Connection reuse can avoid repeated DNS + TCP + TLS work, but does not
guarantee a warm socket or stall-free sends. Connect attempts have a 2.5 s timeout
and retry once for configured connect-phase errors only, before the request is
sent; these failures return `502 {sent:false}`, which the transport
treats as a definite non-delivery (`failed`, retryable) rather than `unknown`.
A browser that abandons a request also cancels the upstream request. The outbox
tracks each delivery as one `Attempt` record (deadline, intent write, controller).

### Delivery review follow-up

Verified echoes now release their delivery slot immediately, including when the
publisher ignores cancellation. Durable commits take their snapshot after journal
hydration, so a timed-out first operation cannot temporarily overwrite restored
intent. Signature batches share a `MessageChannel` yield with transport reads to
avoid nested-timer delays. `tests/fixtures/relay-startup.html` measures cold/warm sends with
512 restored signed records and actual IndexedDB, using only local test identities.
See [the archived query and delivery review](archive/foundation-review.md) for dated
measurements, and [current limits and deferred choices](status.md#known-limits-and-deferred-choices)
for outstanding work. These manual fixtures are not part of `pnpm test`; see
[fixture setup](contributing.md#manual-browser-fixtures).


## Live coverage and quota recovery

The session's `live` capability exposes connection/route state independently from
finite-read readiness. A connected socket is not proof that every route is live.
Global profile and self-scoped membership-hint routes are separate from channel
traffic. The logical interest capacity remains 1,022 channels plus those two globals
(one fewer channel while agent observation is enabled); omitted routes and partial
roster coverage remain visible. Joined background channels share stable wires of
at most 10 channels. Initial replay uses singleton channel filters, matching the
relay's per-REQ filter cap; live-only replacements use one equivalent filter.
Public previews and foreground interests admitted as singletons remain separate;
navigation prioritizes pending work without rebuilding healthy wires. Joined
versus preview classification travels atomically with interests.

Initial replay is opportunistic and capped at 500 events **per channel filter**,
preserving the previous singleton replay allowance. A busy channel cannot consume
another channel's sample. This reduces REQ frames and route-state publications,
not historical database queries. Aggregate replay status stays conservative:
500 received events can mark a batch limited but never prove any channel complete.
EOSE establishes streaming, **not complete historical replay**. Retained channel
windows get finite, signed-bounds head catch-up after establishment/reconnect;
unopened channels defer it until demand. `live.snapshot().heads` distinguishes
pending, verified, deferred and failed obligations. Verification covers the
bounded current head, not all history or every event missed while disconnected.
Catch-up merges into paged readers without resetting older pages or their cursor.

Removing a batch member rebuilds only that batch's survivor scope. One established
source overlaps its zero-replay replacement until EOSE; another removal supersedes
the pending replacement, not that established source. Removed IDs are fenced
immediately, including after re-addition. Original source scopes stay immutable;
ambiguous auxiliary events never gain invented alert attribution. Replacements
use fresh wire IDs, preserve `since`, and request `limit: 0`, so their events are
live even before EOSE. Pending setup alone does not prove continuity. Narrowed-scope
failure, denial, invalid traffic and disposal release both sources. For an
unchanged scope, a renewal timeout or transient relay error retires only the
replacement and retains the established source, with the error visible until
fresh EOSE. The existing minute timer retries that renewal; quota failures retain
the same source but obey the existing cooldown and three-retry limit. Exhausted
or unsupported quota retries require manual Retry, not a reset each minute.

One 60-second recovery timer renews established joined batches and hints the
existing roster and unread owners to repair finite evidence. It does not renew
singleton previews, add per-channel background history reads or reset the socket.
This repairs silent pruning and missed hints; 60 seconds is an interval, not a
convergence deadline under throttling, suspension or failure. Each live-only
replacement consolidates its unchanged kinds, `since` and channel scope into one
`limit: 0` filter: no historical sample is shared, and live matching is equivalent.
The relay still executes one historical query per renewed wire; this reduces
filter-query invocations, not REQs, HTTP repair or local SSE state publications.
Finite repairs stay quiet and do not generate retrospective incoming alerts.

`live.snapshot().roster` reports the finite channel-list refresh obligation,
including failures when no channel is selected. The store owns that obligation,
the optional metadata read, and its learned retry time; live Retry and diagnostic
Refresh channels share the same cooldown. Metadata failure never revokes successful
membership authority. Hints during an active read coalesce into one follow-up;
a refused read retains the obligation without draining queued work. Live Retry
retries failed/deferred work, not every successful refresh or healthy subscription.
A new channel-route failure with Buzz's `restricted: channel access revoked`
reason schedules this same coalesced refresh. CLOSED is a hint, not archive or
membership authority: signed discovery decides whether the channel is archived,
still accessible, or removed. Repeated aggregate failure snapshots do not refresh
again; failed discovery remains visible and explicitly retryable. The existing
explicit `restricted: not a channel member` denial still revokes immediately.

The outbound host owns WS and HTTP admission for each canonical community/viewer.
Healthy requests have **no fixed inter-request delay**. WS admits up to three
outstanding publications and four pending subscription setups; HTTP admits up to
six requests awaiting response headers per principal (error normalization retains
its slot). The broker's existing six-request guard additionally covers response
bodies. Available slots start immediately; completion frees capacity without a timer. These concurrency bounds do not
reserve relay quota: large startup bursts can still receive quota refusals.
Explicit server cooldowns, reconnect backoff and operation deadlines remain;
there is no proactive admission pacing or token bucket. Browser POST replacement does
not reset learned pauses; signed
requests enter HTTP admission after asynchronous authentication, at actual fetch
dispatch. Read/write priority and cancellation cross the reader/transport boundary.
Long pauses surface recoverable errors rather than occupying queued-read deadlines.
Admission is local coordination, not a reservation of the relay's account-wide
budget: other processes/clients can still cause a refusal. Ambiguous publication
outcomes retain their exact signed event and are never transparently re-signed.

The browser broker streams SSE over POST with bounded interests and owner-scoped
retry/priority/interest controls. Retry and interest changes preserve the upstream
socket and healthy unchanged routes, so they do not interrupt pending publications.
Interest updates coalesce through `/stream-interests`; origin, community, owner and
body limits apply (1,024 IDs each for final interests, joined scope and pending
removals, 450 KB combined control body). Pending removals preserve retirement of
old wires even when coalescing hides an intermediate empty interest set. Local
interest revisions fence delayed channel events, denials
and establishment across remove/re-add, including changes during stream startup.
This is local IPC metadata, not a new Nostr extension. An uncertain control outcome
uses bounded reconnect with current interests; publications are not replayed.
Under actual local response backpressure, the host coalesces replaceable route-state
snapshots until `drain`, retaining only the latest captured interest revision.
Connection, observer-liveness and channel live→non-live transitions remain ordered, as do actual traffic,
establishment and denial events; the existing slow-client byte limit still applies.
No timer or delay is added to upstream requests.
Development HTTP/1 streaming uses a close-delimited response to avoid WebKit
stranding trailing chunked frames until later traffic. This is not a new
replay-completeness guarantee.


### User attention during recovery

The warning banner is for failures needing attention. Routine setup and bounded
automatic WebSocket quota recovery stay in Channel Settings → Diagnostics.
A supported quota refusal remains recorded while waiting/retrying and is cleared
only by fresh EOSE, not by sending another REQ or clicking Retry. Diagnostics
labels the original rejection as historical text, not a live countdown.
Exhausted attempts, unsupported pauses, other route/connection failures and
unfinished finite roster/head failures still show a warning and recovery action.
This presentation policy does not increase quotas or guarantee that another
client sharing the account cannot cause a refusal.

## Receive-only typing

Typing indicators show recent activity from another participant in the current
channel or thread. They identify the signer, including agents; they do not imply
online presence, ongoing agent execution, or a promise of an answer.

The session owns this temporary state through `session.typing`. Shared conversation
composers use the same indicator so channel and thread views agree about who is
active and where. Names reuse already loaded profiles; displaying activity does
not start extra reads or connections.

A message clears its author's preceding activity in that conversation. Brief
post-message suppression prevents late activity from immediately bringing the
indicator back; otherwise silence lets it expire. Only current live activity can
activate it, never fetched history. Losing access, disconnecting, clearing the
cache or replacing the session clears it too, so stale activity cannot carry into
another conversation or account.

Typing stays out of message history, unread counts and persistent storage. This
is receive-only: opening or using a composer does not publish typing activity.
