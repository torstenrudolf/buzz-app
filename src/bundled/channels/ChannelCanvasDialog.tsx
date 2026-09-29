import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import type { RelayEvent } from "../../features/relay/events";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./ChannelTemplates.module.css";

type Draft = { content: string; base: string | null };
export function ChannelCanvasDialog({
  canvas,
  scope,
  channelId,
  open,
  onOpenChange,
  finalFocus,
}: {
  canvas: ChannelCanvas;
  scope: string;
  channelId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  finalFocus?: DialogProps["finalFocus"];
}) {
  const key = `canvas-draft-v1:${channelId}`;
  const [saved] = useState(() => {
    const value = readView<unknown>(scope, key, null);
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Partial<Draft>;
    return typeof raw.content === "string" &&
      (raw.base === null || typeof raw.base === "string")
      ? (raw as Draft)
      : undefined;
  });
  const [draft, setDraft] = useState(saved?.content ?? "");
  const [base, setBase] = useState<string | null>(saved?.base ?? null);
  const [head, setHead] = useState<RelayEvent>();
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const operation = useRef(0);
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  const load = useCallback(
    async (replace = false) => {
      const generation = ++operation.current;
      setBusy(true);
      setError("");
      try {
        const event = await canvas.read(channelId);
        if (generation !== operation.current) return;
        setHead(event);
        setLoaded(true);
        if (replace || (!saved && !loaded)) {
          setDraft(event?.content ?? "");
          setBase(event?.id ?? null);
          writeView(scope, key, {
            content: event?.content ?? "",
            base: event?.id ?? null,
          });
        } else if ((event?.id ?? null) !== base)
          setError(
            "Canvas changed since this draft began. Your draft is kept. Copy any edits you want to keep before reloading the saved Canvas.",
          );
      } catch (reason) {
        if (generation === operation.current) setError(String(reason));
      } finally {
        if (generation === operation.current) setBusy(false);
      }
    },
    [canvas, channelId, saved, loaded, scope, key, base],
  );
  useEffect(() => {
    if (open && !loaded) void load();
  }, [open, loaded, load]);
  const save = async () => {
    const generation = ++operation.current;
    setBusy(true);
    setError("");
    try {
      const event = await canvas.save(channelId, draft, base ?? undefined);
      if (generation === operation.current) {
        setHead(event);
        setBase(event.id);
        writeView(scope, key, null);
        onOpenChange(false);
      }
    } catch (reason) {
      if (generation === operation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === operation.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      finalFocus={finalFocus}
      preventClose={busy}
      title="Channel Canvas"
      closeLabel="Close Canvas"
      actions={
        <>
          {error && (
            <Button
              disabled={busy}
              onClick={() => {
                if (!loaded) void load();
                else if (
                  window.confirm(
                    "Discard your draft and reload the saved Canvas?",
                  )
                )
                  void load(true);
              }}
            >
              {loaded ? "Reload saved Canvas" : "Retry loading"}
            </Button>
          )}
          <Button
            variant="prominent"
            loading={busy}
            disabled={
              !loaded || !canvas.available || (head?.id ?? null) !== base
            }
            onClick={() => void save()}
          >
            Save Canvas
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <p className="text-secondary">
          Shared Markdown for this channel. Save checks for detected changes,
          but concurrent saves are not locked.
        </p>
        <Textarea
          aria-label="Canvas Markdown"
          variant="code"
          rows={16}
          value={draft}
          disabled={busy || !loaded}
          onChange={(e) => {
            setDraft(e.target.value);
            writeView(scope, key, { content: e.target.value, base });
          }}
        />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
