import type { ComposerInputElement } from "../messages/composer-dom";
import { createPortal } from "react-dom";
import { useCompletionPosition } from "./useCompletionPosition";
import {
  useId,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  CompletionContext,
  CompletionEdit,
  CompletionQuery,
  CompletionResult,
  ComposerObservation,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { completionResult, matchCompletion } from "./completion";
import type { CompletionEditor } from "./useCompletionEditor";
import styles from "./Completions.module.css";

const RETRY = Symbol("retry-completion");

export function ComposerCompletions({
  registry,
  editor,
  input,
  replace,
  resolved,
  ...context
}: CompletionContext & {
  registry: ContributionReader<ComposerCompletion>;
  editor: CompletionEditor;
  input: RefObject<ComposerInputElement | null>;
  /** Chip ranges and the draft text they were measured against. */
  resolved: Readonly<{
    text: string;
    recipients: readonly Readonly<{ start: number; end: number }>[];
  }>;
  replace(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ): boolean;
}) {
  const providers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const observation = editor.observation;
  // Stale chip ranges cannot classify this caret.
  const match =
    observation &&
    resolved.text === observation.text &&
    matchCompletion(providers, observation, context, resolved.recipients);
  if (!match || !observation) return null;
  return (
    <ContributionBoundary
      key={JSON.stringify([
        contributionKey(match.provider),
        observation.revision,
        match.query.start,
        match.query.end,
        match.query.query,
      ])}
      fallback={
        <span role="status">
          {match.provider.title} suggestions unavailable
        </span>
      }
    >
      <OwnedCompletion
        {...context}
        registry={registry}
        provider={match.provider}
        query={match.query}
        observation={observation}
        editor={editor}
        input={input}
        replace={replace}
      />
    </ContributionBoundary>
  );
}
function OwnedCompletion({
  provider,
  registry,
  query,
  observation,
  editor,
  input,
  replace,
  ...context
}: CompletionContext & {
  provider: Contribution<ComposerCompletion>;
  registry: ContributionReader<ComposerCompletion>;
  query: CompletionQuery;
  observation: ComposerObservation;
  editor: CompletionEditor;
  input: RefObject<ComposerInputElement | null>;
  replace(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ): boolean;
}) {
  const id = useId();
  const compact = provider.pluginId === "buzz.emoji";
  const mention = provider.pluginId === "buzz.mentions";
  const popup = useCompletionPosition(
    input,
    compact ? 0.375 : 1,
    mention ? { preferAbove: true, gap: 4, maxWidth: 380 } : undefined,
  );
  const list = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<CompletionResult>();
  const latest = useRef<CompletionResult | undefined>(undefined);
  // Only user navigation pins an ID; automatic selection follows the first result.
  const [selected, setSelected] = useState<string | typeof RETRY>();
  const revealSelection = useRef(false);
  const live = useRef(false);
  const current = useRef({ editor, replace });
  useLayoutEffect(() => {
    current.current = { editor, replace };
  });
  const active = useCallback(
    () =>
      live.current &&
      registry.snapshot().includes(provider) &&
      current.current.editor.valid(observation),
    [provider, registry, observation],
  );
  const [publish, setPublish] = useState<ComposerCompletionProps["publish"]>();
  useLayoutEffect(() => {
    live.current = true;
    let owned = true;
    setPublish(() => (incoming: CompletionResult) => {
      if (!owned || !active()) return false;
      const next = completionResult(incoming);
      latest.current = next;
      revealSelection.current = true;
      setResult(next);
      setSelected((previous) =>
        next.items.some((item) => item.id === previous)
          ? previous
          : previous === RETRY && next.retry
            ? RETRY
            : undefined,
      );
      return () => {
        if (latest.current !== next) return;
        latest.current = undefined;
        if (live.current) setResult(undefined);
      };
    });
    return () => {
      owned = false;
      live.current = false;
      latest.current = undefined;
    };
  }, [active]);
  const items = result?.items ?? [];
  // Matching syntax is not evidence of pending work. Providers publish their
  // own status when needed; an empty/unpublished result must not flash a portal.
  const visible = !!(items.length || result?.status || result?.retry);
  const count = items.length + (result?.retry ? 1 : 0);
  const index =
    selected === RETRY && result?.retry
      ? items.length
      : items.findIndex((item) => item.id === selected);
  const selectedIndex = index < 0 ? 0 : index;
  const status = result?.status;
  function accept(index: number, key = "click") {
    if (!active() || latest.current !== result) return false;
    if (index === items.length && result?.retry) {
      result.retry();
      return true;
    }
    const item = items[index];
    if (!item || item.disabled || item.canSelect?.(key) === false) return false;
    const accepted = current.current.replace(
      item.edit,
      query,
      observation,
      key,
    );
    if (accepted) current.current.editor.invalidate();
    return accepted;
  }
  useLayoutEffect(() => {
    const element = input.current;
    // Escape must still dismiss an unpublished provider without advertising a
    // nonexistent listbox. A settled empty result leaves ordinary keys alone.
    if (!element || (!visible && result)) return;
    if (visible) {
      element.setAttribute("aria-autocomplete", "list");
      element.setAttribute("aria-haspopup", "listbox");
      element.setAttribute("aria-controls", id);
      if (count)
        element.setAttribute("aria-activedescendant", `${id}-${selectedIndex}`);
      else element.removeAttribute("aria-activedescendant");
    }
    const handle: NonNullable<CompletionEditor["keys"]["current"]> = (
      event,
    ) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        current.current.editor.invalidate();
        return true;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return false;
      if (!active()) {
        // A displayed choice owns plain acceptance even when its final evidence
        // was revoked. Never turn a rejected edit into an unintended send.
        if ((event.key === "Enter" || event.key === "Tab") && count) {
          event.preventDefault();
          event.stopPropagation();
          current.current.editor.invalidate();
          return true;
        }
        return false;
      }
      if (event.key === " " && result?.spaceId) {
        const exact = items.findIndex((item) => item.id === result.spaceId);
        if (accept(exact, " ")) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        return false;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
        event.preventDefault();
        event.stopPropagation();
        const next =
          (selectedIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        revealSelection.current = true;
        setSelected(next === items.length ? RETRY : items[next]?.id);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && count) {
        event.preventDefault();
        event.stopPropagation();
        accept(selectedIndex, event.key);
        return true;
      }
      return false;
    };
    editor.keys.current = handle;
    if (revealSelection.current) {
      list.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
      revealSelection.current = false;
    }
    return () => {
      if (editor.keys.current === handle) editor.keys.current = undefined;
      element.removeAttribute("aria-autocomplete");
      element.removeAttribute("aria-haspopup");
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-activedescendant");
    };
  });
  const Provider = provider.component;
  return (
    <>
      {publish && (
        <Provider
          {...context}
          observation={observation}
          query={query}
          publish={publish}
        />
      )}
      {visible &&
        input.current &&
        createPortal(
          <section
            ref={popup}
            className={styles.popup}
            aria-label={`${provider.title} suggestions`}
            data-compact={compact || undefined}
            data-mention={mention || undefined}
          >
            <div
              id={id}
              role="listbox"
              aria-label={`${provider.title} suggestions`}
              ref={list}
              className={styles.list}
            >
              {items.map((item, i) => (
                // The textarea owns keyboard focus/selection via aria-activedescendant.
                // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
                <div
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === selectedIndex}
                  aria-disabled={!!item.disabled}
                  aria-label={
                    compact && item.detail
                      ? `${item.label} ${item.detail}`
                      : undefined
                  }
                  id={`${id}-${i}`}
                  key={item.id}
                  onPointerDown={(event) => {
                    if (event.button === 0) event.preventDefault();
                  }}
                  onPointerMove={
                    compact || mention
                      ? () => {
                          revealSelection.current = false;
                          setSelected(item.id);
                        }
                      : undefined
                  }
                  onClick={() => accept(i)}
                  className={styles.option}
                >
                  {item.preview && (
                    <span aria-hidden="true" className={styles.preview}>
                      {item.preview}
                    </span>
                  )}
                  <span className={styles.label} data-completion-label>
                    {mention ? (
                      <span className={styles.name}>{item.label}</span>
                    ) : (
                      item.label
                    )}
                    {item.detail && (
                      <small
                        aria-hidden={compact || undefined}
                        data-recipient-key={
                          (mention && /^[0-9a-f]{64}$/.test(item.detail)) ||
                          undefined
                        }
                        title={mention ? item.detail : undefined}
                      >
                        {item.detail}
                      </small>
                    )}
                  </span>
                </div>
              ))}
              {result?.retry && (
                // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
                <div
                  role="option"
                  tabIndex={-1}
                  id={`${id}-${items.length}`}
                  aria-selected={selectedIndex === items.length}
                  className={styles.option}
                  onPointerDown={(event) => {
                    if (event.button === 0) event.preventDefault();
                  }}
                  onPointerMove={
                    compact || mention
                      ? () => {
                          revealSelection.current = false;
                          setSelected(RETRY);
                        }
                      : undefined
                  }
                  onClick={() => accept(items.length)}
                >
                  Retry suggestions
                </div>
              )}
            </div>
            {status && <p role="status">{status}</p>}
          </section>,
          // A body sibling would sit behind a fullscreen modal and outside its
          // accessibility boundary. Ordinary composers keep the body portal.
          input.current.closest('[role="dialog"][aria-modal="true"]') ??
            input.current.ownerDocument.body,
        )}
    </>
  );
}
