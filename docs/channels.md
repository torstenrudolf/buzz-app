# Channels, relay data, and plugin panels

## Run the integration

Configure your public `BUZZ_DEV_VIEWER` pin in `.env.local` using the
[development setup](../README.md#relay-channels), then run `just web` or
`just desktop` (one at a time); the development broker starts with the dev server.
Add a community using the top-left community switcher, open Messages and click a supported GitHub URL in a message to open its object
in a side panel. Pull requests show title, state, author, branches, change counts,
and description; issues, commits, and repositories show their relevant details.
The panel reads GitHub's public API on demand. Private or unavailable objects and
API limits show an explanation with a direct GitHub link. File and branch links
continue to open normally. No GitHub account connection is configured yet.

Descriptions support GitHub-flavored Markdown with inline images, video, and
audio. Other files remain links; media that cannot load keeps a fallback link.
Use **Open on GitHub** for attachments that require repository access.

On desktop, an ordinary click on an unhandled HTTP(S) link with
`target="_blank"` uses the native Tauri opener to launch the default browser,
including attachments and **Open on GitHub**. A plugin that handles the click prevents that fallback; disabling
GitHub restores it. The main-window capability allows only HTTP(S) URLs, not
arbitrary file paths or application commands. Web keeps ordinary browser link
behavior. Adding the native opener requires rebuilding/restarting desktop;
frontend hot reload alone is not enough.

Settings independently enables/disables Channels and GitHub. Disabling GitHub
removes its link handler and open panel; shared channel data remains available.
Channels is required by the current host; optional page removal does not dispose
the app-owned sidebar or session data.

The broker uses the existing authorized Buzz identity in the OS secret store (macOS
Keychain, Linux secret service) and
signs authenticated reads and channel messages in Node. In this broker mode no
private key reaches browser JavaScript; there is a bounded message-signing and
publishing endpoint. The broker is restricted to loopback hosts, same-origin
POSTs, valid Nostr kinds/event IDs, and bounded filters. Without a configured
`BUZZ_DEV_VIEWER` pin, native macOS offers [identity setup](identity.md); web and
unsupported native platforms retain the unavailable shell. The separate native
import/reveal/copy UI deliberately passes private strings through JavaScript.
Packaged builds do not include the development broker. A saved native identity
does not enable relay access: join and community profile editing stay unavailable.
The broker supports explicitly scoped typed relay origins;
see [destination routing and trust limits](communities.md#development-broker-boundary).
This is not a new native login.

## Ownership

- `app/services.ts` constructs client/community, pages, and panels services.
  See [community ownership](communities.md) for selection and join lifetimes.
- `features/relay` owns the [session query core](relay-queries.md), shared profiles,
  and retained channel snapshots. Components use
  its React hooks without creating connections or owning persistence.
- `features/panels` owns target resolution and panel rendering. Panels receive
  `{ target, close }`; their plugins inject additional capabilities as needed.
- `features/messages` owns reusable `ChannelTimeline`, `MessageRow`, `ThreadPanel`,
  `MessageComposer`, delivery presentation, styles and reading geometry. They accept
  ordinary props over the shared session; none owns a connection or outbox.
- `features/channel-navigation` owns the persistent sidebar and its scoped UI handoff
  for session draft rows and preparing DMs. App composes it beside independent pages;
  sidebar actions use the normal navigation controller. It reuses session capabilities
  and existing sidebar components without another relay/cache or plugin registry.
- `bundled/channels` owns page registration, conversation selection/navigation,
  diagnostics, layout and panel placement. `shared/view-state.ts` partitions persisted
  drafts and view intent by community/viewer scope.
- `bundled/github` registers and implements the panel. Channels uses the panel
  contract and does not import the GitHub implementation.
- `plugins/contributions.ts` owns registration identity, readiness, and disposal
  for both extension points.

See [plugin architecture](plugin-architecture.md) for the authoring contracts.
To build another page, follow `bundled/channels/index.tsx`: declare injected
capabilities, register the page, and pass those capabilities to its React tree.
Keep page-specific navigation and arrangement in the plugin; compose shared message
components rather than copying them. Session reconciliation, authorization, retained
reads and durable outbox recovery remain host-owned even if Channels is disabled.

The sidebar and Channels workspace React keys include community/viewer scope **and**
connection generation. This resets their session-owned state on switching or
reconnecting, not unrelated page drafts;
drafts, channel selection and reading geometry retain their stable scope keys.

Saved sidebar groups, ordering, assignments, stars, mutes and sorting live in the
session's `sidebarPreferences` snapshot, not in the mounted Messages page. `ensure()` shares
one initial read; `refresh()` explicitly reloads/retries while retaining the last
good snapshot through loading/errors. Page exits neither restart nor cancel that
read. Cache clearing and session disposal cancel it and discard decoded data;
late completion cannot repopulate a retired snapshot. These are account-owned
preferences, not channel access grants: sidebar sections still intersect the
authorized roster. Local-first launch also restores a display-only copy from the
existing account/relay-scoped device store; this does not add automatic cross-device sync.

The browser/development host exposes one narrow **Mute/Unmute** command. It
re-reads the viewer's signed encrypted `channel-mutes` coordinate, changes only the
requested entry, publishes through existing relay admission, and confirms via
readback. Publication uses the existing authenticated live socket, scoped to the
requesting session/community; a missing or disconnected owner fails without HTTP
fallback or automatic replay. Unrelated fields and explicit unmute tombstones
survive. Invalid, unreadable, or over-budget heads fail closed; only a successful absent-head read
can seed a record. Same-host writes serialize per relay. This is confirmed
whole-record replacement, not atomic cross-device merging or a durable outbox;
simultaneous writers on different hosts can still race. Failure requires explicit
retry. Group/star writes use their separate narrow commands;
[section sorting](#sidebar-sort-persistence) uses its separate preference coordinate.

Rows expose mute/read actions through right-click/long-press, Shift+F10, or the
Context Menu key. They extend the persistent sidebar’s existing menu after
**New session**, separated from session entry; DM removal stays separate.
Mute closes immediately and optimistically changes the next menu action, not
unread truth or notification policy before confirmation. Failure rolls back to
confirmed state and shows an app notification with Retry (same intent) and Dismiss.
Newer clicks supersede older completion UI; session-owned writes and sidebar
pending/error presentation survive page switches. Session replacement discards
that presentation. Cache clear/disposal abort
pending work but cannot retract an accepted relay publication.

Mark as Read delegates to the [durable unread owner](unread.md), without selecting
the row, and closes after the local transaction commits. Observed unread or a
manual mark offers **Mark as Read**; otherwise the menu offers **Mark as Unread**
with its device-only tooltip. An open menu subscribes to the shared projection,
without fetching history or inventing exact counts. Read errors remain in-menu
for explicit retry. Focus resolves the current row by identity even if saved
preferences relocated it during the transaction. Read actions require
`frontier-sync`; hosts lacking mute writes keep read-only preference projection.
Packaged hosts gain no speculative native preference writer.

Move channel, Create new, exclusive Starred placement and startup presentation also
belong to this persistent sidebar. The session serializes placement, sort and mute
writes through one queue, retaining one confirmed preferences snapshot beneath
pending Move and Sort projections. Each confirmation updates only its owned fields
before reapplying pending intent; failure cannot roll back unrelated confirmed
state. Field-only confirmations cannot recover a failed full preference read or
hide its Retry. Move stays gated until that read succeeds. Mute optimism remains
presentation-only; notification policy continues to use confirmed mutes. This
composition does not change the whole-record cross-device limitation below.

Collapsed section keys and sidebar scroll remain separate, scoped view intent.
They survive page switches in the same mounted sidebar, are saved when that
sidebar exits its session, and restore before paint when the roster and groups
are available; navigation history does not own them. Search lives in the top-bar
palette; legacy sidebar filters are ignored. The saved-groups
browser regression records every visible return frame and holds the redundant
decode path, so eventual restoration cannot conceal a fallback-group/scroll jump.

Channel row actions share one sidebar-owned `ContextMenuRoot` / `MenuPopup`, labelled
`Actions for <channel>`. **New session** comes first; additional sidebar actions
should extend that popup, with a separator only when another action group follows.
`ChannelSidebarItem` owns the context trigger inside its memo boundary, using stable
`onOpenMenu` props. It wraps the activity select surface rather than merging popup
props onto the activity button; session disclosure and child rows stay outside.
The popup and trigger are enabled only when `rowActions` supplies actual items;
each action owns its eligibility, so Sessions availability never gates sibling
actions. `useChannelRowMenu` owns channel id, the full rendered section key
(`starred`, `channels`, `group:<id>`, etc.), and the keyboard anchor. It clears
that state if the row leaves that section or loses its last action; moving back
or restoring eligibility does not reopen the menu. For future group commands,
derive the saved group id separately from `group:<id>` rather than conflating it
with rendered placement. Right-clicking the separate session disclosure remains
outside the parent menu trigger, as do child-session rows.

Sidebar create-channel dialogs stay available on other pages. Channel admission
(creation plus verified viewer membership) is fenced to the originating relay
session and navigates to a normal conversation destination. Remaining template
setup continues in that session; failure produces a dismissible notice without
navigating again. Frozen setup receipts and delivery evidence remain saved, but
there is no template Resume or automatic startup continuation. An uncertain
admission keeps the original form locked to its channel identity. **Retry channel**
checks that creation first; if delivery remains unknown, an explicit click may
republish only the exact saved Create event, with the same UUID and signature.
It never continues template writes or retries in the background. Successful recovery opens that channel and reports
any unfinished setup for manual inspection. Closing/reopening retains the attempt;
after session replacement, unresolved ordinary creations (including pre-upgrade
Outbox entries) restore for the same identity-preserving retry. Already-admitted partial
setups do not occupy a new Create form. New-session intent uses the Channels version-1
page route `{ kind: "new-session", parentId }`; Channels checks parent access/type
and Sessions availability. Only parent intent, never draft text, enters history.
Preparing-DM suppression captures the pre-open roster and exact member set, hiding
only newly prepared DMs until confirmation; leaving New message or replacing the
session clears that handoff. Timeline readers and reading leases stay in visible
conversation content and unmount when leaving Messages.

## Sidebar sort persistence

Each sidebar section can independently select **A–Z** (the default) or **Recent**.
The development broker saves these choices in the desktop-compatible encrypted
kind-30078 `channel-sort` record: `{ version: 1, groups: { ... } }`. A–Z removes
that group's override. Saving preserves unrelated fields and choices present in
the record read before publication.

Persistence is **whole-record last-write-wins**, not conflict-safe per-section
merging. Two devices can read the same record and save different sections; the
winning replacement can silently erase the other device's choice even when both
saves report success. The broker's mutation queue serializes its own writes only.
Read-back checks the requested section at that moment; it cannot detect an unseen
choice overwritten in another section or guarantee preservation against later
writes. “Independent” describes selecting a mode per section, not simultaneous
cross-device save guarantees. Retaining the shared record preserves compatibility
with existing desktop writers; per-section conflict resolution would require a
coordinated persistence change.

`dev/sidebar-sort.test.mjs` deterministically exercises that accepted limitation
through the real mutation helper: another section saves and confirms between a
read and publication, then the stale whole-record replacement wins and also
confirms. This is contract coverage, not a concurrency fix.

## Starting a direct message

The **+** action in the DMs sidebar header opens **New message**, a routed empty
conversation in Messages. The header remains available before the first DM exists. Its inline **To:**
field owns a paginated people picker and up to eight recipient chips, excluding
this viewer. Agent profiles are offered only when their exact public key appears
in the ready native control snapshot for this community. Public profile hints and
the compatibility library do not establish control; this filter also applies to
searches and cached results. Selected agent chips are revalidated against the
current ready control snapshot before a fresh open and again before enqueueing.
Already queued messages retain exact-event recovery. Namesake identities show
unambiguous shared public-key labels in their options and selected chips. Human profiles remain available while controls load
or fail. The shared popover hugs shorter result lists up to ten rows (or available
viewport space), then scrolls. Search placeholders retain the previous result count
within that cap. An initial 15-profile preview paints first; bounded background batches
continue without scrolling, including for searches. Pages containing only excluded
agents keep loading; an empty result is shown only after all matching pages finish.
Directory reads use the verified scheduler without
admitting browse results into shared conversation profiles, so a large directory
cannot evict sidebar names. Each incoming batch shares the mention pickers' name
ranking, but new identities append so visible rows never reshuffle. This is not a
globally alphabetical directory: the relay pages by profile update time. Completed
pages and recent searches stay in memory for this account/community session, so
returning or clearing a search resumes the same results. Typing immediately filters
loaded names without replacing local matches with a loading placeholder. Once the
browse directory is complete, searches stay local; while it is incomplete, remote
matches can append in the background. A failed background read
keeps existing people visible and offers retry. Mentions retain their conversation-specific
eligibility. Before a DM exists, a composer-local `DraftMentionRoster` supplies
only the selected recipient identities and names to both mention tools. Removing
a selection updates both menus; an already-inserted mention still requires actual
DM membership on Send. Mentioning never opens the DM early or adds recipients.
The existing `MessageComposer` owns the draft and ordinary input behavior. Its placeholder is blank before selection and lists the selected names
afterward. Disabled mention and emoji icons stay unfilled. No timeline is mounted before the first message is confirmed. DMs omit the date
pill at the beginning of their complete history, while retaining message times
and date separators between days.

`features/direct-messages` owns selection, scoped view intent, and the isolated
chip-removal effect. The five-frame effect lasts 400 ms (a gentler 180 ms fade
with reduced motion); audio is best effort. The copied assets retain their MIT
notice in `public/recipient-removal/LICENSE.txt`.

The relay session exposes `directMessages` over its existing verified reader and
outbox. People are kind-0 pages: a 15-profile browse preview (30 for search), followed by
30-profile browse batches. Searches retain 30-profile pages because profile metadata
can be large enough to exceed the read budget in larger batches. Remote name
searches are debounced by 150 ms.
Opening uses the development broker's purpose-bound `/direct-message` endpoint:
it signs kind 41010 with one to eight distinct other participant keys, checks the
exact command receipt, and returns the canonical channel ID. A unique client tag
allows reissuing this participant-set command after a lost response without
receiving a generic duplicate-event receipt. No private key or arbitrary signing
capability is exposed to the page. Other host adapters report this capability as
unavailable until they implement it.

Before sending, the session requires signed DM metadata and an exact signed roster
containing the viewer and selected people. The first kind-9 message then uses the
normal durable outbox. Navigation waits for an accepted receipt or verified echo.
A failure retains recipients and draft; an uncertain delivery retries its exact
event ID. The outbox persists recovery metadata with the operation before publication and
retains it through confirmed delivery until the composer durably acknowledges it.
Hydration must finish before a fresh send; one recovery key prevents duplicate
first sends. Definitively failed operations restore newer editable draft and recipient
views; uncertain operations keep their durable recovery payload authoritative.
Before acknowledgement retires recovery, saved views are removed and their absence
is verified. Cleanup failure retains recovery for confirmation-only retry. A page
reopened during acknowledgement resets its recovered editor when retirement finishes.
Local storage is a convenience for editable drafts. Only a
definitively failed recovery operation can be removed (including through
Diagnostics), releasing the preserved draft for editing or a changed recipient set. A changed set also invalidates the prepared destination.
Page exit cancels preparation and its delivery waiter, while the outbox retains
ownership of already queued messages. Reopening recovers the pending event rather
than enqueueing a duplicate.

Focused coverage lives in `NewMessage.test.tsx`, `direct-messages.test.ts`,
`relay-broker-api.test.mjs`, and the Chromium/WebKit `new-message.spec.mjs` journey.
The browser journey uses the production app and broker with ephemeral identities
and modeled upstream I/O; it does not send messages to a live community.

## Channel lifecycle

Lifecycle actions extend the persistent sidebar’s existing context popup after
New session and the mute/read group. Lifecycle items use shared leading icons and
a separator only when they resolve and earlier actions exist. Right-click
and keyboard access reuse the existing row trigger; no ⋮ control or second popup
is added. Session creation, attention actions and child-session navigation keep
their existing owners; sessions do not receive lifecycle actions. Move/Star/grouping
controls share this popup with independent eligibility; lifecycle actions do not
change shared-menu styling.

The row menu resolves fresh relay-authored metadata (`39000`), administrators
(`39001`) and membership (`39002`) at exact channel coordinates before offering
Archive/Delete/Leave or DM Hide. Archive requires a direct owner/admin role;
Delete is offered to a direct owner or a member with verified ownership evidence
for an owner-role agent; the last direct owner cannot Leave. The menu omits Leave
when it is forbidden, without an ownership-transfer explanation. Action labels
have no trailing ellipsis. DMs offer Hide only.

Owner-agent eligibility follows the desktop's profile-based UX: read the channel
owners' latest signed kind-0 profiles in bounded exact-author batches, then verify
the unique NIP-OA tag, target binding, owner signature and conditions against the
profile event. Display-only owner fields and agent hints never qualify. The
existing shared verifier owns these checks; no new relay query or deployment is
needed. Direct owners, DMs, archived channels and Archive/Leave execution do not
require these optional profile reads. A failed five-second owner-profile lookup
preserves independently established Archive/Leave, omits Delete and exposes
"Delete check unavailable" with explicit retry in both surfaces. Settings keeps
its retry button focusable and busy during a fresh read, without retaining stale
actions. If focus is still on recovery when the read finishes, it moves to the
retry, an allowed action (Delete first), or a no-actions status. Moving focus
elsewhere while waiting cancels that handoff.

**Profile provenance is not the relay's persisted authorization mapping.** It is
an eligibility hint for offering an attempt, not proof the command will succeed.
A profile without the attestation may hide Delete from a human the relay would
accept; a conflicting valid attestation may expose an attempt the relay rejects.
Profile replacement does not establish relay ownership transfer or revocation.
The viewer signs the unchanged Delete command and the relay enforces its stored
ownership and current channel state. A definitive rejection retains the channel
and recoverable confirmation; uncertain delivery still blocks blind resubmission.
Archive/Leave depend only on the viewer's own channel role. Existing membership
requirements remain; nonmember access, owner-agent Archive authority and
community-admin overrides are not added.
Membership accepts NIP-29 `p` tags with optional relay and role fields
(`["p", pubkey, relay_hint?, role?]`), including the relay's four-field roster.
These fields never substitute for the separate administrator record. Invalid
member keys and duplicate entries still fail closed. Failed menu permission reads
show "Channel actions unavailable" with retry, not raw protocol errors. Pending
permission reads show neither a loading row nor a lifecycle separator; the
separator appears with the resolved actions or unavailable/retry section, and is
omitted when there are no lifecycle items. Actions appear only after verification.

Channel Settings also offers **Leave channel**, **Archive channel** and **Delete
channel** in its tools area, using one fresh lifecycle permission check. Each
entry follows its own permission result: a last owner can Archive/Delete even
though Leave is forbidden, while an ordinary admin without owner-agent evidence can Archive but not Delete.
Forbidden entries are omitted; failed checks offer retry and unsupported
connections explain unavailability. DMs, sessions and read-only nonmember/cached views have no channel
lifecycle entries. Archived channels cannot be deleted:
the relay rejects Delete while archived. An administrator must restore the channel
through another supported client before deletion.
These controls hand off to the same persistent sidebar confirmation/navigation
owner, so confirmed removal can unmount Settings without cancelling completion.
Cancellation returns focus to the originating Settings button (or the sidebar
fallback if that entry has gone away). Archive retains messages and membership;
restore requires another supported client until archived browsing/restore lands.
Archive confirmation explains that a channel administrator can unarchive later
using another supported client, and that this app cannot restore it yet. Archive and Leave
use the default button style in Settings. Archive, Leave and Hide confirmation
primary actions use the prominent variant; Delete remains destructive and Cancel
keeps the default secondary style.
Delete keeps the named-channel warning and destructive confirmation button without
requiring the channel name to be typed. Metadata and member-role editing remain
separate.

Each command has explicit confirmation. The lifecycle owner rechecks signed channel state and, for owner-agent Delete,
profile eligibility before signing and again before publication, validates
the returned command, and confirms relay-owned state before removing a row. Archive retains membership;
confirmed Delete/Leave use the existing access-loss purge. Commands use narrow
development-broker routes, never the message outbox or automatic replay. Hosts
without this capability display an unavailable notice; native/direct-signer parity
is deferred.

Main’s DM × remains local removal, including restoration on new message evidence.
The separate, confirmed Hide conversation action publishes `41012`, not Leave or Delete. The separate relay-authored `30622`
visibility snapshot (`d=viewer`, `p=viewer`, hidden DM `h` tags) only filters sidebar
rows; it does not deny access or prevent exact conversation navigation. Visibility
refreshes with the channel roster, preserves the last good set on failure and
rejects older snapshots. Live cross-device visibility updates and an in-app DM
reopen/unhide flow are deferred; opening a DM through another supported client's
`41010` flow and refreshing restores the row.

A definitive rejection offers retry without optimistic removal. If publication or
confirmation has an uncertain outcome, the dialog warns that the command may have
taken effect, disables blind resubmission and asks the user to close and refresh
channels. Cancellation/cache clear/session replacement fence late results but cannot
retract a request already sent. Cancellation returns focus to the originating row;
confirmed removal moves an active conversation to another available destination
(or the neutral Messages page) with a visible sidebar-row focus fallback. Last-row
completion uses the explicit version-1 Channels route `"empty"`, which bypasses
saved/default conversation selection, including after reload. Retained archived or
hidden membership cannot reopen itself through that destination; intentional exact
navigation to a hidden DM remains supported.

## Editing channel details

Channel Settings shows the signed name, description and explicit visibility for
ordinary channels; missing visibility stays **Not available**, not implicitly
Public. **Edit details** opens the shared Dialog with one Name/Description/Visibility
draft. Selecting Private does not publish. **Save changes** submits all fields
together and is enabled only for valid, changed values. **Cancel**, Close and
Escape discard unsaved edits and return focus to Edit details without closing
Settings. Pending saves and status checks block dialog dismissal; an uncertain
save may be closed and reopened through **Review pending changes** for check-only
recovery, never a blind resend. The panel retains its own Close/Escape focus
return, conversation and collapsed Diagnostics.
Names accept 1–120 code points and descriptions up to 1,000. Typing and paste
are capped at those limits without splitting Unicode code points; a middle edit
keeps the existing suffix and accepts only the inserted text that fits. Existing
over-limit relay values are preserved: edits may reduce or replace text without
growing the excess, and Save stays invalid until both fields meet the limits. Character
counts appear at the trailing end of the label row only within the last 10% of
each limit (`108/120` or `900/1,000`). Visible counters are numeric; the connected
accessible description retains the full character-count meaning.
Names follow the relay’s Unicode whitespace and leading-hash canonicalization
before validation, signing and confirmation. Empty descriptions clear the value. The internal `Buzz session (` marker is
rejected with a specific explanation only when present, not as part of length
feedback. Command validation still rejects oversized input independently of the UI.

Editing requires fresh relay-authored metadata (`39000`), administrators (`39001`)
and membership (`39002`) for the exact channel, plus current session participation.
Only direct channel owners/admins may edit ordinary stream/forum channels. Cached,
read-only, archived, DM and work-session views do not offer this editor. A local
key, delegated agent role or community-admin status does not imply channel authority.
Public → private is supported with an explanation before Save; private → public
is not. The relay remains the final authority.

`features/relay/channel-details.ts` owns the command and uncertain intent. It
rechecks authority and the edit's metadata version immediately before signing and
publication, verifies the signed command, and requires matching fresh metadata
readback—not merely a publication receipt. Confirmed relay metadata feeds existing
shared discovery so the panel, conversation header and sidebar use the same values.
The version check detects observed conflicts but is not a relay-side compare-and-swap:
concurrent writers can still race after the last read.

A definitive rejection keeps the editable draft. **Reload details** rechecks the
base without discarding text edits; if the channel has become private, the draft
adopts that enforced visibility. Inspect the retained edits before saving again. A lost
publication response or failed/mismatched readback locks the submitted draft and
offers **Check save status**, which only reads and never republishes. Uncertain
intent survives panel close/reopen and cache clear within the same session; no
background polling, automatic replay or durable recovery record is added. If
status cannot be confirmed, inspect the channel rather than assume failure.
Session replacement drops the in-memory attempt; it does not retract a sent write.
Channel/session changes fence old drafts and late completions. Operations use a
20-second deadline so a stalled read/write becomes explicit recovery, not an
indefinite saving state.

### FOUNDATION integration rationale

This is migration of an existing Buzz user feature, not a session redesign.
The current session already owns community/viewer identity, verified reads,
participation, shared metadata and cancellation. Composing the dedicated details
owner there keeps those authorities together instead of constructing a second
connection or making the panel a command owner. The approved `session.ts` change
is limited to constructor/import, capability exposure, cancellation, cache clear
and disposal (13 added lines). Policy and write logic remain in the feature owner.

The development broker exposes separate `channel-details-sign` and
`channel-details-publish` routes, accepting only bounded name/about and optional
private visibility. Existing archive-only lifecycle, invitation and message-outbox
admission are unchanged. Publishing reuses the same community's authenticated live
socket; no HTTP fallback or new connection is added. Restart an already-running
dev broker to load these routes. `just web` supports this complete browser flow;
`just desktop` is not required. Hosts without the dedicated capability stay
read-only; packaged/native adapter parity is not implemented here.

Behavior matrices live in `channel-details.test.ts`,
`ChannelDetailsEditor.test.tsx`, `store.test.ts` and `relay-broker-api.test.mjs`.
Real-relay Save/privacy changes require deliberate testing on a disposable channel;
unit/broker tests and a browser Cancel walkthrough do not establish live-write or
native acceptance.

## Performance and correctness carried from Astra

The port retains the prepared-store implementation and its behavior tests:

- 64 prepared heads / 4 MiB serialized memory budget, separate from history.
- Three unpinned history windows; each caps at 2,400 rows or 8 MiB. Mounted readers
  are not evicted by speculative preparation. A budget cap is distinct from EOF.
- Three read slots, at most one background request, with foreground promotion and
  deduplication. Hover/focus prepares at most one speculative head at a time;
  superseded hints do not form a backlog. That shared head keeps foreground
  priority so selection cannot inherit a host-side background wait. Discovery
  restores reverified disk heads against saved, display-only membership before
  network authorization, without waiting for optional channel names, and does not
  fetch heads across the roster.
  Verified heads save before optional profile enrichment; changed profiles can
  enrich the disk record afterward. Network reads belong to intent, selection and
  retained-window live catch-up. Optional profile enrichment stays background.
  Selecting an already-queued catch-up promotes that existing read without adding
  a request or resetting its deadline.
- 1,024 profile entries / 2 MiB signed-record budget, narrow row profile selectors,
  and request-warmed avatars (fetched and decoded, nothing retained; disabled
  under the Save-Data preference). Signature verification yields in batches.
- Account/relay-scoped IndexedDB: 64 records / 8 MiB global disk budget, 24-hour
  expiry. Signed cached events are reverified before display. The same database
  stores account/relay-scoped startup discovery and sidebar organization (a separate
  8 MiB global budget); old version-1 head records survive the version-2 upgrade.
- A 60-second head freshness lease; warm revisits reuse heads without new reads.
  Partial discovery never treats an omitted channel as a membership revocation.
  Explicit denial or signed membership removal invalidates private cached views.
- Viewer membership discovery follows 500-event roster pages using the relay's
  `(until, before_id)` cursor (timestamp descending, event ID ascending), then
  fetches names in batches of at most 500 channel IDs. Verified grants become
  available page by page; successful paged exhaustion confirms scan-start
  omissions with fresh exact roster reads before reconciling against the roster
  versions present when the scan began. Failure, cancellation, nonadvancing
  cursors and the separate 1,024-entry roster/metadata retention caps leave
  coverage partial. Each scan is bounded to three roster-page reads plus at most
  eight 128-channel confirmation reads; metadata failure preserves successful
  membership evidence and earlier name batches.
- Conventional top-down virtua timeline, prepend anchoring, near-bottom following,
  and three cached geometries keyed by session, channel, content, profiles, and width.

Connection generations and store epochs reject late results after disconnect,
replacement, disposal, or access revocation. The data service outlives plugin
components; it is disposed with the app runtime.

## Local-first launch

The selected community and conversation reuse the existing device view-state.
The relay service restores a read-only session from the account/relay-scoped cache
concurrently with the real connection handshake. Saved groups, stars and channel
names are display data, not a confirmed preference mutation base. No cache means
the ordinary cold connection flow; unavailable/corrupt storage never grants access.

A cached roster can display previously downloaded, reverified history for up to
24 hours. It cannot authorize head/history reads, unread evidence, typing or
publishing. Unconfirmed membership is not resaved with a fresh lease. An identical
or newer fresh signed roster promotes it; a complete roster omission or explicit
denial purges both the view and the next-launch record. Partial roster reads do
not prove absence. The live transport's relay identity remains authoritative.

A failed or timed-out handshake retains usable saved content with Retry; browser
online/visibility signals retry the connection. The successor restores its local
read models and materializes retained windows before replacing the cached owner.
The workspace generation stays stable for that promotion, so selection, the
channel timeline DOM and its reading state survive. Ordinary reconnect, account
or community changes still reset presentation lifetimes. Drafts remain scope-keyed.
Cache clearing/disconnect/disposal fence pending restoration and connection results.

`index.html` shows a centered Buzz mark on the synchronously selected light/dark
background before React loads. This is a document launch surface, not a native
pre-webview splash; the native window's initial paint remains separate.
`tests/browser/startup.spec.mjs` exercises IndexedDB reload, held/failed handshake,
in-place recovery, denial-by-omission and both document themes in Chromium/WebKit.
`features/relay/startup.test.ts` covers signed-cache admission and authority boundaries.

## DM label recovery invariant

Access-loss purges remain authoritative: never keep old profiles just to preserve
sidebar names. After roster membership changes, visible DMs must reacquire their
missing names through the shared profile directory at background priority, without
blocking conversation opening. Recovery must cover both loaded profiles being
purged and an initial profile read being cancelled before any name arrives.

`ChannelsPage` passes the **full** roster to `useChannelLabels`; the hook filters
visible conversations for display/profile demand, but derives its recovery trigger
from all channel IDs. Deleting an already-hidden or archived channel can still
invalidate shared profiles. Missing-profile and membership keys remain stable on
ordinary message/preview updates: missing/failed responses must not start a
render-driven request loop. Key fragments remain the fallback for unavailable names.

`useChannelLabels.test.tsx` binds the mounted hook to real session roster omission,
including hidden/archived deletion, stale in-flight replies and unsuccessful name
reads. `tests/browser/dm-labels.spec.mjs` guards the production page wiring and DOM
labels through the real Refresh channels control and broker. These are foundational
recovery constraints, not a new shared-session API or a guarantee of general
profile retry after every cache clear/network failure. See [browser coverage and
limits](browser-testing.md#dm-label-recovery).

## Membership activity

Channel history and the existing live route include relay-signed kind-40099
`member_joined`, `member_left` and `member_removed` summaries. Only recognized,
channel-scoped payloads from the connected relay become activity rows; malformed,
unknown and other authors' summaries are not rendered as JSON. These events do not
grant/revoke access: the existing signed roster remains authoritative.

The timeline groups adjacent arrivals/departures into compact avatar-and-text rows.
Messages, local-day changes and gaps over an hour break groups; removals by different
actors stay separate. Same-adder additions use “added by you” for the viewer;
mixed arrivals do not invent an adder. Grouping is presentation-only: signed event
IDs, pagination cursors and retention budgets remain per event. Profiles reuse the
shared background directory/cache, and reading anchors can resolve a member of a
group. Activity has no message actions, thread, unread evidence or chat preview.

An already-running development broker needs a coordinated restart to load the
expanded live filter; frontend hot reload alone changes only the history/rendering
path. No native or relay changes are required.

## Viewing threads

Click a message's reply count to open its root and replies in the right column.
Up to three overlapping participant avatars appear beside the count, with `+N`
for additional summary participants; missing/unavailable pictures use initials.
They reuse the channel's existing shared profile/media path, not extra per-row reads.
On a supporting relay, the panel opens at the newest 10 replies and loads older
pages of 50 when you scroll upward; there is no Load more replies button. It validates
signed NIP-CW thread bounds on every page. A prior scroll gesture wins over initial
bottom placement. New replies arrive through the existing session and the panel
follows near the bottom, preserving reading position above it. Sending a reply is
explicit navigation intent and reveals the new local row.

**Bounded history:** strict mode retains at most ten pages (10 initial replies
plus nine pages of 50); legacy mode retains at most ten pages of 50. A limit notice is
not a completeness claim. An older relay returning verified replies without thread
bounds on the initial probe triggers a clean legacy restart: automatic oldest-first
traversal, whose bottom may not be the newest reply in a long thread. An empty
unsigned probe is ambiguous with access denial and stays retryable/unavailable.
Malformed bounds, failed requests and missing bounds after strict support never
downgrade. Media review still eagerly loads its bounded comment range.
The thread and a linked object panel share that slot; a companion can remain below.
Close or Escape returns focus to the reply button when it is still mounted. Changing
channel/community or disabling Channels disposes the owned thread view.

The footer reuses `MessageComposer` and defaults to a direct reply to the resolved
root through `session.messages.reply`. Reply on a child selects that message as the
parent without changing the root-keyed draft; canceling the target returns to the
root. Channel and thread drafts are separate and survive reconnection; failed
replies remain inline with the shared retry action and retain their signed ancestry.
Read-only connections keep the existing composer capability notice; missing/revoked
roots do not expose a composer. Exact navigation can retain and focus a selected
reply beyond the traversal range; it does not extend that range or promise complete history.

Ordinary replies remain flat beneath the root. Replies to those replies form nested
lists, with ascending timestamp/event-ID order among siblings. Nested branches start
closed and expand one level at a time; once opened, they stay open for the lifetime
of the thread view, including through child disappearance and rearrival. Expanding
moves focus to the first revealed reply; deleting a focused reply returns focus to
its available parent or thread history. Labeled expansion controls remain available
when visual indentation is capped in narrow panels. Exact links reveal available
ancestors; a reply whose parent is outside loaded history remains visible with a
notice. Sessions remain inline.
Retry appears only after a failed read; there is no routine Refresh control. Names
are optional shared background enrichment. The panel describes **replies loaded**,
not visible rows or complete history.
The relay can filter rows after its limit, and summaries/EOSE are not proof of
exhaustion. See [the thread owner and bounds](relay-queries.md#thread-views).

## Validation and limits

`just scan` runs frontend checks/build, runtime/CLI tests, relay behavior tests,
panel lifecycle tests, GitHub parsing/API tests, headless Chromium/WebKit scroll
journeys, and native checks. See [browser setup, structural limits and diagnostic
measurements](browser-testing.md). Reading intent includes a message anchor for
cold/oversized geometry; legacy positions or anchors outside retained history fall
back to an offset without a same-message guarantee.

Channels supports plain-text Markdown authoring with a shared durable outbox and bounded history.
Channel and thread messages render CommonMark plus GFM headings, emphasis, lists, quotes,
tables, task lists, strikethrough and code, while preserving chat-style single line breaks.
Only credential-free HTTPS links are active; raw HTML is ignored and inline remote images
are not loaded. Existing image Markdown is projected as an attachment instead. Custom emoji remain
event-local and are not substituted inside links or code.
Authenticated live traffic reconciles through the same session. Channel creation and composer
preview/toolbars are not implemented. Reply counts open a bounded thread view; attachments are
links. Routine freshness labels are not shown; Channel Settings → Diagnostics
exposes refresh, outbox inspection and timings. Packaged builds do not
include the development relay broker. GitHub fetches public data only; signed-in
GitHub actions remain on GitHub. A saved-groups/stars failure keeps its specific
reason under **Channel Settings → Diagnostics → Saved groups and stars**.
`Preference query` includes reader queueing, transport and verification; use relay
timings to separate those. `Preference decode` identifies the local decoder stage.
The diagnostic does not trigger another request or change retry policy.

Sending appears immediately in the timeline and shared channel-preview data;
the current sidebar does not render preview text. Delivery
status and retries come from the [unified relay session](relay-queries.md), and a
stale read cannot erase the retained local operation.

Use `session.messages.send(channelId, text)` for channel messages or
`session.messages.reply(channelId, resolvedRootId, text)` for thread replies. Confirmed sends
leave the pending outbox automatically and remain in bounded retained data.
**Outbox → Relay timings** captures and exports stage timings, including in-flight
signing and publishing, without logging message content.


## Reusing conversation UI

Source plugins can import from `features/messages` without depending on bundled
Channels. Pass the current `RelaySession`, stable community/viewer `scope`, channel
identity and navigation callbacks. `ChannelTimeline` also receives the current
`ChannelWindow`; `ThreadPanel` owns allocation/disposal of its thread reader.

`ChannelTimeline`, `ThreadPanel` and `MessageComposer` reset their internal state on
session, scope or destination changes. Callers may retarget ordinary props without
supplying React keys; old thread evidence, scroll state or drafts cannot pair with
a new destination. Persistent draft keys remain `draft:<channelId>` and
`draft:<channelId>:thread:<resolvedRootId>` inside stable scope, not connection generation.
`MessageRow` receives folded data, profiles/media and optional reply/retry callbacks.

This is shared source composition, not a new registry or versioned external UI SDK.
See `tests/fixtures/messages.tsx` for a second consumer that deliberately supplies no
caller remount keys. Its browser regression runs real React StrictMode/session/outbox
with local ephemeral signing keys; it does not contact the deployed relay.

## Community emoji

The smile button in channel and thread composers opens Emoji Mart with standard
Unicode emoji, skin tones, and the selected community's custom category. Its data
and search load only when opened. Search by name/shortcode, then choose an emoji
to insert at the cursor; Enter selects a search result and Escape closes the picker
and returns focus. You can also type `:shortcode:`. The picker follows the host
Light/Dark choice, including while already open, without recreating its search or
dictionary. It does not independently follow the operating system.

The session owns the catalog and its live updates. Reopening reuses the ready
catalog, without hiding custom results behind a fresh read. Catalog failures expose
Retry while leaving Unicode available and retaining drafts. Only one picker owns
Emoji Mart's global dictionary at a time; scoped custom IDs and disposal prevent
old community entries leaking into search or Frequent. Historical messages and
existing reactions keep their signed emoji URLs after catalog changes.
Emoji-only messages stay at the large 42px size regardless of count; normal text
returns the message to its usual size. Long runs wrap instead of shrinking.
Selecting and copying custom emoji preserves their `:shortcode:` in plain text,
along with surrounding text and line breaks. Pasting into a community with that
emoji available resolves the shortcode through its existing composer catalog.
In the composer, Shift+Left/Right selects each rendered custom emoji as one unit,
preserving its full shortcode for copying, replacement and deletion. Reversing
direction shrinks the selection by one emoji. Visible shortcode text and emoji
that cannot be rendered retain ordinary text selection.
Custom emoji autocomplete adds no trailing space. The native caret uses the
regular composer text size while the emoji preview remains large.

Message and thread reaction rows have a Lucide smile-plus button after existing
reactions. Messages without reactions do not show it. The Emoji plugin supplies
the emoji-only picker
through its optional conversation tool `reactionComponent`; the shared message
row owns publication. The picker opens outside the scrolling list, closes on
selection or Escape, and returns focus to the plus button. Failed or unconfirmed
reaction delivery offers Retry reaction through the same outbox. Read-only
connections and archived channels do not expose the action.

The composer shows its GIF tab as soon as relay support is confirmed. Unsupported
results are retried when the picker reopens; the broker caches confirmed support
without retaining negative discovery results. Pickers
without tabs use a search radius equal to the container radius minus the 10px
inset; tabbed pickers keep the smaller 8px search radius.

Emoji uploads and management remain in the existing community workflow.

See [the shared catalog/send contract](relay-queries.md#community-emoji). The local
`/tests/fixtures/emoji.html` diagnostic uses ephemeral identities and no live relay.


## Unread badges and reading intent

The sidebar renders the session-owned [unread capability](unread.md): observed
counts, not exact relay totals. Selecting/preloading a channel is not reading.
Focused, fully visible, settled timeline/thread rows receive an individual marker
after dwell; no automatic channel-prefix advance hides unseen siblings. Conversation
options exposes local-only manual unread, explicit mark-through and sync recovery.
Older synchronized hints may expire under bounded retention. Synced manual-unread
and OS notifications are not enabled by this feature.


### Attachment layout and scrolling

Image attachments reserve their preview geometry before loading and across virtualized
row remounts. Valid `imeta dim` metadata supplies the aspect ratio, bounded to 360px wide
and 320px tall without upscaling. Missing/invalid dimensions use a stable 360:320 frame
that shrinks with the available width; the image is contained without cropping or
upscaling. Unknown-size images may therefore have empty space in the frame. Loading,
failure, or retry does not resize it or force an above-bottom reader to the newest row.
Valid message-carried `imeta blurhash` is decoded locally into a 32×32 canvas in
that same frame when it intersects the viewport. No thumbnail is fetched. The
preview is removed entirely (including behind transparency) only after the lazy
original decodes; failure retains the preview. Missing/invalid hashes or canvas
failures keep the existing background. Syntax validation bounds hashes to 166
base83 characters / 9×9 components; folding does no pixel work. Preview work is
per-mounted-image and uncached, visibility-gated even in nonvirtualized threads.
Without IntersectionObserver, only the ordinary placeholder/original is used.
This favors bounded visible work over instant offscreen previews on scrolling.
`tests/browser/image-scroll.spec.mjs` covers delayed/failed loads, actual remounts,
bottom following, reading anchors and narrow layout in Chromium and WebKit.

## Opening an exact message

Message-addressed conversations reuse the normal timeline and thread panel. A
verified, loaded top-level target is revealed in the timeline. An off-window
message opens as the root in the existing thread panel; a reply opens there with
its actual root and bounded surrounding replies. No around-message channel query
or separate detail screen is added. The presentation choice stays fixed for that
navigation attempt; exact reads do not insert isolated old rows into channel history.

Navigation completes only after the exact folded target is visible and focused.
Reclick/Back reveals again; live/profile updates do not steal focus. The shared
rows preserve Markdown, profile links, composers and background enrichment.
Opening never marks read directly: the ordinary focus/visibility/dwell hook applies.
Missing/deleted targets, access loss and failed reads expose failure/retry instead
of channel-head success. An accessible reply remains visible when its root is
unavailable, without a thread composer. See [the evidence contract](relay-queries.md#exact-message-navigation).
