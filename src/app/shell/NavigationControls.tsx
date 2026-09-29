import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useSyncExternalStore } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
} from "../../shared/design-system/icons/index";
import type { Navigation } from "../../features/navigation/controller";
export function NavigationControls({ navigation }: { navigation: Navigation }) {
  const state = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  return (
    <nav
      className="flex shrink-0 items-center gap-1"
      aria-label="Navigation history"
    >
      <IconButton
        type="button"
        variant="chrome"
        shape="round"
        aria-label="Go back"
        title="Go back"
        disabled={!state.canGoBack}
        onClick={navigation.back}
        icon={<ArrowLeftIcon size={16} aria-hidden="true" />}
      />
      <IconButton
        type="button"
        variant="chrome"
        shape="round"
        aria-label="Go forward"
        title="Go forward"
        disabled={!state.canGoForward}
        onClick={navigation.forward}
        icon={<ArrowRightIcon size={16} aria-hidden="true" />}
      />
    </nav>
  );
}
