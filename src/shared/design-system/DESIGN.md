# DESIGN.md

## Direction

Buzz adopts Block UI's visual language and semantic color grammar. Base UI
remains the behavior layer; Buzz owns styles, composition and product semantics.
Use Inter and JetBrains Mono, public dependencies and generic examples. Do not
copy private packages, proprietary fonts, internal product data or private source.

## Semantic colors

Use `color / purpose / emphasis / state`: surface, text, border and affordance.
An affordance is a control or action color. CSS spells these `--surface-panel`,
`--text-standard`, `--border-prominent` and `--affordance-subtle-hover`.
Tailwind utilities include `bg-surface-panel`, `text-standard`,
`border-prominent` and `bg-affordance-subtle-hover`. Text and border registrations
stay in separate namespaces so they cannot accidentally share a value.

Components choose roles, not palette steps. The palette is an implementation
detail, even when a role uses the same step in both themes. Add a role only for
an actual use, document it in the registry and measure its intended pairings.
Legacy utilities and host aliases remain while their callers migrate. Do not
add new uses. Whole materials such as glass still travel as one shared recipe.

Panel navigation uses `affordance-panel-hover` for its quiet hover and the shared
`affordance-selected` for persistent selection. In dark mode, the unfilled panel
row needs a quieter hover than a filled subtle control; these are distinct roles.

## Foundations

The interface uses shared color, type, spacing and shape roles. Primary actions
are neutral. Text uses Inter for reading and labels, and JetBrains Mono for code
and identifiers. Regular (400) supports reading; Medium (500) marks labels and
structure. The Typography page documents each role’s complete setting.

Panel padding is 24px, control inset 16px, group gap 32px and page-section gap
64px at the default scale. Values are rem-based. Full-window gradient backdrops
and glass navigation support both color modes; content panels use opaque neutral
surfaces. Dark text roles are selected for contrast on their intended surfaces.
Host compatibility names resolve to the shared tokens.

Features own layout, data and behavior. The foundation guard covers `src/`,
including the Emoji Mart adapter. Layout dimensions, emoji artwork geometry and
terminal ANSI/artwork remain renderer-owned; terminal controls use shared colors
and mono type.

This guide describes how to use the system: surface relationships, hierarchy,
identity, interaction and composition. The token registry documents the available
values and their purpose.

Run `pnpm design:dev` and open `/tests/fixtures/design-system.html` to see the system rendered from the tokens themselves.

## Identity shapes

Human avatars are circular. Agent avatars are squircles. Use the shared
Avatar `shape="circle"` or `shape="squircle"`; the shape carries identity meaning,
not density or emphasis. The caller supplies identity type from domain data,
never a name or picture heuristic. `size="fill"` fills the owning layout’s
available space. Shape clips the artwork, never the interactive focus target.
Avatar-only controls use `IconButton variant="avatar"` so the surrounding backdrop
shows through their cutouts at rest, hover, press, and while a menu is open. The
button retains its unmasked keyboard focus ring.
Circular and squircle avatars can add `statusBadge="online" | "away" | "offline"`. The dot
uses a semantic green, yellow, or grey role with light and dark values. Its inset
cutout and dot scale with the existing avatar size; the dot is separate from the
clipped artwork, and avatars without a badge retain their full shape. The agent
cutout and badge follow the squircle contour; agent badges use live presence and leave
unknown status unbadged. All three statuses use solid fills: green for Online,
yellow for Away, and grey for Offline, with semantic light and dark values.
Online retains its step-10 center inside a 1px inset, same-hue step-11
outline, which supplies the 3:1 non-text boundary on supported opaque surfaces.
Away uses an unoutlined Amber 10 fill at the designer's explicit request.
**Known accessibility tradeoff:** the light Away badge falls below the WCAG
1.4.11 3:1 non-text contrast target on supported neutral surfaces. The contrast
guard reports exact accepted light-mode role/color/surface pairs; other pairs
remain enforced. This exception is not an accessibility pass. Dark Away meets
3:1 on these opaque surfaces. Offline stays unoutlined. Badge footprints,
Bézier artwork cutouts, presence behavior and accessible names are unchanged.

## Public identity text

Public-key recognition labels use the shared pure formatter in
`src/shared/identity/public-key.ts`: `npub…` followed by the last three canonical
npub characters by default. This is text, not a component or a new identifier.
Use `formatPublicKey` for one label; use `publicKeyLabels` for an ambiguous group
so distinct keys receive a common suffix length that makes them distinguishable.
Inputs are public identity keys in hex, never credentials. Invalid inputs produce
no label; do not echo an invalid value as a fallback. Raw hex cannot establish
whether a caller supplied a secret: callers must use public-identity fields only.

Keep the full key for routing, persistence, identity comparisons, and explicit key
copy actions. Short labels are recognition aids, not proof of identity. Full-key
inspection/export surfaces remain explicit exceptions. Existing surfaces are not
migrated automatically; new abbreviated public-key displays should reuse this rule.

Identity display names use the active naming policy, not a separate composer rule.
The default policy compares trimmed resolved names case-sensitively (`Honey` and
`honey` are different). It ranks the viewer human, other humans, viewer-owned agents,
then other agents. Unique names stay plain; ties do not choose an arbitrary winner.
Readable owner/agent labels come before last-four npub endings, extended only when
needed. These policy qualifiers are distinct from standalone abbreviated-key labels.

Views supply the comparison set: channel members for reading (plus the referenced
historical identity), DM participants for DM labels, and complete eligible choices
before search filtering for pickers and composer chips (plus existing recipients).
Removing a selected chip does not remove an otherwise eligible namesake from that
set. Repeating one identity is not ambiguous. Live profile and membership changes
update display labels, never authored message source, recipient spans, copyable
text, or notification targets. Accessible names spell out a public-key ending
when the policy uses one. With no active policy, use profile/caller fallbacks.

When an existing composer chip gains a qualifier, reveal only the qualifier with
shared settle motion; newly inserted chips appear at rest. Ordinary typing must
not replay the reveal. The suffix stays visible while a long name ellipsizes.
Removal is immediate and reduced motion disables the reveal animation.

## Posture

Buzz is a place where people build together and bring their agents into the room. Everyday surfaces stay quiet, crisp, and highly functional; character shows up in identity, guidance, transitions, and ceremony rather than in the chrome of ordinary work. Colour is signal, not decoration. When in doubt, the interface gets out of the way of the conversation.

## Surface and depth

- **Panels sit on the backdrop; the backdrop is a gradient.** Everything else is a panel in a different place. The navigation column is not a special kind of surface.
- **A region is separated by a soft fill, not by an outline.** Reach for `bg-inset` before reaching for a border. A bordered box announces its own edges; a filled one lets the content sit in a place. Grouping is the common case, so the quiet treatment is the default one.
- **Use border-standard for quiet separators, border-prominent for controls and border-focus for keyboard focus.** Error and warning boundaries have their own roles. Measure real surfaces in both themes.
- **No page-wide gradient behind documentation or dense reading.** The gradient is the product's backdrop for chrome and panels. Behind a column of prose it fights the text and makes contrast position-dependent — such surfaces sit on `bg-panel`.
- **Shadows stay at the threshold of perception.** If a shadow is obvious, it is too strong. The two elevation values are the whole vocabulary.
- **Floating controls share one outer material.** Menus, selects, popovers, and preview cards use the opaque `floating-surface`: floating fill, primary boundary, panel radius, and graduated lift. Each component still owns its content padding and interaction behavior; sharing the container does not imply that a preview behaves like a menu.
- **Floating rows need their own hover contrast.** Menu, select, and popover activity rows use `affordance-floating-hover` (neutral 3 in light mode, neutral 7 in dark). Supporting text becomes standard text on highlight so it stays readable. Selection marks remain independent of hover. Small action menus and compact account popovers use 10px `radius-row` outer corners with a 4px list inset and 8px inner rows (80% of the outer radius). Their hover uses `affordance-subtle-hover` with immediate feedback. Default/wide menus, content popovers, pickers, dialogs, and alert dialogs retain 24px `radius-panel` outer corners. Choose compact explicitly for short action lists, never automatically from viewport width.
- **Elevation is carried by shadow in light mode and by lightness in dark mode.** On a near-black background there is nothing darker for a shadow to cast, so a floating surface becomes a step lighter instead. Never reach for a stronger shadow to make something float in dark mode.
- **On a translucent surface, elevation reads as less translucency, not as a lighter colour.** A glass container with a fully opaque child looks layered; the same container with a merely brighter child looks unchanged.
- **Light comes from one direction, and every glass surface agrees on it.** A glass rim is bright along the lit edge and dimmer on the opposite one; that is what makes it read as a material rather than an outline. Two surfaces lit from different directions in the same view look like a mistake.
- **A glass rim is not an outline.** If a surface needs a visible boundary rather than a material edge, it wants a border role, not glass.
- **Glass needs something behind it worth seeing.** Translucency over a flat fill is wasted cost; use it where the gradient, an image, or content actually shows through.
- **Only panels and chrome should sit directly on the gradient as a default.** Text and hairlines on a gradient have position-dependent contrast. Good practice rather than a hard rule — a rotated label pill on the backdrop is fine.
- **A translucent surface has no contrast guarantee, and this one is measured.** `check-contrast` pairs each text role with the *opaque* surface roles, so glass is invisible to it — the surface a person actually reads against is the fill composited over whatever gradient happens to be behind it, which varies by position on screen. Sampled from a rendered dark-mode screenshot, primary glass over Night garden runs from `#162e28` in its quiet regions to `#1e4a3c` where the green glow reaches through. On the darker end everything clears; on the brighter end **`text-secondary` measures Lc 58 and `text-tertiary` Lc 43**, against targets of 60 and 45. Marginal, and only in a region the glow reaches — but real, and no guard can see it. Three ways out, none obviously right: make the gradients' bright stops dimmer where panels sit, raise the glass fill a ramp step under a bright backdrop, or keep meta text off glass. **Deliberately unresolved** — it needs the real product content on screen, not a token edit.
- **A redundant fill on glass is not free — it compounds.** Two identical translucent layers are not one layer: `glass-2` over `glass-2` composites to **0.77 alpha**, a value no token holds. Four panels each set the same fill as the container they exactly covered, so panels meant to be the most translucent surface in the system read as nearly solid. Before giving a region a glass fill, check whether its parent already is glass; if the region covers it, it needs no fill of its own.
- **A component that can sit on either the gradient or a panel says so, with a variant.** `Tabs` takes `chrome` (a glass pill for the app backdrop) or `panel` (an underline for a plain surface); `IconButton` has the same axis as its `chrome` variant. The failure that earned it: the chrome container is `glass-2`, which over a white panel composites to pure white, and its selected pill is `neutral-1` — also pure white. Container and selection became one colour with only a shadow between them, and no guard could see it because the component had no way to state which background it expected. **The fix was never to retint `--bg-chrome-selected`** — that moves the collision rather than removing it. **One component with a variant, not two components:** behaviour, keyboard model, accessibility, props, and the Base UI parts underneath are identical, so a sibling component would duplicate all of it to change how selection is drawn, and the two would drift exactly as the four hand-assembled chrome surfaces did. When adding a component that could appear in both places, give it the axis and put both on its specimen page — the chrome-only specimen is why this defect survived until it appeared on a real screen.

Underlined panel tabs keep their labels at intrinsic width and scroll their own
Base UI tablist when the content column is narrow. Keyboard navigation reveals
the focused tab; the shared panel grid must use a shrinkable column so tab labels
do not widen the content below them.

## Temporary focus appearance

Focus outlines are currently hidden globally at the designer's request while
forms are being polished. The centralized override in styles/globals.css takes
precedence over the keyboard-ring recipes documented below. Keep focusability,
Tab order, input modality, selection, and focus restoration intact. Do not add
local replacement rings or disable keyboard interaction. Shared text fields now use
a border flush with the field perimeter: surface-inset fill and a 1px
border-prominent stroke fading over 150ms ease for pointer interaction. The
field-scoped --border variable selects transparent, active, or error color for
the reserved 1px border, so state changes do not shift the layout. Keyboard
focus and reduced motion change immediately. Composite fields own one stroke
around the input and actions; error strokes retain priority. Placeholders use
text-metadata, one step quieter than supporting text, in both themes. This supersedes the older keyboard-only
and no-container-ring recipes for these fields. Existing component
recipes remain so this temporary visual decision can be reversed in one place.

## Surface-aware interactions (proposed)

Opaque surface owners provide a CSS interaction recipe: `interaction-panel`
(default and Panel) or `interaction-floating` (Dialog, floating-surface and
popover-surface). The recipe follows the painted DOM root, including portals;
there is no React provider or runtime color detection. Native modal adapters
using the floating fill opt into the same utility. Transparent groups inherit;
a nested opaque Panel resets. Feature-only surfaces must opt into the recipe
matching their paint; an arbitrary background utility alone is not a context.

Inherited custom-property aliases resolve on the owner, not again on each child.
Do not override upstream `--affordance-*` values on a wrapper to retint controls.
The existing semantic exceptions have named shared recipes: `interaction-availability`
on the status owner uses `data-status="online" | "away" | "offline"` (unknown stays
neutral) for the documented status capsule fills, while `interaction-navigation`
on the sidebar keeps channel rows and session selection equally quiet. Apply these
only to their semantic owners, not as general styling escape hatches. Button and
NavigationItem still do not accept caller-supplied `className`; popup portals keep
their own floating recipe. Availability's existing contrast exceptions remain
recorded in `docs/presence.md`.

Actions consume contextual fill/hover/pressed/selected/boundary roles rather than
redefining global semantic tokens that also color avatars or chips. Floating
rows remain transparent at rest, then use the existing floating highlight with
standard supporting text. Persistent selection is separate from hover. Compact
menus retain their quieter highlight and use a distinct selected fill.

Fields retain surface-inset and their existing invalid/disabled/focus behavior;
only active boundaries adapt to the surrounding surface. Actions inside an
InputGroup reset to the ordinary recipe because their backdrop is the inset
field. Unchecked checkbox/radio and outline boundaries use the contextual
boundary too. Prominent/destructive actions and switch geometry/state colors
are unchanged. No extra hover affordance is added to static content.

The floating control mappings are proposed, not an accessibility certification.
Dark subtle action fills are neutral-6/7/8 at rest/hover/press, on the unchanged
neutral-5 floating surface; those fill edges are below 3:1. The contextual control
stroke uses neutral-9 and clears 3:1 against that outer surface. This proof does
not change focus appearance: the viewer's temporary outline suppression remains,
while the host's separate stylesheet still renders keyboard rings. That existing
host/viewer mismatch needs a separate decision. Glass/inverse/media surfaces
retain their existing explicit treatments, outside this opaque-surface proof.

The Floating surfaces viewer shows actions, rows, fields and choices in actual
shared Panel/Dialog/Popover components, including a nested Panel reset. Verify
both themes, portals, supported states and actual product flows before adoption
is called complete; token math alone cannot validate the CSS cascade.

## Controls

Button and IconButton share prominent, subtle, ghost, inverted, destructive,
outline and link emphasis. Inverted is for an inverse surface; link keeps its
background clear and underlines on interaction. Its
32 / 40 / 52px sizes are sm / md / lg at the default scale, with minimum
heights that accommodate larger text. Text buttons use `--radius-capsule`
(1.625rem / 26px): capsule-shaped through the default 52px large size,
clamped naturally on shorter controls, and bounded on taller ones. Reuse this
role for similarly sized actions; `--radius-pill` remains the fully round role
for circles and pills of any height. Fields retain `--radius-control`.

Button labels stay on one line and do not shrink in flex layouts, following
shadcn's `whitespace-nowrap shrink-0` behavior without changing Buzz's sizing,
emphasis, or Base UI interactions. Parents must reflow whole controls or provide
scrolling when space is limited. Composite reply summaries may reflow whole
avatar/count groups without wrapping individual labels. Small buttons use 16px
side padding and 16px icons; medium and large use 24px side padding and 24px icons.
Labels use the complete text-label-sm / text-label roles, with an 8px icon gap.

IconButton defaults to round and uses the same sm/md/lg sizes. Existing names
remain compatibility aliases: primary/solid → prominent, quiet → subtle,
compact/toolbar → sm, default → md, large → lg. Do not add new alias call sites.
Buzz's tint and chrome icon variants remain for composer and backdrop actions.

Disabled controls retain their filled, outline, or unfilled treatment and cannot
activate. Loading retains the label's geometry, accessible name, focus and variant
colors while blocking activation; never swap in a differently sized loading label.
Pointer hover uses shared state timing; expanded triggers retain pressed emphasis.
Keep keyboard-only focus and reduced-motion behavior owned by the system.

IconButton also offers `xs` (28px with 16px icons) for dense composer formatting
options, preserving the original toolbar layout. Mode toggles remain `sm`.

IconButton defaults to round across all sizes and variants. Use `shape="control"`
only when a rectangular control shape is explicitly needed. Disabled ghost icons
remain unfilled; their muted foreground communicates unavailability without
adding a container to an otherwise empty toolbar.

Composer picker surfaces use the 24px `--radius-panel` role and the shared
popup motion below. Filtering does not stagger results. Search fields follow
the shared form treatment below.

Field groups label, input, help and error using Base UI. Input and Textarea
carry the shared field appearance. RadioGroup is for one choice, Checkbox for an
independent choice and Switch for an immediate on/off setting. Use the native
form semantics exposed by those Base UI primitives rather than duplicating them.

For finite choices, use Select: its inline layout fits compact toolbars and
`variant="field"` fits labelled forms. The proposed `variant="compact"` fits
trailing row choices: a small ghost trigger with a visually hidden accessible
label, bounded single-line value, and full choice text in the popup and value hint.
The caller owns its column width. Pass `disabled` explicitly when the choice
is unavailable. For searchable choices, use the shared Combobox parts; keep
filtering, custom-value commits, and async requests with the feature. Its Control
owns the label, input and integrated browse caret; Popup and Item own the shared
menu presentation. Use its loading state while discovering options, and keep
retry/cancel actions with the feature. Do not style a native select as an Input
or attach a separate round button to mimic a combobox.

### Form composition

Select and Combobox chevrons rotate 180 degrees to reflect the trigger's
aria-expanded state. Use duration-state (150ms) with easing-settle for a
reversible transform transition. Keyboard navigation and reduced motion switch
the orientation immediately. Loading indicators keep their separate behavior.

Fields share a 40px minimum size at the default scale, the control radius,
text-body (now 14px / 20px across Buzz), and the 16px control inset. Derive vertical padding from the control
size, text line height, and boundary; do not force a fixed height that clips
larger text or wrapped Select values. Textarea uses the control inset on all four
sides (16px at the default scale), with manual vertical resizing and a code variant.
In Chromium and WebKit, the native resize grip uses text-metadata and sits 4px
(space-1) inside the corner. Keep it visible at rest. Preserve the native resize hit target and
leave the browser grip unchanged where custom resizer styling is unsupported.

Use Field once per input/textarea, with an 8px internal gap. Select's field
variant, SearchField, and Combobox.Control already own their label and supporting
text; do not add a second Field around them. Use description/error for connected
help and validation. An error replaces the secondary description until it clears;
keep the accessible description synchronized with the visible message. Validation
strokes belong to the outer field, never its auxiliary buttons. Keep feature-owned asynchronous status connected through
aria-describedby. Forms own 16px between adjacent fields and the 32px section
gap between named groups.

InputGroup shares the inline frame for SearchField and Combobox. Icons use an
8px gap, and trailing actions retain a stable slot. SearchField uses the same
12px control radius as other fields, with no separate navigator shape. Focus belongs to the input or action,
while the frame owns the active perimeter stroke. Read-only values can be
read and copied; disabled actions cannot change a value. Search clear restores
input focus. Features still own filtering, custom values, and async recovery.

SearchField, Combobox.Control, and code Textarea default to no autocorrection,
capitalization, or spellcheck. Callers can override these defaults explicitly.
Ordinary Input and prose Textarea retain platform defaults. See the
[exact-text input audit](../../../docs/input-correction-audit.md) for remaining fields.

The Forms page in Just Design documents states, usage, and a form-in-dialog
example. Review it with both themes, narrow widths, and enlarged text before
introducing another form treatment.

Select and Combobox popups use a 150ms entrance and 120ms exit from the shared
state/fast duration tokens. Fade opacity with easing-state and move 4px from the
trigger with easing-settle, reversing the direction above the trigger. The
designer-requested blur from 4px to zero is a narrow exception to the general
no-blur-animation rule. Base UI owns transition presence and dismissal; keyboard
navigation and reduced motion remove the transition, movement, and blur.

### Menus, popovers, and choice rows

Use Menu for actions and lightweight choices, Popover for supporting content or
short forms, and Select/Combobox for form values. Both anchored surfaces reuse
`floating-surface`, viewport collision handling, and the shared popover layer.
Features own their data, callbacks and save/cancel behavior; Base UI owns focus,
keyboard navigation, positioning and dismissal.

Menu group labels belong inside MenuGroup. Selection checks sit at the trailing
edge; the pointer/keyboard highlight is independent of that persistent selection.
Keep the parent row highlighted while its submenu is open. Use `tone="danger"`
for destructive actions and MenuNote for explanatory or status copy outside the
keyboard item list. Long lists scroll inside the popup.

ChoiceRow arranges a label, wrapping description, optional artwork and trailing
metadata. It adds no second click target or tab stop. Keep its slots non-interactive
and let the containing item own state and padding. Use the small shared avatar
for identity choices, retaining human/agent shapes.

PopoverPopup uses 16px content padding, or `padding="list"` when its rows own their
spacing. Use `size="compact"` with list padding for short account/action surfaces: 14rem width and 10px corners. `MenuPopup size="compact"` uses the same corner, inset, row and hover treatment for short action lists. Content and wide popovers retain 24px corners. Name it with PopoverTitle or aria-label; PopoverDescription connects
supporting copy. Hover opening is optional and remains configured by its feature.
Use `padding="none"` for an embedded picker that owns its internal spacing, such as emoji/GIF content.
Menus and popovers use a quicker version of the form dropdown motion: 75ms entry
and 60ms exit (half the state/fast duration tokens), a 2px offset and blur-to-sharp
opacity fade. Movement uses
easing-settle; opacity and filter use easing-state. The offset follows the actual
placement side toward the trigger, including collision flips and nested menus.
This extends the designer-requested blur exception to these anchored surfaces.
Keyboard navigation and reduced motion remove transitions, movement, and blur. The Just Design Menu, Popover and ChoiceRow pages
show these contracts and their compositions.

## Compositions

Composer pickers reuse PopoverPopup and anchor above the whole composer with a
4px gap, preserving the shared popup behavior and material.

Dialog composes a Base UI modal with a shared title, optional description, body,
close button and actions. Pending operations set preventClose so Escape and the
close button agree. It retains the app's explicit dismissal behavior: outside
clicks do not discard a form. Provide initialFocus for search dialogs and
finalFocus when a flow has an external trigger or opens a second dialog.
An explicit finalFocus applies only while focus is still in the closing popup
or on the page body. If the user already moved focus elsewhere, closing leaves
it there, as the default `true` does (`ui/finalFocus.ts`, shared by Menu,
Popover and Dialog).
Editors can supply `headerActions` beside Close and `leadingActions` before the
trailing footer actions. Footer actions wrap as whole controls, never shrinking
single-line labels. When one action exceeds the available width, the footer
scrolls horizontally from a safe start edge so both ends remain reachable.
`onEscape` may return true to consume Escape for an
inline layer (such as an inspector) before dismissing the dialog. Nested modal
layers still use Dialog so Base UI owns their focus trap and dismissal order;
`placement="right"` and explicit `dismissOnOutsideClick` suit inspector sheets.
Use `size="expanded"` for viewport-filling reading surfaces such as code diffs;
the body scrolls while the shared title and close action remain available. This
changes only size, not modal ownership or dismissal behavior.
Use `text-label` (16px, 500 weight at the default scale) for the shared Dialog
title. Group the title and optional description with `--space-2` (8px), beside
the close button so its hit area does not enlarge the text gap. The body owns
vertical padding matching the dialog's horizontal padding: `--space-6` (24px),
or `--space-4` (16px) at the compact breakpoint. Do not add an outer flex gap
on top of that body padding.
The shared Dialog uses state opacity and settling transform tokens for a centered
0.98-scale entrance, with fast timing on exit. Base UI owns transition presence;
keep the controlled component mounted while setting `open={false}` for an exit.
Reduced motion, keyboard navigation, and Escape dismissal are immediate. Pass
`motion="none"` for frequently used surfaces such as the search palette.

Use Accordion for collapsible sections. Form sections pass `keepMounted` so
collapsing them preserves local input state; leave the default for static content.
Use `variant="form"` when the surrounding form owns spacing. It removes outer
margins while keeping the shared row and panel padding. Adjacent disclosure rows
form one stack; avoid inserting form-section gaps between individual rows.

Use Tooltip for short hints on labelled controls; use PreviewCard for richer
content. Tooltip owns its description link and inherits placement, focus and
Escape behavior from Base UI. Overlay layers keep menus and hints above dialogs.
Hints use text-caption (12px / 16px), with space-1 vertical and space-2 horizontal
padding. Pointer entry uses the shared state duration (150ms), fading from a
0.97 scale, 2px downward offset and 2px blur; exit reverses it with the fast
duration (120ms). This designer-requested blur is a tooltip-specific exception.
Base UI instant states and keyboard navigation skip transitions; reduced motion
keeps only the fade.

ToastProvider mounts once in the host. ToastNotice belongs to the source that
owns its state and recovery: unmounting the source removes its notification,
without reporting user dismissal. Gate notices from hidden Settings sections
explicitly; portals do not inherit a hidden ancestor. Keep form errors and
blocked-page recovery inline.

Use `useToastNotification` for completed-action feedback that must outlive its
source row (such as copying profile metadata); the host stack owns its finite
expiry. Keep source-owned recovery on ToastNotice.

Use a finite timeout for transient feedback. Recovery defaults to no expiry and
no dismissal unless the source supplies onDismiss; preserve all recovery actions.
The bounded, scrollable stack keeps older actions available without covering the
shell header or composer. F6 enters notifications, Tab reaches actions. Modals
remain above the stack. Content updates do not restart expiry; timeout changes do.

Tabs with content use renderPanel, which lets Base UI connect each tab and panel.
Route navigation uses NavigationItem with aria-current instead. NavigationItem
offers an `option` variant for picker rows with even 8px padding and immediate
hover feedback. It forwards normal button events, refs and data attributes so unread observation,
preloading and product shortcuts remain with the caller.

PreviewCard may expose one supplemental action through `actionRef`, such as copying
an identity's full npub. Action previews open without a delay so immediate Tab
navigation reaches the action. They remain non-modal and never take focus on hover. Tab
from the trigger reaches the action; Shift+Tab returns to the trigger; forward Tab
continues after the trigger. Escape dismisses the preview before restoring focus,
but never pulls focus back if the user moved it during exit. Closing previews
are no longer Tab destinations.
The positioned portal owns its layer above dialogs. An optional content anchor
keeps previews near compact identity content inside wider actionable rows. Identity
previews prefer above that content (with Base UI collision handling), leaving
the hovered row’s trailing action unobstructed.

## Menu row corners

Every shared menu item uses `--radius-pill` on all four corners. First, middle and
last rows keep the same fully rounded highlight, so moving between them does not
change its shape. Direct items, grouped choices and submenu triggers share this
recipe. Do not add positional or feature-local radius overrides, derive a special
menu inset radius, or change the global row radius to correct a menu.

## Align row content, not state backgrounds

When composing NavigationItem lists inside dialogs or padded panels, align the
leading content column with the heading. With icons, this means the icon slot;
labels form a second consistent column. Give mixed icons and identity fallbacks
the same slot (24px in the page search palette), retaining each
icon's intended size within it.

The hover and selected backgrounds may extend beyond that content edge. Offset
the list wrapper by the existing `--space-control-inset` rather than removing
NavigationItem padding, moving the heading, or overriding the row's paint. The
surrounding composition owns this offset; it is not a global navigation change.

Preserve at least `--space-2` of outer gutter. At the dialog's compact breakpoint
(480px), its padding is 16px, so reduce the outward offset from 16px to 8px. That
small content inset is intentional: the row background and keyboard focus must
stay clear of the dialog edge. Scrollable lists also need space inside their
scroll container for the focus outline; account for that space in the offset.
Align empty-state text with the same leading content column.

Check the composition with no highlighted row, hover, selection and keyboard
focus, in both themes and at narrow widths and enlarged text. Content alignment
should remain legible without a state background to explain it.

## State

- **Design default, hover, pressed, focus, selected, disabled and loading states where they apply.** Pressed changes fill without moving the control. Loading keeps the label footprint and prevents repeated activation; CSS alone cannot enforce it.
- **Hover means one step more contrast, in whichever direction that surface needs.** A light row darkens, a dark chip lightens. Direction lives in the value.
- **Selected is a persistent statement, not a stronger hover.** It should be legible without a cursor present.
- **A selected item in a toggle group is not interactive.** Clicking it does nothing, so it gets no hover.
- **Disabled communicates unavailability, not quietness.** It is not a fourth level of the emphasis ramp.
- **Never hide the only way out of a state.** Before adding a visibility rule, ask what happens when the state it assumes is wrong, and whether the person can still recover.

## Emphasis

- **Three levels of text: normal, lesser, really lesser.** If a fourth seems necessary, the thing wants a different size, weight, or position instead of a fourth colour.
- **Two text colours do most of the work.** Treat the third level as genuinely for metadata.
- **Borders describe their job:** a quiet edge, a control boundary or focus.
- **Weight and size carry hierarchy before colour does.** Reaching for a louder colour to fix hierarchy usually means the size relationship is wrong.

## Type

Two layers, and the same rule as colour: only roles are used when building a
screen. Layer 1 is the raw ramps (`--type-size-*`, `--type-leading-*`,
`--type-tracking-*`, `--type-weight-*`); layer 2 is the roles, which register in
Tailwind's `--text-*` namespace and become utilities like `text-body`. The
authoring lives in `src/shared/design-system/styles/typography.css`.

**Size roles and colour roles never collide**, because they live in different
namespaces: colour registers as `--color-*` and is named for emphasis
(`text-primary`), size registers as `--text-*` and is named for an editorial job
(`text-body`). So `text-primary text-body` is one colour plus one setting, and no
name ever means both.

The active sizes are 12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 56, 72 and 96px
at 100% text size. Sans roles use Inter and mono roles use JetBrains Mono.
Values scale with the host text-size preference.

- Components use named roles, never private primitive sizes. The viewer shows
  each utility’s semantic role and complete setting alongside the size ladder.
- A role carries size, leading, tracking and weight together. Display roles have
  solid leading; the 24px section title uses 24/24, not the primitive's 24/32.
- Regular (400) is for reading; Medium (500) is for labels and structure.
  Existing `font-semibold` consumers resolve to Medium.
- Mono uses `detail/body-xsmall` at 12/16 with 0.03em tracking.
  `--type-xsmall-size` points to the existing 12px step, keeping the semantic
  independent from caption even though their sizes currently match. `text-mono-lg` and
  `text-mono-sm` are compatibility aliases for this same setting, not extra sizes.
- Caption uses 12/16 and 0.0133em tracking. Default reading text is 16/24.
- Preserve text preferences and browser zoom. Author values in scaled rem and
  keep layout geometry independent of text scaling.

Typography provenance: the ramp and role settings derive from the pinned
[Block UI typography specification](https://github.com/squareup/design-blockinterface/blob/eff766161ba8aaee3258ca107f0d904dd542c708/blockUI/docs/type.resolution.draft.json).
The values documented above define this system, including the 12px xsmall role.

## Both modes

- **Design in both modes, not in light and then dark.** Dark is not a filter applied afterwards: elevation, glass, and accent text all behave differently there.
- **Accent text moves in opposite directions between modes.** Darker than its fill on a light background, lighter on a dark one.
- **A tint is a pale wash in light mode and a deep one in dark.** The name describes the job, not the lightness.
- **Check the pairing, not the swatch.** A colour is only right in the context of what sits on it and behind it.
- **Every dark value in this system is authored rather than observed.** The design exploration it came from is light-only. Treat anything that looks wrong in dark as a finding.

## Density and rhythm

- **Scrollbars share one native treatment.** Use `scrollbar-width: thin` and
  `scrollbar-color: var(--scrollbar-thumb) transparent`. The thumb is gray in
  both modes. Load the shared scrollbar recipe into vendor shadow roots too;
  let the browser own scrolling and scrollbar visibility.

- **Dense data renders as rows with dividers, edge to edge.** Wrapping every list item in its own card is the most common way a functional surface becomes a marketing page.
- **Content that separates itself needs no divider, and no container.** A divider is for uniform rows where the eye needs a line to track along. When each entry already carries a visible difference — a colour swatch, a type specimen, an avatar — the content is the separator, and adding a rule or a card on top is redundant structure. Space alone is enough.
- **Never judge a value against a surface it will not be used on.** A swatch on a grey fill, or a type specimen in a tinted box, is being evaluated in a context the product will never reproduce. Samples sit on the page. The one exception is a value that needs a backdrop to exist at all — translucency needs something behind it, and a white surface swatch needs a hairline or it renders as nothing.
- **Cards are for widgets, galleries, and settings groups.** A card is a bordered, padded region on the page, not a different depth.
- **A card carries no default fill.** It sits on `bg-panel` and is grouped by a hairline or by spacing. Fill on a card is reserved for `bg-hover`, and only where the card is actually clickable — so a filled card always means *you are pointing at this*, never merely *this is a box*. This is why there is no `bg-card` role: a card with no default fill needs no name. It also rules out the cards-in-cards look, where a filled card inside a filled panel reads as a stack of empty text fields. Reaching for `bg-inset` here is the specific mistake — `inset` means pushed in, like an input or a code block, which is the opposite gesture from grouping.
- **Pick the frame before the content.** Decide what the surface is — a list, a reading column, a workspace — before filling it.
- **Whitespace is generous by default.** Crowding reads as a different product.

## Motion

- **Direct manipulation follows the pointer exactly, with no easing.** Smoothing during a drag or resize reads as lag. Spring physics belongs to what happens after release.
- **A drag gesture must not select text in whatever it passes over.**
- **Never animate blur.** Re-blurring a large surface every frame is expensive enough to feel. Animate opacity instead.
- **Motion explains a change; it does not decorate one.** If removing an animation loses no information, remove it.

## Colour structure

The palette supplies values. Semantic roles name their purpose. Components and
screens consume those roles so one shared edit can change every caller.

| Layer | Example | Used by |
|---|---|---|
| **Palette** | `--purple-9`, `--neutral-4` | Shared token definitions; each hue has authored light and dark steps. |
| **Roles** | `--surface-panel`, `--text-danger`, `--affordance-subtle-hover` | Component recipes and product screens. |
| **Components** | Button, TextField, Dialog | Product features that need the same appearance and behavior. |

Choose a role by its job, even when it uses the same palette step in both modes.
Add roles for real uses and their required states; document the intended surfaces
and paired text. Do not generate unused role families from every palette hue.
Existing palette utilities and older role names are compatibility APIs while
callers migrate, not the default for new UI. Tailwind's stock palette is removed.

### Changing a color

Change a semantic mapping when one job needs a different value. Change a palette
step when its value is wrong for all roles that share it. Measure the actual
pairings in both themes; a numbered step alone does not guarantee contrast.
For example, warning boundaries use amber-11 in light mode and amber-9 in dark,
because the lighter amber steps cannot identify a control against a light panel.

Palette values are based on Radix Colors (MIT), with authored neutral ramps and
documented adjustments in `tokens.css`. These are values, not a component or
behavior dependency. Base UI remains the component behavior layer.

### Naming and usage

Use purpose, emphasis and state: `surface-panel`, `text-subtle`, `border-danger`,
`affordance-prominent-pressed`. Text and border roles register in their own
Tailwind namespaces so a border cannot accidentally inherit a text color.

- Use `text-danger` for error text and pair it with the documented surface.
- Add a categorical role when a feature needs to distinguish identities by hue.
- Keep transparency in shared material recipes. Do not dim tokens locally.
- Author both light and dark values; do not derive one by dimming the other.
- When two roles share a decision, reference the same token rather than copying a literal.

## Contrast

Buzz judges text contrast with **APCA** (the perceptual algorithm in the WCAG 3
draft). Control and state boundaries use the separate WCAG 2 non-text ratio. Target **Lc 60** for body text, Lc 45 for large
or non-essential text. This is a deliberate position, taken with evidence, and
it is the rule a generated theme is measured against.

- **Why.** The WCAG 2 ratio underweights blue and ignores polarity, so it
  systematically recommends dark text on saturated mid-tone fills where light
  text is plainly more readable. Measured: white on `#3b82f6` scores WCAG 3.68
  (fail) but APCA Lc 69 (pass); black on the same fill scores WCAG 5.71 (pass)
  but Lc 40 — badly unreadable. Apple ships white on `#0088ff`–`#3daefc` in
  Messages at WCAG 2.4–3.5, and Tailwind, Bootstrap, and Radix all ship white
  on their primary blue below or near the WCAG threshold. Three independent
  signals agree with the eye; one number disagrees with all of them.
- **APCA is not the looser choice.** It is stricter wherever WCAG 2 is
  permissive: red on black (WCAG 5.25 pass, Lc 38 fail) and every dark-mode
  mid-grey. Adopting it tightens more pairings than it relaxes.
- **Report both.** WCAG 2 is what an audit measures and what regulators
  recognise today. Design to APCA, and know the WCAG number before shipping a
  surface that will be scanned. Where they disagree, say so in the change.
- **Constrain the fill, never degrade the text.** If neither black nor white
  carries a fill legibly, the fill is wrong — it is not a valid solid. Move the
  fill's lightness and keep the hue; do not settle for the less-bad text.
- **A paired text token is derived, not authored.** `text-on-*` is a function of
  its fill, so it is generated with the fill and never hand-set. Every hand-set
  pairing in this system has been wrong at least once.
- **One implementation of the rule.** Desktop, mobile, and web must not each
  compute their own pairing; they diverge and the same defect ships three times.
- **Size a text step against the worst surface it can land on**, not the most
  common one. `bg-float` is the lightest dark surface, so it is the binding case
  in dark mode; a step that only clears the target on `bg-inset` fails wherever
  a popover opens.
- **Dark mode is not light mode inverted.** APCA is polarity-asymmetric:
  light-on-dark needs more separation than the same WCAG ratio suggests. The
  dark ramp's text steps are therefore lighter than a mirrored ramp would put
  them — steps 9 and 10 sit above where linear spacing would.
- **`text-disabled` is deliberately below target.** Low contrast is the signal
  that a control is unavailable. Never put information a person needs there.
- **`pnpm design:check` enforces this.** Every text role is measured against
  every surface it can sit on, in both modes, parsed from `tokens.css` so the
  check cannot drift from the tokens. Exceptions live in that script with a
  stated reason, which keeps the list short and arguable.
- **A tint's hover is the hardest surface an identity has**, so a `text-*` role is
  sized against that rather than against the neutral panel. Every failure the
  audit found on a coloured surface was on a tint-hover, never at rest.
- **Hairline dividers are not held to a contrast target.** WCAG's 3:1 non-text
  rule covers boundaries needed to identify a *control* or its state, not
  grouping lines. Buzz's borders measure 1.2–1.8:1, which is where Radix and
  Apple ship theirs; raising them would draw the box the fill already implies.
  Error and warning boundary roles must reach 3:1 against surface-base,
  surface-panel, surface-inset and surface-popover in both themes. The contrast
  guard checks these role mappings and status dots separately from text and
  decorative dividers.

### Link contrast

Inline links and mentions use Blue 11 text with Blue 3 hover in both modes.
This is an explicitly approved visual tradeoff: the brighter link color is
preferred to Blue 12, and Blue 3 makes the hover fill more visible than Blue 2,
even where these choices fall below the ordinary contrast target.
It is not a claim of WCAG AA conformance on every supported surface.

The contrast guard accepts only these eight exact mode/role/color pairings:

| Mode | Surface role | Text / surface | APCA Lc | WCAG ratio |
| --- | --- | --- | ---: | ---: |
| Light | affordance-selected | #0d74ce / #e8e8e8 | 58.831 | 3.889 |
| Light | neutral-4 | #0d74ce / #dadada | 50.774 | 3.409 |
| Dark | surface-panel | #70b8ff / #1a1a1a | 59.953 | 8.279 |
| Dark | surface-popover | #70b8ff / #333333 | 55.433 | 6.010 |
| Dark | affordance-subtle | #70b8ff / #333333 | 55.433 | 6.010 |
| Dark | affordance-selected | #70b8ff / #333333 | 55.433 | 6.010 |
| Dark | neutral-4 | #70b8ff / #232323 | 58.707 | 7.476 |
| Dark | affordance-link-hover | #70b8ff / #0d2847 | 57.791 | 7.076 |

Each accepted shortfall is printed with its measurements. Changed colors and
other roles/surfaces remain subject to the normal APCA target; unused exceptions
are reported for removal. The target stays Lc 60. Blue 3 hover in light mode
(#0d74ce on #e6f4fe) clears APCA at Lc 64.614 but falls below WCAG 4.5:1
at 4.252:1; this is also an accepted visual tradeoff.
Light base/inset/subtle surfaces clear APCA but remain below WCAG
4.5:1 at 4.374:1. Focus appearance and link-identification cues are separate
contracts; this color choice does not change them.

## Writing

- **Every word earns its place.** Prefer the shortest phrasing that stays accurate.
- **Labels say what happens, not what the thing is called internally.**
- **Empty states say what this place is for and what to do next.** An empty state is a first impression, not an error.
- **Errors say what happened and what to do about it.** A message the person cannot act on is decoration.

## Accessibility

- **Every interactive element has explicit assistive semantics, and one owner per label.** Two widgets claiming the same label produces duplicate screen-reader stops.
- **Contrast comes from the paired token, not from judgement.** Where a background is not neutral, its text is named for it.
- **Keyboard, pointer, and shortcut paths must not diverge.** When adding an input handler, enumerate the ways a person can reach it and check the ones that are not the mouse.
- **Focus rings are for keyboard navigation, not pointer navigation.** Gate every authored focus treatment with `html[data-keyboard-navigation]` and `:focus-visible`; the app-root input-modality owner supplies that attribute. Mouse, pen, and touch focus stays quiet, including programmatic focus during a drag. Keyboard focus remains clearly visible on the control itself.
- **Colour is never the only carrier of meaning by default.** Pair it with text, shape, or position. The solid avatar status badges in [Identity shapes](#identity-shapes) are an intentional product exception; preserve their solid fills and expose known status through the owning accessible label or description.

## Responsiveness

- **Design for narrow, intermediate, and wide, not just wide.** Intermediate widths are where layouts usually break.
- **Text scales with the person's preference and with zoom.** Anything readable uses relative units; fixed pixel text freezes and breaks zoom.

## Growing the system

1. Use an existing component before assembling its appearance yourself.
2. Choose a semantic role by purpose. Add a state sibling when the actual control needs it.
3. Keep each new role paired in both modes, document it in the token registry, and check contrast.
4. Fix shared decisions in their owner. Do not cancel shared styles from a feature stylesheet.
5. Keep layout, media geometry, editor semantics and data behavior with their product owner.

## Components

- **Compose existing components freely. Never reimplement one.**
- **Focus is keyboard-only visual navigation.** Pointer focus stays quiet; keyboard navigation gives the focused control—not its container—a visible focus ring. Browsers can retain `:focus-visible` after programmatic focus too, so every component focus treatment must explicitly require `html[data-keyboard-navigation]`; do not rely on the base-layer reset to defeat a component-layer outline or shadow. Never add a `:focus-within` focus ring to a container: it duplicates the child control's signal and makes pointer focus noisy.
- **Base UI is the behavior layer.** Before writing an interactive shared component, inspect Base UI for the matching primitive. When one exists, wrap and compose it; Base UI owns focus, keyboard behavior, positioning, portals, and dismissal, while Buzz owns the visual language and product semantics. Reach for native elements only when Base UI has no matching primitive or the component is semantically static.
- **Need a variant that doesn't exist? Add it, mark it proposed.** If a variant almost fits but you would cancel several of its states, the base is wrong for the job and the system is missing a variant.
- **Never add a boolean prop for a visual difference.** Variants are enumerable, so an agent can read the list and pick; booleans multiply, and nobody designed most of the combinations. New props are for data and behaviour, not appearance.
- **Used by one feature? It lives in that feature's folder.** Used by two? Propose it as shared. The folder is the namespace.

## Using the system

- **Use an existing component before creating one, and an existing role before adding one.**
- **A new visual treatment that repeats belongs in the system, not in the feature.**
- **If a shared role fails in a real context, repair the role — never work around it locally.** A documentation specimen frame needed a border but `border-primary` was neutral-4 in both modes, which measured 1.08:1 on the dark page. The wrong response was the one we made first: name `neutral-6` directly and call documentation furniture a special case. The right response was to ask whether the one shared boundary role was wrong, measure it on every surface it reaches, and make it `neutral-4` light / `neutral-6` dark. The frame then returned to `border-primary`, and every product divider improved with it. **A local exception is evidence the shared decision is incomplete, not a licence to bypass it.**
- **Choose the job first.** Page → surface-base; card → surface-panel; popup → surface-popover; recessed region → surface-inset. Controls use affordance roles; labels use text roles; edges use border roles.
- **A role is useful because it names a purpose.** It does not need different palette steps in each theme to earn its name.
- **If a screen looks right but breaks these rules, the rules are probably wrong — say so.** This document is meant to be argued with, not worked around.

## Icons

Phosphor is the only general icon family. Import named icons from `icons/index.ts`, which re-exports individual upstream modules. Add exports as needed; no approval list. SVG-only widgets use individual assets through `icons/svg.ts`. Do not import the upstream packages elsewhere or reintroduce other icon libraries. All six native weights remain designer choices: no size-to-weight or selection-to-fill rules. For chat and conversation metaphors, prefer the rounded `ChatCircle` family (including `ChatsCircle`) over square or teardrop variants; choose the matching dots, text, or slash variant when the meaning requires it. Keep accessible names on controls and decorative artwork hidden from assistive technology.

OneDrive is a designer-approved custom brand mark: its complete outline is recreated on Phosphor’s square canvas, uses the same current-color and sizing behavior, and stays in the shared icon gateway. It does not permit another general icon library.

### Picker search and choices

Mention and media pickers opt into `SearchField variant="capsule"`. Its shared
`search-field.css` recipe also styles Emoji Mart inside its shadow root: body-sm
typography, pill radius, standard panel fill, Phosphor icons, and a 32px clear
action. Other SearchField callers retain the default field treatment. Scrolling
picker results use the opt-in `buzz-thin-scrollbar` native scrollbar recipe.

Mention choices use `NavigationItem variant="option"` with 8px padding and
immediate hover/focus feedback. The picker owns arrow-key navigation and exact
identity selection; rows retain ordinary button semantics.
