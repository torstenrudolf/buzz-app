import { useState } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { Select } from "../../shared/design-system/ui/Select";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { EyeIcon, EyeSlashIcon } from "../../shared/design-system/icons/index";
import type {
  AgentControl,
  AgentControlState,
} from "../../features/agents/control";
import {
  gooseApiKey,
  harnessKind,
  isGoose,
  PI_API_KEYS,
  type AgentDraft,
} from "./agent-edit";
import { AgentEnvironmentEditor } from "./AgentEnvironmentEditor";
import { AgentHarnessEditor } from "./AgentHarnessEditor";
import { AgentModelPicker } from "./AgentModelPicker";

function effectiveGooseProvider(draft: AgentDraft, savedKeys: string[]) {
  const override = draft.environment.GOOSE_PROVIDER;
  if (typeof override === "string") return override;
  if (override === undefined && savedKeys.includes("GOOSE_PROVIDER"))
    return null;
  return draft.provider;
}

function providerApiKey(draft: AgentDraft, savedKeys: string[]) {
  if (draft.command.split("/").at(-1) === "buzz-pi-acp")
    return PI_API_KEYS[draft.provider];
  if (!isGoose(draft.command)) return undefined;
  const provider = effectiveGooseProvider(draft, savedKeys);
  return provider ? gooseApiKey(provider) : undefined;
}

/** Create and Edit share the same settings and native model discovery. */
export function AgentSettingsFields({
  id,
  savedRevision,
  draft,
  control,
  state,
  disabled,
  environmentKeys = [],
  onChange,
  onOpenHarnesses,
  discardEdits = false,
}: {
  id?: string | undefined;
  onOpenHarnesses?: (() => void) | undefined;
  discardEdits?: boolean;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  state: AgentControlState;
  disabled: boolean;
  environmentKeys?: string[];
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const [piProviders, setPiProviders] = useState<string[] | null>([]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const pi = draft.command.split("/").at(-1) === "buzz-pi-acp";
  const goose = isGoose(draft.command);
  const globalKeys = state.data?.defaultSettings?.environmentKeys ?? [];
  // Saved and global environment values are write-only; removing an agent's
  // key exposes the global key rather than the visible scalar default.
  const ownOverride = (key: string) =>
    typeof draft.environment[key] === "string" ||
    (draft.environment[key] === undefined && environmentKeys.includes(key));
  const overridden = (key: string) =>
    ownOverride(key) || globalKeys.includes(key);
  // Blank fields inherit Agent defaults for the same harness, then the build
  // floor (Buzz Agent only). Hidden environment overrides are not guessed.
  const inherited =
    state.data?.defaultSettings?.harness === harnessKind(draft.command)
      ? state.data?.defaultSettings
      : undefined;
  // Draft → same-harness Agent default → build floor, as native resolves it.
  const buzzProvider =
    draft.environment.BUZZ_AGENT_PROVIDER ??
    (draft.provider ||
      inherited?.provider ||
      state.data?.agentDefaults?.provider);
  const modelDefaultKnown =
    (typeof draft.environment.BUZZ_AGENT_PROVIDER === "string" ||
      !overridden("BUZZ_AGENT_PROVIDER")) &&
    ["BUZZ_AGENT_MODEL", "DATABRICKS_MODEL"].every((key) => !overridden(key));
  const databricks = ["databricks_v2", "databricks-v2", "databricks"].includes(
    buzzProvider ?? "",
  );
  const gooseProvider = goose
    ? effectiveGooseProvider(draft, environmentKeys)
    : null;
  const buzzAgent = harnessKind(draft.command) === "buzz-agent";
  // An environment selector can override the visible scalar default.
  const [modelKey, providerKey] = buzzAgent
    ? ["BUZZ_AGENT_MODEL", "BUZZ_AGENT_PROVIDER"]
    : goose
      ? ["GOOSE_MODEL", "GOOSE_PROVIDER"]
      : [undefined, undefined];
  const providerHidden = !!providerKey && overridden(providerKey);
  const modelHidden =
    (!!modelKey && overridden(modelKey)) || (buzzAgent && !modelDefaultKnown);
  const defaultProvider = providerHidden
    ? undefined
    : inherited?.provider ||
      (buzzAgent ? state.data?.agentDefaults?.provider : undefined);
  const defaultModel = modelHidden
    ? undefined
    : inherited?.model ||
      (buzzAgent && databricks ? state.data?.agentDefaults?.model : undefined);
  // An explicit Databricks workspace/filter wins over the global env pair.
  const inheritedKey = (key: string) =>
    buzzAgent &&
    !draft.databricks &&
    globalKeys.includes(key) &&
    !ownOverride(key);
  const inheritedWorkspace = {
    host: inheritedKey("DATABRICKS_HOST"),
    filter: inheritedKey("DATABRICKS_MODEL_FILTER"),
  };
  const apiKey = providerApiKey(draft, environmentKeys);
  const savedKey = !!apiKey && environmentKeys.includes(apiKey.env);
  // Saved keys are write-only; only a key typed for this provider can be shown.
  const typedKey = apiKey && draft.environment[apiKey.env] ? apiKey.env : null;
  // Reveal consent covers one typed key. Clear it during render once that key
  // is removed or the provider changes, so a replacement starts masked.
  if (revealed !== null && revealed !== typedKey) setRevealed(null);
  const revealKey = revealed !== null && revealed === typedKey;
  const change = (patch: Partial<AgentDraft>) => {
    const key = apiKey?.env;
    // A typed key belongs to the provider it was entered for.
    if (
      key &&
      providerApiKey({ ...draft, ...patch }, environmentKeys)?.env !== key
    ) {
      const environment = { ...(patch.environment ?? draft.environment) };
      if (typeof environment[key] === "string") {
        delete environment[key];
        onChange({ ...patch, environment });
        return;
      }
    }
    onChange(patch);
  };
  return (
    <div className="min-w-0">
      <div className="min-w-0 space-y-section-gap">
        <div className="space-y-4">
          <Field label="Name">
            <Input
              disabled={disabled}
              value={draft.name}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Field>
          <Field label="Agent instructions">
            <Textarea
              disabled={disabled}
              rows={6}
              value={draft.systemPrompt}
              onChange={(event) =>
                onChange({ systemPrompt: event.target.value })
              }
            />
          </Field>
        </div>
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">AI configuration</legend>
          <AgentHarnessEditor
            disabled={disabled}
            draft={draft}
            options={state.data?.harnessOptions ?? []}
            defaultProvider={defaultProvider}
            piProviders={piProviders}
            onChange={change}
            onOpenHarnesses={onOpenHarnesses}
            discardEdits={discardEdits}
          />
          {goose && gooseProvider === null && (
            <p role="status" className="text-body-sm text-secondary">
              This agent has a saved GOOSE_PROVIDER override whose value is
              hidden. Replace or remove it under Advanced → Environment to enter
              the matching API key here.
            </p>
          )}
          {apiKey && (
            <div className="space-y-2">
              <Field label={`${apiKey.label} API key`}>
                <InputGroup
                  trailing={
                    typedKey ? (
                      <IconButton
                        aria-label={revealKey ? "Hide API key" : "Show API key"}
                        icon={
                          revealKey ? (
                            <EyeSlashIcon size={16} aria-hidden="true" />
                          ) : (
                            <EyeIcon size={16} aria-hidden="true" />
                          )
                        }
                        size="sm"
                        disabled={disabled}
                        onClick={() => setRevealed(revealKey ? null : typedKey)}
                      />
                    ) : undefined
                  }
                >
                  <Input
                    type={revealKey ? "text" : "password"}
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={disabled}
                    value={draft.environment[apiKey.env] ?? ""}
                    placeholder={
                      draft.environment[apiKey.env] === null
                        ? "Will remove on save"
                        : savedKey
                          ? "Saved key unchanged"
                          : pi
                            ? "Paste API key or use an existing Pi sign-in"
                            : "Paste API key or use existing Goose credentials"
                    }
                    onChange={(event) => {
                      const environment = { ...draft.environment };
                      if (event.target.value)
                        environment[apiKey.env] = event.target.value;
                      else delete environment[apiKey.env];
                      change({ environment });
                    }}
                  />
                </InputGroup>
              </Field>
              <p className="text-body-sm text-secondary">
                {apiKey.env} is used for this agent and model lookup. Leave
                blank to keep a saved key, if present, or use{" "}
                {pi ? "your Pi sign-in" : "Goose credentials"}. Keys exported in
                your shell profile are not used. Saved keys are stored in this
                device’s local agent settings files.
              </p>
            </div>
          )}
          <AgentModelPicker
            onPiProviders={setPiProviders}
            disabled={disabled}
            id={id}
            savedRevision={savedRevision}
            control={control}
            defaults={state.data?.databricksDefaults}
            defaultModel={defaultModel}
            inheritedWorkspace={inheritedWorkspace}
            draft={draft}
            onChange={change}
          />
          <Select
            label="Conversation context"
            variant="field"
            disabled={disabled}
            value={draft.sessionPolicy ?? ""}
            groups={[
              {
                label: "",
                options: [
                  {
                    value: "",
                    label: `Use agent defaults (${state.data?.defaultSettings?.sessionPolicy === "thread" ? "Each thread" : "Entire channel"})`,
                  },
                  { value: "channel", label: "Entire channel" },
                  { value: "thread", label: "Each thread" },
                ],
              },
            ]}
            onValueChange={(sessionPolicy) =>
              onChange({
                sessionPolicy:
                  sessionPolicy === ""
                    ? null
                    : (sessionPolicy as "channel" | "thread"),
              })
            }
            description="Entire channel shares one conversation across threads. Each thread keeps a separate conversation; direct messages remain shared."
          />
          {pi && (
            <p className="text-body-sm text-secondary">
              Providers and models load from your local Pi configuration,
              including extensions. To use a provider that isn’t signed in,
              choose it and add its API key. Save restarts a running agent to
              apply changes.
            </p>
          )}
        </fieldset>
      </div>
      {state.data?.agentDefaults?.ownerOnly && (
        <p className="text-body-sm text-secondary">
          This build allows instructions only from the owner and verified
          same-owner agents.
        </p>
      )}
      <div className="-mx-2">
        <Accordion
          variant="form"
          keepMounted
          items={[
            {
              value: "advanced",
              title: "Environment",
              content: (
                <div className="space-y-4">
                  <Field label="Workspace">
                    <Input
                      value={draft.workspace}
                      disabled={disabled}
                      spellCheck={false}
                      onChange={(event) =>
                        onChange({ workspace: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Arguments (JSON array)">
                    <Textarea
                      rows={3}
                      value={draft.args}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange({ args: event.target.value })
                      }
                    />
                  </Field>
                  <AgentEnvironmentEditor
                    keys={environmentKeys}
                    patch={draft.environment}
                    disabled={disabled}
                    onChange={(environment) => change({ environment })}
                  />
                  <p className="text-body-sm text-secondary">
                    {pi
                      ? 'Pi needs both Provider and Model to override its defaults. Advanced Pi options follow --; for example: ["--", "--extension", "/absolute/path/to/extension.ts"]. PI_CODING_AGENT_DIR can select a local Pi configuration directory.'
                      : "Environment overrides take precedence over provider and model selections."}{" "}
                    Arguments are passed literally, not through a shell.
                  </p>
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
