import { useEffect, useRef, useState } from "react";
import {
  savedMessage,
  type AgentControl,
  type AgentControlState,
  type AgentDefaultSettings,
  type AgentDefaultsEdit,
  type AgentEdit,
} from "../features/agents/control";
import type { ModelCatalog } from "../features/agents/models";
import { PI_API_KEYS, harnessKind } from "../bundled/agents/agent-edit";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { InputGroup } from "../shared/design-system/ui/InputGroup";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Select } from "../shared/design-system/ui/Select";
import { EyeIcon, EyeSlashIcon } from "../shared/design-system/icons/index";
import styles from "./AgentSettings.module.css";

const harnesses = [
  { value: "buzz-agent", label: "Buzz Agent" },
  { value: "goose", label: "Goose" },
  { value: "pi", label: "Pi" },
] as const;

const effortChoices = {
  "buzz-agent": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  goose: ["off", "low", "medium", "high", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh"],
} as const;

function defaultLabel(harness: AgentDefaultsEdit["harness"], value: string) {
  return value && harness === "buzz-agent"
    ? `Use build default (${value})`
    : "Not set (use harness default)";
}

type Choice = { value: string; label: string };

/** A saved ID stays editable even when it is absent from today's suggestions. */
function DefaultsChoice({
  label,
  value,
  customValue = value,
  choices,
  disabled,
  onSelect,
  onCustom,
  resetKey,
}: {
  label: string;
  value: string;
  customValue?: string;
  choices: Choice[];
  disabled: boolean;
  onSelect(value: string): void;
  onCustom(value: string): void;
  resetKey: string;
}) {
  const [custom, setCustom] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new editing session resets the local input mode.
  useEffect(() => setCustom(false), [resetKey]);
  const index = choices.findIndex((choice) => choice.value === value);
  const showInput = custom || index < 0;
  return (
    <div className="space-y-3">
      <Select
        label={label}
        variant="field"
        disabled={disabled}
        value={showInput ? "custom" : `choice:${value}`}
        groups={[
          {
            label: "",
            options: [
              ...choices.map((choice) => ({
                value: `choice:${choice.value}`,
                label: choice.label,
              })),
              { value: "custom", label: "Custom ID" },
            ],
          },
        ]}
        onValueChange={(selected) => {
          setCustom(selected === "custom");
          if (selected !== "custom") {
            const choice = choices.find(
              (option) => `choice:${option.value}` === selected,
            );
            if (choice) onSelect(choice.value);
          }
        }}
      />
      {showInput && (
        <Field label={`Custom ${label.toLowerCase()} ID`}>
          <Input
            disabled={disabled}
            spellCheck={false}
            value={customValue}
            onChange={(event) => {
              setCustom(true);
              onCustom(event.target.value);
            }}
          />
        </Field>
      )}
    </div>
  );
}

function ProviderChoice({
  current,
  state,
  models,
  disabled,
  onChange,
  editSession,
}: {
  current: AgentDefaultsEdit;
  state: AgentControlState;
  models: ModelCatalog["models"];
  disabled: boolean;
  onChange(provider: string): void;
  editSession: number;
}) {
  const harness = state.data?.harnessOptions?.find(
    (option) => harnessKind(option.command) === current.harness,
  );
  const discovered =
    current.harness === "pi"
      ? [
          ...new Set(models.map((model) => model.id.split("/")[0] ?? "")),
        ].filter(Boolean)
      : [];
  const providers =
    current.harness === "pi"
      ? [
          ...discovered.map((value) => ({
            value,
            label: `${PI_API_KEYS[value]?.label ?? value} (available in Pi)`,
          })),
          ...Object.entries(PI_API_KEYS)
            .filter(([value]) => !discovered.includes(value))
            .map(([value, details]) => ({
              value,
              label: `${details.label} (API key may be needed)`,
            })),
        ]
      : (harness?.providers ?? []);
  const builtInProvider = state.data?.agentDefaults?.provider ?? "";
  const builtInLabel =
    providers.find((provider) => provider.value === builtInProvider)?.label ??
    builtInProvider;
  const overrideKey =
    current.harness === "goose"
      ? "GOOSE_PROVIDER"
      : current.harness === "buzz-agent"
        ? "BUZZ_AGENT_PROVIDER"
        : null;
  const change = (provider: string) => onChange(provider);
  return (
    <div className="space-y-2">
      <DefaultsChoice
        label="Default provider"
        value={current.provider}
        choices={[
          { value: "", label: defaultLabel(current.harness, builtInLabel) },
          ...providers,
        ]}
        disabled={disabled}
        resetKey={`${current.harness}-${editSession}`}
        onSelect={change}
        onCustom={change}
      />
      {overrideKey &&
        state.data?.defaultSettings?.environmentKeys.includes(overrideKey) && (
          <p className="m-0 text-body-sm text-warning">
            A saved {overrideKey} environment value can override this provider.
          </p>
        )}
    </div>
  );
}

function PiApiKeyField({
  provider,
  current,
  savedKeys,
  disabled,
  onChange,
}: {
  provider: string;
  current: AgentDefaultsEdit;
  savedKeys: string[];
  disabled: boolean;
  onChange(environment: AgentDefaultsEdit["environment"]): void;
}) {
  const [revealed, setRevealed] = useState(false);
  const apiKey = PI_API_KEYS[provider];
  if (!apiKey) return null;
  const typed = !!current.environment[apiKey.env];
  return (
    <div className="space-y-2">
      <Field label={`${apiKey.label} API key`}>
        <InputGroup
          trailing={
            typed ? (
              <IconButton
                aria-label={revealed ? "Hide API key" : "Show API key"}
                icon={
                  revealed ? (
                    <EyeSlashIcon size={16} aria-hidden="true" />
                  ) : (
                    <EyeIcon size={16} aria-hidden="true" />
                  )
                }
                size="sm"
                disabled={disabled}
                onClick={() => setRevealed(!revealed)}
              />
            ) : undefined
          }
        >
          <Input
            type={revealed && typed ? "text" : "password"}
            autoComplete="new-password"
            spellCheck={false}
            disabled={disabled}
            value={current.environment[apiKey.env] ?? ""}
            placeholder={
              current.environment[apiKey.env] === null
                ? "Will remove on save"
                : savedKeys.includes(apiKey.env)
                  ? "Saved key unchanged"
                  : "Paste API key or use an existing Pi sign-in"
            }
            onChange={(event) => {
              const environment = { ...current.environment };
              if (event.target.value)
                environment[apiKey.env] = event.target.value;
              else {
                delete environment[apiKey.env];
                setRevealed(false);
              }
              onChange(environment);
            }}
          />
        </InputGroup>
      </Field>
      <p className="m-0 text-body-sm text-secondary">
        {apiKey.env} is used for model lookup and every local agent without its
        own value, including other harnesses. Leave blank to keep a saved key or
        use your Pi sign-in. Saved keys remain after provider changes; remove
        them under Environment variables. Saved values are never shown again.
      </p>
    </div>
  );
}

function ModelChoice({
  control,
  state,
  current,
  disabled,
  onChange,
  onModels,
  editSession,
}: {
  control: AgentControl;
  state: AgentControlState;
  current: AgentDefaultsEdit;
  disabled: boolean;
  onChange(patch: Partial<AgentDefaultsEdit>): void;
  onModels(models: ModelCatalog["models"]): void;
  editSession: number;
}) {
  const harness = state.data?.harnessOptions?.find(
    (option) => harnessKind(option.command) === current.harness,
  );
  const pi = current.harness === "pi";
  const [catalog, setCatalog] = useState<{
    key: string;
    models: ModelCatalog["models"];
  } | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const key = JSON.stringify([
    current.harness,
    pi ? null : current.provider,
    harness?.command,
    harness?.defaultArgs,
    current.environment,
    state.data?.defaultWorkspace,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the lookup context; a changed context retires native work.
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setAttempted(false);
    setStatus("");
    onModels([]);
    return () => {
      pending.current?.abort();
    };
  }, [key]);
  const fresh = catalog?.key === key ? catalog.models : [];
  const entries = fresh.filter(
    (model) =>
      !pi || !current.provider || model.id.startsWith(`${current.provider}/`),
  );
  const selectedId =
    pi && current.provider && current.model
      ? `${current.provider}/${current.model}`
      : current.model;
  const choices: Choice[] = [
    {
      value: "",
      label: defaultLabel(
        current.harness,
        state.data?.agentDefaults?.model ?? "",
      ),
    },
    ...entries.map((model) => ({ value: model.id, label: model.name })),
  ];
  const choose = (value: string) => {
    if (pi && !value) onChange({ provider: "", model: "" });
    else if (pi && fresh.some((model) => model.id === value)) {
      const slash = value.indexOf("/");
      onChange({
        provider: value.slice(0, slash),
        model: value.slice(slash + 1),
      });
    } else onChange({ model: value });
  };
  const browse = async () => {
    if (
      !control.models ||
      !harness ||
      harness.available === false ||
      pending.current
    )
      return;
    const run = new AbortController();
    pending.current = run;
    setBusy(true);
    setAttempted(true);
    setStatus(`Loading ${harness.label} models…`);
    const hiddenHost =
      state.data?.defaultSettings?.environmentKeys.includes("DATABRICKS_HOST");
    const hiddenFilter = state.data?.defaultSettings?.environmentKeys.includes(
      "DATABRICKS_MODEL_FILTER",
    );
    const edit: AgentEdit = {
      name: "",
      systemPrompt: "",
      sessionPolicy: current.sessionPolicy,
      workspace: state.data?.defaultWorkspace ?? "",
      harness: {
        command: harness.command,
        args: harness.defaultArgs ?? [],
        provider:
          current.harness === "buzz-agent" && !current.provider
            ? state.data?.agentDefaults?.provider || "databricks_v2"
            : current.provider,
        model: current.model,
      },
      environment: current.environment,
    };
    try {
      const result = await control.models.request(
        {
          edit,
          host:
            current.harness === "buzz-agent" && !hiddenHost
              ? (state.data?.databricksDefaults?.host ?? "")
              : "",
          filter:
            current.harness === "buzz-agent" && !hiddenFilter
              ? (state.data?.databricksDefaults?.filter ?? "")
              : "",
          action: "connect",
          ...(hiddenHost || hiddenFilter ? { inheritWorkspace: true } : {}),
        },
        run.signal,
      );
      if (run.signal.aborted || currentKey.current !== key) return;
      setCatalog({ key, models: result.models });
      onModels(result.models);
      setStatus(
        result.modelOverridden
          ? "A saved environment model override takes precedence over this selection."
          : result.models.length
            ? "Model choices loaded. Availability does not confirm inference access."
            : `No ${harness.label} models found. Enter a custom model ID or retry.`,
      );
    } catch (problem) {
      if (!run.signal.aborted && currentKey.current === key)
        setStatus((problem as Error).message);
    } finally {
      if (pending.current === run) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <div className="space-y-2">
      <DefaultsChoice
        label="Default model"
        value={selectedId}
        customValue={current.model}
        choices={choices}
        disabled={disabled}
        resetKey={`${current.harness}-${editSession}`}
        onSelect={choose}
        onCustom={(model) => onChange({ model })}
      />
      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <Button
            type="button"
            disabled={disabled}
            onClick={() => {
              pending.current?.abort();
              setStatus("Cancelled. Retry when ready.");
            }}
          >
            Cancel model lookup
          </Button>
        ) : (
          <Button
            type="button"
            disabled={
              disabled ||
              !control.models ||
              !harness ||
              harness.available === false ||
              (current.harness === "goose" && !current.provider)
            }
            onClick={() => void browse()}
          >
            {attempted ? "Retry models" : "Browse models"}
          </Button>
        )}
        {status && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            {status}
          </p>
        )}
      </div>
      {harness?.available === false && (
        <p className="m-0 text-body-sm text-secondary">
          Install {harness.label} to browse its models. Custom IDs remain
          editable.
        </p>
      )}
      {!control.models && (
        <p className="m-0 text-body-sm text-secondary">
          Model browsing requires an updated desktop app. Custom IDs remain
          editable.
        </p>
      )}
      {current.harness === "goose" && !current.provider && (
        <p className="m-0 text-body-sm text-secondary">
          Choose a Goose provider to browse its models.
        </p>
      )}
      {pi && current.provider && !current.model && (
        <p className="m-0 text-body-sm text-warning">
          Choose a model for this Pi provider, or clear Provider to use Pi
          defaults.
        </p>
      )}
      {Object.keys(current.environment).length > 0 && (
        <p className="m-0 text-body-sm text-secondary">
          Saved environment values can still affect lookup until these edits are
          saved.
        </p>
      )}
    </div>
  );
}

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
  const [models, setModels] = useState<ModelCatalog["models"]>([]);
  const [editSession, setEditSession] = useState(0);
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
        setEditSession((session) => session + 1);
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
      className={`${styles.card} ${styles.defaultsCard} mt-6 space-y-4`}
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
        onValueChange={(harness) => {
          const environment = { ...current.environment };
          const piKey =
            current.harness === "pi"
              ? PI_API_KEYS[current.provider]?.env
              : null;
          if (
            harness !== "pi" &&
            piKey &&
            typeof environment[piKey] === "string"
          )
            delete environment[piKey];
          change({
            harness: harness as AgentDefaultsEdit["harness"],
            // Keep the provider, but clear values tied to the old harness.
            ...(harness === current.harness ? {} : { model: "", effort: "" }),
            environment,
          });
        }}
      />
      <ProviderChoice
        current={current}
        state={state}
        models={models}
        disabled={disabled}
        editSession={editSession}
        onChange={(provider) => {
          const previousKey =
            current.harness === "pi"
              ? PI_API_KEYS[current.provider]?.env
              : null;
          const environment = { ...current.environment };
          if (
            previousKey &&
            previousKey !== PI_API_KEYS[provider]?.env &&
            typeof environment[previousKey] === "string"
          )
            delete environment[previousKey];
          change({
            provider,
            ...(provider === current.provider ? {} : { model: "" }),
            environment,
          });
        }}
      />
      {current.harness === "pi" && (
        <PiApiKeyField
          key={`${current.provider}-${editSession}`}
          provider={current.provider}
          current={current}
          savedKeys={saved.environmentKeys}
          disabled={disabled}
          onChange={(environment) => change({ environment })}
        />
      )}
      <ModelChoice
        control={control}
        state={state}
        current={current}
        disabled={disabled}
        editSession={editSession}
        onChange={change}
        onModels={setModels}
      />
      <DefaultsChoice
        label="Default effort"
        value={current.effort}
        choices={[
          { value: "", label: "Not set (use harness default)" },
          ...effortChoices[current.harness].map((value) => ({
            value,
            label:
              value === "xhigh"
                ? "Extra high"
                : value.charAt(0).toUpperCase() + value.slice(1),
          })),
        ]}
        disabled={disabled}
        resetKey={`${current.harness}-${editSession}`}
        onSelect={(effort) => change({ effort })}
        onCustom={(effort) => change({ effort })}
      />
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
              setEditSession((session) => session + 1);
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
