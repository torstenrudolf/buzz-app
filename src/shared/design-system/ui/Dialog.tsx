import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "../icons";
import { useState, type ComponentProps, type ReactNode } from "react";
import { IconButton } from "./IconButton";
import { useFinalFocusUnlessMoved } from "./finalFocus";

type PopupProps = ComponentProps<typeof BaseDialog.Popup>;
export type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenChangeComplete?: ComponentProps<
    typeof BaseDialog.Root
  >["onOpenChangeComplete"];
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  leadingActions?: ReactNode;
  headerActions?: ReactNode;
  /** Return true when an inner editor layer consumed Escape. */
  onEscape?: () => boolean;
  placement?: "center" | "right";
  dismissOnOutsideClick?: boolean;
  closeLabel?: string;
  /** Reserve viewport-capped space for changing content; scroll only the body. */
  height?: "content" | "stable";
  /** Expanded reading surfaces retain the same modal/focus behavior. */
  size?: "default" | "expanded";
  /** Keep frequent surfaces such as search palettes immediate. */
  motion?: "default" | "none";
  /** A pending operation can prevent all user dismissal paths. */
  preventClose?: boolean;
  initialFocus?: PopupProps["initialFocus"];
  finalFocus?: PopupProps["finalFocus"];
};

/** Base UI owns the modal, portal, focus trap, Escape and focus restoration. */
export function Dialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  children,
  actions,
  leadingActions,
  headerActions,
  onEscape,
  placement = "center",
  dismissOnOutsideClick = false,
  closeLabel = "Close",
  size = "default",
  preventClose = false,
  motion = "default",
  height = "content",
  initialFocus,
  finalFocus,
}: DialogProps) {
  const [instantClose, setInstantClose] = useState(false);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  const transition =
    motion === "none" || (!open && instantClose) ? "none" : "default";
  return (
    <BaseDialog.Root
      open={open}
      onOpenChangeComplete={onOpenChangeComplete}
      disablePointerDismissal={!dismissOnOutsideClick}
      onOpenChange={(next, details) => {
        if (!next && preventClose) {
          details.cancel();
          return;
        }
        if (!next && details.reason === "escape-key" && onEscape?.()) {
          details.cancel();
          return;
        }
        setInstantClose(details.reason === "escape-key");
        onOpenChange(next);
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          forceRender={placement === "right"}
          data-placement={placement}
          data-buzz-ui=""
          data-motion={transition}
          className="buzz-dialog-backdrop"
        />
        <BaseDialog.Popup
          data-buzz-ui=""
          className="buzz-dialog gap-0"
          data-placement={placement}
          data-height={height}
          data-size={size}
          data-motion={transition}
          aria-modal="true"
          initialFocus={initialFocus}
          ref={focus.ref}
          finalFocus={focus.finalFocus}
        >
          <header className="buzz-dialog-header">
            <div className="buzz-dialog-heading">
              <BaseDialog.Title className="text-label">
                {title}
              </BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="buzz-dialog-description">
                  {description}
                </BaseDialog.Description>
              )}
            </div>
            <div className="buzz-dialog-header-actions">
              {headerActions}
              <BaseDialog.Close
                disabled={preventClose}
                render={
                  <IconButton
                    aria-label={closeLabel}
                    disabled={preventClose}
                    size="compact"
                    icon={<XIcon size={16} aria-hidden="true" />}
                  />
                }
              />
            </div>
          </header>
          <div className="buzz-dialog-body buzz-dialog-content">{children}</div>
          {(actions || leadingActions) && (
            <footer className="buzz-dialog-actions">
              {leadingActions && (
                <div className="buzz-dialog-leading-actions">
                  {leadingActions}
                </div>
              )}
              {actions}
            </footer>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
