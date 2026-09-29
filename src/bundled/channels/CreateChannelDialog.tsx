import {
  emptyLineup,
  parseLineup,
  type Groups,
  type Group,
} from "../../features/channel-templates/model";
import type {
  TemplateDraft,
  TemplateProviders,
} from "../../features/channel-templates/provider";
import type { ChannelCreationInput } from "../../features/channel-templates/setup";
import type { RelaySession } from "../../features/relay/session";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { Select } from "../../shared/design-system/ui/Select";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../../features/relay/work-sessions";
import styles from "./CreateChannelDialog.module.css";

export type CreateChannelInput = ChannelCreationInput;

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(input: CreateChannelInput): Promise<void>;
  pending?: CreateChannelInput | undefined;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  session: RelaySession;
  providers: TemplateProviders;
  groups: Groups | undefined;
  destinations?: readonly Pick<Group, "id" | "name">[];
  groupSource?: "legacy";
  initialGroup: string;
  groupsReady: boolean;
};
export function CreateChannelDialog(props: Props) {
  // Each opening owns its callbacks. Closing/reopening cannot revive an old editor.
  return props.open ? <OpenCreateChannelDialog {...props} /> : null;
}
function OpenCreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
  finalFocus,
  session,
  providers,
  groups,
  destinations = groups?.groups ?? [],
  groupSource,
  initialGroup,
  groupsReady,
}: Props) {
  const available = useSyncExternalStore(
    providers.subscribe,
    providers.snapshot,
  );
  const provider = available.length === 1 ? available[0] : undefined;
  const [initialProvider] = useState(provider);
  const [initialDefault] = useState(() =>
    !pending && provider && !groupSource
      ? (groups?.groups.find((g) => g.id === initialGroup)?.defaultTemplateId ??
        "")
      : "",
  );
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [draft, setDraft] = useState<TemplateDraft | undefined>(() =>
    initialDefault
      ? {
          templateId: initialDefault,
          lineup: emptyLineup(),
          agents: [],
          problem: "Group default is awaiting selection.",
        }
      : undefined,
  );
  const input = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const privateControlId = useId();
  const mounted = useRef(true);
  const previousOpen = useRef(false);
  const previousPending = useRef(pending);
  const [name, setName] = useState("");
  const [descriptionVisible, setDescriptionVisible] = useState(false);
  const [description, setDescription] = useState("");
  const [lifetime, setLifetime] = useState<"ongoing" | "temporary">("ongoing");
  const [privateChannel, setPrivateChannel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [groupId, setGroupId] = useState("");
  const summary =
    pending?.setup ?? (draft ? { agents: draft.agents, groupId } : undefined);
  const group = groupSource
    ? undefined
    : groups?.groups.find((g) => g.id === groupId);
  const editing = useRef(false);
  editing.current = !pending && !busy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const opening = open && !previousOpen.current;
    const restoring =
      open && pending !== undefined && previousPending.current === undefined;
    previousOpen.current = open;
    previousPending.current = pending;
    if (!opening && !restoring) return;
    setName(pending?.name ?? "");
    setDescriptionVisible(!!pending?.description);
    setDescription(pending?.description ?? "");
    setLifetime(pending?.ttlSeconds === undefined ? "ongoing" : "temporary");
    setPrivateChannel(pending?.visibility === "private");
    setError("");
    setGroupId(pending?.setup?.groupId ?? initialGroup);
  }, [open, pending, initialGroup]);
  useEffect(() => {
    if (open && descriptionVisible) descriptionInput.current?.focus();
  }, [descriptionVisible, open]);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    editing.current = false;
    setBusy(true);
    setError("");
    try {
      if (
        !pending &&
        groupId &&
        (!groupsReady || !destinations.some((g) => g.id === groupId))
      )
        throw new Error(
          "Load the destination group or choose No group before creating.",
        );
      if (!pending && draft?.problem) throw new Error(draft.problem);
      const agents = draft?.agents ?? [];
      const canvas = draft?.lineup.canvas ?? "";
      const templateId = draft?.templateId ?? "";
      await onCreate(
        pending ?? {
          name: trimmedName,
          visibility: privateChannel ? "private" : "open",
          ...(lifetime === "temporary"
            ? { ttlSeconds: DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS }
            : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(templateId || groupId || agents.length || canvas
            ? {
                setup: {
                  agents,
                  canvas,
                  groupId,
                  templateId,
                  ...(groupId && groupSource ? { groupSource } : {}),
                },
              }
            : {}),
        },
      );
      if (mounted.current) onOpenChange(false);
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "The channel could not be created.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const recoverySummary = summary && (
    <section aria-label="Channel setup summary">
      <p>
        {summary.agents.length
          ? `${summary.agents.length} selected agent${summary.agents.length === 1 ? "" : "s"}.`
          : "Only you."}
        {summary.groupId &&
          ` Destination: ${destinations.find((g) => g.id === summary.groupId)?.name ?? "saved group"}.`}
      </p>
      {!pending && (
        <>
          <p>
            Your selected setup is retained. Restore Templates &amp; teams to
            edit it, or clear it below.
          </p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditorGeneration((generation) => generation + 1);
              setDraft({ templateId: "", lineup: emptyLineup(), agents: [] });
              setError("");
            }}
          >
            Clear template setup (keep group)
          </Button>
        </>
      )}
    </section>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      preventClose={busy}
      title="Create a channel"
      closeLabel="Close channel creation"
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <span className={styles.privateAction}>
            <Switch
              id={privateControlId}
              aria-label="Private"
              checked={privateChannel}
              readOnly={busy || !!pending}
              aria-disabled={busy || undefined}
              onCheckedChange={(checked) => {
                if (pending) return;
                setPrivateChannel(checked);
                setError("");
              }}
            />
            <label className="text-label-sm" htmlFor={privateControlId}>
              Private
            </label>
          </span>
          <Button
            variant="prominent"
            type="submit"
            form="create-channel-form"
            loading={busy}
            disabled={!name.trim()}
          >
            {pending ? "Retry channel" : "Create channel"}
          </Button>
        </>
      }
    >
      <form
        id="create-channel-form"
        className={styles.form}
        inert={busy}
        aria-busy={busy || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {pending && (
          <p role="status">
            This attempt may already have created a channel. Retry checks it
            first and, if unconfirmed, resends only the same creation request.
            It will not create another channel or continue template setup.
          </p>
        )}
        <fieldset
          disabled={!!pending}
          inert={!!pending}
          style={{ display: "contents", border: 0, padding: 0 }}
        >
          <Field label="Name">
            <Input
              ref={input}
              data-create-channel-name=""
              required
              maxLength={120}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="release-notes"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
          </Field>
          {descriptionVisible ? (
            <Field label="Description">
              <Textarea
                ref={descriptionInput}
                maxLength={1000}
                rows={3}
                placeholder="What this channel is for"
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setError("");
                }}
              />
            </Field>
          ) : (
            <span className={styles.descriptionAction}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDescriptionVisible(true)}
              >
                Add a description
              </Button>
            </span>
          )}
          {!pending && session.channelKit.available && (
            <Select
              variant="field"
              label="Destination group"
              value={groupId}
              groups={[
                {
                  label: "",
                  options: [
                    { value: "", label: "No group" },
                    ...destinations.map((g) => ({
                      value: g.id,
                      label: g.name,
                    })),
                  ],
                },
              ]}
              onValueChange={(id) => {
                setGroupId(id);
                if (draft?.problem === "Group default is awaiting selection.") {
                  setDraft(undefined);
                  setEditorGeneration((generation) => generation + 1);
                }
              }}
            />
          )}
          {!pending && provider && (
            <OwnedContribution
              key={editorGeneration}
              entry={provider}
              registry={providers}
              fallback={
                <>
                  <p role="alert">Template controls could not open.</p>
                  {recoverySummary}
                </>
              }
            >
              {(entry, active) => {
                const Editor = entry.editor;
                return (
                  <Editor
                    session={session}
                    value={draft}
                    initialDefault={
                      editorGeneration === 0 && provider === initialProvider
                        ? initialDefault
                        : ""
                    }
                    group={group}
                    active={() =>
                      active() &&
                      mounted.current &&
                      editing.current &&
                      !session.channelCreation.snapshot()
                    }
                    onChange={(value) => {
                      if (
                        !active() ||
                        !mounted.current ||
                        !editing.current ||
                        session.channelCreation.snapshot()
                      )
                        return;
                      try {
                        const lineup = parseLineup(value.lineup);
                        const resolved = parseLineup({
                          teamIds: [],
                          agents: value.agents,
                          canvas: lineup.canvas,
                        });
                        if (
                          typeof value.templateId !== "string" ||
                          (value.templateId &&
                            !/^[a-zA-Z0-9_-]{1,128}$/.test(value.templateId))
                        )
                          throw new Error("Invalid template selection");
                        setDraft({
                          templateId: value.templateId,
                          lineup,
                          agents: resolved.agents,
                          problem: value.problem
                            ? String(value.problem)
                            : undefined,
                        });
                      } catch (reason) {
                        setError(String(reason));
                      }
                    }}
                  />
                );
              }}
            </OwnedContribution>
          )}
          {!pending && !provider && group?.defaultTemplateId && !draft && (
            <p className="text-secondary">
              Templates &amp; teams is off. This channel will not use the
              group’s saved template default.
            </p>
          )}
          <Field label={<span className="sr-only">Duration</span>}>
            <RadioGroup
              value={lifetime}
              onValueChange={(value) => {
                setLifetime(value);
                setError("");
              }}
            >
              <Radio
                value="ongoing"
                variant="card"
                label="Ongoing"
                description="Keeps its history until you archive it."
              />
              <Radio
                value="temporary"
                variant="card"
                label="Temporary"
                description="Cleans up after 7 days without activity."
              />
            </RadioGroup>
          </Field>
        </fieldset>
        {!pending && draft?.problem && <p role="alert">{draft.problem}</p>}
        {(pending || !provider) && recoverySummary}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
