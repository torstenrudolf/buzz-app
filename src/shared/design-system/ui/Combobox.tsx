import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { useId, type ComponentProps, type ReactNode } from "react";
import { CaretDownIcon, CircleNotchIcon, CheckIcon } from "../icons";
import { Field } from "./Field";
import { InputGroup } from "./InputGroup";
import { IconButton } from "./IconButton";

/** Shared presentation; callers retain filtering, custom values and async work. */
function Control({
  label,
  triggerLabel,
  loading = false,
  onBrowse,
  description,
  error,
  id,
  ...props
}: Omit<ComponentProps<typeof BaseCombobox.Input>, "className" | "render"> & {
  label: string;
  description?: ReactNode;
  error?: ReactNode;
  triggerLabel: string;
  loading?: boolean;
  onBrowse?: () => void;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <Field
      label={label}
      controlId={inputId}
      description={description}
      error={error}
    >
      <BaseCombobox.InputGroup
        render={
          <InputGroup
            trailing={
              <BaseCombobox.Trigger
                tabIndex={0}
                aria-labelledby={undefined}
                aria-label={triggerLabel}
                disabled={props.disabled || props.readOnly}
                onClick={onBrowse}
                render={
                  <IconButton
                    aria-label={triggerLabel}
                    size="sm"
                    icon={
                      loading ? (
                        <CircleNotchIcon
                          size={16}
                          className="motion-safe:animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <CaretDownIcon
                          size={16}
                          className="buzz-dropdown-chevron"
                          aria-hidden="true"
                        />
                      )
                    }
                  />
                }
              />
            }
          />
        }
      >
        <BaseCombobox.Input
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          {...props}
          id={inputId}
          data-buzz-ui=""
          className="buzz-input"
          aria-busy={loading || undefined}
        />
      </BaseCombobox.InputGroup>
    </Field>
  );
}

function Popup({
  children,
  empty,
  className = "",
}: {
  children: ReactNode;
  empty: ReactNode;
  className?: string | undefined;
}) {
  return (
    <BaseCombobox.Portal>
      <BaseCombobox.Positioner
        sideOffset={4}
        className="buzz-select-positioner"
      >
        <BaseCombobox.Popup
          data-buzz-ui=""
          className={`buzz-select-popup text-body ${className}`}
          data-variant="field"
        >
          <BaseCombobox.Empty className="buzz-combobox-empty">
            {empty}
          </BaseCombobox.Empty>
          {children}
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  );
}

function Item({
  children,
  description,
  ...props
}: Omit<ComponentProps<typeof BaseCombobox.Item>, "className" | "render"> & {
  description?: ReactNode;
}) {
  return (
    <BaseCombobox.Item
      {...props}
      className="buzz-select-option buzz-combobox-option"
    >
      <span className="buzz-combobox-item-content">
        <span>{children}</span>
        {description && (
          <span className="text-body-sm text-subtle">{description}</span>
        )}
      </span>
      <BaseCombobox.ItemIndicator
        className="buzz-combobox-indicator"
        keepMounted
      >
        <CheckIcon size={16} aria-hidden="true" />
      </BaseCombobox.ItemIndicator>
    </BaseCombobox.Item>
  );
}

export const Combobox = {
  Root: BaseCombobox.Root,
  Control,
  Popup,
  List: BaseCombobox.List,
  Item,
};
