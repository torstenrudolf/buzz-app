# Unread and read-state ownership

`RelaySession.unread` is the shared capability. Plugins render its immutable
selectors and submit reading intent; they do not maintain counters, sign markers,
open sockets, or write persistence. `src/features/relay/unread.ts` owns bounded
verified message evidence, `read-state.ts` owns durable intent and reconciliation,
and the existing reader/live routes carry both. Disabling Channels does not erase
accepted intent. `src/plugins/author.ts` exports the types through the existing
host-matched author preview, not a cross-version SDK or plugin sandbox.

## Consumer contract

```ts
const target = { kind: "channel", channelId } as const;
const snapshot = session.unread.snapshot(target);
const unsubscribe = session.unread.subscribe(target, render);
await session.unread.ensure(); // shared bounded observation, not per-row fetch

// A custom reading UI owns one cancellable observation lease.
const reading = session.unread.reading(channelId);
await reading.observe(visibleVerifiedMessageIds);
reading.dispose(); // on hide, retarget, focus loss, or unmount
unsubscribe();
```

Targets are `{kind:"channel",channelId}`, `{kind:"thread",channelId,rootId}`,
or `{kind:"message",channelId,messageId}`. The consumer must establish actual
reading intent before calling `observe`: this is a trusted in-process API, not
proof that a human read text. The engine resolves signed message identity,
timestamps, ancestry, deletion and current access; arbitrary timestamps are not
accepted. Cancelled leases cannot survive disposal, revocation/regrant, or a newer
manual-unread action. Restored channel heads pass signature/access verification
and supply evidence before their rows become observable.

Reusable `ChannelTimeline` and `ThreadPanel` own the standard observation policy:
focused active reading surface, visible document, settled positioning, fully
visible rows, and 750 ms dwell. Scroll/content/focus changes cancel/restart dwell.
Mounted virtualizer overscan, preload, selection, and composer focus are not
reading. Automatic observations mark **individual messages**, never a prefix that
could hide unseen siblings. Oversized rows that never fit fully are not auto-read.

- `observedCount` is `null` when unknown or denied, never a fabricated zero.
  Otherwise it counts the bounded evidence currently known, excluding own messages,
  auxiliary events and authorized deletions. It is **not an exact total or lower
  bound**: missing markers/deletions can overcount; missing history can undercount.
- `coverage` and `freshness` describe message evidence, separately from `sync()`.
  Evidence is capped at 4,096 events / 8 MiB. Repair queries the membership roster
  in sequential batches of at most 128 explicit channel IDs (the relay limit),
  with up to 500 recent rows **per batch**, not a shared remainder or one head
  request per sidebar row. A 278-channel roster therefore makes three reads.
  Earlier results publish progressively and survive a later transport failure;
  capacity overflow retains the existing visible error/clear policy and stops repair.
  Querying every ID does not mean observing every channel: busy channels can still
  consume their batch's sample, and missing thread roots can affect inherited markers.
  Repair evidence does not seed channel windows, alter cursors, or mark messages read.
- Initial marker/evidence observation and explicit evidence refresh are foreground
  reads so optional profiles do not block them. Reconnect/periodic sync and marker
  publication remain background. Each evidence batch gets its own queue-inclusive
  10-second deadline **after** marker observation, rather than spending it waiting
  for markers. Marker failure stays visible separately in `sync()` even when
  evidence succeeds. Concurrent `ensure()` calls share active work; a failed attempt
  needs explicit `refresh()` or reconnect, not an unlimited automatic retry loop.
- `attentionCount` is a separate observed subset: DMs, mentions and replies to
  participating threads. It does not trigger notifications or implement mute policy.
- `markThrough(target, messageId)` is explicit prefix intent through verified
  evidence. It can mark unloaded earlier messages read; do not use it for viewport
  observation. A channel prefix requires a top-level message, not a reply.
- `markChannelRead(channelId)` snapshots the newest retained verified message
  (including replies) when invoked, then atomically advances the channel frontier
  and clears the channel's owned local manual-unread marks. It does not fetch
  history, select the row, or substitute the wall clock for message evidence.
  Arrivals beyond that timestamp remain unread; like other timestamp prefixes,
  this also covers messages at or before the cut that arrive later.
  With no message evidence, it clears only the channel's local mark and invents
  no frontier. Success means local durability; publication may still be pending.
- `markUnreadLocal(target)` is durable **on this browser profile/device only**.
  Automatic reading does not clear it. An explicit mark-through clears that
  target's local mark. `syncedManualUnread` is `false`.
- `refresh()` retries evidence/marker observation; `retrySync()` refreshes markers
  and retries pending publication. `ReadMutationResult.durability === "saved"`
  means the local transaction committed, not that the relay accepted it.

The sidebar separates ordinary unread from directed attention. Any unread state,
including activity that exists only in a relevant thread, strengthens the channel
label. Ordinary unread renders no row marker. DMs, mentions, broadcasts, and
relevant thread replies add one accent dot; non-DM row numerals are omitted and DM
avatars are reserved for promoted offscreen cues. Thread activity reuses that dot:
its hover/focus/click popover groups unread replies by canonical thread root and
opens the existing thread panel, so overlapping priority and thread activity never
produce duplicate dots. Merely revealing the popover does not acknowledge a reply.
A local manual-unread mark strengthens the label without fabricating priority; the
underlying observed count remains available.
Channel Settings → Diagnostics exposes explicit actions and Unread status/retry. Unknown and
observed-zero both omit unread styling; the API preserves the distinction. There is
no notification, feed, or exact-count service here.

When unread rows are outside the sidebar's scroll viewport, floating “Unread”
buttons reveal the nearest destination in that direction without exposing a count.
The internal directional set is still deduplicated by destination for geometry and
priority: ordinary destinations use a quiet treatment; any DM, mention, broadcast,
or relevant thread destination promotes the same composition to primary. Thread-only
rows participate, and DMs remain promoted even when their only evidence is thread
activity. The controls measure existing rendered badges/dots—no extra unread
subscriptions or relay reads just to show them. Search-filtered rows do not
participate. Collapsed sections use the summary's position and expand when revealed.
A partly visible row is not outside the fold. Activation scrolls and focuses the
row, retaining its ordinary focus preparation; it does not select the channel or
acknowledge any messages. The count is destinations, not a potentially misleading
aggregate message total. Directional destination counts remain internal and are
not rendered or announced by the control.

Thread buttons keep the summary's total reply count and add a dot when the shared
thread selector has observed unread replies or explicit thread-unread intent.
Accessible names distinguish observed evidence, stale evidence and local-only
intent; unknown/observed-zero omit the dot, not assert complete read history.
Each mounted button subscribes to its own thread, without fetching thread history.
Opening/hovering a button does not acknowledge replies; the existing focused
viewport dwell in `ThreadPanel` supplies individual-message reading intent.
Unread ancestry uses the same canonical marked-reference parser as thread opening
and row projection (case-insensitive hex, last valid marker wins). Resolution still
requires bounded, retained same-channel message evidence; references alone do not
grant access or trigger a read.

## Explicit clearing matrix

| Intent | Durable frontier | Local manual-unread clears |
| --- | --- | --- |
| Automatic visible dwell | Individual verified message | None |
| `markThrough(target, messageId)` | Explicit verified target prefix | That target only |
| `markChannelRead(channelId)` | Channel through newest retained verified message, including replies | Channel, retained messages, verified same-channel reply roots, and threads whose top-level root is retained |
| Channel read with no evidence | None | Channel only |
| Mute/Unmute | None | None |

Channel read does not clear other channels, unproven ancestry, or remote manual
unread overrides. Bounded evidence cannot establish ownership of every historical
local mark. The channel frontier and owned local clears commit in one transaction;
storage failure changes neither, and disposal/cache clear or access revoke/regrant
invalidates queued intent. Automatic dwell retains its existing cancellation rule
for newer manual-unread intent.

## Durable sync and privacy

The journal is separate from disposable message caches in `buzz-read-state-v1`,
partitioned by relay/community scope and viewer. IndexedDB strict read/write
transactions merge concurrent local windows; Web Locks serialize the publisher.
Without host decoding the capability is `unsupported`; without safe serialized
sign/publish it is `read-only`. Read sync requires `frontier-sync`. Local manual
intent can still be saved independently of remote capability.

Signed kind-30078 NIP-RS blobs use self-encryption and a persisted random coordinate
slot/client ID. The Node development broker or the packaged Tauri identity host
owns the key and narrow codec. Native decode verifies own signed NIP-RS coordinates; native signing
accepts only bounded read-state intent, and publication rechecks the signed event
before sending it. Plugins receive no generic encryption or arbitrary-kind signing
capability. Both transports use scoped relay admission and NIP-98 for reads and writes.

Accepted local intent is saved before signing; the exact signed event is saved
before sending. Lost responses/readback retain that event identity for retry.
`accepted` is a publish receipt, not observed coordinate state; `reconciled` also
requires readback. A failed transaction is not acknowledged as saved. Timestamps
are uint32 seconds; replaceable publication clocks advance monotonically with a
bounded lead rather than running indefinitely into the future.

Ordinary frontiers are **bounded recent hints, not everlasting read receipts**.
The local state has a 96 KiB serialized-blob budget and wire publication a 40 KiB
plaintext budget. Persisted local interaction order prioritizes newly read old
history as well as current traffic. Only frontier-only hints can be pruned; older
messages may look unread again. No synthetic channel prefix is introduced to fit.
Override groups, permanent clear floors, directly associated frontiers and possible
inherited channel/thread frontiers are protected; capacity failure is visible,
never floor truncation. Publication of any override-bearing state is deliberately
blocked in this release. Remote registers can be reduced/displayed, but synchronized
manual-unread and canonical override compaction are not enabled.

Marker discovery uses the relay's host-bound NIP-11 `read_state_snapshot` descriptor
when available, independently of request parameters. The exact versioned query
must return a complete own-author kind-30078 snapshot with matching community,
valid signatures and unique coordinates. Ordinary capped arrays and live EOSE do
not establish completeness. The snapshot proves one writer cut, not live freshness,
message-history completeness, a CAS revision, or a global cryptographic community
identity. Absent discovery permits only bounded ordinary marker observation.

Resource bounds: 4,096 snapshot events / 8 MiB encoded event array; envelope stream
is capped before parsing at 8 MiB + 4 KiB. Recognized read-state events can be up
to 96 KiB **on receive**, accommodating older clients' original NIP-44 maximum
plaintext (65,535 bytes → 87,472 base64 characters plus the signed envelope).
The four-event decode batches fit the unchanged 512 KiB HTTP decode budget.
New signing retains its stricter 40 KiB plaintext budget, and both signing and
direct publication retain the 64 KiB event limit. The larger receive budget
does not authorize republishing legacy records.
Blobs remain capped at 10,000 keys. Unknown/undecryptable recognized
coordinates fail marker loading rather than masquerading as empty state. Access
revocation denies projections before any subscriber can inspect another one;
durable account-owned intent survives without exposing revoked context projections.

## Verification

- `read-state-model.test.ts`: protocol reduction and algebra.
- `read-state-retention.test.ts`, `read-state.test.ts`: bounded growth, old-history
  interaction order, restart, exact-event retry, durable mutation and floor safety.
- `reader.test.ts` and history browser journeys: finite-read navigation admission,
  preserved deadlines/cancellation, actual reload and dismissed navigation. Simulated
  pagehide/pageshow tests establish handler behavior, not a full BFCache journey.
  Live-stream reconnect during a delayed departing navigation is a separate
  pre-existing host-lifecycle limitation; this is not a universal unload fence.
- `unread-startup.test.ts`: production reader/session scheduling, large-roster
  batching, progressive/partial failure, explicit/reconnect recovery and access/cache
  fences; `read-state.test.ts` also checks both marker-discovery priority paths.
- `unread.test.ts`: real session lifecycle, access, deletions, reading leases and
  reverified disk-restore evidence without network content.
- `use-reading.test.ts`, timeline/thread tests: dwell/geometry and owner wiring.
- `dev/read-state-broker.test.mjs`: real local HTTP broker, NIP-11/NIP-98/NIP-44,
  reader envelope verification, filter rejection and streamed body limits.
- `MessageRow.test.tsx`, `tests/browser/thread-unread.spec.mjs`: thread selector
  presentation, unchanged summary counts, hover/keyboard-focus treatment, independent
  thread reading, own/peer live arrivals and reload through the production broker.
- `tests/browser/sidebar-unread.spec.mjs`: above/below destination counts and
  priority, activity-only rows, no layout shift, resize/search/collapse, keyboard
  continuation, manual intent, evidence refresh, session retargeting, and no
  reading/selection from reveal. Focus retains existing channel preparation;
  merely showing the indicators does not fetch channels.
- `tests/browser/unread.spec.mjs`: production build/React/session/IndexedDB/broker,
  observed sidebar → focused dwell → encrypted publication/readback, reload,
  cancellation and explicit local-unread clearing with network content held.
  Only upstream relay policy is modeled, with ephemeral identities. This does not
  establish native GUI behavior or deployed relay compatibility.
