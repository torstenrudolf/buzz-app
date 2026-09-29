import { Calendar } from "../../../../src/shared/design-system/ui/Calendar";
import { FieldButton } from "../../../../src/shared/design-system/ui/FieldButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../../../src/shared/design-system/ui/Menu";
import {
  MenuSpecimen,
  PopoverSpecimen,
  ChoiceRowSpecimen,
} from "./MenuSpecimens";
import {
  Header,
  InlineHeader,
} from "../../../../src/shared/design-system/ui/Header";
import {
  InputExamples,
  TextareaExamples,
  SearchExamples,
  SelectExamples,
  ComboboxExamples,
} from "./FormSpecimens";
import { ToastSpecimens } from "./ToastSpecimens";
import { ButtonSpecimen, IconButtonSpecimen } from "./ButtonSpecimens";
import { AlertDialog } from "../../../../src/shared/design-system/ui/AlertDialog";
import { DialogSpecimens } from "./DialogSpecimens";
import { Tooltip } from "../../../../src/shared/design-system/ui/Tooltip";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import { Textarea } from "../../../../src/shared/design-system/ui/Textarea";
import {
  Radio,
  RadioGroup,
} from "../../../../src/shared/design-system/ui/RadioGroup";
import { Checkbox } from "../../../../src/shared/design-system/ui/Checkbox";
import avatarUrl from "../assets/avatar.png";
import { PanelSwapPlaygrounds } from "./PanelSwapPlaygrounds";
import { FlexWorkspace } from "../../../../src/shared/design-system/ui/FlexWorkspace";
import { BentoSpecimen } from "./BentoSpecimen";
import {
  DotsThreeIcon,
  HashIcon,
  ChatCircleIcon,
  PlusIcon,
} from "../../../../src/shared/design-system/icons/index";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { Switch } from "../../../../src/shared/design-system/ui/Switch";
import { PreferenceRow } from "../../../../src/shared/design-system/ui/PreferenceRow";
import { SwitchPreferenceRow } from "../../../../src/shared/design-system/ui/SwitchPreferenceRow";
import { Accordion } from "../../../../src/shared/design-system/ui/Accordion";

import { Avatar } from "../../../../src/shared/design-system/ui/Avatar";
import { InlineChip } from "../../../../src/shared/design-system/ui/InlineChip";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { NavigationItem } from "../../../../src/shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../../../src/shared/design-system/ui/NavigationSection";
import { PanelHeader } from "../../../../src/shared/design-system/ui/PanelHeader";
import { Tabs } from "../../../../src/shared/design-system/ui/Tabs";

import { ComponentAnatomy } from "./ComponentAnatomy";
import { Panel } from "../../../../src/shared/design-system/ui/Panel";
import { FullPageSurface } from "../../../../src/shared/design-system/ui/FullPageSurface";
import { PreviewCard } from "../../../../src/shared/design-system/ui/PreviewCard";
import type { ChipAddress } from "../../../../src/shared/design-system/chips/address";
import { chipFaces } from "../../../../src/shared/design-system/chips/faceResolver";
import { ComposerSpecimen } from "./ComposerSpecimen";

const DESTINATIONS = [
  { value: "home", label: "Home" },
  { value: "messages", label: "Messages" },
  { value: "projects", label: "Projects" },
] as const;

type Destination = (typeof DESTINATIONS)[number]["value"];

function CalendarSpecimen() {
  const [date, setDate] = useState(new Date());
  return <Calendar mode="single" required selected={date} onSelect={setDate} />;
}

function FieldButtonSpecimen() {
  const [duration, setDuration] = useState("Today");
  return (
    <MenuRoot>
      <MenuTrigger render={<FieldButton aria-label="Duration" />}>
        {duration}
      </MenuTrigger>
      <MenuPopup>
        <MenuRadioGroup value={duration} onValueChange={setDuration}>
          {["Today", "This week", "Custom"].map((item) => (
            <MenuRadioItem key={item} value={item}>
              {item}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </MenuRoot>
  );
}

function SpecimenFrame({
  children,
  backdrop = false,
}: {
  children: ReactNode;
  backdrop?: boolean;
}) {
  return (
    <div
      className="component-specimen-frame"
      data-backdrop={backdrop || undefined}
    >
      {children}
    </div>
  );
}

function SpecimenGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="component-specimen-group">
      <h2 className="text-body-sm text-tertiary">{label}</h2>
      <SpecimenFrame>{children}</SpecimenFrame>
    </section>
  );
}

/**
 * One sample with the prop that produced it printed underneath.
 *
 * A row of four icon buttons is unreadable without this — they differ only by
 * fill, so there is no way to tell which one is `solid` and which is `chrome`,
 * and the page is documentation. The caption names the prop as you would type
 * it (`variant="solid"`), not a prose paraphrase, so reading the page tells you
 * what to write.
 */
function Specimen({
  prop,
  children,
}: {
  /** As typed in JSX, e.g. `variant="quiet"`. Omit for a default. */
  prop?: string;
  children: ReactNode;
}) {
  return (
    <div className="component-specimen">
      {children}
      <code className="component-specimen-prop text-mono-sm text-tertiary">
        {prop ?? "default"}
      </code>
    </div>
  );
}

function AvatarSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup label="Identity shape: circles for humans, squircles for agents">
        <div className="component-specimen-row">
          <Specimen prop='shape="circle" · human'>
            <Avatar alt="Alex Lee" fallback="Alex" shape="circle" />
          </Specimen>
          <Specimen prop='shape="squircle" · agent'>
            <Avatar alt="Brain" fallback="Brain" shape="squircle" />
          </Specimen>
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Sizes">
        <div className="component-specimen-row">
          <Specimen prop='size="small"'>
            <Avatar
              src={avatarUrl}
              alt="Morgan Martin"
              fallback="Morgan"
              size="small"
            />
          </Specimen>
          <Specimen prop='size="default"'>
            <Avatar src={avatarUrl} alt="Morgan Martin" fallback="Morgan" />
          </Specimen>
          <Specimen prop='size="large"'>
            <Avatar
              src={avatarUrl}
              alt="Morgan Martin"
              fallback="Morgan"
              size="large"
            />
          </Specimen>
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Status badge and rounded cutout">
        <div className="component-specimen-row">
          {(["small", "default", "large"] as const).map((size) => (
            <Specimen key={size} prop={`${size} · online`}>
              <Avatar
                src={avatarUrl}
                alt="Morgan Martin"
                fallback="Morgan"
                size={size}
                statusBadge="online"
              />
            </Specimen>
          ))}
          {(["away", "offline"] as const).map((status) => (
            <Specimen key={status} prop={`large · ${status}`}>
              <Avatar
                src={avatarUrl}
                alt="Morgan Martin"
                fallback="Morgan"
                size="large"
                statusBadge={status}
              />
            </Specimen>
          ))}
          <Specimen prop="large · no badge">
            <Avatar
              src={avatarUrl}
              alt="Morgan Martin"
              fallback="Morgan"
              size="large"
            />
          </Specimen>
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Agent shape (proposed)">
        <div className="component-specimen-row">
          {(["small", "default", "large"] as const).map((size) => (
            <Specimen key={size} prop={`squircle · ${size} · online`}>
              <Avatar
                src={avatarUrl}
                alt="Agent artwork"
                fallback="Agent"
                shape="squircle"
                size={size}
                statusBadge="online"
              />
            </Specimen>
          ))}
          {(["away", "offline"] as const).map((status) => (
            <Specimen key={status} prop={`squircle · large · ${status}`}>
              <Avatar
                src={avatarUrl}
                alt="Agent artwork"
                fallback="Agent"
                shape="squircle"
                size="large"
                statusBadge={status}
              />
            </Specimen>
          ))}
          <Specimen prop='shape="squircle"'>
            <Avatar
              src={avatarUrl}
              alt="Agent artwork"
              fallback="Agent"
              shape="squircle"
            />
          </Specimen>
          <Specimen prop='shape="squircle", no src'>
            <Avatar alt="Agent fallback" fallback="Agent" shape="squircle" />
          </Specimen>
        </div>
      </SpecimenGroup>
      <LiveAvatarStatusSpecimen />
      {/* No `src`, so the fallback initial shows. Same three sizes, because a
          fallback has to hold the ramp as well as an image does. */}
      <SpecimenGroup label="Fallback, with no src">
        <div className="component-specimen-row">
          <Specimen prop='size="small"'>
            <Avatar alt="Cynthia Chen" fallback="Cynthia" size="small" />
          </Specimen>
          <Specimen prop='size="default"'>
            <Avatar alt="Cynthia Chen" fallback="Cynthia" />
          </Specimen>
          <Specimen prop='size="large"'>
            <Avatar alt="Cynthia Chen" fallback="Cynthia" size="large" />
          </Specimen>
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Fallback, after image failure">
        <Specimen prop="failed image">
          <Avatar
            src="data:image/png;base64,broken"
            alt="Morgan Martin"
            fallback="Morgan"
          />
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup label="Profile buttons">
        <div className="component-specimen-row">
          <IconButton
            aria-label="View Morgan profile"
            size="large"
            icon={
              <Avatar src={avatarUrl} alt="" fallback="Morgan" size="fill" />
            }
          />
          <IconButton
            aria-label="View Alex profile"
            size="large"
            icon={<Avatar alt="" fallback="Alex" size="fill" />}
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Fill an owning layout box">
        <div className="size-40 overflow-hidden rounded-2xl">
          <Avatar
            src={avatarUrl}
            alt="Morgan Martin"
            fallback="Morgan"
            size="fill"
          />
        </div>
      </SpecimenGroup>
    </div>
  );
}

function LiveAvatarStatusSpecimen() {
  const [status, setStatus] = useState<
    "online" | "away" | "offline" | undefined
  >();
  return (
    <SpecimenGroup label="Status transitions">
      <div className="component-specimen-row">
        <Avatar
          src={avatarUrl}
          alt="Live agent artwork"
          fallback="Agent"
          shape="squircle"
          size="large"
          statusBadge={status}
        />
        {(["online", "away", "offline"] as const).map((next) => (
          <Button key={next} size="compact" onClick={() => setStatus(next)}>
            Set {next}
          </Button>
        ))}
        <Button size="compact" onClick={() => setStatus(undefined)}>
          Clear status
        </Button>
      </div>
    </SpecimenGroup>
  );
}
function FullPageSurfaceSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup label="Single full-workspace surface">
        <div className="component-single-surface-demo">
          <FullPageSurface aria-label="Full page surface" />
        </div>
      </SpecimenGroup>
    </div>
  );
}

function PanelSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup label="Panel — the surface by itself">
        {/* No invented header or copy inside this specimen. Panel owns a surface,
            not what a product chooses to put on it, so an empty Panel is the
            honest live component. The gradient is the surrounding context it is
            designed to sit on, not content supplied by the specimen. */}
        <div className="component-single-surface-demo">
          <Panel aria-label="Panel surface" />
        </div>
      </SpecimenGroup>
    </div>
  );
}

/**
 * The parts of Tabs, per variant.
 *
 * Two lists rather than one, because the interesting fact is that the *same*
 * parts are drawn differently — the container and the tab carry no fill at all
 * in `panel`, and the indicator changes from a pill to a bar.
 */
const TABS_CHROME_PARTS = [
  {
    name: "Container",
    selector: ".buzz-tabs",
    show: ["background", "shadow", "blur", "radius"],
    note: "The glass material: fill, blur, and rim arrive together as glass-primary.",
  },
  {
    name: "Selection",
    selector: ".buzz-tabs-indicator",
    show: ["background", "shadow", "radius"],
    note: "An opaque pill behind the selected tab. Opaque because on glass, elevation reads as less translucency.",
  },
  {
    name: "Selected tab",
    selector: ".buzz-tabs-tab[data-selected]",
    show: ["color", "background"],
    note: "Draws no fill of its own — the pill behind it is the selection.",
  },
  {
    name: "Unselected tab",
    selector: ".buzz-tabs-tab:not([data-selected])",
    show: ["color", "background"],
  },
] as const;

const TABS_PANEL_PARTS = [
  {
    name: "Container",
    selector: ".buzz-tabs",
    show: ["background", "shadow", "blur", "radius"],
    note: "Nothing drawn. On a panel the tabs are text and the bar is the only mark.",
  },
  {
    name: "Selection",
    selector: ".buzz-tabs-indicator",
    show: ["background", "radius"],
    note: "A 2px bar on the bottom edge, spanning the selected tab.",
  },
  {
    name: "Selected tab",
    selector: ".buzz-tabs-tab[data-selected]",
    show: ["color", "background"],
    note: "Same size as unselected — selection is colour and the bar, never weight, which would reflow the row.",
  },
  {
    name: "Unselected tab",
    selector: ".buzz-tabs-tab:not([data-selected])",
    show: ["color", "background"],
  },
] as const;

function TabsSpecimen() {
  const [destination, setDestination] = useState<Destination>("messages");
  const [panelDestination, setPanelDestination] =
    useState<Destination>("messages");
  const [iconDestination, setIconDestination] = useState<Destination>("home");
  const iconItems = DESTINATIONS.map((item) => ({
    ...item,
    icon: <ChatCircleIcon size={16} aria-hidden="true" />,
  }));
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup label="Workspace — quiet title tabs for a combined pane">
        <Tabs
          value={iconDestination}
          items={DESTINATIONS}
          label="Workspace panes"
          onValueChange={setIconDestination}
          variant="workspace"
        />
      </SpecimenGroup>

      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Chrome — a glass pill, for the app backdrop
        </h2>
        <SpecimenFrame backdrop>
          <div data-anatomy="tabs-chrome">
            <Tabs
              value={destination}
              items={DESTINATIONS}
              label="Prototype destinations"
              onValueChange={setDestination}
            />
          </div>
        </SpecimenFrame>
        <ComponentAnatomy
          scope='[data-anatomy="tabs-chrome"]'
          caption="Which token draws each part of the chrome variant, read from the specimen above."
          parts={TABS_CHROME_PARTS}
        />
      </section>
      {/* On a panel rather than the backdrop, because that is the whole point of
          the variant — and because this specimen showing only the chrome version
          on only the gradient is why the panel failure went unnoticed until it
          appeared on a real page. */}
      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Panel — an underline, for a plain surface
        </h2>
        <SpecimenFrame>
          <div data-anatomy="tabs-panel">
            <Tabs
              value={panelDestination}
              items={DESTINATIONS}
              label="Prototype destinations on a panel"
              renderPanel={(value) => (
                <p className="text-body-sm">{value} content</p>
              )}
              onValueChange={setPanelDestination}
              variant="panel"
            />
          </div>
        </SpecimenFrame>
        <ComponentAnatomy
          scope='[data-anatomy="tabs-panel"]'
          caption="The same parts in the panel variant. The container and the tab draw nothing at all, which is what makes this legible on a plain surface: there is no second fill to collide with the first."
          parts={TABS_PANEL_PARTS}
        />
      </section>
      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Chrome, with icons and a trailing action outside the selection
        </h2>
        <SpecimenFrame backdrop>
          <Tabs
            value={iconDestination}
            items={iconItems}
            label="Prototype destinations with icons"
            onValueChange={setIconDestination}
            trailingAction={
              <IconButton
                aria-label="Create"
                icon={<PlusIcon size={16} aria-hidden="true" />}
                size="compact"
              />
            }
          />
        </SpecimenFrame>
      </section>
    </div>
  );
}

function PanelHeaderSpecimen() {
  const actions = (
    <IconButton
      aria-label="More conversation actions"
      icon={<DotsThreeIcon size={16} aria-hidden="true" />}
      size="compact"
    />
  );
  return (
    <div className="component-specimen-stack">
      {/* PanelHeader is the header row itself — optional icon, title, and actions.
          Panel is intentionally not wrapped around it: Panel owns the surface and
          PanelHeader owns neither its container nor the content below it. The end
          control is the existing IconButton component, composed through `actions`
          rather than rebuilt as a raw button. */}
      <SpecimenGroup label="Default — icon, title, and IconButton action">
        <PanelHeader
          title="Conversation"
          icon={<ChatCircleIcon size={16} aria-hidden="true" />}
          actions={actions}
        />
      </SpecimenGroup>
      <SpecimenGroup label="Compact — title and IconButton action">
        <PanelHeader variant="compact" title="Thread" actions={actions} />
      </SpecimenGroup>
    </div>
  );
}

function NavigationSectionSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup label='label="Pinned", with rows as children'>
        <div className="component-navigation-section-demo">
          <NavigationSection label="Pinned">
            <NavigationItem
              label="buzz-design"
              icon={<HashIcon size={16} aria-hidden="true" />}
            />
            <NavigationItem
              label="desktop-new"
              icon={<HashIcon size={16} aria-hidden="true" />}
            />
          </NavigationSection>
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Two sections adjacent — the gap between them is the grouping">
        <div className="component-navigation-section-demo">
          <NavigationSection label="Projects">
            <NavigationItem label="berd-main" />
          </NavigationSection>
          <NavigationSection label="Personal">
            <NavigationItem label="design-system" />
          </NavigationSection>
        </div>
      </SpecimenGroup>
    </div>
  );
}

function NavigationItemSpecimen() {
  const [selected, setSelected] = useState("buzz-design");
  const [selectedPill, setSelectedPill] = useState("Notes");
  return (
    <div className="component-specimen-stack">
      {/* Interactive: clicking moves `selected`, so the selected fill and the
          unselected rest state are both visible at once and comparable. */}
      <SpecimenGroup label="Selected, and trailing for metadata — click to move the selection">
        <div className="component-navigation-section-demo">
          <NavigationItem
            label="buzz-design"
            icon={<HashIcon size={16} aria-hidden="true" />}
            selected={selected === "buzz-design"}
            onClick={() => setSelected("buzz-design")}
          />
          <NavigationItem
            label="desktop-new"
            icon={<HashIcon size={16} aria-hidden="true" />}
            trailing={<span className="text-body-sm">3</span>}
            selected={selected === "desktop-new"}
            onClick={() => setSelected("desktop-new")}
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Picker option — even padding and immediate hover feedback">
        <div className="component-navigation-section-demo">
          <NavigationItem
            variant="option"
            label="Alex"
            icon={<Avatar fallback="Alex" alt="" size="default" />}
          />
          <NavigationItem
            variant="option"
            label="Unavailable"
            disabled
            icon={<Avatar fallback="Unavailable" alt="" size="default" />}
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Inset — one level of nesting under a row">
        <div className="component-navigation-section-demo">
          <NavigationItem
            label="Session interaction model"
            icon={<ChatCircleIcon size={16} aria-hidden="true" />}
            inset
            selected={selected === "session"}
            onClick={() => setSelected("session")}
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup label="Pill — click to move the selection">
        <div className="component-specimen-row">
          {["Notes", "Activity"].map((label) => (
            <NavigationItem
              key={label}
              label={label}
              variant="pill"
              selected={selectedPill === label}
              onClick={() => setSelectedPill(label)}
            />
          ))}
        </div>
      </SpecimenGroup>
    </div>
  );
}

const CHIP_PERSON: ChipAddress = { kind: "person", id: "pk-morgan" };
const CHIP_AGENT: ChipAddress = { kind: "agent", id: "pk-morgarita" };
const CHIP_CHANNEL: ChipAddress = { kind: "channel", id: "ch-buzz-team" };
const CHIP_MESSAGE: ChipAddress = { kind: "message", id: "ev-thread-root" };
const CHIP_LINK: ChipAddress = {
  kind: "link",
  id: "https://github.com/block/buzz",
};
const CHIP_UNRESOLVED: ChipAddress = {
  kind: "person",
  id: "9f2c4a1b7e5d8306a4b2c1d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9",
};
const CHIP_LONG: ChipAddress = { kind: "person", id: "pk-long" };

const CHIP_KIND_ROWS = [
  { label: "Person", address: CHIP_PERSON },
  { label: "Agent", address: CHIP_AGENT },
  { label: "Channel", address: CHIP_CHANNEL },
  { label: "Message", address: CHIP_MESSAGE },
  { label: "Link", address: CHIP_LINK },
] as const;

/**
 * Seeds faces so the specimens show resolved chips. The product resolves these
 * from real identity; the page only needs the shapes to be visible.
 */
function seedChipFaces() {
  chipFaces.put(CHIP_PERSON, {
    label: "Morgan Martin",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_AGENT, {
    label: "Morgarita",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_CHANNEL, {
    label: "buzz-team",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_MESSAGE, {
    label: "buzz-team",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_LINK, {
    label: "github.com/block/buzz",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_LONG, {
    label: "A deliberately very long display name that must truncate",
    loading: false,
    resolved: true,
  });
}

function PreviewCardSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup label="Default">
        <p className="text-body text-primary">
          <PreviewCard
            trigger={
              <button type="button" className="buzz-preview-card-example">
                Morgan Martin
              </button>
            }
          >
            <span className="buzz-preview-card-kind text-body-sm text-tertiary">
              Person
            </span>
            <span className="buzz-preview-card-name text-body text-primary">
              Morgan Martin
            </span>
            <span className="text-body-sm text-secondary">
              Product designer
            </span>
          </PreviewCard>{" "}
          is reviewing the first Composer composition.
        </p>
      </SpecimenGroup>
    </div>
  );
}

function InlineChipSpecimen() {
  const [activated, setActivated] = useState<string | null>(null);
  seedChipFaces();

  return (
    <div className="component-specimen-stack">
      <SpecimenGroup label="Kinds">
        {/* Caption under the sample, not in a fixed-width column beside it: a
            label column wide enough for `kind: "channel"` left the link chip
            nowhere to truncate and pushed it off a 380px viewport. */}
        <div className="component-specimen-row">
          {CHIP_KIND_ROWS.map((row) => (
            <Specimen key={row.label} prop={`kind: "${row.address.kind}"`}>
              <InlineChip address={row.address} />
            </Specimen>
          ))}
        </div>
      </SpecimenGroup>

      <SpecimenGroup label="In a sentence">
        <p className="text-body text-primary">
          Asked <InlineChip address={CHIP_PERSON} /> and{" "}
          <InlineChip address={CHIP_AGENT} /> to look at{" "}
          <InlineChip address={CHIP_MESSAGE} /> in{" "}
          <InlineChip address={CHIP_CHANNEL} />, alongside{" "}
          <InlineChip address={CHIP_LINK} /> before the review.
        </p>
      </SpecimenGroup>

      <SpecimenGroup label="Resolved preview">
        <p className="text-body text-primary">
          Hover or focus <InlineChip address={CHIP_PERSON} /> to reveal its
          quiet preview. It supplies context without opening another surface.
        </p>
      </SpecimenGroup>

      <SpecimenGroup label="Inert rendering">
        <p className="text-body text-primary">
          A surface that cannot honestly reveal reference detail renders an
          inert chip: <InlineChip address={CHIP_PERSON} interactive={false} />
        </p>
      </SpecimenGroup>

      <SpecimenGroup label="Unresolved reference">
        <div className="flex flex-col gap-3">
          <div className="component-specimen-row">
            <InlineChip address={CHIP_UNRESOLVED} />
          </div>
          <p className="max-w-md text-body-sm text-tertiary">
            No name to show and nothing to open, so it reads as inert and
            announces itself as unresolved rather than speaking an identity
            fragment aloud.
          </p>
        </div>
      </SpecimenGroup>

      <SpecimenGroup label="Long label truncates">
        <div className="component-specimen-row">
          <InlineChip address={CHIP_LONG} />
        </div>
      </SpecimenGroup>

      <SpecimenGroup label="Wrapping across lines">
        <p className="max-w-xs text-body text-primary">
          A chip sits in the text flow, so a line break falls before or after it
          and never inside it: <InlineChip address={CHIP_PERSON} />{" "}
          <InlineChip address={CHIP_AGENT} /> <InlineChip address={CHIP_LINK} />
        </p>
      </SpecimenGroup>

      <SpecimenGroup label="Activation">
        <div className="component-specimen-row">
          <InlineChip
            address={CHIP_PERSON}
            onActivate={(address) => setActivated(address.id)}
          />
          <span className="text-body-sm text-tertiary">
            {activated ? `Opened ${activated}` : "Not activated"}
          </span>
        </div>
      </SpecimenGroup>
    </div>
  );
}

function SwitchSpecimen() {
  const [checked, setChecked] = useState(false);
  const [busyChecked, setBusyChecked] = useState(true);
  const [selected, setSelected] = useState(false);
  const [managed, setManaged] = useState(false);
  const checkboxId = useId();
  return (
    <div className="component-specimen-stack">
      <div className="divide-y divide-line">
        <SwitchPreferenceRow
          icon={<ChatCircleIcon size={20} />}
          label="Desktop alerts"
          description="Show notifications for new activity."
          checked={checked}
          onCheckedChange={setChecked}
        />
        <SwitchPreferenceRow label="Sound" checked />
        <SwitchPreferenceRow
          label="Unavailable preference"
          icon={<ChatCircleIcon size={20} />}
          disabled
        />
        <PreferenceRow
          icon={<HashIcon size={20} />}
          title="Include archived channels"
          subtitle="Include archived channels when browsing your saved conversations. This longer explanation wraps while the control stays aligned."
          controlId={checkboxId}
          trailing={(labelProps) => (
            <Checkbox
              {...labelProps}
              id={checkboxId}
              label={null}
              checked={selected}
              onCheckedChange={setSelected}
            />
          )}
        />
        <PreferenceRow
          title="Connected accounts"
          subtitle={
            managed
              ? "Account management opened."
              : "Manage the accounts connected to this workspace."
          }
          trailing={
            <Button size="sm" onClick={() => setManaged(!managed)}>
              {managed ? "Done" : "Manage"}
            </Button>
          }
        />
        <PreferenceRow
          title="Channels"
          trailing={<span className="text-body-sm text-subtle">Required</span>}
        />
      </div>
      <Switch
        checked={checked}
        onCheckedChange={setChecked}
        label="Show agent activity"
      />
      <Switch checked label="Show agent activity" />
      <Switch disabled label="Show agent activity" />
      <div className="component-specimen-row">
        <span className="text-body">Plugin enabled (saving)</span>
        <Switch
          checked={busyChecked}
          onCheckedChange={setBusyChecked}
          readOnly
          aria-disabled="true"
          aria-label="Enable busy plugin"
        />
      </div>
    </div>
  );
}

function AlertDialogSpecimen() {
  const [open, setOpen] = useState(false);
  return (
    <SpecimenFrame>
      <Button onClick={() => setOpen(true)}>Discard example changes</Button>
      {open && (
        <AlertDialog
          title="Discard changes?"
          description="Your unsaved example changes will be lost."
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button onClick={() => setOpen(false)}>Keep editing</Button>
              <Button variant="destructive" onClick={() => setOpen(false)}>
                Discard
              </Button>
            </>
          }
        />
      )}
    </SpecimenFrame>
  );
}

function RadioGroupSpecimen() {
  const [summary, setSummary] = useState(false);
  const [delivery, setDelivery] = useState("all");
  const [enabled, setEnabled] = useState(false);
  return (
    <>
      <SpecimenGroup label="Native form reset">
        <SpecimenFrame>
          <form aria-label="Notification preferences">
            <Field label="Notifications">
              <RadioGroup name="notifications" defaultValue="all">
                <Radio value="all" label="All updates" variant="card" />
                <Radio value="mentions" label="Mentions only" variant="card" />
                <Radio value="none" label="Unavailable" disabled />
              </RadioGroup>
            </Field>
            <Checkbox
              name="summary"
              value="yes"
              label="Include a summary"
              defaultChecked
            />
            <Button type="reset">Reset preferences</Button>
          </form>
        </SpecimenFrame>
      </SpecimenGroup>
      <SpecimenGroup label="Controlled form reset">
        <SpecimenFrame>
          <form aria-label="Controlled preferences">
            <Field label="Delivery">
              <RadioGroup
                name="delivery"
                value={delivery}
                onValueChange={setDelivery}
              >
                <Radio value="all" label="All updates" />
                <Radio value="mentions" label="Mentions only" />
              </RadioGroup>
            </Field>
            <Checkbox
              name="summary"
              value="yes"
              label="Include a summary"
              checked={summary}
              onCheckedChange={setSummary}
            />
            <Button type="reset">Reset preferences</Button>
          </form>
        </SpecimenFrame>
      </SpecimenGroup>
      <SpecimenGroup label="Initially disabled choices">
        <SpecimenFrame>
          <form aria-label="Deferred preferences">
            <Button onClick={() => setEnabled(true)} disabled={enabled}>
              Enable choices
            </Button>
            <Field label="Delivery">
              <RadioGroup
                name="delivery"
                defaultValue="all"
                disabled={!enabled}
              >
                <Radio value="all" label="All updates" />
                <Radio value="mentions" label="Mentions only" />
              </RadioGroup>
            </Field>
            <Button type="reset">Reset preferences</Button>
          </form>
        </SpecimenFrame>
      </SpecimenGroup>
    </>
  );
}

export const COMPONENT_SPECIMENS: Record<string, () => ReactNode> = {
  "alert-dialog": AlertDialogSpecimen,
  dialog: DialogSpecimens,
  toast: ToastSpecimens,
  tooltip: () => (
    <SpecimenFrame>
      <Tooltip content="Create a note">
        <IconButton aria-label="Create note" icon={<PlusIcon size={16} />} />
      </Tooltip>
    </SpecimenFrame>
  ),
  field: () => (
    <SpecimenFrame>
      <Field
        label="Workspace name"
        description="Choose a name your team will recognize."
        error="Enter a name."
      >
        <Input required />
      </Field>
      <Field label="Workspace description" error="Enter a description.">
        <Textarea id="workspace-description" required rows={3} />
      </Field>
    </SpecimenFrame>
  ),
  calendar: CalendarSpecimen,
  "field-button": FieldButtonSpecimen,
  input: InputExamples,
  textarea: TextareaExamples,
  "radio-group": RadioGroupSpecimen,
  checkbox: () => (
    <SpecimenFrame>
      <Checkbox label="Include a summary" />
      <Checkbox label="Some selected" indeterminate />
      <Checkbox label="Unavailable" disabled />
    </SpecimenFrame>
  ),
  "swap-workspace": PanelSwapPlaygrounds,
  "flex-workspace": FlexWorkspace,
  workspace: BentoSpecimen,
  button: ButtonSpecimen,
  "icon-button": IconButtonSpecimen,
  avatar: AvatarSpecimen,
  "preview-card": PreviewCardSpecimen,
  "inline-chip": InlineChipSpecimen,
  "full-page-surface": FullPageSurfaceSpecimen,
  panel: PanelSpecimen,
  tabs: TabsSpecimen,
  menu: MenuSpecimen,
  popover: PopoverSpecimen,
  "choice-row": ChoiceRowSpecimen,
  select: SelectExamples,
  combobox: ComboboxExamples,
  switch: SwitchSpecimen,
  "preference-row": SwitchSpecimen,
  accordion: () => (
    <>
      <Accordion
        items={[
          {
            value: "purpose",
            title: "When to use an accordion",
            content: (
              <p className="text-body">
                Use a disclosure for supporting content that does not need to be
                visible all the time.
              </p>
            ),
          },
          {
            value: "behavior",
            title: "Keyboard behavior",
            content: (
              <p className="text-body">
                Focus a heading and press Enter or Space to expand it.
              </p>
            ),
          },
        ]}
      />
      <h3 className="text-label">
        Form disclosures · spacing owned by the form
      </h3>
      <Accordion
        variant="form"
        keepMounted
        items={[
          {
            value: "advanced",
            title: "Advanced",
            content: (
              <Field label="Label">
                <Input placeholder="Draft stays when collapsed" />
              </Field>
            ),
          },
          {
            value: "details",
            title: "Technical details",
            content: (
              <p className="text-body-sm text-subtle">
                Supporting information shares the same row rhythm.
              </p>
            ),
          },
        ]}
      />
    </>
  ),
  header: () => (
    <div>
      <Header
        title="Profile"
        eyebrow="Account"
        subtitle="Your local default for new communities."
      />
      <InlineHeader title="Preferences" subtitle="Choose what works for you." />
    </div>
  ),
  "panel-header": PanelHeaderSpecimen,
  "search-field": SearchExamples,
  composer: ComposerSpecimen,
  "navigation-section": NavigationSectionSpecimen,
  "navigation-item": NavigationItemSpecimen,
};
