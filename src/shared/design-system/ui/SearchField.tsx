import "../styles/search-field.css";
import { Field } from "./Field";
import { InputGroup } from "./InputGroup";
import { Input } from "@base-ui/react/input";
import { MagnifyingGlassIcon, XIcon } from "../icons/index";
import { useRef, type ComponentProps, type Ref, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export function SearchField({
  value,
  onValueChange,
  label = "Search",
  placeholder = "Search",
  inputRef,
  variant = "default",
  description,
  error,
  ...inputProps
}: {
  inputRef?: Ref<HTMLElement>;
  variant?: "default" | "capsule";
  description?: ReactNode;
  error?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  label?: string;
  placeholder?: string;
} & Omit<
  ComponentProps<typeof Input>,
  "value" | "onValueChange" | "className" | "ref" | "render" | "type"
>) {
  const localRef = useRef<HTMLElement | null>(null);
  const clear = value ? (
    <IconButton
      data-search-clear={variant === "capsule" ? "" : undefined}
      aria-label={`Clear ${label.toLowerCase()}`}
      icon={<XIcon size={16} aria-hidden="true" />}
      size="sm"
      disabled={inputProps.disabled || inputProps.readOnly}
      onClick={() => {
        onValueChange("");
        localRef.current?.focus();
      }}
    />
  ) : null;
  const input = (
    <Input
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      {...inputProps}
      data-buzz-ui=""
      className={variant === "capsule" ? undefined : "buzz-input"}
      ref={(node) => {
        localRef.current = node;
        if (typeof inputRef === "function") return inputRef(node);
        if (inputRef) inputRef.current = node;
      }}
      type="search"
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
    />
  );
  const icon = <MagnifyingGlassIcon size={16} aria-hidden="true" />;
  return (
    <Field
      label={label}
      labelVisibility="hidden"
      description={description}
      error={error}
    >
      {variant === "capsule" ? (
        <div data-buzz-ui="" className="search-field">
          {icon}
          {input}
          {clear}
        </div>
      ) : (
        <InputGroup leading={icon} trailing={clear}>
          {input}
        </InputGroup>
      )}
    </Field>
  );
}
