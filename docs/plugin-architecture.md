# Plugin architecture

## Purpose

Buzz should make it practical for people and agents to build new product experiences with code. A designer should be able to build an experimental Channels page using real data and useful components, without implementing relay operations. A developer experience team should be able to add rich integrations to conversations without owning the surrounding application. And end customers of buzz should be able to extend the installed app dynamically, without having to contribute upstream or run the dev server.

Plugins are the unit of contribution and installation. They can contain substantial implementations: several components, their own layout and interactions, and multiple contributions. The foundation is ordinary React components, shared data and execution capabilities, and a small number of explicit extension points.

## The first two authoring experiences

**A page (target authoring experience).** A builder creates a plugin that registers
a page, reads shared channel views, and builds a new interface. They should be able
to reuse timeline/message components or build their own, owning the complete page
implementation and its behavior and appearance. Bundled source demonstrates this composition. The conversation preview
now supplies host Composer/Message through a generated type-only author entry;
broader supported external reuse remains an [author-contract gate](status.md#open-acceptance-and-product-gates).

**Rich conversation content.** An integration plugin recognizes a link to a GitHub pull request or a native Buzz object and supplies a panel showing that object. The Channels page decides where the panel appears. Another page can display the same content in a different arrangement.

Both experiences use real session capabilities. As AI integrations become available, authors should be able to consume those capabilities without rebuilding authentication, execution, or state handling. The [Agents compatibility view](agents.md) shows the existing Buzz library read-only; mentions use current channel membership and existing runners. The connected [local controls checkpoint](agent-control.md) adds native settings and bundled process management through an injected app-owned capability. Execution and credential import stay blocked in the disposable editor; the normal management path requires its separately reviewed, attended handover.

## Ownership

| Area | Responsibility |
| --- | --- |
| Application host | Startup, plugin installation and activation, page navigation, persistent channel sidebar, Settings, and recovery. |
| Page plugin | Its complete React tree, local interaction state, internal navigation, and arrangement of panels. |
| Panel plugin | Recognizing a supported target and implementing the content and interactions for that target. |
| Shared capabilities | Session state, relay access, retained data, local agent controls, and eventually external connections. |
| Reusable UI components | Useful rendering and interaction behavior, configured through ordinary props. |
| Cordis | Dependency availability and resource lifetime across plugin activation, replacement, and disposal. |

Bundled and local plugins use the same contribution contracts. Within the source
tree, shared implementation code remains importable without another registration
layer; this is not a promise that external artifacts can import host source paths.


## Code arrangement

```text
app/                    host, startup, navigation, Settings
plugins/                installation, lifecycle, contribution ownership
features/pages/         page contract and host rendering
features/panels/        target resolution, launcher contract and reusable card/frame
features/shortcuts/     in-app binding dispatch, focus rules and plugin ownership
features/relay/         shared channel data, queries, profiles and durable delivery
features/messages/      reusable timeline, message, thread and composer UI
features/channel-navigation/ persistent sidebar, scoped draft handoff, Channels routes
bundled/channels/       conversation navigation, page layout and panel placement
bundled/projects/       repository/project pages, issue/PR details and Git views
features/projects/     entity route/data contracts and bounded Git read bridge
bundled/agents/         local control UI and read-only current-Buzz library page
features/agents/        app-owned control capability; separate session-owned library
bundled/github/         builtin GitHub panel plugin
bundled/bestie/         builtin companion panel and its snake launcher
```

The host composes one channel sidebar beside independently mounted pages. It reuses
session-owned roster, unread, creation and preferences capabilities; it does not
retain a hidden Channels page or message reader. Sidebar and page render errors
have separate boundaries. Sidebar presentation helpers currently remain importable
from `bundled/channels`; no public sidebar contribution contract is introduced.

Channels is the page-authoring example, not a thin registration wrapper over a
host-owned product page. Keep page-specific components, styles, interactions and tests
beside `bundled/channels/index.tsx`. New page plugins should do the same. At the
owner’s request, reusable conversation UI lives in `features/messages`: timeline,
message rows, thread panel, composer, delivery presentation and reading geometry.
Other source plugins can compose those components through ordinary props, with
internal session/destination isolation rather than caller-dependent remount keys.
Import shared capabilities through the existing relay and panel contracts; do not
create a second connection, cache or outbox inside a page. The conversation preview exposes only Composer/Message in a stable component bag;
source imports are not a versioned external SDK. See
[conversation component ownership](channels.md#reusing-conversation-ui).

## Starting contracts

A plugin exports `inject` and `apply(ctx)`. Pages register with
`ctx.pages.register({ id, title, layout?, companion?, component })`. Panels register with
`ctx.panels.register({ id, title, matches, launcher?, component })`. IDs are local to the
plugin; the registry adds installation identity and revision and removes the
contribution when its Cordis scope ends.

A page calls `panels.resolve(target)` and renders `PanelView` with the resulting
contribution, the target string, and a close callback. The first active matcher
wins; a throwing matcher is skipped. Panels receive `{ target, close }` plus
optional host context. A conversation host may supply
`context: { channelId, canOpen, open }` for contextual panel-to-panel actions.
`canOpen` is advisory active-target availability; `open` re-resolves at click time
and returns false after the originating opening, channel, session or host
presentation retires. This is not a global navigation API or an access grant.
Channel-header launchers use the separate public `channelContext` metadata
contract described below; launcher/fallback panels need not have either context.
A plugin that needs shared data declares `relay` in its
injection list and passes those capabilities to its components using a closure,
just as the bundled Channels page does. The conversation preview adds only the two demonstrated component surfaces.

Channels owns its selected channel and docked target. The panel view isolates
render failures and remounts on target or revision changes. Unloading a plugin
removes its contributions and closes its panel. Other pages can use these same
contracts with their own layout and local navigation.

The initial distribution contains Channels, Projects, Agents, GitHub, Bestie, Emoji, Mentions, Profiles, Terminal and Links. Projects
is enabled by default and owns versioned, validated entity page routes. It resolves
signed metadata through the session reader and reports navigation completion only
after destination content is presented. Git browsing uses a narrow host-owned,
authenticated development broker capability; plugins cannot choose a signer or
remote URL. See [entity links and limits](deep-links.md).
GitHub recognizes repository,
pull request, issue, and commit URLs and loads public object details on demand.
Unsupported URLs retain ordinary link behavior. Private GitHub connections and
agent execution remain future shared capabilities.

### Optional channel templates and Settings cards

`ctx.settingsCards.register({ id, title, component })` contributes a card under
Settings → Messages, not a new route. Adding `group` instead gives the card its own
Settings destination under that labelled navigation group; its section id is the
contribution key (`plugin/card`) and disappears with the plugin. Cards receive `active()` and use ordinary
session capabilities through injection. Host boundaries isolate rendering errors;
exact registration identity and mounted lifetime revoke callbacks on removal.

Templates & teams (`buzz.channel-templates`) is bundled **off by default** in both
browser and desktop catalogs. Explicit saved overrides win. Enable it under
Settings → Plugins, then manage recipes under Settings → Messages. The host sidebar owns
personal groups and the existing + creation buttons, independently of this plugin.

Hosted communities (`block.hosted-communities`) is a Block-specific bundled plugin
under Settings → Communities. It manages Block-hosted relays through a Builderlab
account: browser sign-in, binding the local Buzz identity (a locally signed kind
24243 challenge), and create/archive/unarchive/transfer. Joining stays in the
existing Add a community dialog; the card only copies the new relay address. Its
`/api/builderlab/*` routes live in the development broker (`dev/builderlab.mjs`),
which keeps the session credential and signing key in Node. Packaged builds ship no
broker, so this plugin cannot sign in or manage communities there until a native
backend exists.

`ctx.channelTemplates.register({ id, title, editor, groupDefault, saveAs })` supplies
one optional composition provider. With zero or multiple active providers, no
optional controls are selected. This host-matched preview is not a workflow API:
The sidebar owns creation form/draft data and final dispatch; the session owns signing,
membership, Canvas writes, exact receipts and setup completion notices. Settings and
provider components must check `active()` before accepting delayed work or starting
new writes; this lifecycle fence is not a sandbox or a replacement for access checks.

Normal Create selects a saved template without a customization disclosure or raw
setup dump. Templates & teams settings retain lineup/Canvas editing. Disabling
preserves saved group default references but does not apply them to new intent.
Accepted drafts get a compact summary and Clear action only when the provider is
unavailable or fails;
re-enable does not overwrite edits or automatically apply an unresolved old default.
Accepted setup runs independently of the template/agent catalogs after admission.
Failures preserve frozen setup receipts and Outbox delivery evidence; dismissing a
completion notice only hides that notice. There is no template Resume, automatic
resend or startup continuation. Disabling is not cancellation of already accepted
writes. Group-only and Canvas-only setup
require no agent-library readiness; real agent selections still receive fresh host
validation. Template-specific library demand belongs to mounted plugin controls;
shared group/catalog storage remains session-owned.

Colocated regressions cover app registration, exact-contribution revocation,
accepted-draft retention, completion notices and preserved delivery evidence. They are not live cross-window
or packaged/native acceptance; validation results and remaining gates belong in the
pull request. Updating the native bundled catalog requires a desktop rebuild/restart;
frontend hot reload alone cannot add the entry.

### Composer accessories

`ctx.conversation.registerAccessory({ id, title, order?, component })` contributes
read-only contextual UI above the shared composer. The host passes
`{ session, scope, channelId, threadRootId?, canOpen, open }`: no editor commands,
new socket, or implied access grant. Channels supplies target resolution and panel
placement; other composer consumers can omit navigation and return unavailable.
The shared renderer owns deterministic order, error isolation and command
revocation on removal/unmount. Composer destination keys fence session/channel/
thread changes. The accessory remains usable on read-only connections.

Agent Activity is the first consumer. Plugin activation owns its telemetry lease;
multiple composers subscribe to the same session capability. No global selected
channel or activity-specific dependency is added to reusable message components.
The persistent sidebar reads the same session activity snapshot for its quiet marker;
it owns presentation, not capture or an additional activity lease.
This is a host-matched preview addition, not cross-version capability negotiation.

### Channel-header launchers

A panel may additionally contribute `channelLauncher: ComponentType<ChannelLauncherProps>`.
Channels renders these in its conversation header with public `context`, `pressed`,
`available()` and `toggle(target)`. The page owns one selected channel panel, placed
in the bottom drawer by default or the existing companion column when the contribution
sets `channelPlacement: "side"`; a launcher
selects its **exact active contribution**, not target matching. `available()` and
`toggle()` are revoked when the mounted context or contribution is retired. Optional
`PanelProps.channelContext` carries the current displayed public context to a channel
panel; ordinary link/host panels do not supply it. It is presentation metadata, not
signing authority. Plugins decide when to capture it into their own work.

Channels keeps layout and channel/thread selection. The Terminal plugin binds its
mounted launcher into the existing shortcut dispatcher, and owns sessions separately
from drawer mounts. No global selected-channel store, extra shortcut listener or
host companion change is required. Disabling/replacing a contribution closes its
drawer, and re-enabling starts closed. See [Terminal](terminal.md) for native support,
session behavior and validation limits. This is a host-matched preview addition,
not cross-version capability negotiation.

### Optional Canvas todos

Todos (`buzz.todos`) is bundled **off by default** in browser and desktop. Enable
it under Settings → Plugins. Its channel-header ListChecks button opens a right-hand
side panel, grouping items as To do, Doing and Done, with add, a per-item Doing
toggle, check/uncheck, one optional assignee per item, automatic
saving after each action, and explicit Refresh. It uses shared controls and theme
tokens; Channels still owns panel geometry, responsive placement and selection. Terminal remains in the bottom drawer.

The source of truth is ordinary Markdown in one root level-two `Todos` section:

```markdown
## Todos

- [ ] Review the plan
- [/] Build the preview
- [x] Share the preview
```

`[/]` marks Doing, the common Markdown convention for an in-progress task;
ordinary Markdown renders it as plain text. Canvases without it keep their
existing meaning: `[ ]` is To do and `[x]`/`[X]` is Done.

Only top-level unordered checkbox items in that section are shown. Nested lists,
quotes and fenced examples are not tasks in this view. Doing and checkbox edits
change one source byte; additions insert below the heading without rewriting other
content.
Duplicate Todos sections block editing until corrected in Canvas. Disabling removes
the convenience UI, not the saved list: Channel settings → Canvas remains editable.

An optional terminal suffix records assignment as ordinary Markdown:
` · Assignee: [Display name](nostr:npub…)`, using a full valid npub, not the abbreviated
placeholder shown here. Only that exact structural suffix is assignment metadata;
other links/prose remain task text. The public key is identity; names are escaped
presentation. Assign/change/clear edits only the suffix. The selector uses the
current channel member roster, including that boundary for shared naming policy,
with public-key qualifiers in the opened choices. Missing rosters disable assignment controls; failed profile reads retain key/name fallbacks
and offer retry. Profile renames never rewrite saved Canvas. Former members remain
visible and can be changed or cleared. Assignment sends no notification and grants
no channel membership or access.

Canvas reads occur on open and explicit Refresh, not on a timer. Missing assignee
and member profiles use the existing shared background directory. Typing an unfinished
new item stays local; Add, checkbox and assignment actions save automatically.
Task actions pause while saving; the new-item input stays editable and retains
its text when the save finishes. If the loaded Canvas was written in the current second,
a single cancellable wait respects its timestamp ordering; there is no background
retry loop. Failures and recovered drafts expose Retry rather than silently publishing
on reopen. Save uses the existing session Canvas/outbox contract, including its 24 KiB limit, fresh membership check,
optimistic head comparison and exact confirmation. This is **not atomic concurrency
control**; simultaneous saves can overwrite edits. Detected conflicts retain the
local draft and require reviewing the saved Canvas. Refresh confirms before discarding
edits. Local recovery drafts are partitioned by community/viewer/channel; if browser
storage is unavailable they survive only while the editor stays open. Save never
promotes local recovery storage to shared state. Already accepted outbox operations
remain session-owned if the drawer closes or plugin is disabled.

### Top-bar launchers and the companion slot

A panel may supply `launcher: { icon, target }`. The host renders the decorative
image (generic icon on failure) and uses the panel title as the button label.
`target` is an opaque string, including an empty default; it is not an agent URI.
Launcher-only panels use `matches: () => false`. Clicking selects that exact active
contribution, bypassing target matching so another plugin cannot intercept it.

App owns one launched-panel selection, separate from a page’s local target. The
selection starts closed, repeated clicks toggle it closed, and navigation preserves
open intent. Disable/replacement invalidates the installation object; re-enable
stays closed even at the same key/revision. A stale close cannot dismiss a later
opening, including a later opening of the same contribution. Ordinary close returns
focus to the launcher if available.

Pages explicitly opt in with `companion: true` and receive `{ companion?: ReactNode }`,
a ready-to-render card. They must place it in **every** state, including no relay,
loading and empty data. Channels places its local target above this card in one
right column. Non-opted/legacy pages and Settings use the generic host fallback;
there is never a second simultaneous host dock. The fallback frame stays mounted
while opening/closing to preserve page-local state. `PanelCard` and `PanelFrame`
are ordinary shared components, not another registry.

Only open intent crosses pages: the panel component can remount under a new page,
so this mechanism does not promise persistent agent sessions or drafts. Bestie
currently supplies art and truthful not-connected copy, with no send control or
agent API. Both browser and Rust native/CLI catalogs list it as independently
enabled by the normal bundled policy; saved disabled flags still win.

`main.tsx` creates the shared services once; `app/App.tsx` owns startup screens,
navigation, and built-in Settings. `app/services.ts` composes the core services.
`agentControl` is provided once on the root Cordis context and exported through
the generated type-only author contract. Agents consumes it through injection;
plugin disable/re-enable and community switches do not reconstruct it. Page
unmount clears observation, not enabled intent. Root disposal fences only the
TypeScript projection; the native app owns persistence, credential admission and
process lifetime, and enforces launch/import gates even for direct IPC calls.

Settings and Recovery subscribe directly to plugin management. Page render errors
stay in the page boundary rather than being copied into plugin configuration.

`plugins/manager.ts` is the plugin subsystem's entry point. The app supplies the
Cordis context and bundled manifests/modules. Storage defaults to the platform
adapter, with an optional override for tests. React is provided as `ctx.react`;
external JSX plugins declare `inject = ["react"]` to use the shared instance. The manager
constructs its module loader and execution adapter internally, observes configuration,
and selects the desired plugins (including enabled flags and safe mode).

External plugins can declare host access in `manifest.json`:

```json
{
  "host": {
    "commands": [{ "id": "status", "program": "example-cli", "args": ["status"] }],
    "networkOrigins": ["https://api.example.com"]
  }
}
```

Plugins declaring `host` in `inject` use `ctx.host.runCommand(id)` and
`ctx.host.request({ url, method, headers, body })`. Command calls name a declared
ID; the program and arguments come only from the installed manifest. Native
execution uses no shell or stdin, discards stderr, and returns at most 4 KiB of
UTF-8 stdout. The direct command invocation has a five-second deadline;
cancellation or timeout kills its process group on Unix or its job process tree
on Windows. Failure returns `null`. The app
also searches standard Homebrew binary directories when a macOS GUI launch has a
limited PATH and passes that search path to the command.
Plugins parse and retain their own credentials; the host has no provider registry
or credential store.

Requests use the native HTTPS client, so an external plugin can declare an exact
origin without changing the renderer CSP. URLs must use a declared origin; redirects
are not followed and cookies are not forwarded. Requests accept up to 1 MiB of text
body and 8 KiB of headers; responses return status, up to 64 headers totaling
16 KiB (excluding `Set-Cookie`), and up to 16 MiB of UTF-8 body. The full request
has a 30-second deadline. Browser calls cannot use these native operations.
Existing bundled GitHub requests retain their first-party renderer fetch and CSP
entry.

The import preview lists declarations and marks added or changed access on updates.
The install/update action accepts that displayed version; an enabled update may run
immediately. These declarations help review and catch mistakes. Plugins share the
main WebView and can invoke app commands directly, so the declarations do not
isolate a malicious plugin. Load only trusted plugin code.

### Loading from folders and repositories

Desktop Settings → Plugins loads a folder with the native folder picker, or an
HTTPS/SSH Git repository (including GitHub `owner/repository`). An optional branch
or tag is separate from the repository URL; GitHub `tree` URLs are rejected with
guidance rather than ambiguously splitting branch names and subfolders. Discovery
lists built plugin folders by path, name and manifest ID, including nested `dist`
folders. Choose one and explicitly install/update; the same preview can install
another plugin without fetching again. New plugins stay disabled. Updates match
**manifest ID**, even across repositories, and preserve the saved enabled state:
an enabled update may activate immediately except in safe mode. The UI warns before
that action and shows declared host access, including changes. Installed artifacts do
not watch/pull the source. Plugins installed from a folder keep the selected folder
path for Settings → Plugins → Reload while disabled;
reloading reads the recorded candidate folder and requires the manifest ID to stay the
same. Reload rejects changed host declarations; use Load from folder to review and
install that revision. Enabled plugins must be disabled before reload so memory-only
plugin state, such as credentials, is not discarded by replacing the running module.
Git installs and older installs without saved folder metadata must be imported again.

The Rust manager owns acquisition and immutable preview artifacts, with a bounded
single pending preview per native process. Replacing/closing a preview discards it;
leaving Settings ignores and discards a late result, never automatically installing.
Acquisition is separate from the manager's ten-second management-write timeout.
Installation uses the exact captured bytes and retains the existing artifact hash,
profile locking, rollback, recovery and safe-mode behavior. An uncertain write retains
the preview identity for same-artifact retry; it does not refetch or rebuild.

Local discovery skips symlink directories, `node_modules`, `target` and dot-prefixed
directories such as `.git` and `.claude` (Claude Code worktrees) below the selected
folder; select such a folder itself to import from it. Git discovery does not skip
dot-prefixed directories. Local discovery uses `cap-std` directory-relative reads to
confine descendant path resolution. Files
must be regular, non-symlink UTF-8 text; candidate folder names must be UTF-8 and are
not lossily normalized. Discovery never evaluates modules. Git is a required local
tool: a shallow no-checkout clone reads committed blobs, without hooks, filters,
submodules, LFS downloads or project scripts. Only HTTPS/SSH are allowed; inherited
Git config, URL rewrites, credential helpers and interactive prompts are disabled.
SSH uses the existing agent/known hosts, not user SSH config; password entry, HTTPS
private-repo sign-in and custom SSH-config aliases are not supported in this slice.
Repository URLs/refs are passed as arguments, not a shell command. Private/internal
HTTPS hosts are not prohibited; this is not a public-network-only policy.

Git acquisition has a 60-second deadline (including blob discovery), an observed
256 MiB repository limit and bounded command output; transport processes are killed
on failure before temporary cleanup. These are polling limits, not hard OS quotas.
Folder traversal checks a 60-second budget between directory reads (a hung filesystem
syscall is not forcibly cancelled), 32 nesting levels and 20,000 entries. A preview
holds at most 32 plugins / 32 MiB; each artifact retains the 8 MiB limit. No builds
are run: source-only folders explain that the author must supply `manifest.json`
plus the self-contained `plugin.js`. Separate assets/TSX/runtime dependency resolution
remain outside API v1. Browser Settings truthfully directs users to desktop rather
than adding a second external-plugin storage or broadening CSP. Native commands need
a rebuilt/restarted desktop process; frontend HMR alone cannot add them.

`plugins/storage.ts` isolates browser storage and desktop IPC. `plugins/modules.ts`
imports and caches executable revisions. `plugins/runtime.ts` adapts Cordis lifetimes
and owns activation status; contribution services receive a read-only readiness view
of that same status. There is no separately synchronized status store.

The runtime receives only the desired plugins. It retains cancellation and cleanup
barriers around asynchronous imports and replacement; Cordis owns dependency
availability and effect disposal. Stopping plugin management stops polling and its
owned plugin lifetimes. App shutdown starts manager disposal and root-context
disposal together: a hung plugin cannot delay cancellation of shared sessions,
requests or subscriptions. The returned promise rejects after 10 seconds if cleanup
has not finished; it does not claim that arbitrary plugin code has stopped. Plugin
replacement still waits for the predecessor's actual cleanup, even after a timeout.
React owns only subscriptions and presentation state.

Catalog polling observes external `buzzodz` writes once per second. Its ten-second
watchdog bounds the caller's wait, not native lock acquisition: one pending catalog
read retains ownership until it actually settles. Retry cannot launch a replacement
while that read is pending. Recovery remains available, but is a separate management
operation and still needs the native registry lock. A timed-out management operation
keeps controls busy until actual settlement; late results are not applied. A fresh
poll reconciles the eventual stored state. Disposal stops polling/publication, not
an already-running native operation.

Relay consumers use `session.channels` for channel views,
`session.profiles` for shared identities, and `session.read` for
finite filtered event reads, and `session.unread` for shared observed badges and
cancellable reading intent. See [relay query ownership](relay-queries.md) and the
[unread capability, durability and limitations](unread.md).

Plugins subscribe to `ctx.relay` connection snapshots and bind work to the current
ready session. `useRelayConnection(relay)` is the React adapter; remount session-owned
views with a key including both scope and generation (for example,
``key={`${connection.scope}:${connection.generation}`}``). Scope distinguishes
retained communities whose generation numbers may match; generation distinguishes
reconnections within one scope. Persist drafts and view intent under scope alone,
not generation. Reactive filtered reads use `session.observe`;
writes use `session.outbox` or the `session.messages` convenience methods. Reads,
live traffic and local events share reconciliation, with no separately injected
write service. Dispose owned views when their plugin or session scope ends.

The [Profiles plugin](profiles.md) supplies read-only human/agent identity panels.
Shared message UI opens exact public-key targets through ordinary page callbacks;
no inline-renderer or panel contract extension is needed.

## Navigation targets and visits

The host provides `ctx.navigation` to plugins declaring `navigation` in `inject`.
`open(target)` returns a presentation result, not merely an accepted address:
`opened`, `failed` (with a reason), `superseded`, or `cancelled`. The host owns one
history driver, toolbar/keyboard traversal, and a 15-second attempt deadline.
A visit has stable identity; retrying/reclicking preserves that visit and Forward,
while a new destination truncates the forward branch. Leaving aborts the old
attempt, and late completion cannot acknowledge a replacement attempt.

Version-1 `OpenTarget` accepts legacy Home targets (resolved to Messages), Settings sections, contributed pages with
optional versioned JSON routes, and account/community-bound conversations.
The boundary copies, freezes and bounds route data; an address is never an access
grant. Scoped targets require the original viewer and an already joined community.
An explicit `scope: null` restores Personal space; omitted page scope leaves the
current community alone. Unknown providers/routes fail with the target retained
for retry, rather than silently opening another page.

Pages receive optional `navigation` in `PageProps`. Ordinary pages acknowledge a
successful mount inside the render boundary. Pages declaring `handlesNavigation`
acknowledge their domain presentation with `navigation.complete(...)`; Channels
waits for its requested channel window or exact-message reveal/focus. `navigation.resolve(target)` normalizes a
pending default destination within the same visit, caller and original deadline;
it does not start competing navigation. Normalization revokes the old request.

A page request belongs to the exact active registration and mounted host
presentation. Its signal aborts and its callbacks return false after removal,
replacement, unmount or scoped-community invalidation, even before React cleanup.
A reactivated provider receives a fresh request for the still-pending visit.
Session-aware pages bind each rendered connection with
`navigation.forSession(relay, connection)` and pass that request to their
session-owned subtree; Channels demonstrates this boundary. Replacement revokes
the bound request synchronously without revoking static page authority or resetting
the caller's deadline. These are trusted-plugin lifecycle fences, not a sandbox.

`route: { version, validate }` opts a page
into versioned route parameters. These are host-matched preview types through
`@buzz/author`, not a cross-version runtime compatibility promise.

Browser `#buzz=` addresses and session history support reload and Back/Forward.
`targetLink`/`parseTargetLink` define a `buzz://open` locator codec that omits the
sender's viewer; `bindSharedTarget` pins it for an admitted recipient. Messages also
recognize the Buzz link forms `buzz://channel/<id>`, `buzz://channel/<id>/<event>` and
`buzz://message?channel=<id>&id=<event>&thread=<optional-root>`. Buzz links use the
receiving conversation's community and viewer; `buzz://open` locators retain their
community and use the recipient's viewer. Both pass through existing navigation
admission and session ownership checks. Message targets open their
verified thread, reveal the exact message after bounded history loading, and only
then acknowledge navigation. Supplied root hints do not override verified events.
Missing or unavailable messages report failure. Ingress adapters must reuse this
validated target/completion lifecycle; notification clicks
([notifications](notifications.md)) and OS-delivered deep links on desktop
([OS deep links](deep-links.md)) do. The OS ingress accepts only the Buzz link
forms and binds them to the selected community; any other OS link, `buzz://open`
included, fails `invalid-target` through the same failure notice rather than being
dropped.

Drafts, reading geometry and sidebar view intent remain domain-owned, outside
visit history. Saved sidebar preferences live in the relay session, not in the
mounted page; see [sidebar ownership](channels.md#ownership).

## Conversation contributions

`registerMessage({ id, title, matches, component })` contributes an optional whole
message body. Components receive `{ message: ChannelMessage }`; the first active
match wins, throwing matchers are skipped, and render failure/removal restores the
host body. Registration uses the same owned contribution lifetime as inline/link
renderers. The host retains author/time chrome, actions, attachments and session
ownership. `MessageRenderer` is a host-matched author-preview type, not event
admission or cross-version capability negotiation.

The bundled **Diff viewer** (`buzz.diffs`) handles `ChannelMessage.diff` from legacy
kind 40008. Shared history, live, thread and exact readers retain these messages
independently of the plugin, preserving raw patches rather than interpreting them
as Markdown images or links. The plugin supplies an inline preview and expanded
Unified/Split dialog. Disabled/failed rendering, malformed/incomplete patches and
patches over the display parsing budget retain escaped raw text. Unconsumed
patch lines and unsupported binary payloads also fall back to the complete raw
patch; metadata-only rename/mode/binary summaries retain rich presentation.
Preview, file and raw scroll regions support native keyboard navigation. Diff
messages are not editable, including through the composer's Up-arrow shortcut.
Diff search remains deferred: the client accepts kind 40008 hits, but relays
whose search index allowlist excludes that kind cannot return them. Metadata is
untrusted presentation, not repository access authority. No sending, applying,
repository fetching or sidebar panels are added.

`registerLink({ id, title, matches, className?, component })` contributes optional
presentation for links already recognized by messages. The host retains the anchor,
destination, new-tab/modifier behavior and panel activation. Components receive
`{ url }` and render non-interactive inline content inside that anchor. They must
not nest links or buttons. The first active matching renderer wins; throwing
matchers are skipped. A render failure or plugin removal restores the ordinary
link, including its styling. Registration follows the existing plugin lifetime.

The bundled Links plugin uses blue text, a blue fill only on hover, 2px padding
4px corners, and service icons for GitHub, Google Drive, Figma, Notion, Slack,
Dropbox, OneDrive, GitLab, YouTube, Loom, Zoom and Teams. Google Docs, Sheets and
Slides use distinct file-type icons; unknown websites use a globe. Host matching
does not fetch metadata or infer a service from names in paths or query strings.
It does not fetch titles. Messages currently recognize
credential-free HTTPS and supported Buzz links. Markdown labels preserve their
formatting, escaped pasted wrappers are normalized outside code, and paired `<…>`
autolink wrappers are hidden in display. Buzz links use known channel names with corresponding icons, falling back
to Channel, Message or Thread when that name is unavailable in the current community;
the full destination remains on the anchor. Buzz activation stays inside the host,
including modifier/middle clicks, even when the optional Links plugin is disabled.
Unsupported Buzz formats remain plain text. The host-matched author preview exports `LinkRenderer`; older hosts do not
provide `registerLink`.

Message hover/focus previews are host-owned. The entire card is a keyboard-accessible
link to the same destination, routed through the same host navigation handler. Opening a preview allocates the current
session's bounded thread reader; closing disposes it. The reader supplies verified
message content, author and timestamp and preserves edit/deletion/access handling.
Previewing never acknowledges reading or switches community. The host offers a
resolved label to the bundled presentation via `LinkLabelContext`; no author API
contract or relay protocol changes are required. Known channel references and
unambiguous signed person/agent mentions share the inline hover styling. Names in
ordinary prose never create notification intent or establish an identity.

The conversation preview exposes top-level `registerTool`, `registerCompletion` and `registerInline`
methods and stable `conversation.ui.Composer` / `.Message` / `.Thread` components. Generated
type-only `@buzz/author` declarations are exercised by a source-only external consumer
fixture in `tests/fixtures/conversation-consumer`; it is built and installed only in
the browser test's temporary profile.
This remains a host-matched preview, not a stable cross-version SDK. Shared session
ownership and trusted-plugin authority do not change.

`conversation.ui.Thread({ session, scope, channelId, channelName, messageId })`
renders the existing `ThreadPanel` in an embedded presentation without its
side-panel header or close control. The host supplies contribution renderers, Buzz
link navigation, registered panels in a dialog and media review. The page owns
its surrounding header and placement and passes its current ready session and
stable community/viewer scope; retargeting disposes the old thread and
presentation state. The page holds no second message reader, cache or outbox.
Exact message links still navigate to Channels rather than the page's route.

### Composer ownership and mention tools

The standard composer is reusable host UI in `features/messages`, not a mandatory
Composer plugin. Page plugins may compose it through `conversation.ui.Composer`
(or source props), or build their own editor against the shared session. Optional
chooser UI belongs in tool plugins: `bundled/emoji` and `bundled/mentions` use the
same `registerTool` contract. No page imports their implementations. Optional numeric
`order` (default zero, lower first; ties by contribution key) keeps visual and
keyboard order stable across asynchronous activation and re-enable. Mentions uses
`-10` to retain its position before default-order tools such as Emoji. The host groups
negative-order tools with selected-recipient avatars, preserving DOM/keyboard order;
this is host layout, not a new plugin contract. Inline identity chips remain in the draft.

Links, channel references, selected mentions and custom emoji render through shared
message components directly in the editable draft. Display tokens retain the exact authored source;
copying and sending preserve that source. Arrow keys and deletion open adjacent
links for ordinary text editing. Partially deleting a link keeps it plain during
the editing session; double-click selects the link and triple-click selects its
whole paragraph. The host owns source offsets, plain-text paste, composition, undo and
selected recipient metadata. Token renderers are display-only while editing.
Names pasted as text never create notification intent.

Tools receive `insertText`, `insertMention({ pubkey, name })` and `focus` commands.
Mention insertion atomically records visible text and exact notification intent;
`true` means the edit was accepted, **not** that membership or delivery succeeded.
The host serializes successive commands using the latest draft and selection,
enforces text/recipient limits, and revokes commands on tool removal/replacement,
editor destination/session change, disabled/read-only state and unmount. Names are
presentation, never recipient resolution. Editing/pasting over an identity span
removes its intent under the existing draft rules.

**User intent outlives the tool that created it.** Disabling Mentions removes its
chooser, not selected recipients, their inline chips and avatar removal controls,
scoped drafts or pending messages. Editing or deleting a selected mention removes
its explicit mention intent. Removing an avatar clears that identity's explicit
mention intent without changing the authored text. This does not suppress Sessions
routing: the selected agent or sole session agent can still be addressed. The session
still owns roster/profile data, membership checks, signing and publication/retry.
Plugins remain trusted same-process code; revocable editor commands do not sandbox the session capabilities they receive.

This preview is host-matched: a tool using `insertMention` needs a host providing
that command. The generated type-only `@buzz/author` package and `apiVersion: 1`
are not runtime capability negotiation or cross-version compatibility promises.

### Composer completion providers

Emoji and Mentions each register a separate `registerCompletion` contribution.
The host observes focused, enabled textarea text and collapsed UTF-16 selection,
then chooses the valid syntax match closest to the caret (greatest range start),
with `order` and contribution key breaking ties. This lets a later emoji trigger
win over an earlier multi-word mention query. Matchers
must not depend on asynchronously arriving session data: the winning component owns
reactive roster/profile/catalog filtering. Only that component mounts. An empty
result without status/retry hides the menu while keeping the provider subscribed.
Before the first publication the menu is also hidden: syntax matching is not evidence
of loading. Providers must publish an explicit status for actual pending work. Escape
still revokes unpublished work, without exposing ARIA controls for a missing listbox.

Providers receive immutable observation/range evidence and `publish(result)`—not
DOM, focus or replacement commands. Results contain stable IDs, labels, optional
detail/decorative previews and either text or an exact `{ pubkey, name }` mention.
The host copies edit/query primitives and caps publications at 50 choices. A
publication returns its own withdrawal disposer (or `false` after revocation).
Providers must withdraw synchronously when the data supporting a displayed choice
changes, and republish from the new snapshot; unrelated notifications must not
leave a withdrawn result without pending work. Cleanup cancels asynchronous work.

The host binds callbacks to the exact contribution, editor revision and query.
Edits (including same-text input), selection changes, blur, composition, disabled
state, plugin replacement, destination/session change and unmount revoke old work.
Acceptance rechecks the actual DOM text/caret/focus and atomically replaces the
query through the existing mention-draft path, retaining its text/recipient limits.
Typing/pasting a name alone never creates notification authority. Accepted mention
intent survives optional plugin removal and remains subject to session validation.

One host-owned, viewport-bounded portal renders the active listbox. Focus stays on
the textarea with `aria-controls`/`aria-activedescendant`; arrows follow stable IDs,
plain Enter/forward Tab accept, and Escape dismisses pending results. A rejected
displayed choice must not fall through to sending. Retry is a selectable menu action
using the same arrow/Enter/Tab path, including when there are no results. Modified
keys, Shift+Enter/Shift+Tab and IME events retain ordinary editing behavior.

Emoji lazily copies native-only records (including aliases and keywords) from the
pinned data package; it does not use Emoji Mart's mutable global search singleton.
Community matches come only from the current session catalog. Mentions performs
bounded background enrichment through the shared profile directory, not per-key
network reads or a separate identity cache. Multi-word filtering stays in the
provider so a delayed name can appear without another editor event.

This is the same host-matched preview as toolbar tools, not version negotiation or
a sandbox. Inline mention pills remain outside this completion implementation.

Formatting needs selection transforms. Attachments and voice need shared media
capabilities, destination-bound asynchronous work and cancellation; accepted
material belongs to the draft, not the optional tool. Add these contracts against
real workflows rather than declaring the toolbar a universal editor API.


## Desktop browser

Plugins can render the host-provided [`browser.View` component](browser.md) inside a panel. It opens HTTP(S) pages beside the conversation on macOS desktop. The host owns website rendering, navigation controls, and native session cleanup. Remote pages receive no Buzz IPC bridge; plugin JavaScript remains trusted same-process code. The [capability guide](browser.md#try-the-capability-with-a-local-plugin) includes a complete local-plugin example and installation steps.

## In-app keyboard shortcuts

The host composes one `ShortcutsService` in `app/services.ts`. Plugins declare
`inject = ["shortcuts"]` and call `ctx.shortcuts.register(shortcut)`; their bindings
use the same matching/dispatch rules as host-owned Settings and text sizing.
There is no OS-wide hotkey registration, native accelerator API, or command bus.

```ts
import type { Context, Shortcut } from "@buzz/author";
export const inject = ["shortcuts"];
export function apply(ctx: Context) {
  const shortcut: Shortcut = {
    id: "show-details",
    title: "Show details",
    binding: { key: "k", mod: true, shift: true },
    // Optional Settings presentation order within this plugin's category.
    order: 10,
    when: () => detailsViewIsAvailable(),
    run: () => showDetails(),
  };
  ctx.shortcuts.register(shortcut);
}
```

`binding` is one binding or a nonempty array of aliases. `key` matches the logical
`KeyboardEvent.key` case-insensitively, not a physical `code` (Space is `" "`,
not `"Space"`). `mod` means Command
on Apple platforms and Control elsewhere; Shift/Alt and the other primary modifier
match exactly. IME/AltGraph events and already-prevented events are never consumed.
The window listener runs in the bubbling phase, after local editor handlers.

By default bindings do not run in editable targets (including open Shadow DOM),
while a dialog is open, or repeatedly on a held key. Explicit `allowInEditable`,
`allowInModal` and `repeat` opt in; `when` checks current eligibility without
re-registering. `run` may return a promise; throws/rejections are logged and isolated.
Only a selected binding prevents the browser default. An eligible held binding
still prevents the default when its repeat handler is suppressed.

IDs are namespaced by installation. Only active revisions participate; disable,
failed activation, replacement and Cordis disposal remove eligibility. Plugin ties
are resolved by ascending namespaced ID, independent of activation order. Host
bindings are reserved even while unavailable (Settings does not navigate behind a
modal). `snapshot`/`subscribe` expose ready plugin registrations, not host bindings
or a promise that every binding wins every current focus conflict. The host-only
registration method is deliberately absent from the injected type contract; plugins
remain trusted same-process code, not sandboxed adversaries.

`order` is optional and defaults to `0`. It controls only the row order in Settings
within this owner's category; lower values appear first. Every bundled plugin
assigns deliberate values to its actions (for example, a primary action starts
at `10`), leaving gaps for related actions to be added later. Equal orders use
the stable namespaced contribution key (`pluginId/shortcutId`), then title, as
presentation tie-breakers. The core Buzz host category uses the same metadata
and a host-owned functional sequence: navigation, text sizing, search/settings,
then development-only actions. Host rows use their bare IDs for tie-breaking.
Presentation order does not affect dispatch precedence, and
shortcuts with duplicate titles remain separate rows because registry keys—not
titles—identify bindings and their overrides.

See [`shortcut-counter`](../examples/plugins/shortcut-counter/README.md) for a
self-contained external plugin using the real service without a DOM listener.
The generated type-only `@buzz/author` exports `Shortcuts`, `Shortcut`, `KeyBinding`
and `RegisteredShortcut`. This is a host-matched preview: older hosts without the
`shortcuts` capability cannot activate such a plugin. `apiVersion: 1` alone is not
runtime feature negotiation. Multi-key chord sequences and command palettes are
outside this initial contract.

Users can rebind any registered shortcut in Settings → Shortcuts without plugin
changes. The page lists host bindings and every active plugin contribution from the
dispatcher's own `hostSnapshot`/`snapshot` registries, grouped by owner, so it
cannot drift from what fires. Overrides live in the host-owned device-local
`buzz-shortcut-bindings.v1` preference, keyed by the registry identity the
dispatcher already uses: the bare id for host bindings and `pluginId/id` for plugin
contributions. The dispatcher resolves the effective binding at match time, so a
plugin keeps registering its default and never sees, stores or re-registers for
an override; the override follows the plugin across disable, re-enable and
replacement, and an override whose owner is no longer installed is ignored rather
than deleted. Rebinding replaces an alias set with the single chosen chord; reset
restores every alias. Host chords stay reserved: the page refuses to assign a chord
that another listed shortcut already uses, host or plugin, refuses the copy, cut,
paste and select-all chords (and close-window/quit in the desktop build) because a
match would prevent their default everywhere, and warns when a chord is one the
message editor handles locally. A conflict can still appear after capture, for
example when a plugin that was disabled at the time is re-enabled with the same
default or a new plugin ships one; the dispatcher then resolves it silently, so
each affected row shows an "Also used by …" line naming the others. A malformed
stored override falls back to the registered default rather than stopping
dispatch. `formatBinding` in
`features/shortcuts/format.ts` renders any `KeyBinding` for the current platform;
plugins that print their own hint (the bundled terminal does) show their registered
default because overrides are host state. Xterm is the intentional local-first
exception: before translating a keydown into PTY input, it synchronously forwards
the original event to this same dispatcher through a private DOM handoff. Eligible
app shortcuts (including live rebinds) win there; unhandled keys stay with xterm.
No plugin shortcut API or preference access is added. Ordinary editors continue
to handle keys before the window's bubbling dispatcher.

Known limitations. Capture and matching both use the logical `KeyboardEvent.key`.
On macOS an Option chord reports the composed character, so Option+K is stored
and shown as `⌥˚`, and Shift+digit chords store the punctuation (`!` rather than
`1`). This is internally consistent, so the binding fires, but it depends on the
active keyboard layout and the displayed chord can differ from the keys pressed.
The intended fix is to match Alt/Option chords on the physical `event.code` in
both the capture control and the dispatcher's `matches`, which is a coordinated
change to the plugin-facing matching rules and is deliberately not part of the
Settings page.
