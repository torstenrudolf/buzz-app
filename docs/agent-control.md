# Local agent controls

The Agents page uses one app-owned native controller for creating, importing,
editing and running local agents. Managed cards are keyed by exact identity and
community. Browser-only access keeps the read-only old library; it cannot run
agents. The only product entry point is ordinary desktop startup.

## Normal desktop workflow

Run from the feature worktree with `bin/just desktop`, not a management-only
launcher. The command prepares the pinned agent runtime before starting Tauri;
the first build may take several minutes. Later launches verify and reuse matching
resources, rebuilding missing, stale or corrupt ones. Preparation failure stops
launch rather than opening a desktop that cannot run agents. This opens **Buzz Foundation** using the ordinary live-development
configuration and persistent native settings. Coordinate the native rebuild/relaunch;
quit other Foundation copies first. Saved enabled agents can restore on startup.
Keep imported agents disabled and old Buzz running until an attended handover.

Open **Agents → My agents** for imported identities, their destination community,
process evidence and visible **Start / Stop**. **Edit**, **Duplicate**, and
**Delete** are in the card’s three-dot menu. Duplicate seeds Create with editable
settings and a fresh identity; write-only environment values require re-entry.
Delete stops the local process and removes this app's settings and Keychain key
after confirmation. It does not archive the relay identity or erase messages.
Deployed remote records are refused.
Same-key identities at different destinations have separate
cards; actions use native ID/revision, never the display name. Managed controls
remain available when the old library is disconnected, unavailable or archived.

**Add agent** shares the Edit fields and model browser. In the development desktop,
Create generates a native key, obtains the captured viewer's owner authorization,
saves the agent, starts it, then publishes its profile. A failed Start or profile
publication retains the saved identity and offers a retry for that step; it never
creates another identity. A native Start response can confirm a saved agent while
reporting that its process could not run. During Create, Start, or profile setup,
**Close** leaves the operation running and exposes the existing cards' recovery
Stop. Late completion never closes a subsequently opened dialog. If an operation
cannot be confirmed, refresh status before repeating it.
Create is blocked with an explanation if this app’s runtime is unavailable;
existing agents and profile retry remain intact.
The dev broker and native host must both support this flow. Packaged human
signing remains unavailable.

**Not imported from old Buzz** is a separate collapsible section. Expanding it
loads installed identities for the connected community; already-managed exact
identities are excluded. Each remaining row says **Not imported** and has its own
**Import** action. Source/destination overrides and source warnings stay under
Import options. Import focuses the imported card and says **Imported, not started**.
It does not start a listener, invite an agent or change the old library.

Local team-linked imports snapshot the deployment team's instructions from the
chosen library's `agents/teams.json`, alongside the resolved persona prompt.
The existing ACP team-instructions input receives that snapshot; later edits in
old Buzz are not synchronized. As in old Buzz, a deleted team or a directory-only
legacy binding without a deployment team ID contributes no team instructions.
Remote backends and relay mesh remain unsupported.

Older imports missing this snapshot show **Import or repair from old Buzz**.
Choose their original source library and destination, then **Repair team import**.
This adds only the missing team instructions and advances the saved revision;
it preserves the identity, credentials, prompt, model, environment and enabled
intent, and never starts/restarts an agent. Source changes or changed saved
settings reject the repair. No Keychain read is needed for repair. Before Start,
perform the same attended old-Buzz handover as for a fresh import.

To use an agent, open a channel and select it from **@ mentions**. Both mention
menus include the selected community’s people directory alongside channel members
and managed agents. Directory reads are bounded; narrow the search for more people.
A nonmember is labeled **Not in channel · Choose whether to add when you send**.
Selection alone does nothing. Send asks, as block/buzz desktop does: **Invite**
or **Do nothing**. Without add permission, the only action is **Send anyway**.
Invite uses the existing durable member-add operation and confirms membership
before addressed delivery. It does not start an agent before the outgoing message.
Do nothing and Send anyway send nonmembers as reference mentions, without granting
access or notifying them; channel-member mentions remain addressed. Close or
Escape keeps the draft.
Failed additions keep the draft and allow retry of the same pending operation.
A definitively failed addition older than 15 minutes must be dismissed in Outbox
before a new add; unknown outcomes are never silently replaced. Channel, thread,
and forum-channel composers share this behavior. DM participants and session
admission rules are unchanged.

A confirmed outgoing channel or thread mention now starts an exact imported local
agent (public key + community), without a separate Start click. Import itself
remains non-starting. Stop cancels earlier pending mention wakes and active work;
a later deliberate mention can start the agent again. Plain name text without
recipient selection, received history and unconfirmed sends do not start agents.
Start failures appear separately as “Message sent, but…”; do not resend merely
because execution failed. The old-Buzz ownership guard remains in force.

Mention startup carries the earliest relevant pending send timestamp into the
bundled runner's existing replay input (bounded by its 15-minute catch-up limit).
Already-running agents are not restarted. Mentions during queued or pending startup
attach their earliest timestamp to that same launch, without another credential
read or listener. Stop and changed saved revisions retire that input. If launch
has already finished or the host cannot attach it, the send shows a separate
replay warning instead of silently treating Waiting as Running. Attachment is not
proof of delivery; a later credential/launch failure remains visible in Agents.
Process state is not proof of a live reply; imported identities require old Buzz
stopped before handover.

The focused Add/Edit dialog contains Name and Agent instructions, followed by
**AI configuration** in dependency order: **Harness → Provider → Model**. Provider
choices come from the selected harness; model discovery uses the current draft.
Existing/custom values remain intact when another field changes. Workspace,
arguments and write-only environment patches remain under **Advanced**;
Start/Stop/Restart and exact identity are under **Runtime and identity**. Save uses
native ID/revision and restarts the agent only if it is running and its effective
settings changed (see [saving](#global-agent-defaults-and-saving)). Dirty
drafts resist backdrop/Escape; explicit Cancel/Close discards. Page
navigation/reload still discards page-local drafts.

**Browse models** requests the current Databricks catalog on explicit button
activation, including when typing has already opened the local popup. Typing,
focus and ArrowDown navigation never start a model-host request. Existing
app-isolated credentials are used/refreshed first; only an authentication failure
can open browser sign-in. No separate Connect button is required. Errors/cancellation
need explicit Retry; Refresh in **Advanced model settings** stays headless.
Choose a result or enter a custom ID (blank is allowed); Enter or leaving the field
commits typed text, Escape abandons the query. Save, close and reopen to check it.
If no workspace is configured, edit the agent and set **Databricks workspace (HTTPS origin)**
under **Advanced → Model**. App maintainers can instead supply the nonsecret
`DATABRICKS_HOST` build default below and rebuild the app.

### Nonsecret build defaults

Native builds read these inputs from the repository-root, ignored `.env.local`,
or from the build process environment. A process value wins **by presence**,
including an empty value. Both `just desktop` and release Cargo/Tauri builds use
the same controller-owned configuration. For example:

```dotenv
BUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2
BUZZ_BUILD_AGENT_ENV='DATABRICKS_HOST=https://workspace.example.com
DATABRICKS_MODEL=your-model-id
DATABRICKS_MODEL_FILTER=team-*'
# Optional capability: any present value, even empty/0/false, enables it.
BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1
```

`BUZZ_BUILD_AGENT_ENV` is multiline `KEY=value` content, not a file path. Only
`DATABRICKS_HOST`, `DATABRICKS_MODEL` and `DATABRICKS_MODEL_FILTER` are accepted;
tokens, unknown/duplicate keys and malformed HTTPS origins fail the build without
echoing values. These are **public, nonsecret defaults** compiled into the binary
and available in the native editor snapshot. Never put credentials here. No
organization-specific host, provider or model is supplied by the app.

- Blank saved provider/model selectors inherit the build floor for `buzz-agent`
  only (including its absolute executable path); other harnesses do not. Saved
  selectors win over the floor, and saved `BUZZ_AGENT_PROVIDER`/`BUZZ_AGENT_MODEL`
  environment overrides win over selectors, including explicit empty strings.
  `DATABRICKS_MODEL` is a provider fallback below an explicit Model selector.
- An absent saved Databricks pair inherits the build host/filter; an explicit
  pair, including blanks, wins. Saved `DATABRICKS_HOST`/`DATABRICKS_MODEL_FILTER`
  environment overrides win over either. The same resolution supplies model
  discovery, credential requests and worker startup. Untouched Create or
  name-only Edit/Save never copies build defaults into storage. Editing either
  workspace/filter field intentionally saves **both displayed values**.
- Presence of `BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY` clamps the local listener to
  owner-only after saved settings/environment and removes its response allowlist.
  This includes the runner's verified same-owner agent semantics. It does not
  rewrite imported policy or saved records; remove the flag from both file and
  process to disable the clamp. Empty/`0`/`false` do not disable it.

Changing, adding or removing native inputs requires a **native rebuild and app
restart**; Cargo tracks the file and all three process keys, including removal.
Running agents are not hot-reconfigured. Explicit empty process values clear the
provider or environment floor; boolean capabilities must be absent to disable.
Runtime resources remain separately built from pinned sources with private build
settings stripped. The app-owned relay/key/OAuth boundaries are unchanged:
`BUZZ_RELAY_URL` is not an agent destination, saved destinations remain explicit,
and `DATABRICKS_TOKEN` still conflicts with app-isolated persistent OAuth.

See [configuration parity](configuration.md) for development routing, release
flag exclusions and the supported deployment boundary.

## Harnesses and agent defaults

Individual-agent configuration stays on the Agents page; Settings → Agents owns
installation guidance and device-wide defaults.

### Harnesses

The **Harnesses** card lists only **Buzz Agent**, **Goose**, and **Pi**:

- **Buzz Agent** is bundled and shows **Ready**.
- **Goose** shows **Ready** or **CLI needed**, with **Install** when needed.
  Install runs upstream `download_cli.sh` with `CONFIGURE=false`, as old Buzz
  did; Goose then uses built-in `goose acp`. One install runs at a time.
  Afterward Buzz re-detects, writes an install log, and restarts agents that
  were waiting for Goose.
- **Pi** shows **Ready**, **CLI needed**, or **Adapter needed**. On macOS/Linux,
  **Install** downloads checksum-verified Node v24.18.0 into app-data, then uses
  that Node/npm to install Pi and `buzz-pi-acp` into an app-owned npm prefix.
  Installation has a private log, re-detects the executables, and restarts only
  enabled Pi agents that previously failed because their executable was missing.
  User-global Pi installations remain untouched. Windows and unsupported
  architectures retain manual setup. The copyable commands remain the manual
  fallback (Node.js required):

  ```sh
  npm install -g @earendil-works/pi-coding-agent
  npm install -g --install-links=true 'git+https://github.com/salman1993/buzz-pi-acp.git#86b201e'
  ```

**Check again** re-detects installed Harnesses without reopening Buzz. Status
is executable detection, not a guarantee of sign-in, ACP readiness or inference.
Add/Edit links to Settings → Agents for setup instead of telling people to reopen
the app. The ACP tooltip says:

> Buzz talks to harnesses through the Agent Client Protocol (ACP). Goose supports it natively. Pi needs a small adapter, `buzz-pi-acp`. Your existing CLI setup and sign-in are left untouched.

### Global agent defaults and saving

The **Agent defaults** card in Settings → Agents holds a default harness,
provider, model, effort and environment variables.

- The default harness is **copied into each new agent** at creation (Create
  falls back to Buzz Agent while the default harness is not installed). Changing
  it later does not switch existing agents.
- Provider, model and effort are **looked up at each start** for fields an agent
  leaves blank, only when the agent uses the default harness; per-agent values
  win. The editor shows a blank field as “Use agent defaults (…)”. Effort has no
  per-agent field: an imported agent's `effort_level` stays its override.
- Environment variables apply to every agent and merge **per key**; the agent's
  key wins. A saved Databricks workspace/filter also wins over the corresponding
  global `DATABRICKS_HOST` / `DATABRICKS_MODEL_FILTER` pair. Agents without their
  own workspace/filter inherit the global pair.
- Changing the default harness in the card clears the default model and effort;
  values entered for the new harness before Save are kept.

The store is `defaults.json` under app-data `agent-controller/`, not
localStorage, written atomically with owner-only permissions (0600).
Environment values are write-only, like per-agent API keys: only key names are
returned to the UI. This layer applies before
[`BuildDefaults::resolve()`](../crates/agent-controller/src/defaults.rs), so a
global value wins over the [nonsecret build floor](#nonsecret-build-defaults),
which still fills only Buzz Agent blanks. Goose and Pi receive inherited
provider/model through their existing selectors. Inherited values are never
written into saved agents.

Saving an agent or the defaults restarts, through the native supervisor, only
agents that were **running** before and after the save and whose **effective**
launch settings changed. Stopped and disabled agents are never started or
enabled; a Stop that lands before the restart wins. Save reports “Saved.” or
“Saved. Restarted N agents.” `restartDiff` compares effective settings, so it
also flags inherited changes.

## Avatar editing

Edit uses the same draft avatar picker as human Profile settings: upload/drop an
image, paste an HTTPS URL, choose emoji artwork, or remove the picture. Done changes
the form; Save first persists the exact native ID/revision, then publishes to that
agent's saved community without restarting it. Older native hosts without
`avatarEditingAvailable` retain the display-only avatar.

An omitted picture preserves the saved override; an empty string explicitly removes
it. A changed picture durably marks `profilePending`, so closing/reloading does not
lose the Retry action. The native publisher reads and verifies the agent's current
signed kind-0 profile, changes only picture, and preserves unrelated content and
non-auth tags. Name/bot initialization is only for a missing profile. A local
configuration rename is not an implicit published-profile rename.

One native publication per agent can run at a time, including across renderer
reloads. The host verifies current-profile readback after a matching accepted
receipt before clearing pending at the same saved revision. Conflicting or failed
reads/publications keep pending for explicit retry; no automatic broadcast or
retry loop is introduced. Another client can still replace the profile after this
confirmation; this is not a cross-client transaction.

Browser tests use synthetic profiles/media and controller fixtures. Rust checks
use temporary stores, public fixture keys and loopback HTTP. They do not establish
live relay access, native image rendering or packaged human signing. Camera and
recording are outside this avatar slice.

## Agent Keychain unlock (macOS)

Managed agent keys share one agent-only Keychain item: service
`dev.local.buzz.foundation.agents`, account `agent-bundle-v1`. After a successful
read, the native credential owner caches it for the session; starting another
migrated agent does not read another Keychain item. Human identity and old Buzz's
credential blob stay separate. Nothing collects the macOS password or changes
Keychain access controls. Development signing and other credentials can still
cause OS prompts; this is not a promise of exactly one total dialog.

Existing app-owned `agent:<key-community>` entries are copied lazily on Start or
other explicit credential use, with exact identity validation and secure readback.
The first migration can require multiple approvals. Original entries remain for
rollback; explicit Delete removes both copies before removing settings. New keys
are written only to the bundle, so older versions cannot start newly created keys.
Do not operate older and newer credential writers concurrently during rollback.
Never delete old Buzz's source credentials for this migration.

A short per-OS-user file lock serializes bundle access across cooperating
worktrees/profiles. Writes re-read the current bundle under that lock and verify
readback; a nonsecret invalidation token in the lock file invalidates other
sessions' cached copies before writes. Lock files contain no keys. Busy storage
fails visibly and requires explicit Retry; it never waits behind another app's
consent prompt or automatically replays a write. This does not coordinate manual
Keychain edits or older app versions; quit the app before changing storage outside
this owner. A refused unlock is remembered until explicit Start/Retry, Import,
Create, profile publication, or Delete; later auto-start rows do not reopen it.

All launch-selected agents appear **Waiting to start · unlock Keychain if prompted**
until their turn finishes acquiring credentials. A successful acquisition advances
to **Starting process**, then process-alive evidence or a specific failure with
**Retry start**. Stop remains available while waiting; pending OS dialogs may
still need dismissal, but a late result cannot start a stopped agent. Quit and
saved-revision fences remain in force. No frontend polling automatically retries
Start. Windows/Linux retain their existing per-agent credential adapter.

### Development startup diagnostics

Debug builds print `[agent-startup]` and `[agent-keychain]` lines to the existing
`just desktop` terminal. Selection records include the public key/community ID,
effective `startOnAppLaunch` and enabled intent, then each auto-start attempt records its
final process state. Credential records identify bundle/individual/legacy item
class, operation, begin/end, sanitized failure category and elapsed time. They
never print keys, raw item accounts, relay URLs, environment, agent names or OS
error text. Release builds do not emit these diagnostics; no new log store or
telemetry transport is added. A Keychain API call is not proof of an OS prompt.

For an attended check, retain only these prefixed lines locally, note the dialog's
item label (never the password), then quit and relaunch the **unchanged binary**.
Do not manually start agents or send waking mentions during this check: credential
lines have no agent ID, so overlapping credential operations cannot be attributed
by order. Already-migrated agents should use the bundle, not individual reads. Native
signing/OS consent remains a separate observation; do not equate a fixture pass
or a Keychain call count with password-dialog acceptance. Auto-start off is a
saved preference, not an execution failure: change **Start on launch** in the
agent profile's Runtime tab deliberately rather than rewriting settings.

## Runtime boundary

Native startup opens `app_data_dir/agent-controller`, never the old library as a
destination. One serialized controller lives for the app lifetime. It restores
agents whose start-on-launch preference is on (legacy records without one follow
saved enabled intent) with app-owned credential custody and verified resources.
Page/plugin/community disposal drops observations, not processes. Quit fences
pending starts and stops owned processes while retaining enabled intent. A pending
OS credential dialog does not hold the controller: Stop, Disconnect and Quit
retire late starts; Save during a credential wait requires an explicit retry.
Synthetic native tests inject rejecting or in-memory credentials and runtime
resources. Production has no disposable storage override or preview launch mode.

Launch-selected agents start relay listeners; their AI worker pools remain lazy
until work arrives. Status reads project configured ACP/MCP paths without reading
or hashing executables. These paths and `runtimeAvailable` describe the bundle
accepted at initialization, not a fresh integrity check or relay readiness. Every
actual launch still verifies its bundled worker, ACP and MCP executables before
spawn, and exposes verification failure on the agent. Native Start projects one
final snapshot after recording its outcome. This adds no incoming wake service
for fully stopped listeners and no durable interrupted-turn recovery.

On Unix, an execed supervisor in the same app binary owns each agent's shared
identity lock, isolated listener session, and temporary runtime directory. App
Stop/Quit and kernel EOF on forced app death both trigger the existing whole-session
teardown; ownership is released only after listener and workers have exited.
Unconfirmed teardown keeps the lock and private directory, and normal Quit remains
fail-closed. This does not clean up listeners orphaned before this fix, does not
contain a worker that deliberately escapes its session, and does not add process
containment on non-Unix platforms.

## Ownership and handoff

- `features/agents/control.ts`: camelCase DTOs and app-owned observable projection.
  `control-service.ts` constructs it once at root app composition and exposes its
  `AgentControl` interface through Cordis injection. Only the app disposes the projection;
  the author contract exposes neither its disposal nor host construction.
- `control-native.ts`: named native IPC commands, including explicit model-request tickets. Browser returns an
  unavailable capability; no fetch fallback, local storage, signing or runner.
- `bundled/agents/AgentControlPanel.tsx`: compose with `{ control }` independently
  of selected community or relay connectivity. It owns only observation and UI
  drafts. Its five-second status refresh runs while visible, including after a
  read or operation error; reads coalesce and never replay writes. A read
  rejected specifically because native startup is initializing or its lock is busy
  stays pending for at most twenty 250ms waits. Other errors or exhausted retries
  remain visible above the cards, with explicit Retry as well as the next periodic
  read. Successful reads clear the global warning; native per-agent errors remain
  on the affected agent, and failed Save/Create/Delete details stay in their dialog.
  Unmount clears the timer, not enabled intent or processes.
- Native host owns persistent state, credential custody, process groups, lock and
  duplicate ownership checks, source import validation and sanitized diagnostics.
  Critical sections wait in arrival order through the host's async admission gate
  and execute on blocking workers; a status read does not reject a concurrent
  command as busy. The worker retains admission until it finishes, even if its
  caller disappears. Credential and network waits release admission so recovery
  Stop can still invalidate pending launches. Shutdown is checked again after
  acquiring native state. Failed commands are never automatically replayed.
  It must bound IPC operations and reject with deliberately user-facing strings;
  raw child/OS/parser errors must never cross into these snapshots or rejections.

## User contract

- Start enables host-owned execution; Stop disables automatic resume and stops active
  work. A later deliberate outgoing mention can enable execution again. Native confirmation, not React optimism, determines displayed state.
  App Quit stops owned processes but retains enabled intent for the next launch.
- Start on launch is a separate persisted preference set with
  `agent_control_start_on_app_launch`. It is not a config revision and never
  starts or stops the running process; a restore it triggers is an ordinary Start.
  Created and imported agents save it off; only legacy records without one follow
  enabled intent. A launch restore queued behind another agent's credential
  prompt skips any agent explicitly started or stopped since the app opened.
- While a process is alive, `restartDiff` itemizes saved settings that differ from
  the settings it was started with. The native side compares raw values and sends
  only redacted entries: prompt character counts, masked arguments and environment
  values, and environment keys as added/removed.
- `running` is **process-alive evidence only**, labeled “Process running · relay
  readiness unverified.” It is not a Listening/Working badge or proof a mention
  can be received. Native wake/readiness acceptance is separate.
  The avatar badge is relay presence, which the harness publishes just after
  the process starts; the card re-reads it briefly after start/stop (see
  [presence](presence.md#ownership-and-bounds)).
- Save uses `expectedRevision` and updates only editable fields, then restarts
  running agents whose effective settings changed (see
  [Global agent defaults and saving](#global-agent-defaults-and-saving)).
  Saved/running revisions remain distinct. Dirty drafts survive refresh and save
  failure. A newer saved revision blocks overwrite and offers explicit discard;
  the person can copy their edits before discarding. Drafts are page-local and
  are not persisted across navigation/reload.
- Arguments use a JSON string array rather than splitting shell text, preserving
  spaces and literal quoting. Empty/comma-containing arguments are rejected because
  the current ACP transport cannot represent them faithfully. The executable is a per-agent
  harness choice; Settings → Agents owns the Harnesses setup card. The
  host must validate launch configuration and unsupported imported semantics
  before execution.
- Harness and Provider choices come from native `harnessOptions` through the
  injected Core snapshot. Buzz Agent offers Databricks v2. Goose appears with an
  absolute executable path when the local CLI is installed, and offers common
  Goose providers plus a custom ID. A missing CLI leaves Goose disabled; the
  **Check again** action re-detects it after installation without an app
  restart. Switching into or out of Goose supplies ACP
  arguments and clears the previous provider/model; selecting a Goose provider clears the
  previous model. For Goose, an explicit Browse asks Goose ACP for the selected
  provider's supported-model list and searches it in the existing picker. The
  exact returned ID is saved; an unlisted ID remains possible but is flagged
  after discovery. The picker shows at most ten matches while filtering the full
  list. Saved write-only `GOOSE_PROVIDER` overrides remain native; native uses
  the effective provider before asking Goose. Goose has no separate Refresh
  action because its catalog lookup can start OAuth. Known API-key providers
  show a masked key field beside Provider. Its write-only environment patch is
  used for both model lookup and agent launch; a blank field uses Goose's
  existing credentials. The key field follows a draft `GOOSE_PROVIDER` override.
  When a saved override's value is hidden, Buzz asks the user to replace or
  remove it in Advanced → Environment before showing a provider-specific key
  field. These per-agent keys are stored in the app's local
  `agents.json` settings file and its backup with restricted filesystem
  permissions, not in Goose's keyring. Listing errors prompt the user to enter credentials or retry;
  manual model entry remains available. Executable detection
  is not a sign-in or ACP readiness check. Custom command/provider values remain
  editable, including absolute paths. Buzz Agent retains on-demand Databricks
  model browsing. A Goose catalog entry does not establish caller EXECUTE permission
  or successful inference. Advanced arguments remain a literal JSON array. Old native hosts
  without this metadata fall back to custom entry.
- With a Goose provider and model selected, **Test connection** runs one
  `goose run --text` turn without a saved session or extensions in the agent
  workspace using the effective draft provider,
  model, and write-only environment. Buzz requests a ten-token output limit
  and sets thinking effort to off. Success requires a nonempty assistant text
  reply in Goose's JSON output; Goose can exit successfully after a provider error.
  The result does not verify Buzz relay readiness or launch the agent. A failed
  or timed-out test leaves the draft unchanged.
- Environment values never arrive in snapshots. Inputs are masked write-only
  patches: missing key preserves; string replaces (including empty); null removes.
  Undo omits a patch again. Successful save clears entered values from UI state.
  Browser strings cannot promise zeroization. Unknown native fields stay native.
  Saved `BUZZ_AGENT_MODEL`/`BUZZ_AGENT_PROVIDER` (buzz-agent) and
  `GOOSE_MODEL`/`GOOSE_PROVIDER` (Goose) overrides win over Model/Provider
  selectors; blank selectors do not erase them. ACP uses the same effective model.
  Snapshots name the deciding key (`launchModelEnv`/`launchProviderEnv`,
  including `DATABRICKS_MODEL` or a hidden provider behind a blank buzz-agent
  model) and omit the resolved value.
- Import previews only the chosen installed/development library and requires an
  explicit secure **Destination community** origin. Old Buzz ignores saved relay
  pins at runtime; blank, stale or malformed saved pins do not route or hide
  identities here. Native validates the chosen destination, shows it beside each
  exact key, and retains it with the preview token through commit. Source or
  destination edits discard candidates and invalidate late preview results. Each
  Import action selects one exact identity. Duplicate source keys fail closed even with different
  old pins; changed sources and duplicate destination ownership are rejected.
  Only explicit Import actions commit, always stopped. No key minting, membership
  enrollment or source-store write. After a failed preview, correct the destination/source
  and choose **Load agents** or **Retry**; both refresh status before previewing.
  Never edit the old library to work around a destination error.
- Operations are serialized except explicit recovery Stop during a pending
  Start/Restart, Import, Create or profile-publication credential wait. Stop can
  reach the native fence for a pending launch or another known enabled/running
  identity; only one Stop is admitted at a time. Other writes remain blocked until
  both operations settle. Superseded success, error and finalization cannot
  overwrite the newer Stop result or unlock its pending operation. Stop does not
  cancel native credential writes: imported/created rows may still commit stopped,
  and profiles may publish. Recover these changes by a fresh status read, never by
  replaying the superseded result.
  Old pre-write reads cannot overwrite newer command evidence. Failed reads/commands retain the last snapshot
  and draft with explicit uncertainty. Start/Restart/Save/import require a fresh
  successful host read before retry. Explicit Stop is the only recovery exception:
  it remains available for identities in the retained snapshot, even if that stale
  snapshot says stopped/disabled. Failed durable disable remains unconfirmed;
  Stop is never automatically retried. No process recovery loop in TypeScript.

## Databricks connection and models

- Native `agent_models.rs` owns one ticketed, 180-second operation lane, separate
  from the controller lock. Only the user-intent Connect IPC action (Browse/Retry) can open a browser; it tries headless discovery first. Refresh is always headless.
  Cancel, context change, page unmount and root disposal retire the ticket. Native
  admission remains occupied until the old task's future has actually dropped.
- The immutable `buzz-agent` dependency is pinned in
  [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml); no local-checkout dependency. It owns
  OAuth PKCE, refresh, catalog parsing/filtering and per-page bounds. It retains current Buzz endpoint/redirect semantics. Native rejects over 10,000
  projected models or oversized IDs.
- OAuth credentials remain under this app's
  `agent-controller/buzz-agent/oauth/databricks/<connection-hash>.json`. Connect,
  native catalog, worker catalog and inference share this exact engine layout.
  Unix directories are owner-only; helper token files are owner-only. They are
  **not Keychain-encrypted**; other code running as your OS user can access them.
  Non-Unix helper persistence remains memory-only. No old Buzz cache/Keychain or
  ambient `DATABRICKS_HOST`/`DATABRICKS_TOKEN` is read.
- Disconnect requires Stop for all owned workers using the displayed workspace,
  retires pending starts for it, and removes only its app cache (retaining the lock
  inode). It does not revoke browser sessions or tokens at Databricks. Cancel may happen
  after successful authentication; use Disconnect if credentials should be removed.
- Save persists workspace/filter with the harness revision; Connect does not save
  or start. Saved or draft environment overrides take precedence; conflicting inputs fail before
  auth rather than querying a misleading catalog. An effective non-v2 provider,
  token override or revision conflict also blocks connection. `BUZZ_AGENT_MODEL`
  produces a visible override warning, never leaks its value or rewrites it.
- Catalogs may be partial; no completeness claim. The pinned helper's labelled
  authenticated-empty defaults are omitted here because they are not discovered
  IDs. Empty/error states keep manual entry available.
- [Nonsecret build defaults](#nonsecret-build-defaults) supply the workspace,
  model fallback and filter without copying them into saved agents. Unknown or
  secret build keys fail closed. With no saved or build workspace, enter one
  explicitly before browsing models.

## Runtime resources

Ordinary `bin/just desktop` and `bin/pnpm tauri build` prepare these resources
automatically. Direct Cargo builds do not run that JavaScript preparation step.
To prepare/build without launching any app or accessing old credentials:

```sh
bin/pnpm install --frozen-lockfile
bin/node scripts/build-agent-runtime.mjs
bin/pnpm build
bin/cargo build -p buzz-foundation
```

[`runtime/agent-runtime.json`](../runtime/agent-runtime.json) pins the five tools
to the same immutable source revision as the native library. The build script fetches
that revision and uses pinned Cargo for one `cargo build --release --locked` of all
five tools outside the checkout, scrubs injected Buzz/provider environment and
per-shell compiler overrides (`RUSTFLAGS`, `RUSTC_*`, `CARGO_PROFILE_*`, …), and stages binaries plus
revision/target/SHA256 manifest in `src-tauri/resources/agent-runtime`. Worktrees
of one clone reuse a verified bundle cached under the Git common directory, keyed
by the pin, tool list, build arguments and `rustc -vV`. Native build copies them to
`target/debug/agent-runtime`. Generated binaries/manifest are not committed.
Startup verifies the exact tool set, target, revision and file hashes. Packaged
macOS apps may accept signing-induced hash changes only when the runtime belongs
to the running app and its resource seal verifies under Block's Developer ID.
The final hashes are retained in memory; required launch tools are rehashed before spawn. No PATH/old-bundle fallback or runtime
download. The manifest detects corrupt/mixed resources, not a same-user attacker
who can replace the app and manifest. Inputs are immutable, not a promise of
bit-identical machine-independent binaries. This build is not a signed installer.

### Updating the agent runtime

Update the library pin in `src-tauri/Cargo.toml` and the bundle pin in
`runtime/agent-runtime.json` together, then refresh `Cargo.lock` without unrelated
dependency upgrades. The runtime integration test checks that both pins name the
same repository and immutable revision; the native synthetic manifest reads the
runtime spec rather than carrying another copy of the pin.

Re-run the resource preparation and native build commands above, then validate:

```sh
bin/cargo test --locked -p buzz-foundation -p buzz-agent-controller -- --include-ignored
bin/node --test tests/integration/agent-runtime.test.mjs
```

These checks use isolated fixtures, including the staged binaries; they do not
launch the app or access live credentials. Exercise upstream behavior changes
with relevant bundled-tool smoke checks. Do not commit generated resources;
live handover remains a separate step below.

## Handover and rollback

1. While old Buzz still runs, review/import only. Choose the installed/development
   library and destination under **Import options**. Import may prompt for the
   selected legacy secure-storage blob; it creates app credentials in the separate agent-only bundle described above.
   The source
   is read-only and imported agents stay stopped. Refused custody is a blocker,
   never a reason to migrate keys implicitly.
2. Review prompt, workspace, harness/provider/model and write-only overrides.
   Browse models, save explicitly, and verify settings after reopening.
3. Before Start or an outgoing mention, stop old Buzz **and its listeners** with
   the human's agreement. Native refuses detected legacy paths; it never kills
   them. Cooperating new-app profiles also hold an exact-key/community OS lock.
   Neither protects against relaunching unmodified old Buzz: no coexistence claim.
4. Observe a real channel/thread reply, idle wake, Stop cancellation and Quit
   cleanup in the attended workflow. A process-running badge is not relay evidence.
5. Stop agents on a workspace before Disconnect. A saved host edit does not change
   a running worker. Temporary signing files under private `runs/agent-*` disappear
   only after confirmed teardown. This is lifecycle management, not a sandbox for
   same-user code that escapes its Unix session.
6. Roll back with Stop and confirmed new-owner cleanup, then Quit and resume that
   identity in old Buzz. Never delete the old library or its credentials.

## Validation and limits

`control.test.ts`, `control-native.test.ts`, `agent-edit.test.ts` cover projection
races, unavailable browser, exact IPC payloads, uncertain result handling,
save/restart feedback, literal arguments and environment patch
semantics.
`tests/browser/agent-control.spec.mjs` drives the real editor and capability over
the isolated fake host in Chromium/WebKit: dirty refresh, save failure, revisions,
write-only replacement, Stop, unmount without control actions, selected import,
browser unavailability and narrow dark layout. Mounted recovery cases start with
running and stopped snapshots, fail status reads, then exercise explicit Stop
through the real capability; failed durable disable retains uncertainty and drafts.
These browser fixtures do not prove native IPC or persistence.

`src/app/agent-control.integration.test.ts` exercises real app composition, Agents
registration, plugin management, community selection and the native adapter with
synthetic IPC/relay transports. The same injected capability remains functional
through disable/re-enable, two real community session switches and Personal space.
Captured IPC contains only snapshots during those transitions; root disposal fences
further reads without sending Stop. This is not a mounted native GUI test.
`src/plugins/author.test.mjs` builds declarations and independently compiles a plugin
consumer with no host source, checking Context injection and non-exported ownership.
`src-tauri/src/agents/tests.rs` uses the actual command handler and Tauri mock runtime
with temporary disk stores for Save/CAS/Stop, source preview, rejecting test credentials/runtime and
shutdown fencing. These checks do not establish secure custody, process teardown
or a working listener.

The isolated browser fixture (`tests/fixtures/agent-control.*`) remains test-only:
no dotenv loading, live broker, native credentials or actual process execution.
It supports the controller, editor-grid and model browser regression suites, not
an alternative product launch mode. Check results belong in the PR at their exact
snapshot rather than as permanent checkpoint claims here.

Local execution currently uses Unix containment; native credential import/create
is macOS-only. Custom harnesses require an absolute executable and are not
certified by bundled Buzz Agent tests. Unsupported settings stay editable but
Start refuses them. OAuth files are owner-only, not Keychain-encrypted. A failed
import can leave create-only app custody for retry but no enabled/configured agent.
No remote/mesh runtime, live team synchronization or conditional attestation is added. Synthetic checks
do not establish actual Keychain ACLs, production TLS/inference, live replies,
forced native quit, signed packaging or other-platform behavior.

## Pi harness

On macOS/Linux, Settings → Agents offers **Install** for a missing Pi CLI or
adapter. It uses an app-owned Node and npm prefix; manual setup still works.
Choose **Check again** to re-detect without reopening the app. Pi appears
alongside Buzz Agent and Goose.
Availability means the executables were found, not that authentication or
inference has been verified. This
integration uses the adapter's Pi argument forwarding after `--` (verified with
buzz-pi-acp 0.0.33) and Pi's `get_available_models` RPC (verified with Pi 0.86.1).

Choose **Pi → LLM Provider → Browse models**, or leave Provider unset and Browse
to see all locally available providers. The returned provider/model pair is saved
as separate fields; model IDs retain namespace slashes and punctuation. Browse
also adds extension-provided providers to the provider choices. Pi provider
changes filter the loaded catalog without launching another lookup. Workspace,
arguments or environment changes retire it and clear discovered provider suggestions. Custom provider
and model entry remain available, including when lookup fails or returns no models.
When a provider is set, enter its exact model ID without adding the provider prefix.
The Advanced model field preserves text literally, including IDs that themselves
start with the provider name. After Browse, an unlisted ID carries a warning;
manual IDs remain allowed and an available catalog is not inference validation.
Clear both fields to keep Pi's own defaults. Choosing a provider requires a model
before Start; Pi otherwise silently ignores a provider-only flag. Save restarts a
running Pi agent whose effective settings changed.

Discovery launches the same locally resolved Pi used by the ACP adapter, in the
agent's workspace, with the same explicit environment and extension arguments.
It uses `--mode rpc --no-session --no-themes` and sends only
`get_available_models`, never a prompt or Buzz identity. Selection is omitted
from catalog startup so a stale model cannot prevent finding its replacement.
Cancel, changed workspace/configuration, and closing the editor retire the native
lookup; Unix cleanup kills the lookup process group. Errors require explicit retry.
Pi may return a cached extension catalog; Refresh reloads Pi’s available snapshot
and does not guarantee a fresh remote catalog. The catalog reflects Pi's available models and local credentials, not a guarantee
of inference permission. Authentication and extension caches remain Pi-owned;
configure sign-in in Pi. Extensions are executable local code and can perform
their own initialization/authentication during discovery.

Runtime forwards Provider and Model as `--provider` / `--model` to the adapter
and uses `provider/exact-id` for ACP model selection. There are no invented Pi
provider/model environment variables. The controller owns `PI_ACP_PI_COMMAND`;
it resolves Pi and Node beside the adapter first, then the usual local install
locations. Ambient provider credentials are not inherited. Use Pi's credential
store or explicit write-only per-agent environment patches.

Optional extension configuration uses Pi's existing facilities, with no provider
package bundled into the OSS app:

- Install/configure packages in Pi normally; both discovery and runtime load them.
- Set `PI_CODING_AGENT_DIR` in Advanced environment to use a specific local Pi
  configuration directory. It is saved locally, never projected in a snapshot.
- To load a particular extension, set Advanced arguments to
  `["--", "--extension", "/absolute/path/to/extension.ts"]`. Paths containing spaces
  are supported. `--no-extensions` disables automatic extension discovery while
  keeping explicitly supplied extensions. Advanced runtime arguments are preserved
  and forwarded to the adapter, including
  thinking, skills and tools. Browse supports standard Pi configuration options
  and strips provider/model flags for catalog startup. Unsupported extension flags
  or positional input block Browse with an explanation, while manual entry and
  runtime arguments remain available. Browse also rejects inline `--flag=value`
  syntax and `--api-key`, whose meaning depends on the selected startup provider;
  use Pi's local credential store or explicit provider environment instead.
  The adapter still owns its reserved
  session, prompt and mode flags. Explicit Provider/Model fields are appended last.

Internal distributions can provision a pinned extension package and Pi config,
or supply an installed extension path through these same settings. Keep private
package URLs, hosts, filters, authentication and model policy in the private
packaging/configuration owner. Discovery and runtime must point at that same
configuration. The current internal release repository builds the old desktop;
its generic build environment injection is not a Pi resource-bundling contract
for this app. Signed bundling, automatic employee provisioning and release
pipeline migration require separate release work; no release is published here.
