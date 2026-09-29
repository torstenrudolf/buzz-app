import { useEffect, useState } from "react";
import {
  ArchiveIcon,
  EyeSlashIcon,
  SignOutIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import {
  MenuIcon,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type {
  ChannelLifecycleAction,
  ChannelLifecycleSettings,
} from "../../features/relay/channel-lifecycle-protocol";

/** Mounted only while a menu is open: no per-row/background capability reads. */
export function ChannelLifecycleMenu({
  channelId,
  lifecycle,
  choose,
  disabled,
  separator,
}: {
  channelId: string;
  lifecycle: ChannelLifecycleCapability;
  choose(action: ChannelLifecycleAction): void;
  disabled: boolean;
  separator: boolean;
}) {
  const [state, setState] = useState<ChannelLifecycleSettings>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry starts a fresh permission lookup.
  useEffect(() => {
    if (!lifecycle.available) return;
    const controller = new AbortController();
    setState(undefined);
    setFailed(false);
    void lifecycle.load(channelId, controller.signal).then(
      (settings) => {
        if (!controller.signal.aborted) setState(settings);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [channelId, lifecycle, retry]);
  if (!lifecycle.available)
    return (
      <>
        {separator && <MenuSeparator />}
        <MenuItem disabled>
          Channel actions unavailable on this connection
        </MenuItem>
      </>
    );
  if (failed)
    return (
      <>
        {separator && <MenuSeparator />}
        <p role="alert">Channel actions unavailable</p>
        <MenuItem
          closeOnClick={false}
          disabled={disabled}
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry channel permissions
        </MenuItem>
      </>
    );
  if (
    !state ||
    !(
      state.canHide ||
      state.canArchive ||
      state.canDelete ||
      state.canLeave ||
      state.deleteUnavailable
    )
  )
    return null;
  return (
    <>
      {separator && <MenuSeparator />}
      {state.canHide ? (
        <MenuItem disabled={disabled} onClick={() => choose("hide")}>
          <MenuIcon>
            <EyeSlashIcon size={14} />
          </MenuIcon>
          Hide conversation
        </MenuItem>
      ) : (
        <>
          {state.canArchive && (
            <MenuItem disabled={disabled} onClick={() => choose("archive")}>
              <MenuIcon>
                <ArchiveIcon size={14} />
              </MenuIcon>
              Archive channel
            </MenuItem>
          )}
          {state.deleteUnavailable && (
            <>
              <MenuItem disabled>Delete check unavailable</MenuItem>
              <MenuItem
                closeOnClick={false}
                disabled={disabled}
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry Delete check
              </MenuItem>
            </>
          )}
          {state.canDelete && (
            <MenuItem disabled={disabled} onClick={() => choose("delete")}>
              <MenuIcon>
                <TrashIcon size={14} />
              </MenuIcon>
              Delete channel
            </MenuItem>
          )}
          {state.canLeave && (
            <MenuItem disabled={disabled} onClick={() => choose("leave")}>
              <MenuIcon>
                <SignOutIcon size={14} />
              </MenuIcon>
              Leave channel
            </MenuItem>
          )}
        </>
      )}
    </>
  );
}
