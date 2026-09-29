# Desktop test releases

The **Desktop previews** workflow builds and signs Apple Silicon test builds from
`main`. It publishes a DMG, a signed updater archive with its `.sig`, and
`SHA256SUMS` as a GitHub prerelease, tagged
`v<app-version>-preview.<run-number>.<attempt>` at the built commit.

Runs are scheduled at **00:17, 06:17, 12:17, and 18:17 UTC**. To start one manually:

```sh
gh workflow run release.yml --repo block/buzz-app --ref main
```

These builds use `macos-latest` and the repository's pinned toolchain. The
workflow publishes an Apple-signed/notarized DMG and a separately Tauri-signed
updater `.app.tar.gz` and `.sig` for Apple Silicon. The updater archive is
rebuilt from the verified app in the signed DMG; built-in Tauri artifact
creation remains disabled because this DMG-only build does not emit an updater
archive. The release automatically promotes each eligible build to the rolling preview
feed after the signed prerelease is published and the promotion gate passes.
This includes scheduled runs and manual builds without `promote_version`.
An updater-less artifact, invalid signature, or rollback leaves the existing feed
unchanged, but the promotion job fails and needs investigation. The workflow
does **not** publish to the legacy `block/buzz` updater. Older installed apps
cannot use the feed until an updater-enabled build is installed. Preview builds
are built with the updater enabled and check the preview endpoint below.

## macOS preview updater feed (automatic promotion, manual recovery)

The preview endpoint is `https://github.com/block/buzz-app/releases/download/preview-feed/latest.json`.
This is a dedicated rolling prerelease in `block/buzz-app`, separate from legacy
`block/buzz`'s `buzz-desktop-latest`. Reserve `stable-feed/latest.json` in this
repository for a future production channel; this workflow never creates it.
Neither endpoint is `releases/latest`: versioned builds are prereleases.

**Auto-promotion begins as soon as this workflow lands on `main`.** Install an
updater-enabled DMG manually first (older installed builds lack the updater),
and verify its embedded public key and preview endpoint match the release
configuration. The job checks those values in each candidate binary before
advertising it, but it cannot validate a live Apple-signed old→new install
before publishing. For manual recovery or a controlled repromotion, dispatch
an existing version from `main`:

```sh
gh workflow run release.yml --repo block/buzz-app --ref main \
  -f promote_version=0.0.0-preview.<run>.<attempt>
```

After the first eligible build publishes, exercise discovery, signature
verification, download, install, relaunch/version, and absent-feed and
mismatched-key handling on disposable clients before expanding preview
distribution. There is no safe way to perform a live old→new check against
the fixed URL without first exposing a candidate to clients already pointed
there. Restrict distribution until that check succeeds.
The release build must embed the same pinned public key and preview endpoint as
#312; promotion verifies both in the candidate executable. Builds made before
that integration are ineligible even if their updater archive and signature
exist. The promotion gate downloads the archive and signature, verifies the
Minisign archive and trusted-comment signatures against the client's pinned
key. CLI 2.11.x signs the archive and trusted comment but does not embed an
authenticated version. The gate accepts that format and verifies both
signatures, but cannot bind the advertised feed version to those signed bytes.
A feed-response attacker can replay an older authentic archive/signature under
a higher advertised version. Preview distribution must accept that residual
risk until a coordinated CLI/updater 2.12.x bump emits `version:` and enables
`requireSignedVersion`, then require the same version at promotion. Do not enable
the client flag alone: 2.11.x signatures would fail. A signature mismatch
fails before the rolling manifest is replaced.

The job builds the `darwin-aarch64` Tauri manifest with the signature from that
release and an immutable versioned asset URL, refuses full-SemVer rollback and
changed same-version metadata, and replaces the rolling manifest last. The
archive and signature remain on the versioned release. The job reads back
and compares the GitHub API asset; this is not evidence of public endpoint
availability. Confirm the endpoint in an installed client after the first
promotion. GitHub asset replacement can briefly return 404 while the old asset
is replaced. Promotion is serialized with the release workflow, and a failed
upload needs investigation before the next scheduled run.
Recover from a broken feed by promoting a higher tested build; for key loss or
client failure, distribute a manually installed Apple-signed DMG. Do not assume
rolling back a signed archive can undo an installed update.

## Prerequisites

Deploy [the signing infrastructure](https://github.com/squareup/tf-mobuild-workers/pull/1398)
and set these repository Actions secrets:

- `OSX_CODESIGN_ROLE`: ARN of `block-buzz-app-codesign-role`.
- `CODESIGN_S3_BUCKET`: `block-buzz-app-artifacts-bucket-<environment>`.
- `TAURI_SIGNING_PRIVATE_KEY`: persistent Tauri updater private key (not the
  Apple Developer ID signing identity). Restrict access to release CI and back
  it up outside Actions; losing it prevents old updater-enabled builds from
  trusting new releases.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password for that key.

Keep the matching updater public key in updater-enabled app builds. Rotate only
with a planned transition/recovery path (a manually installed signed DMG if
necessary); changing the key alone strands existing installations. Do not
publish a preview `latest.json` until its archive and signature are available
at stable HTTPS URLs. Verify old-build → new-build installation promptly after
the first eligible auto-promotion, before wider preview distribution.

The manifest records hashes before signing. Packaged macOS apps accept changed
hashes only after verifying their enclosing app's resource seal and Block Developer
ID signature. The app retains the signed files' hashes in memory and checks them
before each launch. Development builds and other platforms still require the
manifest hashes to match. The release workflow verifies the signed seal,
notarization, and manifest identity before publishing.

## Windows and Linux installer candidates

The same **Desktop previews** workflow has a manual `candidates` switch. It builds
unsigned Windows x64 NSIS `.exe` and Ubuntu 24.04 x64 `.deb`/AppImage artifacts,
without running macOS signing or the release publisher:

```sh
gh workflow run release.yml --repo block/buzz-app \
  --ref <candidate-branch> -f candidates=true
```

Scheduled runs and dispatches without this switch retain the existing macOS
publication path. Candidates use the same preview version, source commit, pinned
runtime revision and five-tool manifest; they never use legacy Buzz's sidecars,
updater feed, application identifier, or signing secrets. The workflow records
`SOURCE_COMMIT` and checksums over final installer bytes. Download the
`windows-x64-candidate` and `linux-x64-candidates` artifacts from that Actions run
within seven days. These are **ready to try only after their build and payload
checks pass**, not accepted releases.

Windows uses the repository's Rust, Node and pnpm pins on the hosted MSVC runner
because Hermit does not run there. NSIS retains Tauri's current-user install and
WebView2 download-bootstrapper defaults (network needed if WebView2 is absent).
The job silently installs into a disposable runner directory and verifies the
installed runtime manifest and each tool's hash, without launching the app.

Linux reuses old Buzz's Ubuntu 24.04 recipe and guarded Wayland/GStreamer AppImage
repair from `block/buzz` tag `desktop-v0.5.25`. Repacking tools and the type2 runtime
are checksum-pinned. Resource binaries must retain their manifest hashes; the
repair restores the verified original tools after linuxdeploy rewrites ELF RPATHs,
then the workflow verifies both extracted package payloads after repacking.
Compatibility guards fail rather than silently omitting a fix.
AppImage still relies on host desktop/media libraries; this is not a promise of
universal distro compatibility. Neither candidate job writes shared build caches.

### Acceptance still required

Use disposable Windows 11 and Ubuntu 24.04 GNOME accounts with throwaway keys.
Do not replace an everyday machine's `buzz://` handler without agreement.

1. Install and launch without a developer toolchain; respect Windows security
   policy for unsigned apps. Linux needs a working Secret Service desktop session.
2. Create/import identity, quit and relaunch with the same key. Check unavailable
   storage fails safely. Join the intended community, send/receive and reconnect.
3. Check cold/warm `buzz://` links, install a newer preview over the previous one,
   verify identity/settings survive, and record uninstall/retained-data behavior.
4. Have a human repeat install → messaging → restart before accepting the build.

Two Windows native failures were last observed at `a68b39d6` (legacy-import path
separator assertion and model-auth recovery). Re-run the existing manual Windows
CI lane on the candidate and diagnose any surviving failures separately from
installer success. The packaging jobs do not waive them or enable local-agent
hosting. Builderlab/NIP-FI admission remains a separate product limitation.
There is no Windows/Linux publication or auto-update in this first candidate
slice; accepted artifact publication follows native acceptance.
