# Foundation status and open gates

Maintained reference, reviewed 2026-09-09 against `95eeacc`. This is a working
trusted-plugin foundation, **not a release-readiness claim**. Keep current decisions
and acceptance gaps here; keep chronological results in the [archive](#historical-evidence).

## Implemented scope

- Host-owned session revocation and independently reachable host shutdown. Channels
  owns its page/navigation/layout under `src/bundled/channels`; reusable conversation
  components live in `src/features/messages` ([ownership](channels.md#reusing-conversation-ui)).
- Explicit public development-identity pin and typed secure relay origins. Live
  development uses the opt-in broker. Native macOS, Windows and Linux have
  [packaged identity, admission and relay access](identity.md). Installed-app
  acceptance remains open, including the Windows/Linux secure-store and transport
  paths.
- React lifecycle repair, current-DOM scroll metrics and a checked-in Chromium/WebKit
  scrolling gate. [Browser testing](browser-testing.md) defines exactly what it proves.

The checkpoint is recorded at `deb1d310`, typed relay URLs at `a85fda6`, and the
browser gate at `95eeacc`. Those are implementation checkpoints, not release tags.
The recorded validation used Apple Silicon macOS and synthetic isolated transports.
Wes confirmed the reported native interaction freeze fixed; that does not close
all native workflows. See the archive for exact-state results and known warnings,
and [contributing](contributing.md) for maintained commands and test organization.

## Decisions to preserve

- Keep `app/`, `plugins/`, `features/` and `bundled/`; no parallel `core/` tree.
  [Plugin architecture](plugin-architecture.md) maps ownership. Shared Rust plugin
  installation belongs in `crates/plugin-manager`; Tauri commands stay adapters.
- Host services own identity, authorization, retained data and durable delivery.
  Pages own their complete UI and local intent; panels own target content. Do not
  introduce a second connection, optimistic cache or outbox in a page plugin.
- Read revocation purges inaccessible host views and fences obsolete work; it does
  not delete pending signed intent, re-sign retries or erase trusted-plugin copies.
  [Relay queries](relay-queries.md) is the authority for these semantics and budgets.
- Session-owned views use **scope + generation**; persisted drafts/reading intent
  use stable **scope**. [Communities](communities.md) owns selection and lifetimes.
- Plugins are trusted same-process code, not sandboxed. Host cancellation must be
  reachable despite hung async cleanup; replacement still waits for actual cleanup.
  Synchronous blocking requires restart/safe mode. One shared React runtime remains.
- Bundled source is an authoring example, not a versioned external SDK. Promote UI
  reuse only for real consumers; do not copy host contracts into a hand-maintained SDK.
- Preserve the public-key pin, Keychain match, destination capture and broker
  same-origin guards. Trusted-app-origin intent is not a human gesture. Arbitrary
  HTTPS destinations may be private/internal; no public-only or DNS-rebinding claim.
- Changes to `FOUNDATION` files need explicit human guidance ([AGENTS.md](../AGENTS.md)).
  Native identity, network policy and author contracts are separately guided product
  work, not incidental cleanup. Trace returned-value consumers and exercise actual
  React mount/StrictMode/unmount when changing service lifecycle contracts.

## Open acceptance and product gates

| Gate | What is still needed |
| --- | --- |
| Native lifecycle acceptance | Agree app-data **and keyring** isolation, then exercise actual CLI install/update → running-app observation, on-disk rollback/backup, disable/recovery/safe mode and process restart. Browser fixture storage is not native IPC/filesystem evidence. |
| Native identity and networking | External plugins can declare exact commands and HTTPS origins for bounded native calls. Packaged real-data acceptance and per-user login/session behavior remain open. Hosted communities' Builderlab sign-in and identity binding are broker-only and unavailable in packaged builds. The declarations are disclosure, not plugin isolation; private keys stay outside plugin JavaScript. Do not widen CSP to unrestricted networking. |
| Supported author contract | The conversation preview adds generated type-only `@buzz/author`, scaffold consumption and external Composer/Message reuse. Final validation, archived cross-host compatibility and native acceptance remain open; no stable SDK promise. |
| Independent plugin acceptance | Independently build a real-data page and a non-GitHub panel without private host imports, copied contracts or bespoke host patches. In a packaged app: install disabled → enable/use → A/B switching → update/remount → disable → rollback → failed-start recovery. Include revocation, unknown/rejected writes and stalled cleanup. |
| Distribution | PR CI is wired in `.github/workflows/ci.yml`; decide release signing, updating, provenance and compatibility support. Record packaged artifacts and platform-specific results. Native test targets at the recorded gate contain zero cases; compilation is not GUI acceptance. |
| Performance and interaction | Measure cold/warm delivery stages, many-view/community retention, repeated mount/switch cycles and long-soak behavior on target devices. Browser timing/heap samples are diagnostics, not universal performance promises. Keyboard, touch and native WebView acceptance remain outside the wheel-scrolling gate. |

Before any native test launch, agree app name, purpose, open/close activity and
input automation. Isolated app data alone does not isolate credentials. No real
identity access, live writes or real membership revocation as test setup without
consent. Owner review decides expansion; this checklist does not authorize it.

## Known limits and deferred choices

- Thread windows open newest-first on supporting relays, capped at ten pages of
  50. Legacy fallback still traverses oldest-first and cannot guarantee the newest
  tail in long threads. Empty unsigned probes stay unavailable rather than imply
  exhaustion. [Thread behavior](channels.md#viewing-threads).

- Cold/oversized geometry may restore an offset while shifting the message being
  read. Exact cold message anchors need a separate product change; see
  [the measured limitation](browser-testing.md#known-reading-position-limitation).
- Opened community sessions persist until disposal; there is no aggregate session
  cap/eviction policy. Individually bounded views do not establish an aggregate
  memory budget. All restored journal signatures still gate the first send;
  multiple windows writing one outbox partition need an explicit coordination model.
- `observe()` is bounded retained evidence, not replacement-snapshot or ranked-query
  caching. Define domain freshness/removal semantics rather than adding a query DSL.
- A conventional HTTP query cache (for example, a GitHub-detail TanStack Query pilot)
  may help when shared caching is needed; do not layer it over every relay read.
  Workers, subscription indexes or a collection/query engine need measured demand
  and a bounded prototype preserving relay authorization and durable unknown outcomes.
- No sandbox/marketplace, universal UI SDK, agent API, broad community administration
  or speculative query-engine rewrite is included. Existing feature omissions and
  budgets remain in [Channels](channels.md) and [communities](communities.md).

## Historical evidence

- [Query and delivery review, 2026-09-07](archive/foundation-review.md): reproduced
  delivery/hydration defects, local measurements and library/API recommendations.
- [Hardening plan and execution journal, 2026-09-08–09](archive/hardening-plan.md):
  authorizations, sequencing and successive checkpoint handoffs.
- [Validation journal, 2026-09-08–09](archive/hardening-validation.md): exact-state
  checks, regressions, browser acceptance, owner confirmation and evidence paths.

The journals are historical evidence, not parallel current task lists. Later
entries supersede earlier status within them; their local artifact paths may not
exist on another contributor's machine.
