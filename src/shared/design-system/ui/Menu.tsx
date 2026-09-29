import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { CheckIcon, CaretRightIcon } from "../icons/index";
import { useFinalFocusUnlessMoved } from "./finalFocus";
import type { ComponentProps, ReactNode } from "react";

export const MenuRoot = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const ContextMenuRoot = BaseContextMenu.Root;
export const ContextMenuTrigger = BaseContextMenu.Trigger;
export const MenuGroup = BaseMenu.Group;
export const MenuRadioGroup = BaseMenu.RadioGroup;

export type MenuPosition = Pick<
  ComponentProps<typeof BaseMenu.Positioner>,
  | "align"
  | "alignOffset"
  | "anchor"
  | "collisionPadding"
  | "collisionAvoidance"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type PopupProps = Omit<ComponentProps<typeof BaseMenu.Popup>, "className"> &
  MenuPosition & {
    children: ReactNode;
    /** Compact is for short action lists; larger choices retain panel corners. */
    size?: "compact" | "default" | "wide";
  };

function PositionedPopup({
  align = "start",
  alignOffset,
  anchor,
  children,
  collisionAvoidance,
  collisionPadding = 8,
  size = "default",
  side = "bottom",
  sideOffset = 4,
  sticky,
  finalFocus,
  ref,
  ...props
}: PopupProps) {
  const focus = useFinalFocusUnlessMoved(finalFocus, ref);
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        className="buzz-menu-positioner"
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding}
        side={side}
        sideOffset={sideOffset}
        sticky={sticky}
      >
        <BaseMenu.Popup
          {...props}
          ref={focus.ref}
          finalFocus={focus.finalFocus}
          data-buzz-ui=""
          data-size={size}
          className="buzz-menu-popup text-body-sm"
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

/** An anchored action menu with collision handling and shared floating-surface styling. */
export function MenuPopup(props: PopupProps) {
  return <PositionedPopup {...props} />;
}

export function MenuSubmenu({ children }: { children: ReactNode }) {
  return <BaseMenu.SubmenuRoot>{children}</BaseMenu.SubmenuRoot>;
}

export function MenuSubmenuPopup(props: PopupProps) {
  return <PositionedPopup side="right" align="start" {...props} />;
}

type ItemProps = Omit<ComponentProps<typeof BaseMenu.Item>, "className"> & {
  tone?: "default" | "danger";
};

export function MenuItem({ tone = "default", ...props }: ItemProps) {
  return (
    <BaseMenu.Item {...props} data-tone={tone} className="buzz-menu-item" />
  );
}

type LinkItemProps = Omit<
  ComponentProps<typeof BaseMenu.LinkItem>,
  "className"
>;

export function MenuLinkItem(props: LinkItemProps) {
  return <BaseMenu.LinkItem {...props} className="buzz-menu-item" />;
}

type SubmenuTriggerProps = Omit<
  ComponentProps<typeof BaseMenu.SubmenuTrigger>,
  "className"
>;

export function MenuSubmenuTrigger({
  children,
  ...props
}: SubmenuTriggerProps) {
  return (
    <BaseMenu.SubmenuTrigger {...props} className="buzz-menu-item">
      {children}
      <CaretRightIcon
        className="buzz-menu-submenu-arrow"
        size={16}
        aria-hidden="true"
      />
    </BaseMenu.SubmenuTrigger>
  );
}

type CheckboxItemProps = Omit<
  ComponentProps<typeof BaseMenu.CheckboxItem>,
  "className"
>;

export function MenuCheckboxItem({ children, ...props }: CheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem {...props} className="buzz-menu-item">
      <span className="buzz-menu-choice-label">{children}</span>
      <BaseMenu.CheckboxItemIndicator
        className="buzz-menu-item-indicator"
        keepMounted
      >
        <CheckIcon size={16} aria-hidden="true" />
      </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
  );
}

type RadioItemProps = Omit<
  ComponentProps<typeof BaseMenu.RadioItem>,
  "className"
>;

export function MenuRadioItem({ children, ...props }: RadioItemProps) {
  return (
    <BaseMenu.RadioItem {...props} className="buzz-menu-item">
      <span className="buzz-menu-choice-label">{children}</span>
      <BaseMenu.RadioItemIndicator
        className="buzz-menu-item-indicator"
        keepMounted
      >
        <CheckIcon size={16} aria-hidden="true" />
      </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return (
    <BaseMenu.GroupLabel className="buzz-menu-group-label">
      {children}
    </BaseMenu.GroupLabel>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="buzz-menu-separator" />;
}

export function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <span className="buzz-menu-icon" aria-hidden="true">
      {children}
    </span>
  );
}

export function MenuTrailing({ children }: { children: ReactNode }) {
  return <span className="buzz-menu-trailing">{children}</span>;
}

/** Supporting context and status text, outside the menu's keyboard item list. */
export function MenuNote(props: Omit<ComponentProps<"p">, "className">) {
  return <p {...props} className="buzz-menu-note text-body-sm" />;
}
