import { useState } from "react";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { DotsThreeIcon } from "../../../../src/shared/design-system/icons";
import { NavigationItem } from "../../../../src/shared/design-system/ui/NavigationItem";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import { Textarea } from "../../../../src/shared/design-system/ui/Textarea";
import { SearchField } from "../../../../src/shared/design-system/ui/SearchField";
import { Select } from "../../../../src/shared/design-system/ui/Select";
import { Checkbox } from "../../../../src/shared/design-system/ui/Checkbox";
import { Switch } from "../../../../src/shared/design-system/ui/Switch";
import {
  Radio,
  RadioGroup,
} from "../../../../src/shared/design-system/ui/RadioGroup";
import { Dialog } from "../../../../src/shared/design-system/ui/Dialog";
import { Panel } from "../../../../src/shared/design-system/ui/Panel";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../../../src/shared/design-system/ui/Popover";
import { Section } from "./primitives";

/** Diagnostic composition only: actual shared controls and portal owners. */
function Controls() {
  const [query, setQuery] = useState("Design");
  const [choice, setChoice] = useState("all");
  return (
    <div className="space-y-4" data-interaction-controls="">
      <div className="flex flex-wrap gap-2">
        <Button>Secondary action</Button>
        <Button variant="outline">Outline action</Button>
        <Button variant="ghost">Ghost action</Button>
        <IconButton aria-label="More actions" icon={<DotsThreeIcon />} />
        <Button disabled>Unavailable</Button>
        <Button loading>Saving</Button>
      </div>
      <NavigationItem
        label={
          <>
            Interactive row{" "}
            <span className="text-metadata">Supporting detail</span>
          </>
        }
      />
      <NavigationItem
        selected
        label={
          <>
            Selected row{" "}
            <span className="text-metadata">Supporting detail</span>
          </>
        }
      />
      <NavigationItem disabled label="Disabled row" />
      <Field label="Name">
        <Input placeholder="Project name" />
      </Field>
      <Field label="Description">
        <Textarea placeholder="What is this for?" rows={2} />
      </Field>
      <Field label="Required name" error="Enter a name.">
        <Input />
      </Field>
      <Field label="Read-only name">
        <Input readOnly value="Project notes" />
      </Field>
      <SearchField label="Search" value={query} onValueChange={setQuery} />
      <Select
        variant="field"
        label="Notifications"
        value={choice}
        onValueChange={setChoice}
        groups={[
          {
            label: "Notify me about",
            options: [
              { value: "all", label: "All messages" },
              { value: "mentions", label: "Mentions only" },
            ],
          },
        ]}
      />
      <Checkbox label="Include replies" />
      <Checkbox label="Partially selected" indeterminate />
      <Checkbox label="Disabled choice" disabled />
      <Switch label="Notify me" />
      <Field label="Access">
        <RadioGroup defaultValue="team">
          <Radio
            value="team"
            label="Team"
            description="Everyone in your team"
            variant="card"
          />
          <Radio
            value="invited"
            label="Invited"
            description="Only invited people"
            variant="card"
          />
        </RadioGroup>
      </Field>
      <Panel aria-label="Nested panel">
        <div className="p-4">
          <Button>Nested panel action</Button>
        </div>
      </Panel>
    </div>
  );
}

export function SurfaceInteractionSpecimen() {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Surface-aware interactions — proposed"
      description="The same controls on a panel, in a dialog and in a portaled popover. Compare both themes. Fields retain their inset fill; the nested panel resets its action recipe. Focus outlines remain globally suppressed by the current design policy."
    >
      <div className="flex flex-wrap gap-4">
        <Button onClick={() => setOpen(true)}>Open interaction dialog</Button>
        <PopoverRoot>
          <PopoverTrigger render={<Button>Open interaction popover</Button>}>
            Open interaction popover
          </PopoverTrigger>
          <PopoverPopup aria-label="Interaction popover">
            <Controls />
          </PopoverPopup>
        </PopoverRoot>
      </div>
      <Panel aria-label="Interaction panel">
        <div className="p-4">
          <Controls />
        </div>
      </Panel>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Interaction dialog"
        actions={<Button onClick={() => setOpen(false)}>Close proof</Button>}
      >
        <Controls />
      </Dialog>
    </Section>
  );
}
