import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import {
  detailsDraftErrors,
  canonicalDetailsName,
  type ChannelDetails,
  type ChannelDetailsDraft,
} from "../../features/relay/channel-details-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Select } from "../../shared/design-system/ui/Select";
import styles from "./Channels.module.css";

/** Unlike native maxLength, count Unicode code points without splitting emoji.
 * Trim only inserted growth, preserving existing text even above the UI limit. */
function boundedInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  previous: string,
  limit: number,
): string {
  const ceiling = Math.max(limit, [...previous].length);
  const excess = [...input.value].length - ceiling;
  if (excess <= 0) return input.value;
  // The caret follows the inserted text. Remove overflow there, not from the
  // end of the field, so typing/pasting in the middle cannot eat existing text.
  const caret = input.selectionStart ?? input.value.length;
  const before = [...input.value.slice(0, caret)];
  const prefix = before.slice(0, Math.max(0, before.length - excess)).join("");
  const value = prefix + input.value.slice(caret);
  input.value = value;
  input.setSelectionRange(prefix.length, prefix.length);
  return value;
}

/** The capability owns writes; this view owns only a destination-bound editable draft. */
export function ChannelDetailsEditor({
  capability,
  channel,
}: {
  capability: ChannelDetailsCapability;
  channel: ChannelSummary;
}) {
  const id = channel.id;
  const attempt = useSyncExternalStore(capability.subscribe, () =>
    capability.snapshot(id),
  );
  const initial = () => ({
    capability,
    id,
    loading: true,
    editing: false,
    pending: false,
    error: "",
    base: undefined as ChannelDetails | undefined,
    draft: undefined as ChannelDetailsDraft | undefined,
  });
  const [state, setState] = useState(initial);
  // Discard drafts during render, not a frame after retargeting to another identity.
  const matches = state.capability === capability && state.id === id;
  if (!matches) setState(initial());
  const view = matches ? state : initial();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const statusId = useId();
  const nameCountId = useId();
  const descriptionCountId = useId();
  const patch = useCallback(
    (
      next:
        | Partial<typeof state>
        | ((old: typeof state) => Partial<typeof state>),
    ) =>
      setState((old) =>
        old.capability === capability && old.id === id
          ? { ...old, ...(typeof next === "function" ? next(old) : next) }
          : old,
      ),
    [capability, id],
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      patch({ loading: true, error: "" });
      try {
        const base = await capability.load(id, signal);
        if (!signal.aborted)
          patch((old) => ({
            base,
            // Privacy is authoritative; keep text edits, not an impossible
            // public draft after another editor made the channel private.
            draft:
              old.draft && base.visibility === "private"
                ? { ...old.draft, visibility: "private" }
                : old.draft,
          }));
      } catch (error) {
        if (!signal.aborted)
          patch({
            base: undefined,
            error: String(error instanceof Error ? error.message : error),
          });
      } finally {
        if (!signal.aborted) patch({ loading: false });
      }
    },
    [capability, id, patch],
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    busy.current = false;
    void load(controller.signal);
    return () => {
      controller.abort();
    };
    // The owner and destination, not metadata updates, define this editor lifetime.
  }, [load]);
  const draft = attempt?.draft ?? view.draft;
  const pending = view.pending || attempt?.status === "saving";
  const locked = view.loading || pending || !!attempt;
  const canEdit = !!view.base?.canEdit;
  const normalized = draft && {
    ...draft,
    name: canonicalDetailsName(draft.name),
  };
  const errors = normalized ? detailsDraftErrors(normalized) : undefined;
  const nameLength = [...(draft?.name ?? "")].length;
  const descriptionLength = [...(draft?.description ?? "")].length;
  const showNameCount = nameLength >= 108 && !errors?.name;
  const showDescriptionCount = descriptionLength >= 900 && !errors?.description;
  const dirty =
    !!normalized &&
    !!view.base &&
    (normalized.name !== view.base.name ||
      normalized.description !== view.base.description ||
      normalized.visibility !== view.base.visibility);
  const canSave =
    view.editing &&
    !locked &&
    canEdit &&
    dirty &&
    !Object.values(errors ?? {}).some(Boolean);
  const edit = () => {
    if (attempt || (!view.loading && canEdit))
      patch({ editing: true, draft: attempt?.draft ?? view.base, error: "" });
  };
  const close = () => {
    if (!pending && !busy.current) patch({ editing: false, error: "" });
  };
  async function save() {
    const controller = lifetime.current;
    if (busy.current || !canSave || !view.base || !normalized || !controller)
      return;
    busy.current = true;
    patch({ pending: true, error: "" });
    try {
      await capability.save(view.base, normalized, controller.signal);
      if (controller.signal.aborted) return;
      await load(controller.signal);
      if (!controller.signal.aborted) patch({ editing: false });
    } catch (error) {
      if (!controller.signal.aborted)
        patch({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        patch({ pending: false });
      }
    }
  }
  async function check() {
    const controller = lifetime.current;
    if (!controller || busy.current || attempt?.status !== "unconfirmed")
      return;
    busy.current = true;
    patch({ pending: true, error: "" });
    try {
      await capability.check(id, controller.signal);
      if (controller.signal.aborted) return;
      await load(controller.signal);
      if (!controller.signal.aborted) patch({ editing: false });
    } catch (error) {
      if (!controller.signal.aborted)
        patch({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        patch({ pending: false });
      }
    }
  }
  const status = (
    <div id={statusId} className={styles.detailsEditor}>
      {attempt?.status === "saving" && (
        <p role="status">Saving channel details…</p>
      )}
      {attempt?.status === "unconfirmed" && (
        <p role="status">
          The change may have been saved. Check its status before trying again.
          Checking never resends it. Closing this dialog does not undo the
          change.
        </p>
      )}
      {!attempt && view.loading && (
        <p role="status">Checking channel permissions…</p>
      )}
      {!attempt && !view.loading && view.base && !canEdit && (
        <p>Only current channel owners and admins can edit these details.</p>
      )}
      {view.error && <p role="alert">{view.error}</p>}
      {!attempt && view.error && (
        <Button
          disabled={view.loading || pending}
          onClick={() => {
            if (lifetime.current) void load(lifetime.current.signal);
          }}
        >
          Reload details
        </Button>
      )}
    </div>
  );
  return (
    <section className={styles.detailsEditor} aria-label="Edit channel details">
      {(canEdit || attempt) && (
        <Button ref={editButton} onClick={edit}>
          {attempt ? "Review pending changes" : "Edit details"}
        </Button>
      )}
      {!view.editing && status}
      <Dialog
        open={view.editing}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Edit channel details"
        closeLabel="Close edit channel details"
        preventClose={pending}
        initialFocus={attempt ? undefined : nameInput}
        finalFocus={editButton}
        actions={
          <>
            <Button disabled={pending} onClick={close}>
              {attempt ? "Close" : "Cancel"}
            </Button>
            {attempt?.status === "unconfirmed" ? (
              <Button
                variant="prominent"
                loading={view.pending}
                disabled={view.loading}
                onClick={() => void check()}
              >
                Check save status
              </Button>
            ) : (
              <Button
                type="submit"
                form={formId}
                variant="prominent"
                loading={pending}
                disabled={!canSave}
              >
                Save changes
              </Button>
            )}
          </>
        }
      >
        <form
          id={formId}
          className={styles.detailsEditor}
          aria-describedby={statusId}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {draft && (
            <>
              <Field
                label={
                  <span className={styles.detailsLabel}>
                    <span>Name</span>
                    {showNameCount && (
                      <span
                        aria-hidden="true"
                        className="text-body-sm text-subtle tabular-nums"
                      >
                        {nameLength}/120
                      </span>
                    )}
                  </span>
                }
                error={errors?.name}
              >
                <Input
                  ref={nameInput}
                  {...(showNameCount
                    ? { "aria-describedby": nameCountId }
                    : {})}
                  required
                  value={draft.name}
                  disabled={locked || !canEdit}
                  onChange={(event) =>
                    patch({
                      draft: {
                        ...draft,
                        name: boundedInput(
                          event.currentTarget,
                          draft.name,
                          120,
                        ),
                      },
                    })
                  }
                />
                {showNameCount && (
                  <span id={nameCountId} className="sr-only">
                    {nameLength} of 120 characters
                  </span>
                )}
              </Field>
              <Field
                label={
                  <span className={styles.detailsLabel}>
                    <span>Description</span>
                    {showDescriptionCount && (
                      <span
                        aria-hidden="true"
                        className="text-body-sm text-subtle tabular-nums"
                      >
                        {descriptionLength.toLocaleString("en-US")}/1,000
                      </span>
                    )}
                  </span>
                }
                error={errors?.description}
              >
                <Textarea
                  {...(showDescriptionCount
                    ? { "aria-describedby": descriptionCountId }
                    : {})}
                  rows={3}
                  value={draft.description}
                  disabled={locked || !canEdit}
                  onChange={(event) =>
                    patch({
                      draft: {
                        ...draft,
                        description: boundedInput(
                          event.currentTarget,
                          draft.description,
                          1000,
                        ),
                      },
                    })
                  }
                />
                {showDescriptionCount && (
                  <span id={descriptionCountId} className="sr-only">
                    {descriptionLength.toLocaleString("en-US")} of 1,000
                    characters
                  </span>
                )}
              </Field>
              {view.base?.visibility === "public" ? (
                <Select
                  label="Visibility"
                  variant="field"
                  value={draft.visibility}
                  disabled={locked || !canEdit}
                  description={
                    draft.visibility === "private"
                      ? "Saving makes this channel invite-only. Existing members keep access; people outside the channel lose access. You cannot make it public again here."
                      : undefined
                  }
                  groups={[
                    {
                      label: "",
                      options: [
                        { value: "public", label: "Public" },
                        { value: "private", label: "Private" },
                      ],
                    },
                  ]}
                  onValueChange={(value) =>
                    patch({
                      draft: {
                        ...draft,
                        visibility: value === "private" ? "private" : "public",
                      },
                    })
                  }
                />
              ) : (
                <p>
                  {draft.visibility === "private"
                    ? "Private · This channel cannot be made public here."
                    : "Public"}
                </p>
              )}
            </>
          )}
          {view.editing && status}
        </form>
      </Dialog>
    </section>
  );
}
