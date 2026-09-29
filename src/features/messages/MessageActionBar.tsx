import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  ChatCircleIcon,
  CopyIcon,
  DotsThreeIcon,
  LinkIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import styles from "./Messages.module.css";

const AfterMenuClose = createContext<
  ((action: () => void) => void) | undefined
>(undefined);
export const useAfterMessageMenuClose = () => useContext(AfterMenuClose);

export function MessageActionBar({
  onReply,
  replyDisabled,
  link,
  copyText,
  quickControls,
  overflowItems,
  messageId,
  menuTriggerRef,
}: {
  messageId?: string;
  menuTriggerRef?: Ref<HTMLButtonElement>;
  onReply?: (() => void) | undefined;
  replyDisabled?: boolean | undefined;
  link?: string | undefined;
  copyText(): string;
  quickControls?: ReactNode;
  overflowItems?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const busy = useRef(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const [handingOffFocus, setHandingOffFocus] = useState(false);
  const copy = async (text: () => string, label: string) => {
    if (busy.current) return;
    busy.current = true;
    setCopying(true);
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(text());
      setNotice({ text: `${label} copied`, error: false });
    } catch {
      setNotice({
        text: "Couldn’t copy. Try again from the message menu.",
        error: true,
      });
    } finally {
      busy.current = false;
      setCopying(false);
    }
  };
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: This groups message actions, not form fields. */}
      <div
        className={styles.messageActions}
        data-open={open || undefined}
        role="group"
        aria-label="Message actions"
      >
        {quickControls}
        {onReply && (
          <IconButton
            aria-label="Reply"
            title={
              replyDisabled ? "Reply unavailable for this message" : "Reply"
            }
            size="sm"
            disabled={replyDisabled}
            icon={<ChatCircleIcon />}
            onClick={(event) => {
              event.currentTarget.focus();
              onReply();
            }}
          />
        )}
        <span>
          <IconButton
            aria-label="Copy link"
            title={link ? "Copy link" : "Message link unavailable"}
            size="sm"
            disabled={!link || copying}
            icon={<LinkIcon />}
            onClick={() => {
              if (link) void copy(() => link, "Link");
            }}
          />
        </span>
        <MenuRoot
          open={open}
          onOpenChange={(next) => {
            if (next) setHandingOffFocus(false);
            setOpen(next);
          }}
          onOpenChangeComplete={(opened) => {
            if (!opened) {
              const action = afterClose.current;
              afterClose.current = undefined;
              action?.();
            }
          }}
        >
          <MenuTrigger
            render={
              <IconButton
                ref={menuTriggerRef}
                aria-label="More message actions"
                title="More message actions"
                size="sm"
                icon={<DotsThreeIcon />}
              />
            }
          />
          <MenuPopup
            align="end"
            data-message-id={messageId}
            // A boolean preserves Base UI's safeguard when focus already moved.
            // A callback returning true would force focus back over a newer action.
            finalFocus={!handingOffFocus}
          >
            <AfterMenuClose.Provider
              value={(action) => {
                setHandingOffFocus(true);
                afterClose.current = action;
              }}
            >
              <MenuItem
                disabled={copying}
                onClick={() => void copy(copyText, "Message")}
              >
                <MenuIcon>
                  <CopyIcon />
                </MenuIcon>
                Copy message
              </MenuItem>
              {overflowItems}
            </AfterMenuClose.Provider>
          </MenuPopup>
        </MenuRoot>
      </div>
      {notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
    </>
  );
}
