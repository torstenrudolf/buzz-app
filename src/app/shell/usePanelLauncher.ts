import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Panels, RegisteredPanel } from "../../features/panels/service";

type Opened = {
  panel: RegisteredPanel;
  target: string;
  trigger: HTMLButtonElement;
};
export function usePanelLauncher(panels: Panels, ready: boolean) {
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [opened, setOpened] = useState<Opened>();
  const panelRef = useRef<HTMLElement>(null);
  // Exact installation object, not just key/revision: same-revision re-enable is new intent.
  const selected =
    ready && opened && available.includes(opened.panel) ? opened : undefined;
  useEffect(() => {
    if (opened && !selected) setOpened(undefined);
  }, [opened, selected]);
  const previous = useRef<Opened>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = opened;
    // Focus after the menu's event handling, including first-open fallback bodies.
    // Preserve focus when the panel's content has already claimed it.
    const card = panelRef.current;
    if (
      opened &&
      before !== opened &&
      card &&
      !card.contains(document.activeElement)
    )
      card.focus();
    if (
      before &&
      !opened &&
      panels.snapshot().includes(before.panel) &&
      before.trigger.isConnected
    )
      before.trigger.focus();
  }, [opened, panels]);
  return {
    panelRef,
    available: ready ? available : [],
    selected: selected?.panel,
    target: selected?.target,
    launch(panel: RegisteredPanel, trigger: HTMLButtonElement) {
      const { launcher } = panel;
      if (ready && launcher && panels.snapshot().includes(panel))
        setOpened((current) =>
          current?.panel === panel
            ? undefined
            : { panel, target: launcher.target, trigger },
        );
    },
    canOpen(target: string) {
      return ready && !!panels.resolve(target);
    },
    /** Show whichever registered panel claims this target; reopening keeps it. */
    open(target: string, trigger: HTMLButtonElement) {
      const panel = ready ? panels.resolve(target) : undefined;
      if (panel) setOpened({ panel, target, trigger });
    },
    close() {
      // Bind to this opening, not merely this panel: reopening gets a new lifetime.
      setOpened((current) => (current === opened ? undefined : current));
    },
  };
}
