import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Messages.module.css";

/** Replies expand once and remain readable lists, not a collapsible tree widget. */
export function ReplyBranch({
  message,
  layout,
  summary,
  label,
  hasReplies,
  open,
  depth,
  onExpand,
  children,
}: {
  message: ReactNode;
  layout: "thread" | "continuation";
  summary: ReactNode;
  label: string;
  hasReplies: boolean;
  open: boolean;
  depth: number;
  onExpand(): void;
  children: ReactNode;
}) {
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const focusRevealed = useRef(false);
  useLayoutEffect(() => {
    if (!open || !focusRevealed.current) return;
    focusRevealed.current = false;
    const row = panel.current?.querySelector<HTMLElement>("[data-message-id]");
    if (row) {
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
    }
  }, [open]);
  const messageRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    return () => {
      const row = element.querySelector<HTMLElement>("[data-message-id]");
      if (!row?.contains(document.activeElement)) return;
      const parent = element.parentElement?.parentElement
        ?.closest("[data-depth]")
        ?.querySelector<HTMLElement>("[data-message-id]");
      const history = element.closest<HTMLElement>(
        '[aria-label="Thread messages"]',
      );
      queueMicrotask(() => {
        // Exact-link reparenting restores focus during layout; never override it
        // or a user who has deliberately moved elsewhere.
        if (row.isConnected || document.activeElement !== document.body) return;
        const target = parent?.isConnected ? parent : history;
        if (!target?.isConnected || target.closest("[inert]")) return;
        if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <div
      className={styles.replyBranch}
      data-depth={Math.min(depth, 6)}
      data-open={open && hasReplies}
      data-layout={layout}
    >
      <div ref={messageRef} className={styles.replyBranchMessage}>
        {message}
      </div>
      {hasReplies && !open && (
        <div className={styles.replyBranchSummary}>
          <Button
            variant="link"
            size="sm"
            aria-label={label}
            aria-expanded={false}
            aria-controls={panelId}
            onClick={() => {
              focusRevealed.current = true;
              onExpand();
            }}
          >
            {summary}
          </Button>
        </div>
      )}
      <div
        id={panelId}
        ref={panel}
        className={styles.replyBranchPanel}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}
