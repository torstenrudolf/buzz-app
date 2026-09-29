# Shared observed community presence

Profiles show Active, Away, or Offline with text, while avatar badges use
solid status fills. Pending, failed, stale, or unavailable evidence renders no
status; it is not relabeled Offline. People's message and thread bylines omit presence badges and custom status symbols.
One-to-one DM avatars and profiles retain them. Agent message avatars retain presence
badges and demand presence when mounted. Their online badge morphs into a centered
three-dot pill while the existing agent activity feed reports working or typing;
activity is scoped to the displayed conversation when one is supplied. The same
indicator is used in DM rows and agent profiles. It publishes no presence changes.
This describes recent Buzz session status in this community, not proof that a
person is available. Signed live status changes arrive on the existing socket;
bounded snapshots repair missed events and disconnects. The relay stores one status per community/pubkey:
multiple devices are last-writer-wins, so an idle device can report Away even
while another is active. A crashed connection's lease can remain for up to 180
seconds; refreshing the snapshot does not prove that the session is still alive.

## Your status

The account avatar, message/thread bylines, profiles and one-to-one DM avatars
consume the selected community session's observed directory. A menu choice is a
command, not evidence: only accepted publication, verified live events, or a
verified complete snapshot changes badges. Pending/unavailable status has no
badge; the account control says **Status unavailable**. Personal space has no
community authority, so it also has no observed badge.

The account dropdown offers **Online**, **Away**, and **Offline**. Online resumes
automatic activity detection; Away and Offline remain device-local overrides.
The checked radio uses the same observed status as the button and avatar; unknown
has no checked item. Selecting Online resumes automatic detection rather than
pinning the badge green. Previously saved `online` values now restore as automatic.
Automatic is not a separate menu choice. A click shows a loader while observed
status differs from the target, without changing any badge optimistically. Each
attempt has a 15-second confirmation deadline; a new click replaces it, a community
or identity change cancels it, and late confirmation clears a timeout message.
Same-value commands also ask the existing publisher to reassert the status.

Online label text and avatar centers use Green 10. Away avatar centers and label backgrounds
use Amber 10. Online retains its Green 11 outline; Away has no outline.
Away label text uses the mode-aware Amber 12 `text-warning` role.
Label backgrounds mix their status color at 12%, 18% on hover, and 24% while
pressed/open. Online and neutral Offline mix over `surface-inset` for a darker
fill; Away keeps its translucent fill over the menu. Against the actual white
light menu and #333333 dark menu, label contrast is:

| Label | Light resting / hover / open | Dark resting / hover / open |
| --- | --- | --- |
| Online | 2.87 / 2.69 / 2.51 | 5.90 / 5.32 / 4.74 |
| Away | 10.63 / 10.28 / 9.94 | 7.76 / 6.65 / 5.70 |
| Offline | 6.00 / 5.47 / 4.96 | 8.96 / 7.70 / 6.53 |

These are WCAG contrast ratios. Away and Offline pass AA's 4.5:1 small-text
target in both modes. Online passes in dark mode but still fails in light mode,
where darkening its fill reduces contrast with Green 10 text. The Online avatar
outline meets the 3:1 non-text boundary target against supported surfaces.
The unoutlined light Away badge deliberately falls below 3:1; this is an
accepted visual tradeoff, not an accessibility pass. Dark Away meets 3:1 on
the measured opaque surfaces. See the identity-shape guidance in
[DESIGN.md](../src/shared/design-system/DESIGN.md#identity-shapes).

The design guide also requires APCA Lc60 for text. Online misses that target in
both themes: approximately Lc40–48 in light mode and Lc44–47 in dark mode across
the same states. Its dark-mode WCAG pass does not establish APCA compliance.

The Online label is a deliberate design exception, approved to preserve the Green 10
palette and Medium (500) availability capsule shown in the
[review snapshots](https://github.com/block/buzz-app/pull/323). Its composited fills
are outside the static token-pair guard, so its measured text exception is recorded
here. Passing the guard does not mean the Online label meets contrast targets.
Presence still has accessible status text, and the dropdown uses standard text
colors; that does not remedy the visual shortfall.

The one app activity owner stores `auto | away | offline` per viewer in
`buzz-presence.v1:<pubkey>`. Same-origin windows observe storage changes; all
retained communities use that viewer's intent. Startup restores it before opening
a session. Existing `auto` and legacy `online` values restore automatic mode; missing or
unrecognized values fall back to `auto`. Storage failure applies only to the
current window and displays a warning. This is device-local, not cross-device
arbitration: another device or CLI can overwrite the relay's last-writer-wins status.

The existing authenticated publisher sends bare kind:20001 status. An accepted
Offline clears presence once without renewal; locally unsent/refused/unconfirmed
clears retry on the existing cadence, and reconnect or lock handoff publishes
current intent again. A failed publication does not roll back the saved choice
or imply confirmed delivery. There is no durable invisible policy on the relay.

## Ownership and bounds

- One app input source derives Away after ten minutes without Buzz input. Focus
  loss and changing communities alone do not mean Away. Foreground return counts
  as activity; capture-phase input also observes editors that stop bubbling,
  including input without a keydown. Same-origin windows share
  recent input through BroadcastChannel. Tauri samples machine-wide idle every
  30 seconds using the same `user-idle` macOS/Windows support as the old desktop.
  Unsupported platforms and command failures fall back to Buzz input. No
  cross-device arbitration is added.
- Each retained connected session owns one volatile presence directory. Mounted
  profiles, message bylines, and one-to-one DM sidebar rows demand authors. At
  most 256 unique authors are selected; the demanded viewer takes first priority,
  then profiles, then existing
  selections and stable acquisition order. Overflow has no visible status.
- Initial/new demand coalesces for 100ms, waiting at least five seconds after the
  previous read settles so transit cannot race the broker’s start gate. Successful
  views refresh after 60–65 seconds. Evidence expires 75 seconds after request start.
  An owner may request an earlier read that keeps current evidence and still
  waits for the start gate; managed agent cards do so every five seconds, for up
  to thirty seconds, while native process status and the badge disagree (for
  example, just after start or stop).
  Empty demand makes no request; removed authors lose their evidence. Hidden views,
  disconnect, access/cache invalidation and disposal invalidate observations.
- One demand-scoped kind:20001 live-only route shares the authenticated socket.
  Its author set updates at the existing coalesced snapshot/start gate, not on
  every mounted row. Replacement keeps the old wire until the new EOSE; removed
  subjects are fenced locally. Accepted self-publication and verified live events
  update that same directory and fence older in-flight snapshots per subject.
  Live evidence has the same 75-second local freshness bound. Later snapshots
  remain authoritative and can replace it. Disconnect cleanup is not broadcast
  by the relay, so snapshots remain necessary.
- One bounded complete snapshot is validated before any status changes. The
  configured relay must sign each unique requested subject; only a successful
  complete response can make omitted subjects Offline. This is read-time evidence,
  not the relay's remaining lease. Invalid or failed responses mean Unknown for
  the whole snapshot. Valid relay-signed unsupported statuses mean Unknown only
  for that subject; canonical peers and complete-response omissions remain usable.
- The development broker and native signed transport permit one optional HTTP flight, a principal-wide
  five-second start gate, 256 subjects, a 20 KiB request and 1 MiB response, and
  a ten-second request lifetime. Optional work never uses ordinary read slots or
  dispatch credit. Local busy skips retry after 5–6 seconds; network failures wait
  60–65 seconds, honoring longer server cooldowns.
- Renewal uses the existing authenticated socket, with a Web Lock per scope/viewer
  serializing same-origin windows. Publication is lossy and bounded; it never
  enters the durable outbox, replays missed ticks, or publishes Offline on close.
  Hidden observation does not stop connected-community renewal. Actual shared
  relay cooldowns still take priority. Status changes and explicit commands start
  without initial jitter; connect and lock handoff retain 250–1000ms jitter.
  Admission skips report the remaining five-second send gate or cooldown; the
  same renewal timer retries 50ms after that boundary, without polling. Other
  locally unsent publications retry after 5–6 seconds, while refused or unconfirmed
  publications retain the 60–65 second interval.

Bounded presence reads and publications can run during ordinary HTTP work and
channel subscription setup; neither waits for the entire host to become idle.
Unavailable evidence can persist during relay cooldowns or unavailability. These limits bound
client work; they do not
promise zero CPU/network/backend cost, instant transitions, or a delivery SLA.
There is one bounded presence REQ per observing session, no added socket and no
relay change. Native reads reuse the existing authenticated `POST /query`, signer,
response verification and optional admission lane.

## Validation

Owner tests live with `features/presence`, relay transport/admission and the broker.
`tests/browser/presence.spec.mjs` exercises the built app and production broker with
modeled upstream and ephemeral keys: held profile snapshots versus chat,
byline presence/demand, accepted avatar choices agreeing with self-message badges
and reload, and real same-origin preference
synchronization/Web Lock handoff while Offline. `settings.spec.mjs` retains the
account disclosure, keyboard traversal and Settings journey in both engines. `channel-opening.spec.mjs` includes matched-thread
measurement support. See [browser measurement limits](browser-testing.md).

These fixtures do not certify deployed relay capacity, native-window behavior,
attended account use, or cross-device availability. Full production-broker browser
idle/publication integration remains unverified; controlled DOM owner tests cover
captured input, idle, foreground return, disposal, overrides, storage failure,
viewer isolation, Offline retry/no-renewal/reconnect and derived publication.
The isolated source preview also exercises idle/input through the avatar indicator.
