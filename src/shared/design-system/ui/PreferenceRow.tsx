import { useId, type ReactNode } from "react";

type ControlLabel = {
  "aria-labelledby": string;
  "aria-describedby"?: string | undefined;
};

/** Shared settings layout. The trailing control owns interaction and state. */
export function PreferenceRow({
  icon,
  title,
  subtitle,
  trailing,
  controlId,
  accessibleTitle,
  disabled = false,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode | ((label: ControlLabel) => ReactNode);
  /** Associate the title with a switch, checkbox, or other labelled input. */
  controlId?: string;
  accessibleTitle?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const subtitleId = subtitle ? `${id}-subtitle` : undefined;
  const Title = controlId ? "label" : "div";
  return (
    <div
      data-buzz-ui=""
      className="buzz-preference-row"
      data-disabled={disabled || undefined}
      data-has-icon={icon ? "" : undefined}
    >
      {icon && (
        <span className="buzz-preference-row-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="buzz-preference-row-content">
        <Title
          id={titleId}
          className="buzz-preference-row-label"
          htmlFor={controlId}
          aria-label={accessibleTitle}
        >
          {title}
        </Title>
        {subtitle && (
          <span id={subtitleId} className="buzz-preference-row-description">
            {subtitle}
          </span>
        )}
      </div>
      {trailing != null && (
        <div className="buzz-preference-row-trailing">
          {typeof trailing === "function"
            ? trailing({
                "aria-labelledby": titleId,
                "aria-describedby": subtitleId,
              })
            : trailing}
        </div>
      )}
    </div>
  );
}
