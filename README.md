# Buzz Foundation

Shared React frontend for web and Tauri desktop, with bundled page plugins and
local desktop plugins managed by `buzzodz`. Channels reads the relay through a
shared data service; the GitHub plugin adds rich reference panels to channels.

## Run

Hermit pins just, Node.js 24, pnpm 11.8.0, and Rust in `bin/`; no global tool
installation is needed. From the repository root, activate the pinned environment:

```sh
source bin/activate-hermit
just web
just desktop
```

Or run `bin/just web` / `bin/just desktop` without activation. Tools download from
public Hermit sources. Dependencies use npm's public registry by default; local
registry and CA settings remain in effect. Desktop
builds still require the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
See [contributing](docs/contributing.md) for exact pins, registry settings,
and the pinned pnpm package's Intel Mac limitation.

Both commands forward arguments to their development tool (Vite or Tauri).
The default port is derived from the worktree's path, giving each checkout a
stable default that normally avoids collisions between parallel worktrees;
`just desktop` prints the URL it chose. Override it with `just web --port 1431`
or `just desktop --port 1432`. Browser servers prefer the requested port and
use the next open port automatically; desktop requires the exact port to be free and keeps
Vite and the native window on the same URL. Use an explicit port if two paths
collide, another process occupies the default, or you start a second instance
from the same checkout:

```sh
just desktop
# A second instance from the same checkout:
just desktop --port 1431
```

Ports do not isolate account credentials or native plugin data. For separate
plugin profiles, use the existing `BUZZODZ_PROFILE` setting described below.
Without live opt-in they run the shell without relay identity access.
`just iterate` applies formatting and runs fast checks plus the frontend build.
`just scan` adds tests and native checks. [PR CI](.github/workflows/ci.yml) runs
those checks in cached, parallel jobs with sharded browser journeys.
Install the fast staged-file pre-commit and related-test pre-push hooks once per worktree with
`bin/pnpm hooks:install`; see [hook behavior and partial staging](docs/contributing.md#git-hooks).

### Design system

Run `just design` (or `bin/just design` without activation) to install locked
dependencies, start the standalone design-system viewer, and open it in your
browser. It uses port 1442 and does not start the desktop app or live relay broker.
If that port is occupied, choose another with `just design --port 1444`.
Press Ctrl+C to stop the server.

### OS deep links

Desktop builds register `buzz://` with the OS, the scheme in-app links already use, so
opening a `buzz://message?channel=…&id=…`, `buzz://channel/<id>`, or
`buzz://channel/<id>/<event>`, or a repository/project/PR/issue link outside the
app focuses it and opens that destination, on a cold start too. Entity Git browsing
uses the authenticated development broker; packaged Git transport remains unavailable. Development,
bundled, and released builds all use `buzz://` and compete for its OS handler.
macOS only routes a scheme to a bundled app, so test there with
`just desktop-bundle`; Windows and Linux
dev builds register themselves at launch. See [OS deep links](docs/deep-links.md) for
per-platform steps and limits.

## Relay channels

Live development currently requires **an existing Buzz account in the OS credential
store**: the `buzz-desktop` / `secrets` Keychain entry on macOS, or the same entry in
the freedesktop secret service on Linux (read with libsecret's `secret-tool`, so
install `libsecret-tools` and run inside an unlocked desktop session). This development broker is not native
sign-in and is not included in packaged builds. `just web` and `just desktop` run
it automatically once `BUZZ_DEV_VIEWER` is configured; without that pin they start
in the non-live shell/fixture state.

1. Copy your existing Buzz account's **public key** (npub or 64-character hex).
2. Add it to the git-ignored `.env.local` at this repository's root. The optional
   relay settings below are examples only; replace them with your community's origin:
   ```dotenv
   BUZZ_DEV_VIEWER=npub1YOUR_PUBLIC_KEY
   # Optional default for unscoped development-broker requests:
   BUZZ_RELAY_URL=wss://relay.example.com
   # Optional: on a fresh dev port, save and select BUZZ_RELAY_URL as a community.
   BUZZ_DEV_OPEN_RELAY=1
   # Optional compatibility map for memberships saved with short aliases:
   BUZZ_COMMUNITY_ALIASES='{"example":"wss://relay.example.com"}'
   ```
   Never put an nsec/private key in this file. The public pin explicitly authorizes
   the account to use; it does not import or change a key. Relay URLs and aliases
   are public configuration, not secrets. With both relay settings unset, there is
   no default relay or alias map; Personal space and communities saved by canonical
   URL remain usable. Configuration does not automatically join a community:
   `BUZZ_DEV_OPEN_RELAY=1` only saves and selects the default relay locally on a
   dev port whose saved choice is absent. It does not implicitly join a community,
   accept an invite, or publish a profile. Normal session traffic and presence still
   apply.
3. Start a development target:
   ```sh
   just web
   # Or, instead of web:
   just desktop
   ```

   Open the Local URL printed by `just web`. Each worktree derives a stable
   default port from its path, but two paths can still collide. If the default
   is busy, use `just desktop --port 1431` (or another free port) instead of
   stopping the other copy.

The broker reads the existing Keychain credential only after validating the
public pin, refuses mismatches and never falls back to another credential. If it
reports a mismatch, check which account your existing Buzz installation uses;
do not delete or replace its Keychain entry. Environment variables override
`.env.local`. Restart the dev server after changing the configuration. Without
an existing supported credential, live development is unavailable; shell and
fixture tests still work.

Media attachments in live development need `ffmpeg` on the server’s PATH for
video, HEIC/HEIF, and the existing `voice-note-*.wav` exception (macOS:
`brew install ffmpeg`; Linux: your distribution’s ffmpeg package). The broker
prepares canonical H.264/AAC MP4 or single-frame JPEG before upload hashes/signs
those exact bytes. Missing tools and unsupported codecs fail visibly. No generic
audio conversion or recording UI is added.

JPEG/PNG/WebP cleanup preserves orientation and alpha; GIF/APNG/WebP structural
cleanup preserves animation. Animated images requiring ICC or EXIF orientation
transforms reject rather than silently change appearance. Snapshot PNG manifests
survive cleanup. A lazy, cancellable lossless WebP encoder covers still-image pixel
cleanup on WebKit, which lacks a canvas WebP encoder.

Final-file defaults match old Buzz: 50 MiB images, 10 MiB GIFs, 100 MiB generic
files, 500 MiB videos. The relay remains authoritative and can enforce lower
limits, 25-million-pixel images, and video codec/duration/resolution constraints.
The client separately bounds source files at 500 MiB (voice notes: 128 MiB), ten
files per draft, and 1,000 MiB retained sources per session. These source/batch
safety budgets are not old-relay final-byte limits. Preparation can grow or shrink
files. Browser Blobs still retain complete prepared payloads; only the broker's
transfer buffers are streaming. Private spool files and conversion children are
request-owned, cancelled on disconnect and cleaned before admission is released.

Picker/paste/drop share the same tab-local draft. Files must finish uploading
before Send; navigation pauses unfinished uploads for explicit Retry. Reload loses
unsent files. Background Send, attachment-first new sessions and UX polish are
separate work. Live uploads use the development broker in dev runs and the
native `relay_upload` path in packaged desktop builds. Packaged HEIC and non-MP4
video files are not converted by the broker and may be rejected by the relay.

The broker supports reads, live traffic and basic message sending **as your real
account**. Profile changes and invite admission can also write to real communities.
Use **Switch community → Add a community** and type the community's `wss://` or
`https://` relay origin (no path, credentials, query or fragment). For example,
`wss://relay.example.com` and `https://relay.example.com` identify the same relay
origin. Continue contacts that destination using your
identity; joining or publishing a profile is a later explicit step. Then open
Messages, choose a channel, and click a GitHub reference. See
[the channel extension contract and data budgets](docs/channels.md) for ownership,
performance, validation, and limitations.

Messages is the landing page. Channels is required and cannot be disabled; optional plugins such as GitHub can be toggled in Settings.

See [client and community ownership](docs/communities.md) for the minimal join/profile flow, session scopes, and switching checks.

## CLI

Run `pnpm buzzodz --help` from this repository, or install the standalone executable:

```sh
cargo install --locked --path crates/plugin-manager --bin buzzodz
buzzodz plugin init /tmp/my-page example.page "My page"
# Generate and pack the host-matched type-only preview once:
pnpm author:build
(cd dist-author && pnpm pack --pack-destination ..)
pnpm --dir /tmp/my-page add -D "$PWD/buzz-author-0.0.0-preview.1.tgz"
buzzodz plugin build /tmp/my-page
buzzodz plugin install /tmp/my-page/dist
buzzodz plugin enable example.page
buzzodz plugin list
```

The CLI prints readable results and reports errors with a nonzero exit code.
`disable`, `remove`, and
`rollback` take a plugin ID. New installs start disabled; updates preserve their
existing enabled state. `recover` backs up management settings and resets to
bundled defaults, preserving artifacts for reinstallation.

`--home ABSOLUTE_PATH` and `--profile NAME` precede `plugin`. The desktop and CLI
also read `BUZZODZ_HOME` and `BUZZODZ_PROFILE` (default: `default`). Match these to
target the same instance. Otherwise, profiles live under the OS application-data
directory in `dev.local.buzz.foundation/profiles`.

```sh
BUZZODZ_PROFILE=experiment just desktop
buzzodz --profile experiment plugin list
```

`BUZZODZ_SAFE_MODE=1 just desktop` opens the shell without external pages.
Bundled pages work on web; their enabled settings are stored in that browser.
Folder and Git/GitHub loading is available in **desktop Settings → Plugins**.
Choose a folder, or enter an HTTPS/SSH repository URL and optional branch/tag;
then select a built plugin subfolder and install it. New installs are disabled;
updates retain their enabled state and may run immediately. Repositories must
include built `manifest.json` + `plugin.js` artifacts—Buzz never runs project builds
or install scripts. See [import behavior and limits](docs/plugin-architecture.md#loading-from-folders-and-repositories).
Browser installation is not supported; the browser shows a desktop-only explanation.

## Emoji and reusable conversation UI

Emoji is independently toggleable in Settings. Its picker and custom rendering
plug into shared conversation surfaces; catalog, event tags and delivery stay
session-owned. The standard composer remains shared host UI, independent of any
example plugin. Automated tests use source-only external consumer and tool fixtures
to exercise component reuse and contribution lifecycle.

## Plugin contract

`src/bundled/channels` is a bundled example. External projects have `manifest.json`
(`id`, `name`, `apiVersion: 1`) and an entry point exporting
`apply(ctx)`. `ctx` is a Cordis context. External JSX plugins export
`inject = ["react", "pages"]` and obtain `const React = ctx.react` inside `apply`, then call
`ctx.pages.register({ id, title, component })` to contribute a page. A plugin may register
several pages or none. Page IDs are unique within their plugin. Buzz supplies React
and owns the Cordis runtime (`@deepseek-ai/cordis` 4.0.2). Import their types only
in external plugins; runtime imports are rejected by the scaffold's builder.

The scaffold uses classic JSX, so normal JSX compiles against the local `React`
variable. Components in other files can be created by a factory receiving that
same React instance. Automatic `react/jsx-runtime` imports are not supported by
the current standalone module format. Older plugins using `apply(ctx, host)` must
switch to the React injectable and rebuild.

Module evaluation must be pure. Enabled plugins activate even when their page is
not selected. Register plugin resources with `ctx.effect(() => cleanup)`; these
are disposed on disable, replacement, or app teardown. React effects belong to
the visible page and clean up when navigating away. Plugin activation must finish
within ten seconds, including waiting for required services. Losing a required
service hides the plugin's pages while Cordis waits and reactivates it; each
reactivation has a fresh ten-second deadline. Failed activation is shown in Settings;
disable/enable or install a new revision to retry. Replacement waits for prior
cleanup; if cleanup stalls, restart before that plugin can activate again.

The CLI scaffolds `src/index.tsx`, a standard `vite.config.ts`, and a `pnpm build`
script that type-checks and bundles the page. `buzzodz plugin build` runs that
script; Node/pnpm are only needed for authoring, not installing or loading pages.

API v1 distributes one self-contained JavaScript module; use inline styles or
existing host classes. Separate CSS/assets are not supported. Type-check an
external source project with `pnpm exec tsc` in that directory.

The host owns navigation, Settings, loading errors, and render error boundaries.
Settings controls and CLI management do not depend on plugin activation. Updates are detected while the app
is running. A selected page remounts when its revision changes; its local React
state resets. Plugin-specific persistent data has no host API yet.

Plugins are trusted code executing in the app's JavaScript context. They are not
sandboxed: infinite loops, global changes, and external side effects cannot be
contained or rolled back by a React error boundary. Restart selects the bundled page, but enabled external plugins still activate.
Use `BUZZODZ_SAFE_MODE=1` to pause external plugins for a launch if startup freezes.
This leaves the profile’s saved enabled settings unchanged. The CLI remains usable if the UI
freezes. Loaded JavaScript module revisions remain in memory until restart.

See [foundation status and open gates](docs/status.md) for maintained decisions,
remaining acceptance work and historical evidence.

## Code entry points

- `src/main.tsx` → `src/app/App.tsx`: startup and app shell
- `src/plugins/api.ts` and `src/features/{pages,panels}/service.ts`: plugin contracts
- `src/plugins/runtime.ts`: Cordis activation and disposal
- `src/plugins/storage.ts`: web/desktop storage adapter
- `crates/plugin-manager`: shared Rust manager and `buzzodz`
- `src-tauri/src/lib.rs`: desktop commands delegating to that manager

The app composes core services once in `src/app/services.ts` and passes the page
reader directly to the React shell. Cordis owns plugin dependencies and effects;
React owns rendering, subscriptions, and page selection. The shell is ordinary
app UI and remains available when no plugins are active.

`src/features/pages` owns page registration, activation filtering, and rendering.
It observes plugin status through a Cordis service; it does not import app wiring.
`src/plugins` owns installation and executable lifetimes, including the adapter
from Cordis state changes to observable plugin status. Bundled features use the
same registration contract as external plugins. Target-based panels provide a second extension point alongside pages; both use the same
contribution ownership and readiness implementation.

Release signing, updating, and distribution are not configured. To exercise a
local macOS bundle with embedded frontend assets: `pnpm tauri build --debug --bundles app`.

### Agents compatibility preview

In live development mode, Agents reads the **installed Buzz** library on this
machine (`~/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json`
on macOS, `$XDG_DATA_HOME/xyz.block.buzz.app/agents/managed-agents.json` on Linux,
defaulting to `~/.local/share`) without changing it. The separate Buzz development-build library is not merged.
It shows selected definitions and linked public identities; Refresh reads changes
made in Buzz. No creation, configuration, migration, member addition or runtime
controls are included. Keep Buzz running for existing agents to answer selected
`@` mentions in their channels and threads. See [scope and manual checks](docs/agents.md).

## Project resources

- [Contextual identity names: cross-client spec and fixtures](src/bundled/identity-naming/README.md)
- [Mention rules: cross-client spec and fixtures](src/bundled/mentions/README.md)
- [Contributing](docs/contributing.md)
- [Project leads](CODEOWNERS)
- [Governance](GOVERNANCE.md)
- [Apache-2.0 license](LICENSE)
- [Source attribution](NOTICE.md)
