# Agent memories: owner-view read capability

The development relay broker and packaged native identity host support owner-view
reads. Both capture the viewer key and community origin, use authenticated relay
admission, and return a purpose-bound listing without exposing keys or arbitrary
plaintext decryption to the renderer.

The caller supplies only an exact agent public key. The host captures the current
relay and fixes the owner to the authenticated viewer, querying kind 30174 with
`authors=[agent]`, `#p=[viewer]`. Self-profile requests are unsupported: being the
viewed agent does not identify its owner. No inventory, name, avatar shape or
profile marker grants access. Remote-owned agents need no local instance.

The relay authorizes the owner-scoped read. The host verifies each signature,
exact author/kind and single owner/d tags before NIP-44 decryption, rejects duplicate
JSON names and unpaired Unicode surrogates at every depth. An exact NIP-44
round-trip with the original nonce rejects lossy UTF-8 decoding (and noncanonical
padding) before parsing, without rejecting legitimate replacement characters.
The host validates body/slug and HMAC-derived address, selects
newest timestamp/lowest-ID heads, then drops tombstones. Unknown fields remain
compatible. Invalid records mark a partial result; they never prove empty memory.
An empty successful response means no valid records returned for this viewer in
this community, not ownership or a complete cross-relay absence claim.

Protocol reference: block/buzz `docs/nips/NIP-AE.md` at
`b7c99fb94808cf3b07bb7540121d8eb4513578dd`. No old desktop implementation or
credential loader is copied into the plugin.

## Budgets and lifetime

- 256 returned envelopes; hitting the cap marks the result potentially incomplete.
- 2 MiB streamed upstream/DTO response; 1 MiB retained decoded entry data.
- Ten-second fetch/decode deadline, plus a ten-second incoming upload deadline.
- Four mounted views per session; no periodic refresh or startup requests.
- Oversized input fails closed, not silently truncated before head selection.

A session owns each explicitly opened view; its consumer releases it on unmount.
Refresh drops the previous plaintext rather than displaying stale contents during
errors. Access purge, disconnect, cache clear and disposal clear snapshots and
abort/fence pending work. Reconnection does not automatically reload sensitive data.
For hosts with a live stream, connected live updates are an intentional revocation
fence even though the memory read uses HTTP. Reads before connection or during
reconnection/cache clearing report blocked, not a failed HTTP request. Manual
retry after recovery is required; reconnecting never reloads plaintext automatically.
Read failure, blocked admission, denied access, unsupported host/target, partial result and successful
empty remain distinct. Session copies are RAM only; trusted plugin copies cannot
be revoked or zeroized. The host zeroes its derived conversation-key byte array,
not JavaScript strings. No secret key enters renderer/plugin JavaScript.

This is a bounded snapshot from the selected community, not NIP-65 relay discovery
or a live directory. No edits, graph/orphan computation, inventory ownership gate,
arbitrary-owner API or general decrypt endpoint is introduced.

## Verification

Colocated protocol tests exercise encryption/signatures, foreign/self/owner pairs,
slug addresses, duplicate JSON fields, head/tombstone ordering and budgets. Real
broker HTTP tests exercise captured relay/owner filters and rejected caller scope.
Actual relay-session tests exercise lazy reads, errors/retry, unsupported hosts,
view limits, scope isolation and late-result rejection across revocation, disconnect,
cache clear, release and disposal. These are synthetic identities/transport checks,
not production memory reads or packaged-native acceptance.

## Profile presentation

The Profiles plugin adds a lazy Memories tab and an isolated `ProfileMemories`
child. No request starts until that tab mounts. Core and slug entries use native
text disclosures, not HTML or Markdown execution. Leaving the tab, closing the
panel or disabling Profiles disposes its view; reopening requests new evidence.
The tab does not rely on agent-shaped avatars to decide access. Unsupported hosts
and self targets explain the limitation without issuing a read.

RTL tests exercise actual React StrictMode, the profile tab, pending work, scope
switches, retry states and unmount. The existing Chromium/WebKit profile journey
adds keyboard disclosure and narrow-width wrapping checks through actual plugin
registration. No browser cases were added or removed; authority permutations remain
in the cheaper protocol/session tests. Live relay memory, packaged/native acceptance and cross-platform acceptance
remain unverified by these browser fixtures.
