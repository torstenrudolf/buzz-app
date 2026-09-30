# Packaged human identity and relay access

Native macOS, Windows and Linux without the live development broker offer
**Use an existing key** or **Create a new identity**. These are alternatives. Import accepts an nsec,
validates its checksum and secp256k1 scalar, and persists that exact key before
adopting its public identity. It never generates a replacement after an import,
read or write failure. Denied/unavailable/corrupt storage is not first run.

One native owner keeps the key in memory after successful restore. The new
create-only secure-storage item is service `dev.local.buzz.foundation.identity` in release
builds, or `dev.local.buzz.foundation.identity.debug` with Rust debug assertions,
account `human`. Debug worktrees share the debug item, not the release identity;
ports and frontend dev mode do not isolate it. macOS keeps its existing default
file Keychain/security-framework implementation. Windows uses Credential Manager;
Linux uses Secret Service through keyring 3.6.3, as old Buzz does. Linux requires
a running desktop Secret Service with a default collection (for example GNOME
Keyring), reachable on the user's session D-Bus. Missing, inaccessible or ambiguous
storage fails closed: unlock/configure the store and explicitly retry.

Human storage does not use or change agent credentials or old Buzz's
`buzz-desktop/secrets` blob. A competing item refuses overwrite. Windows/Linux
creates and agent deletes share a per-user, service/account file lock under the
OS account's home `.buzz-foundation/credential-locks`, independent of HOME/XDG,
profile and worktree overrides. Lock files are empty, retained, and never hold keys;
a busy lock reports a retryable error rather than waiting behind another process's
consent dialog. Locks serialize cooperating Buzz instances, not arbitrary other
programs or other machines. Windows credentials use keyring's enterprise persistence
and may roam under Windows policy; locks do not coordinate machines.
Neither Windows Credential Manager nor Secret Service supplies per-app access
isolation from other programs running as the same OS user.

There is no file/environment fallback, automatic legacy migration, human key
replacement or human delete command. The existing **explicit agent import** may
read only the selected old Buzz service/account and copy the selected agent key
into this app's separate agent namespace; it never writes the old blob. Agent
import remains macOS-only; Create also saves new agent keys through the
Windows/Linux adapters (see [local agent controls](agent-control.md)).
No user key belongs in release configuration.

A shared credential blob can reduce repeated OS prompts by caching many credentials
after one read. For this one human key, one cached item retains that read-once benefit without
coupling human writes to agent credentials or old-app blob writers. This is not a
claim that per-secret storage is always superior or that prompts are eliminated.
Consent, app signing and update behavior require attended native verification.

## UI and sensitive data

Settings exposes Profile in Personal space as well as in a selected community.
Identity details remains available if the community profile cannot load. The full
npub and hex public key can be copied. The nsec is absent from the rendered field
until Reveal; Copy can fetch it without revealing it. Hide, leaving Profile,
window blur and document hiding retire pending reveals and clear the displayed
secret. Failed private-key actions report fixed errors. Copy deliberately leaves
the key on the OS clipboard; the UI warns about that.

The app UI passes a private string through IPC only during explicit import/export
interaction. JavaScript/IPC string memory is not guaranteed zeroized. Native
key bytes and temporary storage buffers use zeroizing owners, but this is not a
claim that every framework allocation is wiped. No secret is put in public
snapshots, plugin service registrations, localStorage, logs or relay events.
The main app and its same-origin plugins are trusted, not isolated security
principals; plugin JavaScript can invoke `identity_export` directly. Not registering
a plugin key service is an API ownership choice, not a sandbox. The main-webview
command permission is not proof of a human gesture.

## Packaged connection

A public native viewer hydrates the existing public-key-scoped local profile and
memberships. On macOS, Windows and Linux, app composition supplies the shared
native relay adapter after identity restoration. Windows/Linux installed-app
transport acceptance remains unverified. Only the selected saved community opens on restart; Personal
space stays disconnected. Discovery failure leaves the community retryable.
Native sessions do **not** fall through to the dev broker signer.

The native identity owner signs event templates and authenticates HTTP with
NIP-98, including the exact request URL, method, a body hash on POST and a fresh nonce
for each attempt. Native networking permits only the discovery, join-policy, invite
acceptance/claim, query, event and bounded workflow run-history routes on HTTPS
origins, with bounded bodies, timeouts and no redirects. JavaScript never obtains the private key for transport.
NIP-11 `self` establishes relay authority; the operator-contact `pubkey` is not
a substitute. The existing live owner handles WSS/NIP-42 authentication and
signature verification. IPC permissions remain limited to the main WebView.

Channel lifecycle/details and identity archive commands, channel recipe preparation/decoding,
and opening direct messages use purpose-bound native commands. Creation kind 9007 is
advertised only when NIP-11 reports NIP-29 support. NIP-44 stays in the native
identity owner; recipe plaintext is never returned by a generic decrypt command.

Community admission, kind-0 profile reads/publication and the adapter's advertised
message/event writes use this identity. [Join recovery](communities.md#packaged-admission-and-recovery)
records public progress before remote changes. The existing durable outbox retains
uncertain delivery across restart; retry uses the same signed event with fresh HTTP
authentication. Events older than 15 minutes get a strong ID readback instead of
being republished or silently re-dated. Missing/failed readback retains uncertainty;
the user must inspect the conversation before explicitly sending a new message.

Protected media and uploads are native, because the webview cannot attach Blossom
(kind 24242) authentication itself: `<img>`, `<video>` and `<audio>` send no custom
headers, and the CSP keeps `connect-src` closed to general HTTPS. Relay `/media/`
URLs selected by shared TypeScript render through the `buzz-media` URI scheme,
which validates HTTPS and the `/media/<hash>` URL shape but does not enforce
saved-community membership; the selected server receives a short-lived token
scoped to its origin. The scheme signs a fresh 60-second `get` token per request
and forwards only a bounded single `Range`; non-image/video/audio types (and SVG)
are served with download disposition and `nosniff`. The main webview does not navigate to protected media for downloads: a narrowly scoped native command authenticates the bounded media GET, saves to the OS Downloads directory without replacing existing files, and rejects unsafe filenames. `relay_upload`
hashes, signs (`upload` + `x`) and sends the exact bytes JavaScript passes it;
shared TypeScript (`hostUpload`) owns limits, error mapping and descriptor
validation. JavaScript never signs kind 24242. HEIC and non-MP4 video conversion
remain dev-broker-only (ffmpeg), so those files upload unconverted and the relay
may reject them. Repository HTTP and other
broker-only helpers are not claimed by this adapter. NIP-FI assertion
acquisition is not implemented, so deployments enforcing it are outside acceptance.
Windows/Linux custody, credential migration and release-signing acceptance remain
separate limitations.

Development with `VITE_BUZZ_LIVE=1` continues to use its pinned legacy broker
identity, and does not offer native private-key controls. Creating/importing the
new native item does not update that old blob. Future reset/rotation would not
synchronize copies automatically; neither operation is in this scope.

## Try the UI without credentials

Use the existing environment-free fixture Vite config:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1547
```

Open `/tests/fixtures/identity.html`. It uses mock IPC and an in-memory public
fixture key, not an OS credential store or a relay. Import accepts only the
displayed fixture key. Reset and simulated restart affect fixture state only. **Never enter a real
nsec.** Browser exercises prove UI behavior, not secure native persistence.

Before real-key use or a usable-release claim: independent custody review,
isolated native consent/denial/import/create/restart checks, human UI feedback,
and installed-app live read/send/receipt/restart acceptance are still required.
Do not launch/restart someone's desktop app or inspect their credentials to test.

### Windows/Linux native acceptance (not established by the fixture)

Use a disposable **OS account/VM**, not a profile, port or HOME override: credentials
are per OS user. Use only throwaway keys, keep old Buzz closed for import handover,
and do not connect that identity to a real community for this storage check.

- On Windows and Linux with a working Secret Service/default collection, create
  or import, export the throwaway key, quit/relaunch, and confirm the same public
  identity and export. Repeat separately for debug and release builds.
- With an existing Linux key locked, dismiss the unlock request. Expect a storage
  error/retry, not first-run create/import choices; unlock and retry to restore.
  Without Secret Service, expect an error rather than key generation/fallback.
- Where two development instances can run, an occupied human/agent item must not
  be overwritten. Lock contention must be retryable; after exit, locks release.

Deferred until agent import/create is enabled on Windows/Linux: explicitly import
a throwaway old-Buzz agent, restart and verify the exact key, then delete only the
destination agent and verify the old source remains. This is not a reachable UI
acceptance step for this storage slice and does not establish Windows execution.

Attended Windows/Linux execution and human confirmation are release gates, not
claims made by cross-compilation, fake-store tests, or the browser fixture.
