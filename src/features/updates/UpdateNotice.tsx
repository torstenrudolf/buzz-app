import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { Updates } from "./updates";

/** Offers restart once a downloaded update is ready, except while Settings shows it inline; dismissal lasts until it resolves. */
export function UpdateNotice({ updates }: { updates: Updates }) {
  const status = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  const inline = useSyncExternalStore(
    updates.subscribe,
    updates.inlineVisible,
    updates.inlineVisible,
  );
  const dismissed = useSyncExternalStore(
    updates.subscribe,
    updates.noticeDismissed,
    updates.noticeDismissed,
  );
  const recovery = useSyncExternalStore(
    updates.subscribe,
    updates.noticeRecovery,
    updates.noticeRecovery,
  );
  const { state } = status;
  const visible = state === "ready" || state === "installing" || recovery;
  if (!visible || dismissed || inline) return null;
  const pending = [
    "checking",
    "available",
    "downloading",
    "installing",
  ].includes(state);
  const descriptions = {
    idle: "Click to update",
    ready: "Click to update",
    installing: "Updating",
    checking: "Checking for updates...",
    available: "Preparing update...",
    downloading: "Downloading update...",
    "up-to-date": "You're on the latest version.",
    unavailable:
      "Automatic updates aren't available on this build. Download the latest release manually.",
    error: "",
  };
  return (
    <ToastNotice
      title={
        state === "error"
          ? "Update failed"
          : recovery
            ? "Software Updates"
            : "Ready to update!"
      }
      description={
        status.state === "error" ? status.message : descriptions[state]
      }
      tone={state === "error" ? "error" : "info"}
      onDismiss={updates.dismissNotice}
      closeLabel="Dismiss update notification"
    >
      <Button
        type="button"
        size="sm"
        loading={pending}
        onClick={() =>
          void (state === "ready"
            ? updates.installAndRelaunch()
            : updates.checkForUpdate())
        }
      >
        {state === "ready" || state === "installing" ? "Update now" : "Retry"}
      </Button>
    </ToastNotice>
  );
}
