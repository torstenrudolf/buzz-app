import {
  DownloadIcon,
  FileTextIcon,
} from "../../shared/design-system/icons/index";
import type { Attachment } from "../relay/contracts";
import {
  isNativeMediaSource,
  isProxySource,
  safeOpenUrl,
} from "./attachment-source";
import styles from "./Messages.module.css";

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${Math.round(size / (1024 * 1024))} MB`;
  return `${Math.round(size / (1024 * 1024 * 1024))} GB`;
}

function mimeLabel(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const [type, subtype] = mime.split("/");
  if (!type || !subtype) return undefined;
  if (subtype === "pdf") return "PDF file";
  if (!/^[a-z0-9]+$/i.test(subtype)) return undefined;
  return `${subtype.toUpperCase()} file`;
}

export function FileAttachment({
  attachment,
  source,
  onOpenLink,
}: {
  attachment: Attachment;
  source: string | undefined;
  onOpenLink(url: string): boolean;
}) {
  const displayName = attachment.name ?? mimeLabel(attachment.mime) ?? "File";
  const proxySource = source
    ? isProxySource(source) || isNativeMediaSource(source)
    : false;
  const externalSource = !!source && safeOpenUrl(source) && !proxySource;
  if (source && !proxySource && !externalSource)
    return <UnavailableFileAttachment displayName={displayName} />;

  const content = (
    <>
      <FileTextIcon size={24} aria-hidden="true" />
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>
          {source
            ? attachment.size
              ? formatFileSize(attachment.size)
              : proxySource
                ? "Download file"
                : "Open file"
            : "File unavailable"}
        </span>
      </span>
      {proxySource && <DownloadIcon size={20} aria-hidden="true" />}
    </>
  );
  if (!source) return <UnavailableFileAttachment displayName={displayName} />;
  if (externalSource)
    return (
      <a
        className={styles.fileAttachment}
        href={source}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${displayName}`}
        title={displayName}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (onOpenLink(source)) event.preventDefault();
        }}
      >
        {content}
      </a>
    );
  return (
    <a
      className={styles.fileAttachment}
      href={source}
      download={attachment.name ?? ""}
      aria-label={`Download ${displayName}`}
      title={displayName}
    >
      {content}
    </a>
  );
}

function UnavailableFileAttachment({ displayName }: { displayName: string }) {
  return (
    <span className={styles.fileAttachment} role="status" title={displayName}>
      <FileTextIcon size={24} aria-hidden="true" />
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>File unavailable</span>
      </span>
    </span>
  );
}
