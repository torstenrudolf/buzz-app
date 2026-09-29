import { useState } from "react";
import {
  savedMessage,
  type AgentControl,
  type AgentControlState,
  type AgentDefaultSettings,
  type AgentDefaultsEdit,
} from "../features/agents/control";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Select } from "../shared/design-system/ui/Select";
import styles from "./AgentSettings.module.css";

const harnesses = [
  { value: "buzz-agent", label: "Buzz Agent" },
  { value: "goose", label: "Goose" },
  { value: "pi", label: "Pi" },
] as const;

function draftFrom(saved: AgentDefaultSettings): AgentDefaultsEdit {
  const { environmentKeys: _keys, ...fields } = saved;
  return { ...fields, environment: {} };
}

/** Device-wide defaults. Environment values are write-only: only keys return. */
export function AgentDefaultsCard({
  control,
  state,
}: {
  control: AgentControl;
  state: AgentControlState;
}) {
  const saved = state.data?.defaultSettings;
  const [draft, setDraft] = useState<AgentDefaultsEdit | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  if (!saved || !control.saveDefaults) return null;
  const current = draft ?? draftFrom(saved);
  const disabled = state.busy || state.status !== "ready";
  const change = (patch: Partial<AgentDefaultsEdit>) => {
    setNotice("");
    setDraft({ ...current, ...patch });
  };
  const keys = [
    ...new Set([...saved.environmentKeys, ...Object.keys(current.environment)]),
  ].sort();
  const save = () => {
    setError("");
    void control.saveDefaults?.(current).then(
      (snapshot) => {
        setDraft(null);
        setNewKey("");
        setNewValue("");
        setNotice(savedMessage(snapshot.restarted, snapshot.restartFailures));
      },
      // The controller's sanitized reason: a save may already have committed
      // (e.g. Stop overtook its restart), so never claim nothing was saved.
      (problem: Error) => setError(problem.message),
    );
  };
  return (
    <section
      aria-labelledby="agent-defaults-title"
      className={`${styles.card} mt-6 space-y-4`}
    >
      <div className="space-y-1">
        <h3 id="agent-defaults-title" className="m-0 text-label">
          Agent defaults
        </h3>
        <p className="m-0 text-body-sm text-secondary">
          New agents start with this harness. Blank provider, model and effort,
          plus inherited conversation context, use these values at each start.
          An agent’s own choices win.
        </p>
      </div>
      <Select
        label="Default harness"
        variant="field"
        disabled={disabled}
        value={current.harness}
        groups={[{ label: "", options: harnesses }]}
        onValueChange={(harness) =>
          change({
            harness: harness as AgentDefaultsEdit["harness"],
            // Model and effort belong to the previous harness.
            ...(harness === current.harness ? {} : { model: "", effort: "" }),
          })
        }
      />
      <Field label="Default provider">
        <Input
          disabled={disabled}
          value={current.provider}
          placeholder="Not set"
          onChange={(event) => change({ provider: event.target.value })}
        />
      </Field>
      <Field label="Default model">
        <Input
          disabled={disabled}
          value={current.model}
          placeholder="Not set"
          onChange={(event) => change({ model: event.target.value })}
        />
      </Field>
      <Field label="Default effort">
        <Input
          disabled={disabled}
          value={current.effort}
          placeholder="Not set, for example high"
          onChange={(event) => change({ effort: event.target.value })}
        />
      </Field>
      <Select
        label="Conversation context"
        variant="field"
        disabled={disabled}
        value={current.sessionPolicy}
        groups={[
          {
            label: "",
            options: [
              { value: "channel", label: "Entire channel" },
              { value: "thread", label: "Each thread" },
            ],
          },
        ]}
        onValueChange={(sessionPolicy) =>
          change({
            sessionPolicy: sessionPolicy as AgentDefaultsEdit["sessionPolicy"],
          })
        }
        description="Entire channel shares one conversation across threads. Each thread keeps a separate conversation; direct messages remain shared."
      />
      <fieldset disabled={disabled} className="min-w-0 space-y-3">
        <legend className="mb-2 text-label-sm">Environment variables</legend>
        <p className="m-0 text-body-sm text-secondary">
          Added to every agent; an agent’s own key wins. Saved values stay on
          this device and are never shown again.
        </p>
        {keys.length > 0 && (
          <ul className={styles.rows}>
            {keys.map((key) => {
              const removed = current.environment[key] === null;
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-body-sm"
                >
                  <code className={`${styles.command} text-mono`}>{key}</code>
                  <span className="flex items-center gap-2">
                    <span className="text-secondary">
                      {removed
                        ? "Removed on save"
                        : typeof current.environment[key] === "string"
                          ? "Set on save"
                          : "Set"}
                    </span>
                    <Button
                      size="sm"
                      type="button"
                      aria-label={`${removed ? "Keep" : "Remove"} ${key}`}
                      onClick={() => {
                        const environment = { ...current.environment };
                        if (removed || !saved.environmentKeys.includes(key))
                          delete environment[key];
                        else environment[key] = null;
                        change({ environment });
                      }}
                    >
                      {removed ? "Keep" : "Remove"}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="Name">
              <Input
                value={newKey}
                spellCheck={false}
                onChange={(event) => setNewKey(event.target.value.trim())}
              />
            </Field>
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Value">
              <Input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={newValue}
                onChange={(event) => setNewValue(event.target.value)}
              />
            </Field>
          </div>
          <Button
            type="button"
            disabled={!newKey}
            onClick={() => {
              change({
                environment: { ...current.environment, [newKey]: newValue },
              });
              setNewKey("");
              setNewValue("");
            }}
          >
            Add variable
          </Button>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          disabled={disabled || !draft}
          onClick={save}
        >
          Save defaults
        </Button>
        {(draft || newKey || newValue) && (
          <Button
            type="button"
            disabled={disabled}
            onClick={() => {
              setDraft(null);
              setNewKey("");
              setNewValue("");
            }}
          >
            Discard
          </Button>
        )}
        {notice && (
          <p role="status" className="m-0 text-body-sm">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
