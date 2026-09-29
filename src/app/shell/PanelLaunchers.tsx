import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useState } from "react";
import { SidebarIcon } from "../../shared/design-system/icons/index";
import type { RegisteredPanel } from "../../features/panels/service";

export function PanelLaunchers({
  panels,
  selected,
  launch,
}: {
  panels: readonly RegisteredPanel[];
  selected: RegisteredPanel | undefined;
  launch(panel: RegisteredPanel, trigger: HTMLButtonElement): void;
}) {
  return panels
    .filter((panel) => panel.launcher)
    .map((panel) => (
      <IconButton
        type="button"
        key={`${panel.key}:${panel.revision}`}
        variant="chrome"
        shape="round"
        aria-label={panel.title}
        title={panel.title}
        aria-expanded={panel === selected}
        onClick={(event) => launch(panel, event.currentTarget)}
        icon={
          <LauncherIcon
            key={panel.launcher?.icon}
            src={panel.launcher?.icon ?? ""}
          />
        }
      />
    ));
}
function LauncherIcon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <SidebarIcon size={16} aria-hidden="true" />
  ) : (
    <img
      src={src}
      alt=""
      className="object-contain"
      onError={() => setFailed(true)}
    />
  );
}
