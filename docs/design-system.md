# Design system and appearance

The shared components live in `src/shared/design-system` and appear at
`/tests/fixtures/design-system.html`. Buzz follows Block UI’s approach to semantic
roles, controls and states, using Base UI for behavior and public fonts and assets.
The app imports the same form and overlay styles as the component viewer.
See [the adoption map](design-system-adoption.md) for ownership and retained adapters.

The **host** owns appearance, including startup and recovery. A plugin must not be
required to render the shell correctly. Pages still own their layout and behavior;
this is shared styling, not a second component registry or a parallel `core/` tree.

## First release contract

Settings → Appearance offers **Light**, **Dark**, and **System**, defaulting to System. System
follows the computer's color scheme as it changes. The choice
is device-local (`buzz-appearance.v1` in browser-origin localStorage), not a community
profile or relay event. There is no theme marketplace or appearance sync
between devices. Another same-origin window observes saved changes without rebuilding
pages or relay services. Failed storage reads open safely in System; failed saves apply
for this session and expose a retry in Appearance. Invalid stored values use System.

`public/appearance-init.js` runs as a parser-blocking same-origin script in the HTML
head, before the React bundle. It sets `data-color-mode` on `<html>`; CSS supplies the
palette and `color-scheme`. It requires no unsafe-inline script CSP exception. Its
storage key/parser is intentionally tiny and checked against the service in tests.
`src/shared/theme/service.ts` owns live state, storage events, DOM application and
browser theme-color metadata. `app/services.ts` owns its lifetime, including disposal.
The built-in palettes do not fetch anything or wait for plugin/relay startup.

Native window decorations and pre-WebView launch color are **not** controlled by a
CSS attribute. An attended packaged-app check is still needed before claiming native
chrome/relaunch parity; no broad Tauri capability or CSP expansion was added here.

## Tokens and shared controls

`src/shared/design-system/styles/tokens.css` owns the public palette and semantic
roles. `src/shared/styles/tokens.css` is a compatibility bridge for older callers,
not a second palette. The app imports one Tailwind reset and keeps its existing
appearance service, storage and startup ownership.

| Group | Examples | Purpose |
| --- | --- | --- |
| Surface | `--surface-base`, `--surface-panel`, `--surface-popover` | Page, card, popup |
| Text | `--text-standard`, `--text-subtle`, `--text-inverse`, `--text-danger` | Meaning and emphasis |
| Border | `--border-standard`, `--border-prominent`, `--border-focus` | Edges and keyboard focus |
| Affordance | `--affordance-prominent`, `--affordance-subtle`, `--affordance-danger` | Controls and actions |

Shared components consume these roles; features consume shared components.
Base UI owns focus, keyboard interaction, selection, portals and dismissal.
Buzz owns visual styles and product behavior. Build missing shared components
from Base UI rather than copying private components or wrapping another library.

Use complete type roles with Inter and JetBrains Mono. Do not import proprietary
fonts, private packages or internal business examples. Default, hover, pressed,
focus, selected, disabled and loading states are shared component decisions.
Loading must prevent repeated actions while preserving the label footprint.

The standalone design viewer imports the real shared controls without app startup,
identity or relay services. Check the actual app as well as specimens, in both
themes and at narrow, intermediate and wide widths with enlarged text.

## Future theme contributions (design boundary, not implemented API)

A theme's identity is separate from its `light | dark` color mode. Future first-party
or plugin definitions can contribute named, versioned semantic values; the host owns
validation, explicit user selection, applying/removing overrides and a built-in
fallback when a contribution disappears. Do not make feature components branch on
specific theme names. Do not advertise internal source imports as a versioned SDK.
Add a supported contribution API only with its first real external consumer and
unload/rollback tests. Trusted same-process plugins can already execute arbitrary
code; these authoring conventions are not a sandbox or CSS security boundary.

## Evidence and remaining validation

`shared/theme/service.test.ts` checks parser/bootstrap agreement, denied storage,
save/retry/restore, events and disposal. `tokens.test.ts` checks complete paint roles
and selected WCAG AA token pairs. These calculations are **not** a full rendered
accessibility audit (transparency, images and focus placement need inspection).

`tests/browser/appearance.spec.mjs` exercises the production frontend with fixture
relay data in Chromium and WebKit: Settings controls, reload, denied save/retry,
cross-window updates preserving a live draft/DOM/scroll anchor, responsive screenshots,
and the dark document while the entire application JS bundle is withheld. Existing
Settings journeys also cover the added navigation stop. No live relay writes occur.

Emoji Mart uses the root mode and an in-place attribute observer, disposed with the
picker. Browser regressions cover host Settings changes through an open widget,
opening in Dark, and no updates after disposal. Mutation probes exercise the startup
script, Settings writes/retry, host lifetime and widget initial/update/disposal paths.

Run the design guards, unit tests and relevant browser journeys for a changed
component. Native window chrome and relaunch still need an attended packaged-app
check; browser checks do not establish native acceptance or third-party plugin
styling. Keep full batch validation separate from an interactive preview.



## Text size and shortcuts

The host owns a separate device-local `buzz-font-scale.v1` preference (80–200%,
10% steps; default/reset 100%). Color-mode storage is unchanged. Settings →
Appearance supplies visible decrease/increase/reset controls and save-failure retry.
The bootstrap and appearance service apply `--buzz-text-scale`; invalid persisted
values fall back to 100%, and same-origin storage events re-read the latest choice.

Command+, opens Settings on Apple platforms. Command+= / Command++ increase text,
Command+- decreases and Command+0 resets. Other platforms use Control. Zoom works
while typing and in dialogs without changing browser/WebView zoom; Settings does
not navigate behind an open modal. The [shortcut service](plugin-architecture.md#in-app-keyboard-shortcuts)
also serves plugins and owns event dispatch/lifetime rules.

Only typography scales: root rem size, layout spacing, icons and native window
geometry stay unchanged. Shared Tailwind type utilities and built-in fixed-size
CSS typography consume the scale. Plugin text can inherit host typography or use
`font-size: calc(15px * var(--buzz-text-scale, 1))`; avoid multiplying inherited
font size by the scale again. Use unitless or scaled line-height so enlarged text
does not overlap. Independent plugins that hard-code sizes and third-party shadow
widgets need their own adapter; this is not a forced CSS rewrite of arbitrary code.

Settings → Shortcuts lists every host and active plugin shortcut from the live
dispatcher, grouped by owner, with each owner's deliberate numeric order,
per-row Change/Reset and Reset all. Buzz's host rows use a functional sequence
(navigation, text sizing, search/settings, then development-only actions); plugins
choose the order of their own actions. Equal orders use stable registry identity
and then title as tie-breakers. It
is built from existing components (`Input`, `Button`, `NavigationSection`,
the shared PreferenceRow layout) and `formatBinding`, which renders chords as glyphs
in Control, Option, Shift, Command order on Apple platforms (⇧⌘K) and as words
elsewhere (Ctrl+Shift+K), with a plain-words accessible label. A row whose chord
another listed shortcut also answers to carries a plain "Also used by …" line in
subtle text, no colour. Two pieces are
provisional and await a design pass: the key-combo `<kbd>` chip
(`src/features/shortcuts/KeyCombo.tsx`) and the inline key-capture control
(`src/features/shortcuts/KeyCaptureControl.tsx`). Both are deliberately
black-and-white: capture composes the shared Input with feature-owned sizing
and keyboard handling; notices retain explicit alert text in neutral roles.
The keycaps use standard text, surface, border and radius tokens. Both live outside
`src/shared/design-system/ui/`, and are marked with a `DESIGN PASS PENDING` file
comment and `data-design-pass="pending"` on their root so they are greppable.
Capture keeps the shared keyboard-focus treatment. Escape cancels; Tab/Shift+Tab
leave capture without saving, with an accessible instruction explaining the exit.
Rows wrap their actions before the title collapses.

`tests/browser/shortcuts.spec.mjs` covers real key dispatch to Settings and actual
message/composer text, draft/node preservation, reset/limits/reload, modal/editor/
Shadow DOM guards, the independent example's disable/re-enable path, and rebinding
that example's shortcut from Settings → Shortcuts (host conflict refused, new chord
fires, old chord does not, persists across reload, reset restores). These
Chromium/WebKit checks use a fixture broker, not native menu accelerators. An
attended desktop shortcut try remains necessary for native acceptance.

## Incremental system integration

The host entry `src/shared/styles/globals.css` now loads the shared system's
palette, typography roles, materials and component styles with one Tailwind reset.
It does not import the viewer's global entry, preference owner, docking vendor CSS
or workspace experiments. Panel styling remains defined only by the shared system.

Bundled screens use semantic colors and shared controls. Compatibility names
forward to the same shared roles; they are not the vocabulary for new work.
`bg-primary` forwards to the prominent action role, while `text-primary` and
`border-primary` keep their text and border meanings. Native plugin fallbacks
remain available outside shared-control boundaries.

Shared primitives carry `data-buzz-ui`, including portal popup roots. Legacy
native-element selectors exclude that boundary and its descendants (without native CSS scope); shared typography starts there.
For new custom compositions use the same boundary and named type roles, not old
native-element styling. Inline chips deliberately inherit their sentence's type.
Do not nest legacy UI inside a migrated boundary without explicitly migrating it.
This boundary does not imply a Panel, padding, scrolling or page lifecycle.

The host's existing `data-color-mode` drives shared dark tokens directly, and
`--buzz-text-scale` feeds the type ramp once. Root size and layout geometry do not
scale. Startup bootstrap, preferences, recovery, cross-window events and theme-color
remain owned by the existing appearance service. The viewer retains its separate
preference and full-document typography; its settings do not change the host.
BentoWorkspace still uses the viewer preference helper and is not ready for app
adoption; no workspace experiment is imported by app startup.

The host mounts the shared input-modality hook once, including cleanup. Shared
keyboard focus remains visible; pointer focus does not acquire a ring.

The actual-app Appearance/shortcuts journeys cover startup, preferences, focus,
and the temporary font/color compatibility contracts. Remove compatibility checks
as their legacy consumers disappear; no separate legacy viewer or test suite is
needed. Browser checks do not establish native or packaged acceptance. Broad scan
remains an agreed integration-batch gate.

## Baseline ownership and exceptions

Bundled UI uses semantic roles, including renderer adapters. Change color values
in the shared token layer and visual control recipes in the shared components.
Feature CSS owns layout, not a second Button/Input recipe. `design:check` rejects
direct palette consumption and feature selectors that override control paint,
padding or typography; `design:census` includes the app and renderer string reads.
These are static guardrails, not a substitute for browser checks.

Anchored emoji, mention, completion, account and diagnostics surfaces use
`popover-surface` for their border, fill, elevation and layer. Their placement,
scrolling and specialized keyboard/editor interactions remain feature-owned.
Popup selection uses the shared hover affordance so it stays visible on the
raised dark surface. Compact completion/emoji layouts may select shared radius
tokens to fit their inner geometry. Shared Button/IconButton `title` props render
a shared Tooltip; content titles (full names, timestamps and media descriptions) remain native.

Explicit exceptions: GIF and image tiles use native media buttons, image zoom
uses a native range with semantic colors; rendered Markdown task
checkboxes and inline links keep their content semantics; the rich editor uses
native selection colors; terminal ANSI colors and decorative artwork remain
renderer-owned. The design viewer's layout experiments are not bundled app UI.
Plugin examples consume public CSS roles and host fallbacks. External plugins
cannot be guaranteed to follow this system; no new plugin API is introduced here.

The browser adoption regression changes semantic fill, type and spacing values
and checks the actual Settings button, inline chips and production CSS inside
message-history containers and anchored popups. It exists because DOM emulation
cannot establish CSS layer ownership.

## Message specimens

`just design` includes **Product patterns → Messages**, a catalogue of current
message content, attachments, delivery feedback, thread summaries, and membership
activity. Examples render the production message components against local sample
data; filters, narrow preview, and reset help compare states without a relay.

Product specimens live in `tests/fixtures/message-gallery` and run in a separate
iframe with the host stylesheet. `design:build` builds that document alongside the
core viewer via `vite.message-gallery.config.ts`; the viewer's core-only bundle
boundary remains intact. The iframe inherits the viewer's theme and fills the
available viewport height.
The gallery scrolls inside its isolated document so fullscreen media and its
Close control stay visible. Theme changes reload sample state.

This is a visual inventory, not live delivery or plugin validation. Composer,
presence, unread tracking, and timeline pagination remain outside this first pass.

## Content headers and settings fills

Use `Header` for a settings page's title and introductory subtitle, and
`InlineHeader` for groups inside that page. Both accept an optional eyebrow, icon,
actions and heading level; the default levels are h2 and h3. Keep heading IDs on
the title for labelled regions. `PanelHeader` still owns workspace chrome, and
`DialogTitle`/`DialogDescription` retain dialog labelling semantics; do not replace
those with a generic heading. The initial adoption covers Profile, Plugins,
Appearance, Shortcuts and Notifications; other pages can adopt these when touched.

Light-mode inset fields and quiet fills use neutral-2 (#f5f5f6). Panel hover uses
that same stop; subtle-button hover sits between neutral-2 and neutral-3, while
selected and pressed states retain stronger contrast. Dark-mode roles are unchanged.

## Preference rows

`PreferenceRow` owns settings layout: an optional decorative Phosphor `icon`,
`title`, optional `subtitle`, and `trailing` content. Titles use `text-label-sm`;
subtitles use `text-body-sm`. Text wraps and controls retain their own interaction,
focus, disabled, and pending behavior. The row itself is not an action target.

Use `SwitchPreferenceRow` for on/off settings. It accepts the existing `label`,
`description`, and Switch props, associates the title and description, and supports
an optional icon. It preserves read-only, focusable pending switches.

For other inputs, supply their ID as `controlId` and use the trailing render function
to apply the generated accessible label and description:

```tsx
<PreferenceRow
  title="Include archived channels"
  subtitle="Include archived channels in search results."
  controlId={checkboxId}
  trailing={(labelProps) => (
    <Checkbox {...labelProps} id={checkboxId} label={null}
      checked={included} onCheckedChange={setIncluded} />
  )}
/>
```

Action rows pass a named Button directly to `trailing`, without `controlId`.
Status rows may pass text such as “Required.” A row's `disabled` prop only styles
its text and icon; the caller must also disable its control. Icons are decorative
and must not contain interactive content. Keep plugin management actions and errors
outside the primary toggle row. Pages retain ownership of grouping and dividers.

The PreferenceRow catalog page includes interactive switch, checkbox, button,
icon, subtitle, disabled, and required-status examples.

Standard Button sizes use the 14px `text-label-sm` role while retaining their
existing minimum heights. The extra-small capsule keeps its caption role.
