# Profiles: viewing public identities

The bundled `buzz.profiles` plugin supplies a profile panel for any
public identity, human or agent. It uses the current session's shared profile
directory. Agents retains agent-specific configuration and its page-local editor. Profiles
can dispatch existing local Start/Stop/Restart commands for an exact managed
identity in the active community; profile metadata and library hints grant no authority.

**Local agent** is a read-only summary from the app-owned native `AgentControl`
snapshot. It appears only for a record with the exact profile key whose relay
origin matches the active community scope (`sameCommunityAgents`). Native
custody is app-wide: the viewer is not an owner check, so any account in this
app on the same relay sees the same local record. It
shows process status (still "relay readiness unverified", not a listening badge),
saved harness/provider/model/workspace (labelled as saved settings, since
environment overrides may change what is launched), saved-vs-running revision
drift and diagnostics. Instructions are no longer displayed in the read-only
summary; the verified owner opens the existing native editor in place with
**Agent instructions**, without leaving the profile. Environment keys and
arguments are not shown. Opening the Info tab requests a status read; concurrent
requests coalesce. This summary adds no polling and observes the profile panel's
periodic refresh. A failed read keeps the last evidence.
The host error, runtime-unavailable reason, unconfirmed-status notice and Retry
are shown once, by the profile actions. Browser/unavailable hosts, loading/error
without evidence, unknown keys and records saved for another community render
nothing, leaving the public identity. Community switches re-filter immediately.
Start/Stop/Restart are the separate profile actions above. The owner-only
**Agent instructions** ingress in Info requires a unique native record; harness
logs are in Runtime for the exact owned local agent.

## Owner runtime tab

**Runtime** appears only when the viewer is the verified NIP-OA owner and the
active community has at least one native record for the profile key. It always
shows **Instances**. Saved and running configuration requires an unambiguous
record: the exact selected instance ID, or the only record for a bare profile.
A bare multi-record profile shows the instance list without choosing a default;
selecting one opens its configuration. It follows
Buzz desktop's Runtime tab and copy: a Restart required notice with the native
redacted saved-versus-running diff, Activity (status and the Start on launch
switch), Agent configuration (runtime command, who can send instructions, ACP
and MCP commands, imported provider backend), Model settings and Advanced
(workspace, environment variable names and Databricks settings). Model and
Provider show what the next start passes to the worker from saved selectors or
build defaults. When a saved environment override decides one, it shows "Set by
environment (KEY)" and never the value; Edit Model and Edit Provider open the
existing Agents editor. Environment values, arguments and credentials are not
shown. Runtime config-file settings (MCP
servers, mode, token limits) are not read. The switch persists through the host;
failures keep the confirmed value and expose Retry status. Losing ownership or the
native record returns to Info. The owner check is presentation only: these fields
come from the same app-wide snapshot as Local agent.
Activity also offers a focused **Harness log** row for the exact local identity
when the scoped development signer is available. It hides the profile body until
Back, reads native private listener output through a one-use owner proof on each
read, and polls every 30 seconds while mounted and visible. Native retention is
bounded to 1 MiB; visible output is ANSI-stripped and clipped to the last 120
lines/64 KiB. Changing community, losing ownership or the local record closes the
view. Empty, loading, copy and generic error states do not expose native errors.
A packaged app cannot obtain this development-broker proof and fails closed.

When Agent Activity is enabled, the host supplies conversation context and the
profile is a known agent (a self-declared agent profile hint or a local library
record), **View activity** opens its raw panel for this exact identity and
originating channel. People's profiles show neither the card nor the action.
The Info tab's “Latest activity” card shows up to three recently updated assistant
messages or tool titles/statuses from the existing session-owned records, restricted
to this exact public key and originating channel (including threads). Retained text
chunks are joined by session/turn/message identity; without a message identity,
tool updates separate text segments within that turn. Tool updates reuse the tool
identity.
Each item shows at most 600 trailing characters of retained text, with a marker
when the preview clips that text, and renders at most three lines. Earlier chunks
may have left the session journal; the preview cannot identify missing history.
Plain text only: no HTML, images or active links.
Prompts, thinking, arguments, raw results and unsupported records are omitted;
“View activity” retains the raw destination. This is a bounded preview, not a full
transcript or history backfill. The timestamp includes visible content updates as
well as turn signals. It uses a short date and time rather than
a relative age that could become stale between snapshot updates. No context means
no preview, never an all-channel fallback. Connecting, disconnected, unavailable
and empty states are explicit. Counts and detailed explanations stay in the
activity panel; the preview does not infer idle state or successful completion.

The known-agent check is the same display-only evidence as the squircle avatar: it
does not infer that the identity is an owned/running agent. Public agent hints
never grant telemetry access. The
existing observer admission and session access-reset/generation fences remain the
authority; the child adds no library read, capture lease, socket, timer or store.
Disabling Agent Activity removes the preview/action and clears capture. Profile
opening subscribes only to the existing snapshot; it never starts telemetry.
Raw records, channel switching and live-feed retry remain in the activity panel.

Guarded invitations that fail or have an unknown outcome remain saved in the
outbox. Its generic Retry action is withheld for these records. Retrying the
add from the managed-agent profile rechecks current eligibility and reuses the
exact saved event while it is still within the relay's 15-minute timestamp
window. The ordinary channel composer uses a separate invitation path; it does
not renew or reuse these guarded profile invitations. After expiry, check
membership; if absent, remove the expired “Add agent” item from Outbox and
add the agent again from the managed-agent profile. Older unguarded invitation
records can be promoted to guarded intent when reused through that profile flow.
Remove from outbox does not revoke an invitation already dispatched to the relay.

## Agent identity

For an identity with an agent hint (below), the Info tab adds a **Managed by**
row, matching Buzz desktop. It shows only a verified owner and is otherwise
absent:

- The owner comes from the NIP-OA `auth` tag on the identity's own winning
  signature-verified kind 0 (newest `created_at`, lower id on ties). A
  session-owned `session.observe` view supplies that event: it merges live
  events, refreshes on reconnect and resets on purge. While that view is live,
  the profile directory's retained signed head also seeds that choice, so
  reopening the pane after cache eviction never accepts an older response than
  the profile the session already shows. The directory notifies subscribers
  when that head changes even if display fields do not, so a head restored
  from disk also updates the pane. Verification is bound to that exact event
  id, so an auth-only change or a lagging older read never keeps or restores a
  previous owner. It requires exactly one tag, owner ≠ agent, conditions
  evaluated against the event, and a valid BIP-340 signature over
  `nostr:agent-auth:<agent>:<conditions>`.
- The row shows the owner's name (`formatPublicKey` without a profile name),
  with "(you)" when the viewer is the owner. It opens the owner's profile in
  the same slot when the host can open it.
- A missing or invalid tag, a failed read, or no available view shows no row.
  Without a view nothing can signal an auth-only change, so the retained head is
  not trusted; reopening the profile retries. The existing `isAgent` shape
  check, avatar shape and local library never supply an owner.

Public metadata follows base Buzz's profile order: **Public key**, **Managed by**,
**NIP-05**, **Agent type**, **Capabilities**. The existing npub copy control keeps
its exact value and feedback. The other public fields are whole-row copy buttons,
with hover/keyboard indicators, a 1.5-second success check and base Buzz's copy
feedback. Runtime names use the base labels (Goose, Claude Code, Codex, Aider),
while copying the raw agent type; capabilities display/copy comma-separated values.
NIP-05 remains self-declared: the row matches base Buzz without a verification
claim or badge. Display/copy never performs DNS verification.

The typed `features/agents/public-metadata` projection consumes signature-verified
session views scoped to the exact kind-10100 author. The newest event wins (lower
id on timestamp ties), including removal/malformed replacements. Base's sparse
legacy defaults apply. If the existing NIP-OA verifier establishes an owner, an
exact owner-authored kind-30177 coordinate takes precedence: valid managed content
shows type `agent` with no legacy capabilities; malformed winning policy suppresses
legacy fallback. Owner verification and policy reads must settle before displaying
that projection, including when the pane first opens.
This is public presentation, not custody, runtime configuration or permission.

The existing live profile route includes kinds 10100/30177; the panel adds no socket,
polling loop or independent cache. Views refresh on reconnect/purge and dispose on
profile/session replacement. The owner view acquires capacity before optional public
enrichment; failed reads/view admission share one Retry profile control with the
profile directory. Optional enrichment failure preserves the loaded profile without
a whole-profile error. Completed copy toasts belong to the host stack and survive
row replacement/navigation; late clipboard completions from retired rows are ignored.
Runtime/actions/Activity/Instances retain their position before the public fields.
Ordinary human
profiles without agent metadata have no agent fields. A self-authored kind 10100
supplies agent display metadata, not management authority.

## Boundaries

- Shared message UI recognizes author-avatar targets and identity-bound mentions.
  Ordinary `canOpenLink` / `onOpenLink` props advertise availability and dispatch.
  Channels resolves active contributions at click time and owns the right slot.
- `nostr:npub…` is the exact public-key target, with no relay hint or authority.
  Opening uses the current community session, never another connection or cache.
- Message avatars use an app-local `buzz:agent-profile:<pubkey>` target when
  their existing display evidence identifies an agent, including kind-40002
  messages without profile metadata. This preserves the avatar shape and an
  unnamed **Unknown agent** heading. Other unnamed identities use `npub…xyz`.
  The full copyable public key and profile-read retry remain available.
  The navigation hint grants no ownership or native control and is not added
  to the shared agent directory. Only the panel boundary accepts it; public
  message links and composer tokens remain restricted to `nostr:npub…`.
  Public metadata and configured names still win.
  An empty confirmed native inventory says **Not managed on this device**;
  it does not claim the agent is offline or absent from the whole community.
- Display names bind only against the message's signed `p` keys, longest first.
  Unknown, ambiguous, untagged and incomplete names stay plain text. Code/link
  contexts are conservatively excluded on the full body, before URL rendering.
  This is not a Markdown parser or a notification change.
- Replacement edits remain readable but their mentions are not clickable: old
  Buzz can change body identity bindings without changing original recipients.
  Full-key-qualified namesake occurrences also remain literal. Bodies changed by
  Markdown image removal do not bind clickable mentions either: stripping an image
  can create a name that never appeared in the signed prose. Image attachments and
  signed notification recipients are unchanged. Full edit-snapshot rendering
  compatibility is deliberately deferred.
- Disabling Profiles removes its panel and clickable affordances without changing
  prose, drafts, delivery or recipient intent. Re-enable does not reopen it.
- Profile enrichment in channels and threads remains a background batch. The
  panel fetches only its selected missing key, with explicit failure/missing retry.
  Community/session replacement disposes the old view. About and self-declared
  NIP-05 metadata stay in the existing bounded directory and follow
  replacements/removal.
- A profile replaces the existing thread/object slot, not a second parallel dock.
  Close/Escape returns focus to the original control, falling back to the stable
  originating thread control if opening the profile unmounted the thread.

## UI and iteration

Avatar, name, about, self-declared NIP-05 (not DNS-verified), exact copyable
npub, and, for known agents, an optional compact activity preview/action. **Message** is offered for a
foreign profile when the session can start direct messages; as in New message,
a known agent qualifies only while this community's ready native control manages
it, rechecked on click. It opens (or reopens) the one-to-one DM through the session's direct-message operation and
navigates to the relay-confirmed channel in the scope captured at click time. A
confirmed open also clears that DM's local sidebar hide. The person's
self-published NIP-38 `general` status (kind 30315, emoji tag plus text) uses the
session's shared live status owner, including expiration and clear events.
Custom `:shortcode:` emoji use the community emoji catalog with a text fallback.
Set or clear your own status from the top-right profile menu. Shared design-system
Avatar and Button use the host-loaded styles directly. The profile content marks its
`data-buzz-ui` boundary and uses shared heading/body/mono roles; its stylesheet
owns layout, not component overrides. No new theme owner, second global reset or
shell migration. Designers own later refinement.

Agent hints change avatar shape, not authority:

- Profiles, mentions, participants and membership avatars use squircles for
  self-declared `is_agent`/`isAgent` metadata or exact keys in the loaded session
  library; otherwise they use circles. My Agents cards always use squircles.
- Message authors also use these hints. An original kind-40002 envelope is enough
  on its own and keeps that treatment through edits.
- Library hints are lazy: opening or refreshing Agents loads them; clearing the
  library removes that fallback. Avatars never fetch the library or scan telemetry.

None of these hints proves ownership or running state. One bundled SVG mask scales
across sizes and clips only artwork, leaving the profile button's focus ring intact.

Use the normal `bin/just desktop` or `bin/just web` workflow in the feature worktree
with the existing public live-mode pin; run only one dev target at a time.

## Evidence and remaining checks

`avatar-shapes.spec.mjs` covers painted pixels and focus across sizes, themes and
viewports in Chromium/WebKit, including the artwork inside participant/membership
overlap borders (pictures and initials). Shape attributes alone do not prove that
inset artwork is clipped. Completion tests cover loaded-library changes without
another keystroke; profile-directory tests cover marker-only updates.

`tests/browser/profiles.spec.mjs` runs real React/ChannelsPage, thread reading,
profile directory, panel registry and plugin lifecycle against a synthetic
transport. It covers avatar/mention keys, keyboard/focus, disable/re-enable,
thread-only mention enrichment, failure/retry and session replacement in Chromium
and WebKit. It also checks copy success/failure with a stubbed clipboard and
light/dark layout at 390, 900 and 1280px widths. It does not establish an OS
clipboard, live relay or native packaging result. `profiles-appearance.spec.mjs`
additionally exercises the compiled app and host appearance owner: shared type,
color, compact-button styling, keyboard-only focus and single-scaled typography
at narrow, intermediate and wide widths in both modes.

Focused tests cover target validation, mention ambiguity/code/link boundaries,
signed-event → fold → renderer indentation preservation, current-body edit
marking, about-only profile updates, rendering and actual bundled registration.
The CI repair also narrows channel catch-up cancellation to top-level timeline
heads: `live-session.test.ts` forces overlapping unread reads for 1, 2 and 130
channels; `sidebar-unread.spec.mjs` holds unread evidence through real EOSE and
checks its badges without retries. Access-loss/disconnect cancellation is unchanged.
Broad scan and native build/package acceptance remain deferred to an agreed
integration batch. The earlier read-only profile slice changed no sending/signing
behavior; the managed-agent admission described below does.

## Info, channels and linked instances

The profile's Channels tab uses the current viewer's `session.channels`
list and exact `ChannelSummary.members` from relay-authored rosters. It excludes
archived, hidden, DM and session conversations. Only positively identified stream
and forum rows render; when a matching roster lacks a recognized type, that
membership is unclassified and omitted from the channel rows. Ready empty copy
qualifies this uncertainty for the viewed identity, including partial lists.
Verified classified rows remain visible
alongside a transient list error; loading/error/partial discovery is not an
empty membership claim; retry uses `refreshList`. Rows navigate using the existing
scoped conversation destination when a valid community scope and navigation
capability exist, otherwise remain plain text.

On native hosts, linked instances use `agentControl`'s exact managed `pubkey` and
normalized `relayUrl` for the active community. The subsection is absent without
native control or a valid community scope. Agent identity hints gate loading and
visibility, never ownership; exact native matches alone supply instance rows. The
section stays hidden for a non-agent without a match. It never derives ownership
from the old Buzz library, self-declared profile markers, or names.

Each owner-accessible row opens the existing Profile panel with a typed
`buzz:agent-instance:` target containing native ID, identity public key, viewer
and canonical community origin. The target is selection, not authorization:
private instance detail additionally requires the current signed profile's
verified owner to equal the viewer, successful ownership observation, and an exact
native record matching ID, public key and community. A background refresh of the
same already-admitted signed head preserves the mounted detail, tab and focus;
errors revoke that admission. A new winning head cannot borrow the previous
head's authority while verification is pending. Initial/pending new-head ownership
shows **Loading…**; a failed ownership read, deletion or changed viewer/community shows
**Unavailable**, never a sibling's settings. **Retry** refreshes native
control and ownership evidence. **Back to profile** opens the ordinary identity;
the Channels host still owns panel replacement, close and focus restoration.
Native read/operation errors retain exact-instance detail and the existing actions'
stale-snapshot notice, Retry status and recovery Stop while ownership remains
established. Tabs retain the exact instance. Ordinary identity runtime/actions require one
unambiguous native match; an instance view selects that record by ID.

Archive labels come from `session.archives`, keyed by identity, rather than native
process status. Archived rows use the same explicit target and remain navigable.
The existing public profile tabs and actions are reused, not replaced by an Agents
page or a second editor. The owner-only ingress requires a verified NIP-OA
owner and a ready, unique native match in this community; the versioned
agent-identity route opens the existing editor, never a guessed sibling.
Browser fixtures exercise live/archived selection,
tabs, back, keyboard close/focus and deletion through the real plugin/Channels
host in Chromium and WebKit. React tests cover exact actions, failed-read recovery,
non-owner denial and scope changes with synthetic native data.

Behavior/copy reference: base Buzz `UserProfilePanel.tsx` explicitly retains the
requested instance public key and opens its runtime tab; its
`ProfileInstancesSection.tsx` keeps archived rows clickable and supplies
**Archived** / **Current**. `UserProfilePanelHeaderContent.tsx` supplies
**Back to profile**; `managedAgentRuntimeStatus.ts` supplies **Unavailable**.
These files live under `desktop/src/features/profile/ui` and
`desktop/src/features/agents` in `block/buzz`. Buzz-app's native records also
need an ID because several records can share one identity.

The Info tab keeps the public key. Linked-instance discovery stays on Info only
when no Runtime tab is eligible. Verified owners with native records see
**Instances** in Runtime, with a collapsed count (“1 instance” / “N instances”)
opening exact native rows. The Channels tab offers
**Add to channel** only for an exact native-managed identity in this community
that is also a managed session choice. It offers loaded, classified stream/forum
channels with a roster, excluding archived, hidden, read-only and already-member
rows. On submission it refreshes native evidence, then checks current agent,
session and channel eligibility across the fresh roster read and at publisher
entry. The relay still decides permission; local evidence does not grant it.
Before publisher entry, navigation or loss of eligibility stops the write. Once
publication begins, leaving the tab cannot undo the request; the session outbox
retains its outcome and an unconfirmed result requires checking membership
before attempting again. Neither list is a cross-community/global directory.

## Owned local agent actions

`ProfileAgentActions` observes the app-owned `AgentControl` injected into Profiles.
It mounts only in Info; changing tabs releases
the actions view without cancelling an admitted app-owned command. Returning to
Info observes current host evidence without restoring focus from the retired view.
In this composition, actions own controller errors and Retry status on Info;
Runtime configuration provides its own error and Retry status for an exact record.
Linked instances suppress a duplicate only when the host view presents recovery
(unknown inventory or one exact match on Info, an exact record on Runtime).
Ambiguous identities keep a single linked-instance status warning and Retry agents. Standalone
linked-instance views retain their own recovery. Initial-read Retry remains available
when native ownership is unknown.
It matches the exact public key and canonical active-community scope to one native
ID; namesakes, other-community identities, ambiguous matches and browser-only
profiles get no runtime actions. It adds no controller, relay scan or agent editor.
Profiles and Agents use `useAgentControl` only to subscribe. One mounted panel
owns `useAgentControlRefresh`; an exact-instance panel owns it for its nested
profile too. Child Actions/Delete/Runtime controls do not install intervals.
The panel refreshes host evidence every five seconds while visible, including
after errors, matching Agents' read-only recovery policy. Explicit Retry status
remains available; no poll starts, stops or restarts a process. Unmount releases
observation and its refresh timer, never native execution.

Start/Restart require ready host evidence, an available runtime and no pending
operation or process transition. Stop uses the controller's existing recovery
policy, including stale evidence and pending launch/credential waits; it is the
intentional exception to disabling pending actions. A pending Stop cannot repeat.
Host failures remain visible with snapshot uncertainty for the matched agent.
Known unmatched profiles suppress unrelated controller errors; an initial read
failure still offers Retry while ownership is unknown. Start stays focusable but
inactive while pending, and moves focus to Stop if success removes the focused
Start button. It does not steal focus moved elsewhere during the wait. Stop and
Restart retain focus when disabled or pending without allowing activation.
`agentLaunchBlock` centralizes the launch gates used by Profiles and Agents.
Retired relay
presentations cannot dispatch commands. The separate runtime child owns badges
and runtime detail; actions do not infer relay readiness.

Info adds an owner-gated route to the Agents editor for a unique native match;
the owner Runtime tab also reuses the editor dialog. Mounted React regression
tests exercise exact dispatch, pending/failure/
recovery and profile/community lifecycle through the real controller projection
with a synthetic native host. Live process/credential handover and rendered native
acceptance remain attended checks, not established by these tests.
