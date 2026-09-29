import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import { canvasPreviewText } from "./canvas-preview";
import type { ChannelSummary } from "../../features/relay/contracts";
import { channelIcon } from "../../features/channels/channel-icon";
import {
  CaretRightIcon,
  FileTextIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./Channels.module.css";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import { ChannelDetailsEditor } from "./ChannelDetailsEditor";

export function ChannelSettingsPanel({
  channel,
  close,
  children,
  setupTools,
  details,
  openCanvas,
  canvas,
  canvasOpen = false,
}: {
  channel: ChannelSummary | undefined;
  close(): void;
  children: ReactNode;
  setupTools?: ReactNode;
  details?: ChannelDetailsCapability;
  openCanvas?(trigger: HTMLButtonElement): void;
  canvas?: ChannelCanvas;
  canvasOpen?: boolean;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
  }, []);
  const channelId =
    channel && !channel.readOnly && openCanvas ? channel.id : undefined;
  const [preview, setPreview] = useState<{
    canvas: ChannelCanvas;
    channelId: string;
    text: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!canvas || !channelId || canvasOpen) return;
    setPreview(undefined);
    let active = true;
    void canvas.read(channelId).then(
      (event) => {
        if (active)
          setPreview({
            canvas,
            channelId,
            text: canvasPreviewText(event?.content ?? ""),
          });
      },
      () => {
        if (active) setPreview({ canvas, channelId, text: "", failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [canvas, channelId, canvasOpen]);
  const currentPreview =
    preview?.canvas === canvas && preview?.channelId === channelId
      ? preview
      : undefined;
  const previewText = currentPreview?.text ?? "";
  const previewFallback = currentPreview?.failed
    ? "Preview unavailable. Open to retry."
    : currentPreview
      ? "No content yet"
      : "Loading preview…";
  const ChannelIcon = channelIcon(channel);
  return (
    <Panel
      as="aside"
      aria-label="Channel settings"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className={styles.settingsPanel}>
        <PanelHeader
          title="Channel Settings"
          actions={
            <IconButton
              ref={closeButton}
              size="toolbar"
              aria-label="Close channel settings"
              onClick={close}
              icon={<XIcon size={18} aria-hidden="true" />}
            />
          }
        />
        <div className={styles.settingsContent}>
          {channel && (
            <>
              <div className={styles.settingsIdentity}>
                <span className={styles.settingsIcon}>
                  <ChannelIcon size={32} aria-hidden="true" />
                </span>
                <h3 className="text-heading text-primary">{channel.name}</h3>
              </div>
              <dl className={styles.settingsDetails}>
                {channel.channelType !== "session" &&
                  channel.channelType !== "dm" && (
                    <>
                      <div>
                        <dt>Description</dt>
                        <dd className={styles.settingsDescription}>
                          {channel.description === undefined
                            ? "Not available"
                            : channel.description || "No description"}
                        </dd>
                      </div>
                      <div>
                        <dt>Visibility</dt>
                        <dd>
                          {channel.visibility === "public"
                            ? "Public"
                            : channel.visibility === "private"
                              ? "Private"
                              : "Not available"}
                        </dd>
                      </div>
                    </>
                  )}
                {channel.channelType && (
                  <div>
                    <dt>Channel type</dt>
                    <dd>
                      {channel.channelType === "dm"
                        ? "Direct message"
                        : channel.channelType === "forum"
                          ? "Forum"
                          : channel.channelType === "session"
                            ? "Session"
                            : "Channel"}
                    </dd>
                  </div>
                )}
                {channel.members && (
                  <div>
                    <dt>Members</dt>
                    <dd>{channel.members.length}</dd>
                  </div>
                )}
                <div>
                  <dt>Channel ID</dt>
                  <dd className={styles.settingsId}>{channel.id}</dd>
                </div>
              </dl>
            </>
          )}
          {channel && !channel.readOnly && openCanvas && (
            <button
              type="button"
              className={styles.settingsCanvas}
              aria-label="Canvas"
              aria-description={previewText || previewFallback}
              aria-haspopup="dialog"
              onClick={(event) => openCanvas(event.currentTarget)}
            >
              <ChoiceRow
                leading={<FileTextIcon size={20} aria-hidden="true" />}
                label="Canvas"
                description={
                  previewText ? (
                    <span className={styles.settingsCanvasPreview}>
                      {previewText}
                    </span>
                  ) : (
                    previewFallback
                  )
                }
                trailing={<CaretRightIcon size={16} aria-hidden="true" />}
              />
            </button>
          )}
          {channel &&
            (channel.channelType === "stream" ||
              channel.channelType === "forum") &&
            !channel.readOnly &&
            !channel.cached &&
            !channel.archived &&
            (details?.available ? (
              <ChannelDetailsEditor channel={channel} capability={details} />
            ) : (
              <p>Editing is unavailable on this connection.</p>
            ))}
          {setupTools}
          <details className={styles.settingsDiagnostics}>
            <summary>Diagnostics</summary>
            <div className={styles.settingsTools}>{children}</div>
          </details>
        </div>
      </div>
    </Panel>
  );
}
