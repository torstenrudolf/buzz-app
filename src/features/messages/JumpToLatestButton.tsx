import { ArrowDownIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Messages.module.css";

export function JumpToLatestButton({
  newMessageCount,
  onClick,
}: {
  newMessageCount: number;
  onClick(): void;
}) {
  const label =
    newMessageCount > 0
      ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
      : "Jump to latest";
  return (
    <div className={styles.jumpToLatest}>
      <Button
        data-jump-to-latest=""
        size="sm"
        variant="outline"
        onClick={onClick}
      >
        <ArrowDownIcon size={16} aria-hidden="true" />
        {label}
      </Button>
    </div>
  );
}
