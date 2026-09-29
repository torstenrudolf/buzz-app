import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { useEffect, useId, useRef, useState } from "react";
import type {
  AgentControl,
  ControlSnapshot,
} from "../../features/agents/control";
import type { ModelCatalog } from "../../features/agents/models";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { agentEdit, isGoose, type AgentDraft } from "./agent-edit";

const VISIBLE_MODEL_LIMIT = 10;

export function AgentModelPicker({
  id,
  draft,
  savedRevision,
  control,
  defaults,
  defaultModel,
  inheritedWorkspace,
  onPiProviders,
  onChange,
  disabled = false,
}: {
  disabled?: boolean;
  /** Pi's signed-in providers, or null while its catalog is loading. */
  onPiProviders?(providers: string[] | null): void;
  id?: string | undefined;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  defaults: ControlSnapshot["databricksDefaults"];
  defaultModel?: string | undefined;
  /** Workspace/filter supplied by write-only Agent defaults; values stay native. */
  inheritedWorkspace?: { host: boolean; filter: boolean };
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const statusId = useId();
  const goose = isGoose(draft.command);
  const pi = draft.command.split("/").at(-1) === "buzz-pi-acp";
  const external = goose || pi;
  // An inherited Agent defaults value wins over the compiled floor at launch;
  // leave it blank here so native resolves the same hidden value.
  const host =
    draft.databricks?.host ??
    (inheritedWorkspace?.host ? "" : (defaults?.host ?? ""));
  const filter =
    draft.databricks?.filter ??
    (inheritedWorkspace?.filter ? "" : (defaults?.filter ?? ""));
  const [catalog, setCatalog] = useState<{
    key: string;
    data: ModelCatalog;
  } | null>(null);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const attempted = useRef<string | null>(null);
  // Native resolves absolute executables and write-only provider overrides.
  const supported = !!control.models;
  const highlighted = useRef<ModelCatalog["models"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  // All draft context participates: native resolves write-only overrides against
  // the saved revision. Discovery never persists draft values.
  const key = JSON.stringify([
    id,
    savedRevision,
    draft.revision,
    draft.command,
    pi ? null : draft.provider,
    draft.args,
    draft.workspace,
    draft.environment,
    pi ? null : host,
    pi ? null : filter,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: context change cancels actual native work even when no result has arrived.
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setStatus("");
    setQuery(null);
    setOpen(false);
    attempted.current = null;
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [key]);
  // Provider is only a filter for Pi's catalog, but pending search text belongs
  // to the provider the person was editing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider changes retire its pending search text without invalidating Pi’s catalog.
  useEffect(() => {
    setQuery(null);
    highlighted.current = null;
  }, [draft.provider]);
  // A test result belongs to the exact draft it tested.
  const testKey = JSON.stringify([key, draft.provider, draft.model]);
  const [test, setTest] = useState<{
    key: string;
    run: AbortController;
    result: string;
  } | null>(null);
  const testing = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: editing the tested draft retires its native test.
  useEffect(
    () => () => {
      testing.current?.abort();
      testing.current = null;
    },
    [testKey],
  );
  const testResult = test?.key === testKey ? test.result : null;
  const testConnection = async () => {
    if (!control.models || testing.current) return;
    const run = new AbortController();
    testing.current = run;
    // Only this run may settle its own result; a retired run clears it.
    const settle = (result: string) =>
      setTest((current) =>
        current?.run !== run
          ? current
          : run.signal.aborted
            ? null
            : { ...current, result },
      );
    setTest({ key: testKey, run, result: "testing" });
    try {
      await control.models.request(
        {
          id,
          expectedRevision: id ? draft.revision : undefined,
          edit: agentEdit(draft, true),
          host: "",
          filter: "",
          action: "test",
        },
        run.signal,
      );
      settle("ok");
    } catch (error) {
      settle((error as Error).message);
    } finally {
      if (testing.current === run) testing.current = null;
    }
  };
  const run = async (action: "connect" | "refresh" | "disconnect") => {
    if (!control.models || pending.current) return;
    // Native runs one lookup at a time; model browsing replaces a test.
    testing.current?.abort();
    testing.current = null;
    setTest(null);
    if (!external && !host.trim() && !inheritedWorkspace?.host) {
      setStatus(
        "Set your Databricks workspace under Advanced → Model to browse models.",
      );
      return;
    }
    attempted.current = key;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setCatalog(null);
    setStatus(
      action === "connect"
        ? external
          ? `Loading ${pi ? "Pi" : "Goose"} models…`
          : "Loading models… sign in through your browser if asked."
        : action === "refresh"
          ? "Loading models…"
          : "Removing this app’s credentials for this workspace…",
    );
    try {
      const data = await control.models.request(
        {
          id,
          expectedRevision: id ? draft.revision : undefined,
          edit: action === "disconnect" ? undefined : agentEdit(draft, true),
          host: external ? "" : host,
          filter: external ? "" : filter,
          action,
          ...(!external &&
          ((inheritedWorkspace?.host && !host) ||
            (inheritedWorkspace?.filter && !filter))
            ? { inheritWorkspace: true }
            : {}),
        },
        abort.signal,
      );
      if (abort.signal.aborted || currentKey.current !== key) return;
      setCatalog({ key, data });
      setStatus(
        data.disconnected
          ? "Disconnected from this workspace in Foundation."
          : data.models.length
            ? ""
            : goose
              ? "No models found for this Goose provider. Check its configuration or enter a custom ID."
              : pi
                ? "No signed-in Pi providers found. Buzz doesn’t use API keys exported in your shell profile. Choose a provider under LLM Provider to add its API key, or enter a custom ID."
                : "No models found. Enter a custom ID or check the workspace/filter under Advanced → Model.",
      );
    } catch (error) {
      if (!abort.signal.aborted && currentKey.current === key)
        setStatus((error as Error).message);
    } finally {
      if (pending.current === abort) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  // Pi's catalog is headless and supplies the signed-in provider list, so load
  // it when Pi is selected. Later context edits wait for Browse or Retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only entering Pi triggers the automatic lookup.
  useEffect(() => {
    if (pi) void run("connect");
  }, [pi, draft.command]);
  const fresh = catalog?.key === key ? catalog.data : null;
  const reportedProviders = JSON.stringify(
    !pi
      ? []
      : busy
        ? null
        : [...new Set(fresh?.models.map((m) => m.id.split("/")[0] ?? ""))],
  );
  useEffect(() => {
    onPiProviders?.(JSON.parse(reportedProviders));
  }, [reportedProviders, onPiProviders]);
  useEffect(() => () => onPiProviders?.([]), [onPiProviders]);
  const entries = (fresh?.models ?? []).filter(
    (m) => !pi || !draft.provider || m.id.startsWith(`${draft.provider}/`),
  );
  const piNoModelsMessage =
    "No Pi models for this provider. Buzz doesn’t use API keys exported in your shell profile. Add this provider’s API key for this agent, then browse models again.";
  const selectedId =
    pi && draft.provider && draft.model
      ? `${draft.provider}/${draft.model}`
      : draft.model;
  const chooseModel = (value: string) => {
    if (pi && value.includes("/") && entries.some((m) => m.id === value)) {
      const split = value.indexOf("/");
      onChange({
        provider: value.slice(0, split),
        model: value.slice(split + 1),
      });
    } else {
      const prefix = `${draft.provider}/`;
      onChange({
        model:
          pi && draft.provider && value.startsWith(prefix)
            ? value.slice(prefix.length)
            : value,
      });
    }
  };
  const selected =
    entries.find((model) => model.id === selectedId) ??
    (draft.model ? { id: draft.model, name: draft.model } : null);
  const items = [...entries];
  if (selected && !entries.some((model) => model.id === selected.id))
    items.unshift(selected);
  const custom = query?.trim();
  if (
    custom &&
    !items.some((model) => model.id === custom || model.name === custom)
  )
    items.push({ id: custom, name: custom });
  const matchingItems =
    query === null
      ? items
      : items.filter((item) =>
          `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase()),
        );
  const commitQuery = () => {
    if (query === null) return;
    const match = entries.find(
      (item) => item.id === query || item.name === query,
    );
    chooseModel(match?.id ?? query);
    setQuery(null);
  };
  return (
    <section data-buzz-ui="" className="text-body" aria-label="Model settings">
      <div className="space-y-3">
        <div>
          <Combobox.Root<ModelCatalog["models"][number]>
            disabled={disabled}
            items={goose && busy ? [] : items}
            filteredItems={
              goose && busy
                ? []
                : goose
                  ? matchingItems.slice(0, VISIBLE_MODEL_LIMIT)
                  : matchingItems
            }
            value={selected}
            inputValue={query ?? selected?.name ?? ""}
            open={open}
            onInputValueChange={(value, details) => {
              if (
                details.reason === "input-change" ||
                details.reason === "input-clear"
              ) {
                setQuery(value);
                // Pending text is an unsaved edit too: enable Save and protect the
                // dialog while blur/Enter commits it or Escape abandons the query.
                onChange({});
              }
            }}
            onOpenChange={(next, details) => {
              // Browse opens the list, even if typing already opened it. Base UI
              // may deliver its mousedown toggle after the button's click handler.
              if (!next && details.reason === "trigger-press") {
                details.cancel();
                return;
              }
              setOpen(next);
              if (!next && details.reason === "escape-key") setQuery(null);
            }}
            modal={false}
            onItemHighlighted={(item) => {
              highlighted.current = item ?? null;
            }}
            itemToStringLabel={(model) => model.name}
            isItemEqualToValue={(a, b) => a.id === b.id}
            onValueChange={(model) => {
              if (model) chooseModel(model.id);
              setQuery(null);
            }}
          >
            <Combobox.Control
              label="Model"
              triggerLabel="Browse models"
              aria-describedby={status ? statusId : undefined}
              loading={busy}
              onBrowse={() => {
                if (supported && !fresh && attempted.current !== key)
                  void run("connect");
              }}
              placeholder={
                defaultModel
                  ? `Use agent defaults (${defaultModel})`
                  : "Choose or enter a model"
              }
              onBlur={commitQuery}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery(null);
                if (
                  event.key === "Enter" &&
                  !highlighted.current &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  commitQuery();
                  setOpen(false);
                }
              }}
            />
            <Combobox.Popup
              className={goose ? "agent-model-popup" : undefined}
              empty={busy ? null : "Type a model ID to use a custom model."}
            >
              {busy && (
                <div
                  role="status"
                  aria-label="Model lookup"
                  className="flex items-center gap-2 px-3 py-2 text-body-sm text-secondary"
                >
                  <CircleNotchIcon
                    size={16}
                    className="motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                  {pi ? "Loading Pi models…" : "Loading models…"}
                </div>
              )}
              {pi &&
                !busy &&
                (status ||
                  (fresh && draft.provider && entries.length === 0)) && (
                  <div className="px-3 py-2 text-body-sm text-secondary">
                    {fresh && draft.provider && entries.length === 0
                      ? piNoModelsMessage
                      : status}
                  </div>
                )}
              <Combobox.List
                style={{
                  maxHeight: "min(20rem, calc(var(--available-height) - 4rem))",
                  overflowY: "auto",
                }}
              >
                {(model: ModelCatalog["models"][number]) => {
                  const custom = !entries.some(
                    (entry) => entry.id === model.id,
                  );
                  return (
                    <Combobox.Item
                      key={model.id}
                      value={model}
                      description={
                        goose && model.name === model.id
                          ? custom
                            ? "Custom ID"
                            : undefined
                          : `${model.id}${custom ? " · Custom ID" : ""}`
                      }
                    >
                      {model.name}
                    </Combobox.Item>
                  );
                }}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Root>
        </div>
        {goose && fresh && entries.length > VISIBLE_MODEL_LIMIT && (
          <p className="text-body-sm text-secondary">
            Showing up to {VISIBLE_MODEL_LIMIT} models. Type to search all{" "}
            {entries.length}.
          </p>
        )}
        {status && (
          <p
            id={statusId}
            role="status"
            className={`text-body-sm ${busy && goose ? "flex items-center gap-2 text-primary" : "text-secondary"}`}
          >
            {busy && goose && (
              <CircleNotchIcon
                size={16}
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            )}
            {status}
          </p>
        )}
        {busy ? (
          <Button
            disabled={disabled}
            onClick={() => {
              pending.current?.abort();
              pending.current = null;
              setBusy(false);
              setStatus("Cancelled. Retry when ready.");
            }}
          >
            {external ? "Cancel model lookup" : "Cancel sign-in"}
          </Button>
        ) : (
          status &&
          supported && (
            <Button disabled={disabled} onClick={() => void run("connect")}>
              Retry models
            </Button>
          )
        )}
        {supported && external && draft.provider && draft.model && !busy && (
          <div className="space-y-2">
            <Button
              disabled={disabled}
              loading={testResult === "testing"}
              onClick={() => void testConnection()}
            >
              Test connection
            </Button>
            {testResult && (
              <p
                role="status"
                className={`flex items-center gap-2 text-body-sm ${testResult === "ok" ? "text-success" : testResult === "testing" ? "text-secondary" : "text-danger"}`}
              >
                {testResult === "ok" ? (
                  <CheckCircleIcon size={16} aria-hidden="true" />
                ) : testResult !== "testing" ? (
                  <WarningCircleIcon size={16} aria-hidden="true" />
                ) : null}
                {testResult === "ok"
                  ? "Connected. The model replied."
                  : testResult === "testing"
                    ? "Sending a short test message…"
                    : testResult}
              </p>
            )}
          </div>
        )}
        {pi && draft.provider && !draft.model && (
          <p className="text-body-sm text-warning">
            Choose a model for this provider before starting, or clear Provider
            to use Pi defaults.
          </p>
        )}
        {pi && fresh && entries.length === 0 && draft.provider && (
          <p className="text-body-sm text-secondary">{piNoModelsMessage}</p>
        )}
        {pi &&
          fresh &&
          draft.model &&
          !entries.some((model) => model.id === selectedId) && (
            <p className="text-body-sm text-warning">
              This model ID is not in Pi’s available catalog. Select a listed
              model or confirm the exact custom ID before starting; Pi may
              accept an invalid ID until the first message.
            </p>
          )}
        {fresh?.modelOverridden && (
          <p className="text-body-sm text-warning">
            {goose ? "A GOOSE_MODEL" : "A saved BUZZ_AGENT_MODEL"} environment
            override takes precedence. Change it in Advanced → Environment to
            use this selection.
          </p>
        )}
        {goose &&
          fresh &&
          draft.model &&
          !entries.some((model) => model.id === draft.model) && (
            <p className="text-body-sm text-warning">
              This model ID is not in Goose’s current provider list. Select a
              listed model or confirm the custom ID before starting.
            </p>
          )}
        {goose && (
          <p className="text-body-sm text-secondary">
            Browse to check this Goose provider’s models using the credentials
            entered above or already configured in Goose.
          </p>
        )}
      </div>
      <h3 className="mt-section-gap mb-2 text-label">Advanced</h3>
      <div className="-mx-2">
        <Accordion
          variant="form"
          keepMounted
          items={[
            {
              value: "advanced",
              title: "Model",
              content: (
                <div className="space-y-3">
                  <Field label="Model ID (custom or blank)">
                    <Input
                      disabled={disabled}
                      value={draft.model}
                      spellCheck={false}
                      onChange={(event) =>
                        onChange({ model: event.target.value })
                      }
                    />
                  </Field>
                  {pi && (
                    <p className="text-body-sm text-secondary">
                      This field uses the exact model ID, including any
                      namespace slashes, without adding the provider. Its text
                      is saved literally.
                    </p>
                  )}
                  {supported && pi && (
                    <Button
                      disabled={disabled || busy}
                      onClick={() => void run("refresh")}
                    >
                      Refresh models
                    </Button>
                  )}
                  {supported && !external && (
                    <>
                      <Field label="Databricks workspace (HTTPS origin)">
                        <Input
                          disabled={disabled}
                          value={host}
                          placeholder={
                            inheritedWorkspace?.host
                              ? "Use agent defaults"
                              : "https://workspace.example.com"
                          }
                          spellCheck={false}
                          onChange={(event) =>
                            onChange({
                              databricks: { host: event.target.value, filter },
                            })
                          }
                        />
                      </Field>
                      <Field label="Model filter (optional)">
                        <Input
                          disabled={disabled}
                          value={filter}
                          placeholder={
                            inheritedWorkspace?.filter
                              ? "Use agent defaults"
                              : undefined
                          }
                          spellCheck={false}
                          onChange={(event) =>
                            onChange({
                              databricks: { host, filter: event.target.value },
                            })
                          }
                        />
                      </Field>
                      <p className="text-body-sm text-secondary">
                        Editing either field saves both displayed values.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={disabled || busy}
                          onClick={() => void run("refresh")}
                        >
                          Refresh models
                        </Button>
                        <Button
                          disabled={disabled || busy}
                          onClick={() => void run("disconnect")}
                        >
                          Disconnect
                        </Button>
                      </div>
                      <p className="text-body-sm text-secondary">
                        Credentials are shared within Foundation for this
                        workspace, not with old Buzz. Disconnect removes this
                        app’s cache, not your browser session.
                      </p>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
    </section>
  );
}
