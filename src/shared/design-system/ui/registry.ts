export type ComponentStatus = "core" | "proposed";

/** Documentation location, independent from the source folder. */
export type ComponentCollection = "components" | "product-ui";

/**
 * A Base UI part a component is built on. `name` is the export as documented;
 * `docs` is the path segment on base-ui.com/react/components, and `module` is
 * the import specifier, so the two cannot be claimed independently of the code.
 */
export type BaseUiPart = {
  name: string;
  docs: string;
  module: string;
};

export const BASE_UI_PARTS = {
  alertDialog: {
    name: "Alert Dialog",
    docs: "alert-dialog",
    module: "@base-ui/react/alert-dialog",
  },
  radio: { name: "Radio", docs: "radio", module: "@base-ui/react/radio" },
  radioGroup: {
    name: "Radio Group",
    docs: "radio-group",
    module: "@base-ui/react/radio-group",
  },
  checkbox: {
    name: "Checkbox",
    docs: "checkbox",
    module: "@base-ui/react/checkbox",
  },
  avatar: { name: "Avatar", docs: "avatar", module: "@base-ui/react/avatar" },
  button: { name: "Button", docs: "button", module: "@base-ui/react/button" },
  contextMenu: {
    name: "Context Menu",
    docs: "context-menu",
    module: "@base-ui/react/context-menu",
  },
  field: { name: "Field", docs: "field", module: "@base-ui/react/field" },
  input: { name: "Input", docs: "input", module: "@base-ui/react/input" },
  menu: { name: "Menu", docs: "menu", module: "@base-ui/react/menu" },
  select: { name: "Select", docs: "select", module: "@base-ui/react/select" },
  combobox: {
    name: "Combobox",
    docs: "combobox",
    module: "@base-ui/react/combobox",
  },
  switch: { name: "Switch", docs: "switch", module: "@base-ui/react/switch" },
  tabs: { name: "Tabs", docs: "tabs", module: "@base-ui/react/tabs" },
  accordion: {
    name: "Accordion",
    docs: "accordion",
    module: "@base-ui/react/accordion",
  },
  toast: { name: "Toast", docs: "toast", module: "@base-ui/react/toast" },
  tooltip: {
    name: "Tooltip",
    docs: "tooltip",
    module: "@base-ui/react/tooltip",
  },
  dialog: { name: "Dialog", docs: "dialog", module: "@base-ui/react/dialog" },
  popover: {
    name: "Popover",
    docs: "popover",
    module: "@base-ui/react/popover",
  },
  previewCard: {
    name: "Preview Card",
    docs: "preview-card",
    module: "@base-ui/react/preview-card",
  },
} as const satisfies Record<string, BaseUiPart>;

export const BASE_UI_DOCS_ROOT = "https://base-ui.com/react/components";

export function baseUiDocsUrl(part: BaseUiPart): string {
  return `${BASE_UI_DOCS_ROOT}/${part.docs}`;
}

export type ComponentDefinition = {
  slug: string;
  name: string;
  purpose: string;
  behavior: string;
  variants: readonly string[];
  status: ComponentStatus;
  /** Where this component appears in the design-system navigation. */
  collection: ComponentCollection;
  owner?: string;
  /**
   * The component whose frame this component belongs inside in the design
   * system navigation. This is documentation hierarchy, not an import graph:
   * a child remains independently usable and documented on its own page.
   */
  parent?: string;
  /** The file this component lives in, relative to `src/`. */
  source: string;
  /**
   * The Base UI parts this component imports itself. Empty means it is built
   * from native elements — which is a legitimate answer, not a gap: a header,
   * a section, and a surface have no behaviour to inherit.
   */
  baseUi: readonly BaseUiPart[];
  /**
   * Sibling components it composes, by slug. A component with no Base UI part
   * of its own can still inherit behaviour through one of these.
   */
  composes: readonly string[];
};

export const COMPONENTS: readonly ComponentDefinition[] = [
  {
    slug: "calendar",
    name: "Calendar",
    purpose: "Choose a date using a month grid.",
    behavior:
      "React DayPicker owns calendar arithmetic and keyboard navigation; Buzz owns styling and Phosphor navigation icons.",
    variants: ["single date", "selected", "today", "disabled dates"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Calendar.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "field-button",
    name: "FieldButton",
    purpose: "Open a picker with the same shape and inset as a text field.",
    behavior: "Base UI Button composes with menu and popover triggers.",
    variants: ["default", "disabled", "expanded"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/FieldButton.tsx",
    baseUi: [BASE_UI_PARTS.button],
    composes: [],
  },
  {
    slug: "toast",
    name: "Toast",
    purpose:
      "Compact feedback without moving the page or hiding recovery actions.",
    behavior:
      "Base UI owns announcements, focus, expiry and dismissal; unresolved recovery stays visible",
    variants: ["transient", "actionable", "dismissible"],
    status: "core",
    collection: "components",
    source: "shared/design-system/ui/Toast.tsx",
    baseUi: [BASE_UI_PARTS.toast],
    composes: ["icon-button"],
  },
  {
    slug: "alert-dialog",
    name: "AlertDialog",
    purpose: "Confirm a consequential action before continuing.",
    behavior: "Base UI owns modal focus and alert-dialog semantics",
    variants: ["default", "pending"],
    status: "core",
    collection: "components",
    source: "shared/design-system/ui/AlertDialog.tsx",
    baseUi: [BASE_UI_PARTS.alertDialog],
    composes: [],
  },
  {
    slug: "tooltip",
    name: "Tooltip",
    purpose: "A short hint for an already labelled control.",
    behavior: "Base UI owns focus, positioning and dismissal",
    variants: ["default"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Tooltip.tsx",
    baseUi: [BASE_UI_PARTS.tooltip],
    composes: [],
  },

  {
    slug: "dialog",
    name: "Dialog",
    purpose: "A shared modal frame with title, content and actions.",
    behavior:
      "Base UI owns focus, positioning, dismissal and transition presence; shared motion tokens animate entry and exit",
    variants: ["default", "expanded", "motion none"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Dialog.tsx",
    baseUi: [BASE_UI_PARTS.dialog],
    composes: ["icon-button"],
  },

  {
    slug: "checkbox",
    name: "Checkbox",
    purpose: "Choose an independent option.",
    behavior: "Base UI owns form and keyboard semantics",
    variants: ["default", "disabled", "invalid"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Checkbox.tsx",
    baseUi: [BASE_UI_PARTS.checkbox],
    composes: [],
  },

  {
    slug: "radio-group",
    name: "RadioGroup",
    purpose: "Choose one option, including labelled settings cards.",
    behavior: "Base UI owns form and keyboard semantics",
    variants: ["default", "disabled", "invalid"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/RadioGroup.tsx",
    baseUi: [
      BASE_UI_PARTS.radioGroup,
      BASE_UI_PARTS.radio,
      BASE_UI_PARTS.field,
    ],
    composes: [],
  },

  {
    slug: "textarea",
    name: "Textarea",
    purpose: "A multiline field with shared label and validation behavior.",
    behavior: "Base UI owns form and keyboard semantics",
    variants: ["default", "disabled", "invalid"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Textarea.tsx",
    baseUi: [BASE_UI_PARTS.field],
    composes: [],
  },

  {
    slug: "input",
    name: "Input",
    purpose: "A single-line text field.",
    behavior: "Base UI owns form and keyboard semantics",
    variants: ["default", "disabled", "invalid"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Input.tsx",
    baseUi: [BASE_UI_PARTS.input],
    composes: [],
  },

  {
    slug: "field",
    name: "Field",
    purpose: "Label, description and error for a form control.",
    behavior: "Base UI owns form and keyboard semantics",
    variants: ["default", "disabled", "invalid"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Field.tsx",
    baseUi: [BASE_UI_PARTS.field],
    composes: [],
  },

  {
    slug: "swap-workspace",
    name: "Panel Swap",
    purpose:
      "Custom two-panel movement experiment. The actual panel follows the pointer, its neighbor slides into the vacated position after halfway, and release settles the panel into place. Resize continuously between them; widths and heights are remembered separately. A single directional edge cue previews switching between side-by-side and vertical arrangements; orientation and size change only on release. Drag empty header space to rearrange, or drag the title onto the other header to preview combining as tabs. A translucent purple title pill follows tab drags while both panes stay in place. A purple insertion line marks the destination header; release combines the panes in one layout update. Drag a combined tab toward an edge to separate it with a black directional cue. Only movement animates; resizing and structural size changes are immediate. No full-pane overlay or timed hold.",
    behavior:
      "Pointer capture, live transforms, keyboard swapping, and Base UI separator semantics",
    variants: ["two panels"],
    status: "proposed",
    collection: "product-ui",
    owner: "desktop-new Workspace",
    source: "shared/design-system/ui/SwapWorkspaceExperiment.tsx",
    baseUi: [
      {
        name: "Separator",
        docs: "separator",
        module: "@base-ui/react/separator",
      },
    ],
    composes: ["panel", "button", "tabs"],
  },
  {
    slug: "flex-workspace",
    name: "Flex Layout",
    purpose:
      "Compare standard FlexLayout docking with the existing Dockview workspace. Blank panels with rounded tabs and Buzz colors; no custom drag handles or placement restrictions.",
    behavior: "FlexLayout tabs, docking, and resizing",
    variants: ["native docking"],
    status: "proposed",
    collection: "product-ui",
    owner: "desktop-new Workspace",
    source: "shared/design-system/ui/FlexWorkspace.tsx",
    baseUi: [],
    composes: ["button"],
  },
  {
    slug: "workspace",
    name: "DocView",
    purpose:
      "Arrange panels with continuous resizing and purple edge-drop highlights. Navigation stays anchored at the upper left; a panel may sit below it. Only splits that leave both panels usable are offered. No presets or tab stacking.",
    behavior: "Dockview pointer dragging and resize",
    variants: ["split-only"],
    status: "proposed",
    collection: "product-ui",
    owner: "desktop-new Workspace",
    source: "shared/design-system/ui/BentoWorkspace.tsx",
    baseUi: [],
    composes: ["panel-header"],
  },
  {
    slug: "preference-row",
    name: "PreferenceRow",
    purpose:
      "A settings row with an optional icon, title, subtitle, and trailing control or status.",
    behavior:
      "The row supplies control label associations; trailing controls own interaction and state.",
    variants: [
      "title",
      "subtitle",
      "icon",
      "switch",
      "checkbox",
      "button",
      "status",
      "disabled",
    ],
    status: "proposed",
    collection: "components",
    owner: "Buzz Settings",
    source: "shared/design-system/ui/PreferenceRow.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "switch",
    name: "Switch",
    purpose: "A labelled setting that is on or off.",
    behavior: "Base UI owns checked state and keyboard behavior",
    variants: ["off", "on", "disabled", "visible or accessible-only label"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/Switch.tsx",
    baseUi: [BASE_UI_PARTS.switch],
    composes: [],
  },
  {
    slug: "button",
    name: "Button",
    purpose:
      "A bounded capsule-shaped, single-line action with shared emphasis, loading and destructive states.",
    behavior: "Base UI Button",
    variants: [
      "prominent",
      "subtle",
      "ghost",
      "destructive",
      "outline",
      "inverted",
      "link",
      "size: xs | sm | md | lg",
      "loading",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Button.tsx",
    baseUi: [BASE_UI_PARTS.button],
    composes: [],
  },
  {
    slug: "icon-button",
    name: "IconButton",
    purpose: "A compact icon-only action that always owns an accessible label.",
    behavior: "Composes Buzz Button",
    variants: [
      "prominent",
      "subtle",
      "ghost",
      "inverted",
      "destructive",
      "outline",
      "link",
      "tint",
      "chrome",
      "avatar",
      "media",
      "shape: round (default) | control",
      "size: xs (20px, 12px icon) | sm (32px) | md (40px) | lg (52px)",
      "legacy aliases: quiet, solid, compact, toolbar, default, large",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/IconButton.tsx",
    baseUi: [],
    composes: ["button"],
  },
  {
    slug: "avatar",
    name: "Avatar",
    purpose:
      "A person or agent identity image with a stable fallback. Circle by default; callers can select the proposed squircle shape from display-only agent evidence.",
    behavior: "Base UI Avatar",
    variants: ["small", "default", "large", "fill", "circle", "squircle"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Avatar.tsx",
    baseUi: [BASE_UI_PARTS.avatar],
    composes: [],
  },
  {
    slug: "preview-card",
    name: "PreviewCard",
    purpose:
      "A portal-rendered, non-modal preview of an object's already-available context.",
    behavior:
      "Base UI Preview Card; optional destination anchor supports pointer and keyboard activation",
    variants: ["default", "destination"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/PreviewCard.tsx",
    baseUi: [BASE_UI_PARTS.previewCard],
    composes: [],
  },
  {
    slug: "inline-chip",
    name: "InlineChip",
    purpose:
      "A reference to a person, agent, channel, message, or link shown inline in a sentence.",
    behavior: "Semantic native button or image role",
    variants: [
      "person",
      "agent",
      "channel",
      "message",
      "link",
      "resolved preview",
      "loading",
      "unresolved",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/InlineChip.tsx",
    baseUi: [],
    composes: ["preview-card"],
  },
  {
    slug: "full-page-surface",
    name: "FullPageSurface",
    purpose:
      "The optional single rounded surface filling a page’s available workspace. Pages with multi-panel composition do not use it.",
    behavior:
      "Semantic native region; the page owns content padding, scrolling, alignment, and composition",
    variants: ["full workspace"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/FullPageSurface.tsx",
    baseUi: [],
    composes: ["panel"],
  },
  {
    slug: "panel",
    name: "Panel",
    purpose:
      "An independently legible workspace surface sitting on the atmospheric workspace backdrop. It owns only the rounded surface — fill, border, shadow, and clipping — never a header, content, or resize behaviour.",
    behavior: "Semantic native region",
    variants: ["panel"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Panel.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "tabs",
    name: "Tabs",
    purpose:
      "A single-select switch between sibling views. `chrome` is the glass pill for the app gradient; `panel` is an underline for a plain surface; `workspace` is quiet title tabs for a combined pane. One component because only the surface differs — the behaviour, keyboard model, and props are identical.",
    behavior: "Base UI Tabs",
    variants: ["chrome", "panel", "workspace"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Tabs.tsx",
    baseUi: [BASE_UI_PARTS.tabs],
    composes: [],
  },
  {
    slug: "header",
    name: "Header",
    purpose:
      "Content title with optional subtitle, eyebrow, icon and actions; compact InlineHeader for groups.",
    behavior: "Semantic heading with caller-selected level",
    variants: ["header", "inline"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Header.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "panel-header",
    name: "PanelHeader",
    purpose:
      "A panel's header row: optional icon, title, and actions. It composes controls supplied through actions but owns neither the panel container nor the content below it.",
    behavior: "Semantic native header",
    variants: ["default", "compact"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    parent: "panel",
    source: "shared/design-system/ui/PanelHeader.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "search-field",
    name: "SearchField",
    purpose: "A compact filter field with a search cue and clear action.",
    behavior: "Base UI Field and Input",
    variants: ["default", "capsule"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/SearchField.tsx",
    baseUi: [BASE_UI_PARTS.input],
    composes: ["field", "icon-button"],
  },
  {
    slug: "composer",
    name: "Composer",
    purpose:
      "The message drafting frame: editable content, contextual information, tools, send state and delivery feedback.",
    behavior:
      "Native form and textarea semantics; product capabilities supply rich editing and tool behavior",
    variants: [
      "empty",
      "draft",
      "multiline",
      "context",
      "sending",
      "error",
      "disabled",
      "narrow",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/Composer.tsx",
    baseUi: [],
    composes: ["icon-button"],
  },
  {
    slug: "navigation-section",
    name: "NavigationSection",
    purpose: "A named group of related rows in a dense workspace navigator.",
    behavior: "Semantic native section",
    variants: ["default"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/NavigationSection.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "navigation-item",
    name: "NavigationItem",
    purpose:
      "A selectable destination row or pill with optional icon and metadata.",
    behavior: "Base UI Button",
    variants: ["row", "pill", "option", "inset", "selected"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Messages",
    source: "shared/design-system/ui/NavigationItem.tsx",
    baseUi: [BASE_UI_PARTS.button],
    composes: [],
  },
  {
    slug: "accordion",
    name: "Accordion",
    purpose: "Reveal related content without leaving the page.",
    behavior:
      "Base UI owns expansion, keyboard activation, and panel semantics; keepMounted preserves local form state while collapsed",
    variants: [
      "default",
      "form",
      "navigation",
      "activity",
      "controlled expansion",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/Accordion.tsx",
    baseUi: [BASE_UI_PARTS.accordion],
    composes: [],
  },
  {
    slug: "combobox",
    name: "Combobox",
    purpose:
      "A searchable form field with an integrated browse control and shared option popup.",
    behavior:
      "Base UI owns keyboard navigation and selection; callers own filtering, custom values and async discovery",
    variants: ["default", "loading", "disabled"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Combobox.tsx",
    baseUi: [BASE_UI_PARTS.combobox],
    composes: ["field", "icon-button"],
  },
  {
    slug: "popover",
    name: "Popover",
    purpose:
      "An anchored surface for supporting details, short forms, and interactive content.",
    behavior:
      "Base UI owns positioning, focus restoration and dismissal; feature code owns content and state",
    variants: ["content", "list", "none", "compact", "wide"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/Popover.tsx",
    baseUi: [BASE_UI_PARTS.popover],
    composes: [],
  },
  {
    slug: "choice-row",
    name: "ChoiceRow",
    purpose:
      "A label, optional description, leading artwork and trailing detail inside a choice.",
    behavior:
      "Presentational content; the containing control owns selection, interaction and semantics",
    variants: ["label", "description", "icon", "avatar", "trailing detail"],
    status: "proposed",
    collection: "components",
    source: "shared/design-system/ui/ChoiceRow.tsx",
    baseUi: [],
    composes: [],
  },
  {
    slug: "menu",
    name: "Menu",
    purpose: "Present contextual actions and choices from a compact trigger.",
    behavior:
      "Base UI owns positioning, dismissal, keyboard navigation, selection, and nested submenus",
    variants: [
      "actions",
      "compact",
      "links",
      "checkbox choices",
      "radio choices",
      "nested submenus",
    ],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/Menu.tsx",
    baseUi: [BASE_UI_PARTS.menu, BASE_UI_PARTS.contextMenu],
    composes: [],
  },
  {
    slug: "select",
    name: "Select",
    purpose:
      "A labelled choice with inline, compact row and full-width form layouts.",
    behavior: "Base UI owns focus, keyboard selection, grouping, and dismissal",
    variants: ["inline", "compact", "field", "disabled"],
    status: "proposed",
    collection: "components",
    owner: "desktop-new Design system",
    source: "shared/design-system/ui/Select.tsx",
    baseUi: [BASE_UI_PARTS.select],
    composes: ["field", "button"],
  },
];

/**
 * What a component is actually built on, once composition is followed.
 *
 * `own` is what the file itself imports from Base UI. `inherited` is what it
 * gets through a sibling — IconButton has no Base UI import of its own, but it
 * renders a Buzz Button, so Base UI Button's behaviour is still underneath it.
 * Reporting only `own` would call that component unbacked, which is wrong; not
 * distinguishing them would hide where the dependency actually enters.
 */
export type BaseUiBacking = {
  own: readonly BaseUiPart[];
  inherited: readonly { part: BaseUiPart; through: string }[];
};

export function resolveBaseUiBacking(slug: string): BaseUiBacking {
  const byPart = new Map<string, { part: BaseUiPart; through: string }>();
  const root = COMPONENTS.find((candidate) => candidate.slug === slug);
  if (!root) return { own: [], inherited: [] };

  // Bounded by the registry itself, and `seen` makes a cycle terminate rather
  // than recurse — a component composing a component that composes it back is a
  // mistake we would rather see as a missing row than a hung page.
  const seen = new Set<string>([slug]);
  const queue = [...root.composes];

  while (queue.length > 0) {
    const nextSlug = queue.shift();
    if (!nextSlug || seen.has(nextSlug)) continue;
    seen.add(nextSlug);

    const next = COMPONENTS.find((candidate) => candidate.slug === nextSlug);
    if (!next) continue;

    for (const part of next.baseUi) {
      if (!byPart.has(part.name))
        byPart.set(part.name, { part, through: next.name });
    }
    queue.push(...next.composes);
  }

  // A part imported directly is reported once, as its own — not twice because a
  // composed sibling happens to use it too.
  for (const part of root.baseUi) byPart.delete(part.name);

  return { own: root.baseUi, inherited: [...byPart.values()] };
}
