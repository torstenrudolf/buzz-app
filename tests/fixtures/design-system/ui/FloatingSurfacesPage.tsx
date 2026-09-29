import { SurfaceInteractionSpecimen } from "./SurfaceInteractionSpecimen";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { PreviewCard } from "../../../../src/shared/design-system/ui/PreviewCard";
import { Select } from "../../../../src/shared/design-system/ui/Select";
import { Note, PageHeader, Section } from "./primitives";

export function FloatingSurfacesPage() {
  const [value, setValue] = useState("all");
  return (
    <>
      <PageHeader
        title="Floating surfaces"
        intro="One shared outer appearance for a card above the page. The shared Preview Card and Select use the same background, border, corners, and shadow while keeping their own content and interactions."
      />
      <SurfaceInteractionSpecimen />
      <Section
        title="The shared recipe"
        description="Use floating-surface for the outer material. The consumer supplies its width, padding, placement, and behavior; the recipe supplies these four visual roles."
      >
        <div className="flex flex-wrap gap-6 rounded-xl bg-surface-panel p-6">
          <div className="floating-surface flex min-w-0 max-w-full flex-col gap-3 p-6">
            <span className="text-label text-standard">
              A card above the page
            </span>
            <span className="text-body text-subtle">Opaque, not glass.</span>
          </div>
          <dl className="flex min-w-0 flex-col gap-2 text-body text-standard">
            {[
              ["Background", "surface-popover"],
              ["Border", "border-standard"],
              ["Corners", "radius-panel"],
              ["Shadow", "shadow-sm"],
            ].map(([label, token]) => (
              <div key={label} className="flex flex-wrap gap-x-4 gap-y-1">
                <dt>{label}</dt>
                <dd className="text-mono-sm text-subtle">{token}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
      <p className="text-body-sm text-subtle">
        Small action menus opt into 10px outer corners, 8px rows, and a 4px
        inset. Other floating surfaces retain the 24px panel radius. See the{" "}
        <Link to="/design/components/$slug" params={{ slug: "popover" }}>
          Popover examples
        </Link>{" "}
        for the content-based sizing rule and both treatments.
      </p>
      <Section
        title="Same surface, different behavior"
        description="These are the real shared components, not copied card styles. Hover over the preview trigger, or open the dropdown with a click or keyboard. Use the catalog theme control to compare light and dark."
      >
        <div className="flex flex-wrap items-start gap-8 rounded-xl bg-surface-panel p-6">
          <div className="flex min-w-0 flex-col gap-3">
            <PreviewCard
              trigger={<Button variant="ghost">Preview example</Button>}
            >
              <span className="text-label text-standard">Design review</span>
              <span className="text-body-sm text-subtle">
                Supplemental context without leaving the page.
              </span>
            </PreviewCard>
            <Link
              to="/design/components/$component"
              params={{ component: "preview-card" }}
              className="text-body text-link underline"
            >
              Preview Card component
            </Link>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <Select
              label="Notifications"
              value={value}
              onValueChange={setValue}
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
            <Link
              to="/design/components/$component"
              params={{ component: "select" }}
              className="text-body text-link underline"
            >
              Select component
            </Link>
          </div>
        </div>
      </Section>
      <Section
        title="Where it is used today"
        description="Preview Card and Select use floating-surface. The agent model combobox also uses the Select popup styling. This is an existing shared recipe, not a new component."
      >
        <Note>
          Adoption is not yet uniform. Mention pickers and several menus use a
          separate popover-surface recipe with the same background, border, and
          shadow but control corners instead of panel corners. It also supplies
          popup layering and selected-row contrast. Compact emoji suggestions
          have an explicit corner treatment, and some menus still assemble their
          own appearance. This page documents the current system; it does not
          migrate those consumers or add enforcement.
        </Note>
      </Section>
      <Section
        title="Ownership"
        description="The recipe already lives in the shared design system, in styles/materials.css. Change the shared recipe there rather than copying its declarations into a feature."
      >
        <p className="max-w-2xl text-body text-subtle">
          Where a surface uses a Base UI primitive, Base UI owns that
          interaction; other surfaces retain feature-owned interaction. Buzz
          owns the appearance. Sharing the outer material does not make those
          controls interchangeable, and does not prescribe their content spacing
          or keyboard behavior.
        </p>
        <div className="flex flex-wrap gap-4 text-body text-link underline">
          <Link to="/design/elevation">Elevation</Link>
          <Link to="/design/glass">Glass</Link>
        </div>
      </Section>
    </>
  );
}
