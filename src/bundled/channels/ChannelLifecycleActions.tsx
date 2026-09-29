import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type {
  ChannelLifecycleAction,
  ChannelLifecycleSettings,
} from "../../features/relay/channel-lifecycle-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ArchiveIcon,
  SignOutIcon,
  TrashIcon,
} from "../../shared/design-system/icons";

/** Settings reads permissions only while open; the sidebar owns confirmation. */
export function ChannelLifecycleActions({
  channelId,
  lifecycle,
  choose,
}: {
  channelId: string;
  lifecycle: ChannelLifecycleCapability;
  choose(action: ChannelLifecycleAction, trigger: HTMLElement): void;
}) {
  const [state, setState] = useState<{
    channelId: string;
    lifecycle: ChannelLifecycleCapability;
    permissions?: ChannelLifecycleSettings;
    failed?: boolean;
    pending?: "delete" | "all";
  }>();
  const [retry, setRetry] = useState(0);
  const retryButton = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const retryPermissions = (pending: "delete" | "all") => {
    // Keep the recovery control mounted, but discard every stale permission.
    setState({ channelId, lifecycle, pending });
    setRetry((value) => value + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry starts a fresh permission lookup.
  useEffect(() => {
    if (!lifecycle.available) return;
    const controller = new AbortController();
    setState((previous) =>
      previous?.channelId === channelId &&
      previous.lifecycle === lifecycle &&
      previous.pending
        ? previous
        : undefined,
    );
    const finish = (value: {
      permissions?: ChannelLifecycleSettings;
      failed?: boolean;
    }) => {
      if (controller.signal.aborted) return;
      restoreFocus.current = document.activeElement === retryButton.current;
      setState({ channelId, lifecycle, ...value });
    };
    void lifecycle.load(channelId, controller.signal).then(
      (permissions) => finish({ permissions }),
      () => finish({ failed: true }),
    );
    return () => controller.abort();
  }, [channelId, lifecycle, retry]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hand off focus after the permission result mounts.
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    // Do not take focus back if the user left recovery before this commit.
    if (
      document.activeElement === document.body ||
      document.activeElement === retryButton.current
    )
      (retryButton.current ?? result.current)?.focus({ preventScroll: true });
  }, [state]);
  if (!lifecycle.available)
    return <p>Channel actions unavailable on this connection</p>;
  if (state?.channelId !== channelId || state.lifecycle !== lifecycle)
    return null;
  const retryLabel =
    state.failed || state.pending === "all"
      ? "Retry channel permissions"
      : "Retry Delete check";
  const permissions = state.permissions;
  return (
    <>
      {permissions?.canLeave && (
        <Button
          ref={!permissions.canDelete ? result : undefined}
          onClick={(event) => choose("leave", event.currentTarget)}
        >
          <SignOutIcon size={16} aria-hidden="true" />
          Leave channel
        </Button>
      )}
      {permissions?.canArchive && (
        <Button
          ref={
            !permissions.canDelete && !permissions.canLeave ? result : undefined
          }
          onClick={(event) => choose("archive", event.currentTarget)}
        >
          <ArchiveIcon size={16} aria-hidden="true" />
          Archive channel
        </Button>
      )}
      {(state.pending || state.failed || permissions?.deleteUnavailable) && (
        <div>
          <p role={state.failed ? "alert" : "status"}>
            {state.pending
              ? "Checking channel actions…"
              : state.failed
                ? "Channel actions unavailable"
                : "Delete check unavailable"}
          </p>
          <Button
            ref={retryButton}
            loading={!!state.pending}
            onClick={() => retryPermissions(state.failed ? "all" : "delete")}
          >
            {retryLabel}
          </Button>
        </div>
      )}
      {permissions?.canDelete && (
        <Button
          ref={result}
          variant="destructive"
          onClick={(event) => choose("delete", event.currentTarget)}
        >
          <TrashIcon size={16} aria-hidden="true" />
          Delete channel
        </Button>
      )}
      {retry > 0 &&
        permissions &&
        !permissions.canLeave &&
        !permissions.canArchive &&
        !permissions.canDelete &&
        !permissions.deleteUnavailable && (
          <p
            ref={(element) => {
              result.current = element;
            }}
            role="status"
            tabIndex={-1}
          >
            No channel actions available.
          </p>
        )}
    </>
  );
}
