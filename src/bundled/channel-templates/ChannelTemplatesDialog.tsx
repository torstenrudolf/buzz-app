import type { RelaySession } from "../../features/relay/session";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelKit } from "../../features/channel-templates/capability";
import {
  emptyLineup,
  type AgentChoice,
  type KitEntry,
  type KitValue,
  type Team,
  type Template,
} from "../../features/channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { AgentSelection, TemplateFields } from "./TemplateFields";
import styles from "../channels/ChannelTemplates.module.css";

export function ChannelTemplatesDialog({
  session,
  open,
  onOpenChange,
  kit,
  agents,
  initial,
  notice,
  active,
}: {
  session?: RelaySession | undefined;
  active(): boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  kit: ChannelKit;
  agents: readonly AgentChoice[];
  initial?: Template | undefined;
  notice?: string | undefined;
}) {
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const state = useSyncExternalStore(kit.subscribe, kit.snapshot);
  const [draft, setDraft] = useState<Team | Template>();
  const [base, setBase] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      kit.ensure();
      if (initial) {
        setDraft(initial);
        setBase(undefined);
      }
    }
  }, [open, kit, initial]);
  const edit = (entry: KitEntry) => {
    if (entry.record.value.type === "groups") return;
    setDraft(structuredClone(entry.record.value));
    setBase(entry.eventId);
    setError("");
  };
  const save = async (
    value: KitValue,
    expected: string | undefined,
    deleted = false,
  ) => {
    if (!live.current || !active()) return;
    setBusy(true);
    setError("");
    try {
      await kit.save(value, expected, deleted);
      setDraft(undefined);
      setBase(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      preventClose={busy}
      title={
        draft
          ? draft.type === "team"
            ? "Saved team"
            : "Channel template"
          : "Templates & teams"
      }
      closeLabel="Close templates"
      actions={
        draft ? (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                setDraft(undefined);
                setError("");
              }}
            >
              Back to library
            </Button>
            <Button
              variant="prominent"
              loading={busy}
              disabled={!draft.name.trim() || state.status !== "ready"}
              onClick={() => void save(draft, base)}
            >
              Save {draft.type}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className={styles.stack} inert={busy}>
        <p className="text-secondary">
          Private to you in this community. Saved teams stay reusable; applying
          a template copies its starting setup once.
        </p>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {state.status !== "ready" && (
          <p role="status">
            {state.error ??
              (state.status === "unavailable"
                ? "This host does not support saved templates."
                : "Loading your saved templates…")}
          </p>
        )}
        {draft ? (
          <>
            <Field label="Name">
              <Input
                maxLength={120}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            {draft.type === "team" ? (
              <AgentSelection
                session={session}
                agents={agents}
                selected={draft.agents}
                onChange={(agents) => setDraft({ ...draft, agents })}
              />
            ) : (
              <>
                <Field label="Description">
                  <Input
                    maxLength={1000}
                    value={draft.description}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </Field>
                <TemplateFields
                  session={session}
                  value={draft}
                  onChange={(value) => setDraft({ ...draft, ...value })}
                  entries={state.entries}
                  agents={agents}
                />
              </>
            )}
            <p className="text-secondary">
              Edits affect future channels only. Concurrent saves are checked,
              not locked across devices.
            </p>
          </>
        ) : (
          <>
            <div className={styles.actions}>
              <Button
                disabled={!kit.available || state.status !== "ready"}
                onClick={() => {
                  setDraft({
                    type: "template",
                    id: crypto.randomUUID(),
                    name: "",
                    description: "",
                    ...emptyLineup(),
                  });
                  setBase(undefined);
                }}
              >
                New template
              </Button>
              <Button
                disabled={!kit.available || state.status !== "ready"}
                onClick={() => {
                  setDraft({
                    type: "team",
                    id: crypto.randomUUID(),
                    name: "",
                    agents: [],
                  });
                  setBase(undefined);
                }}
              >
                New team
              </Button>
              <Button onClick={() => void kit.refresh()}>Refresh</Button>
            </div>
            {(["template", "team"] as const).map((type) => (
              <section key={type} className={styles.list}>
                <h3>{type === "team" ? "Saved teams" : "Channel templates"}</h3>
                {state.entries
                  .filter(
                    (e) => !e.record.deleted && e.record.value.type === type,
                  )
                  .map((entry) => {
                    const value = entry.record.value;
                    if (value.type === "groups") return null;
                    return (
                      <div key={value.id} className={styles.row}>
                        <Button variant="ghost" onClick={() => edit(entry)}>
                          {value.name}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete “${value.name}”? Existing channels stay unchanged. References in templates and group defaults will need replacement.`,
                              )
                            )
                              void save(value, entry.eventId, true);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    );
                  })}
              </section>
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}
