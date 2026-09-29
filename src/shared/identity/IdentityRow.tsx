import { npubEncode } from "nostr-tools/nip19";
import {
  useId,
  useRef,
  useState,
  type AriaAttributes,
  type ReactNode,
} from "react";
import { CopyIcon } from "../design-system/icons";
import { IconButton } from "../design-system/ui/IconButton";
import { useToastNotification } from "../design-system/ui/Toast";
import { Avatar } from "../design-system/ui/Avatar";
import { ChoiceRow } from "../design-system/ui/ChoiceRow";
import { PreviewCard } from "../design-system/ui/PreviewCard";
import { formatPublicKey } from "./public-key";

/** Shared identity presentation. The caller retains selection and action behavior. */
export function IdentityRow({
  pubkey,
  name,
  picture,
  isAgent = false,
  keyLabel = formatPublicKey(pubkey),
  detail,
  previewDetail,
  render,
}: {
  pubkey: string;
  name: string;
  picture?: string | undefined;
  isAgent?: boolean | undefined;
  keyLabel?: string | undefined;
  detail?: string | undefined;
  previewDetail?: ReactNode;
  render?:
    | ((content: ReactNode, previewProps: AriaAttributes) => ReactNode)
    | undefined;
}) {
  const previewId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const previewProps: AriaAttributes = {
    "aria-describedby": descriptionId,
    "aria-details": open ? previewId : undefined,
  };
  const anchor = useRef<HTMLSpanElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const notify = useToastNotification();
  const npub = npubEncode(pubkey);
  const content = (
    <span ref={anchor} className="inline-flex max-w-full align-middle">
      <ChoiceRow
        leading={
          <Avatar
            alt=""
            fallback={name}
            src={picture}
            size="small"
            shape={isAgent ? "squircle" : "circle"}
          />
        }
        label={<span className="block truncate text-body-sm">{name}</span>}
        description={
          <span className="block truncate text-caption">
            {isAgent ? "Agent · " : ""}
            {keyLabel}
            {detail ? ` · ${detail}` : ""}
          </span>
        }
      />
    </span>
  );
  return (
    <>
      <span id={descriptionId} className="sr-only">
        Identity preview opens on focus. When open, press Tab to reach Copy
        npub, or Escape to dismiss the preview.
      </span>
      <PreviewCard
        id={previewId}
        open={open}
        onOpenChange={setOpen}
        side="top"
        anchor={anchor}
        actionRef={copyButton}
        aria-label={`${name} identity`}
        trigger={
          render ? (
            <span className="flex min-w-0 flex-1">
              {render(content, previewProps)}
            </span>
          ) : (
            <button
              type="button"
              className="flex min-w-0 flex-1 text-left"
              aria-label={`Preview ${name} identity`}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? previewId : undefined}
              {...previewProps}
              onClick={() => setOpen(true)}
            >
              {content}
            </button>
          )
        }
      >
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            alt=""
            fallback={name}
            src={picture}
            size="large"
            shape={isAgent ? "squircle" : "circle"}
          />
          <div className="min-w-0">
            <div className="text-label wrap-anywhere">{name}</div>
            <div className="text-body-sm text-subtle">
              {isAgent ? "Agent" : "Person"}
              {detail ? ` · ${detail}` : ""}
            </div>
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-start gap-1">
          <span className="min-w-0 flex-1 text-mono-sm break-all select-text">
            {npub}
          </span>
          <IconButton
            ref={copyButton}
            size="xs"
            variant="ghost"
            aria-label="Copy npub"
            icon={<CopyIcon size={16} aria-hidden="true" />}
            onClick={() => {
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(npub))
                .then(
                  () => notify("Copied npub", "success"),
                  () =>
                    notify(
                      "Couldn’t copy npub. Select the text to copy it.",
                      "error",
                    ),
                );
            }}
          />
        </div>
        {previewDetail}
      </PreviewCard>
    </>
  );
}
