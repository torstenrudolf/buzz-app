# Client and community ownership

The app opens into Personal space with no joined community. The shell, local
profile editor, Home, Settings and plugin management do not wait for a relay.
`features/communities/service.ts` owns the local identity's default profile,
saved memberships and optional selection. `features/relay/session.ts` still owns
each community's queries, live subscriptions, projections and durable outbox.

## Try it

Configure `BUZZ_DEV_VIEWER` with your existing Buzz public key in `.env.local`
([setup and safety notes](../README.md#relay-channels)), then run
`just web` and open the Local URL it prints, or use `just desktop` instead. The
development broker runs on macOS and Linux and refuses an OS-store identity
that does not match your explicit public pin.
Click the avatar → **Settings → Profile**. With a community selected in the left
rail, Save updates only your profile in that community; there is no separate
profile-destination selector. In Personal space, Save edits the local default for
new communities without publishing. Use **Add a community** in the left rail and
type a **Relay URL**. There
is no destination dropdown. Accepts `wss://` or `https://` origins, for example
`wss://relay.example.com` or `wss://other.example.com`, and other
Buzz-compatible community relays. No community is pre-joined.

Surrounding whitespace, host case, a final DNS dot, default port 443 and a single
root slash normalize to the same HTTPS origin. Non-default ports are preserved.
Credentials, insecure schemes, non-root paths, query and fragment are rejected,
not silently stripped. Continue starts discovery and authenticated profile reads;
typing does not contact a relay. The canonical origin stays visible before policy
acceptance or profile publication. Failed setup keeps the typed input and current
selection. Reopening the same canonical origin does not duplicate its membership.

An existing readable profile is offered unchanged: **Open community** saves the
membership locally without publishing. New setup shows the relay's join policy,
optional invite code, then a profile prefilled from the local default. Invite
admission uses the relay's policy receipt and signed claim endpoints. Profile
publication uses a signed kind:0 event and requires a matching accepted receipt
and current profile readback before the client saves the completed membership.
Rejected setup retains input and does not replace the currently selected community.
An admitted invite is a remote side effect and is not undone if later profile
setup fails or is cancelled.

Profile editing preserves existing fields that this editor does not expose.
After a confirmed Settings save, the profile also becomes the device-local
default used in Personal space and new-community setup; other existing community
profiles are not changed. Media under the current community's `/media/` path is
not copied into that default:
its previous picture is kept, while public URLs and explicit removal still update
it. First-join seeding follows the same rule. URLs hosted by another community and
URLs entered in Personal space are not classified by this guard; user-supplied HTTPS
URLs are not guaranteed portable. The top-right button and menu show the selected
community's name and avatar through its existing profile/media session. Pending
or unavailable community profiles show an identity fallback, not another
community's avatar. Personal space uses the local default. Merely loading a
community profile does not replace that local default. The first completed community setup seeds
the local default only when it is still empty.
The shared avatar editor supports image upload/drop, HTTPS URLs, emoji artwork
and removal. Done changes the form draft; Save applies it. Uploads use the selected
community's existing media transport. Personal space accepts a public HTTPS URL
without uploading. A protected media URL from one community is not a portable
public avatar for another. Switching communities retires the editor: a save not
yet dispatched is cancelled, while an already dispatched save remains bound to
its original community and cannot alter the next community's draft. Settings Save
re-reads the effective name/picture/description after the accepted receipt; a failed read or
conflicting current profile retains the draft for explicit Save retry instead of
reporting success. This confirmation is not a transaction against other clients.

Use the persistent left community rail to select a saved community or Personal
space. Personal space
clears selection without forgetting memberships. The rail’s Add control opens the
existing join dialog; displaying saved communities reads relay metadata but does not open sessions for them. Messages shows an intentional
empty state there. Try drafting in A, switching to B, then returning to A.
Selected channels, drafts and reading offsets are partitioned by the canonical
community origin and viewer; channel IDs alone are not sufficient keys.

## Session lifetime

Selecting a saved membership lazily acquires its session. Sessions survive page
navigation and switching; startup opens only the selected one. Opened communities
retain their existing per-session query/cache budgets. Arbitrary destinations mean
there is **no longer a two-session maximum**: retained session count grows with
communities opened until app disposal. This slice does not add background eviction
or change in-flight delivery ownership. A failed session remains retryable without
replacing the shell or its siblings.
App disposal closes all owned contexts and their subscriptions.

The `ctx.relay` compatibility reader follows selection. A component captures a
concrete session for reads and commands. Every broker request, including signing,
publishing, media and live traffic, uses that session's destination path. A send
started in A continues in A even after B becomes selected. Connection generations
still fence obsolete work within a session; they are not persistent storage keys.
Channel-head persistence now includes community origin as well as viewer, rather
than relying solely on the relay signing key. In development broker mode signing keys never enter browser
JavaScript; local preferences contain the public viewer ID only. The app-owned
[native identity UI](identity.md) has deliberate import/reveal/copy interactions,
not a plugin key service.

Packaged builds do not include the broker. Native macOS, Windows and Linux
[identity import/create](identity.md) and the shared native relay adapter provide
discovery, admission, profile publication, authenticated reads and supported event
writes. Native invite minting and relay-advertised KLIPY GIF search use the same
captured HTTPS community; neither requires the development broker. Windows/Linux
installed-app acceptance remains unverified. Community creation/removal and
background connection eviction are not implemented. Native agent enrollment has
its own [local control contract](agent-control.md). Avatar uploads still require
the development media host. Agents have local
configuration plus separately scoped participation; selecting a community must
not become a deployment or enrollment command.

## Packaged admission and recovery

The native dialog journals an unfinished join before policy/claim dispatch and a
submitted profile before publication. Records are partitioned by public viewer
and canonical HTTPS origin, independent of configured aliases. Existing alias
records normalize to origins when their mapping is available and are persisted
on the next journal write. Unresolved legacy aliases are retained independently:
they do not block other joins or recovery, and become available again after
restoring their original mapping. Records contain only a transaction ID,
destination and optional profile draft, never invite codes, policy receipts or
private keys.
Storage failure blocks the remote operation. Completing a native join requires
successful local membership persistence before clearing its recovery record.

After closing or restarting, open **Add a community** to resume the most recent
unfinished destination. Continue makes a fresh authenticated profile read, with
strong consistency. Successful access resumes profile setup even if the profile
does not exist yet; it never requires reusing an expired invite after admission.
Network failure retains the record for retry. Confirmed access denial returns to
the policy/invite step, where the user can supply a valid code and current consent.
Profile readback avoids repeating a publication whose receipt was lost. An accepted
publication also requires a fresh matching profile read before saving membership
and clearing the journal. Failed reads, missing profiles and superseded writes
retain the submitted draft for explicit retry, including after restart. Late
completions cannot advance an unmounted dialog or a replaced transaction.

Saved memberships are restored through the existing session owner. Uncertain
message delivery stays in the existing endpoint/viewer-scoped IndexedDB outbox,
with no automatic resend on restart. See the [native transport limits](identity.md#packaged-connection).

## Development broker boundary

One parser in `features/communities/destination.ts` serves UI, membership hydration
and broker routing. Optional `BUZZ_COMMUNITY_ALIASES` JSON configuration maps
previously saved short IDs to secure origins; no aliases ship by default. Set the
same alias-to-origin mappings in ignored `.env.local` to reopen memberships that
use short IDs. Unknown but valid aliases are retained in local storage without
being shown or connected; profile edits preserve their saved selection. An explicit
Personal selection or a new join replaces that selection, not the retained membership.
Restore the original configuration and restart to make those memberships available
again. Never remap an existing alias to another community. With no configured alias, new community IDs
are canonical HTTPS origins. Existing origin + viewer storage
keys for drafts, reading state and outbox do not change. Saved aliases and URL
variants deduplicate; malformed saved destinations are ignored independently.

Before contacting a new origin, the client makes a same-origin POST to
`/api/relay/register`. Registration validates and remembers the origin in the
broker process, with **no upstream request, join or signature**. Scoped routes
only resolve registered destinations (configured aliases remain available for
old callers). `BUZZ_RELAY_URL` optionally supplies the unscoped broker destination;
without it unscoped relay operations fail explicitly. `/api/relay/identity` stays
available independently. These settings do not join/select a community or send a
request on startup. Both are public routing values, not credentials; alias mappings
are embedded in the frontend. Restart/rebuild after changing them. Environment
variables override `.env.local`; see `.env.example`. As a separate opt-in,
`BUZZ_DEV_OPEN_RELAY=1` makes a live dev server save and select the canonical
`BUZZ_RELAY_URL` origin for a viewer whose local client record is absent, labeled
with the relay host. Only `1` enables it and it requires `BUZZ_RELAY_URL`; any
saved record, including Personal space, wins; switching in the UI never writes
configuration; production builds ignore it. Session acquisition/retry registers again, including startup of a
saved custom community after broker restart. Query/sign/publish, policy/claim,
owner/admin invite minting and member changes (`invite`, `member`; scoped only,
relay-enforced, used by the bundled `buzz.moderation` plugin), metadata, protected
media and live traffic stay bound to the captured destination.
HTTP authority discovery and other upstream fetches reject redirects.

The broker keeps its loopback Host check, requires exact local Origin on POSTs,
and rejects mismatched Origin or non-same-origin Fetch Metadata on GETs too.
This establishes **trusted-app-origin intent, not a human gesture**; same-origin
plugins and local processes remain trusted, not sandboxed. User-directed HTTPS
networking may reach internal/private destinations. This is not a public-only
network policy or DNS-rebinding defense; TLS verification remains enabled.
This broker integration does not expose private keys to JavaScript or widen CSP.
The separate [native identity adapter](identity.md) deliberately exports keys for
backup; same-origin plugin JavaScript is trusted and can invoke that IPC too.

## Verification

`src/features/communities/service.test.ts` covers no-community initialization,
local profiles, scoped view intent, session retention and selective restoration.
`broker.test.ts` runs real localhost HTTP with signed fixture events to verify
multi-community routing, profile publication, invite claims, and a captured send
after opening another community. `destination.test.ts` checks normalization and
rejection; `broker-url.test.ts` exercises the real middleware with isolated signing
keys and upstream fixtures, including registration, cross-origin guards, all route
sinks and captured sends. Service tests cover arbitrary membership persistence,
selected-only restore, retry registration and equivalent-URL selection. Existing relay tests cover connection generations,
late responses, delivery and revocation.

`native-join.test.tsx` mounts the real dialog, community service and native adapter
with fixture IPC to cover claim/profile response loss, acknowledged but superseded
or missing profiles, read and persistence failures, interrupted setup, alias
recovery and selected-only restart. `join-journal.test.ts` covers alias addition,
removal and unresolved legacy records across restarts. `native-api.test.ts`
and `relay/native.test.ts` cover routing, verification, live auth, capacity,
receipt correlation and expired-event readback. `app/services.test.ts` exercises
native composition, failure/retry and development precedence. Rust tests cover
actual IPC signing, exact-byte HTTP authentication and redirect rejection without
touching Keychain.

One browser case is added, with none removed: `tests/browser/mocked-native-ipc.spec.mjs`
proves page reload and real localStorage/IndexedDB recovery in Chromium and WebKit.
It preserves one identity across an uncertain claim, joins, loses a message
receipt, reloads, then explicitly retries the identical signed message. The IPC
endpoint is mocked by Playwright; it does not establish Keychain consent, a full native
process restart, production TLS, deployed relay interoperability or notarized
release acceptance.

The paired `tests/fixtures/mocked-native-ipc.html` and `.tsx` files mount the real
community dialog, identity/community services and JavaScript native transport
adapter. Playwright supplies the identity, signing and HTTP responses and stubs
WebSocket; browser storage and reload are real. The page requires the test's IPC
endpoint, so it is not a standalone manual diagnostic.

This regression fixture originated in `78d986c0`, independently of the recording
toolkit added in `f68926da` and removed in `0a9ff77f`. It remains automated test
coverage, not a native-app recording. Any retained local recordings from that
removed toolkit used a simulated host; their source revision must be established
from capture metadata, not the gallery's hard-coded revision label.

Regression evidence: restoring the original unfiltered signing payload makes
both browser engines fail at message delivery (`failed` instead of `unknown`),
because the IPC fixture enforces Rust's strict template shape. Restoring the
four-field projection passes the journey.

Run it with:

```sh
bin/pnpm test:browser tests/browser/mocked-native-ipc.spec.mjs --project chromium --project webkit --no-deps
```

Open `/tests/fixtures/communities.html` for a browser-only fixture of the actual dialog.
It intercepts all broker requests and uses a separate fixture identity. Save a
local profile, join using any invite code, and customize the prefilled name. The
first profile publication deliberately fails; retrying should add the membership
while keeping the local name unchanged. No remote membership, profile, or policy
acceptance is created by this fixture. Live validation with an authorized identity can restore existing profiles and
read selected communities without posting test messages. The fixture itself is
not evidence of live access; see [manual fixture setup](contributing.md#manual-browser-fixtures).
