import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import styles from "./ChannelLifecycleDialog.module.css";

const copy = {
  archive: {
    title: "Archive channel",
    detail:
      "Archive this channel for everyone and remove it from the sidebar. Messages are kept. A channel administrator can unarchive it later using another supported client; this app cannot restore it yet.",
  },
  delete: {
    title: "Delete channel",
    detail:
      "Delete this channel for everyone. You cannot undo this action from Buzz.",
  },
  leave: {
    title: "Leave channel",
    detail:
      "Leave this channel and remove it from your sidebar. You may need an invitation to rejoin a private channel.",
  },
  hide: {
    title: "Hide conversation",
    detail:
      "Hide this conversation from your sidebar only. Messages and membership are kept; other participants are not removed.",
  },
} as const;

export function ChannelLifecycleDialog({
  channelId,
  channelName,
  action,
  lifecycle,
  close,
  completed,
}: {
  channelId: string;
  channelName: string;
  action: ChannelLifecycleAction;
  lifecycle: ChannelLifecycleCapability;
  close(): void;
  completed(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      operation.current?.abort();
    };
  }, []);
  const submit = async () => {
    if (operation.current || refreshRequired) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      await lifecycle.run(action, channelId, controller.signal);
      if (!controller.signal.aborted) completed();
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : String(error));
        setRefreshRequired(error instanceof ChannelLifecycleUnconfirmed);
      }
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      data-buzz-ui=""
      className={styles.dialog}
      aria-labelledby="channel-lifecycle-title"
      aria-describedby="channel-lifecycle-description"
      onKeyDown={(event) => {
        // Keep the navigation disclosure open; native cancel still owns Escape.
        if (event.key === "Escape") event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <h2 id="channel-lifecycle-title">
        {copy[action].title}: {channelName}
      </h2>
      <p id="channel-lifecycle-description">{copy[action].detail}</p>
      {error && <p role="alert">{error}</p>}
      {busy && (
        <p role="status">
          Checking permissions and waiting for relay confirmation…
        </p>
      )}
      <div className={styles.actions}>
        <Button type="button" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={action === "delete" ? "destructive" : "prominent"}
          disabled={busy || refreshRequired}
          onClick={() => void submit()}
        >
          {copy[action].title}
        </Button>
      </div>
    </dialog>
  );
}
