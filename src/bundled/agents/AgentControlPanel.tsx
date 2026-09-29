import { Dialog } from "@base-ui/react/dialog";
import type { useIdentityNames } from "../../features/identity-names/react";
import {
  useAgentControl,
  useAgentControlRefresh,
} from "../../features/agents/control-react";
import { sameCommunityAgents } from "../../features/agents/choices";
import type { PageNavigation } from "../../features/navigation/service";
import { useEffect, useState, type ReactNode } from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
  CloneSettings,
  ImportSource,
} from "../../features/agents/control";
import { PlusIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { AgentCard } from "./AgentCard";
import { AgentEditor } from "./AgentEditor";
import { LocalInventoryAction } from "./LocalInventoryAction";
import { relayOrigin } from "../../features/communities/destination";
import { AgentImport } from "./AgentImport";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { AgentDeleteDialog } from "./AgentDeleteDialog";
import "./AgentControls.css";

/** No relay dependency. Page lifetime owns observation only, never native execution. */
export function AgentControlPanel({
  control,
  importDestination = "",
  createOwner,
  resolveName,
  children,
  editTarget,
  editRequest,
  onCloseTarget,
  onOpenHarnesses,
}: {
  resolveName?: ReturnType<typeof useIdentityNames>;
  onOpenHarnesses?: (() => void) | undefined;
  control: AgentControl;
  importDestination?: string;
  createOwner?: string | undefined;
  editTarget?: string | null;
  editRequest?: PageNavigation;
  onCloseTarget?: () => void;
  children?: (
    state: AgentControlState,
    edit: (agent: AgentView, avatar?: string) => void,
    duplicate: (agent: AgentView) => void,
    remove: (agent: AgentView) => void,
    importedId: string | null,
    label: (agent: AgentView) => string,
    onUseHere: (pubkey: string) => void,
    onImport: (pubkey: string, source?: ImportSource) => void,
  ) => ReactNode;
}) {
  const [adding, setAdding] = useState<{
    destination: string;
    owner: string;
    source?: AgentView;
    initialSettings?: CloneSettings;
  } | null>(null);
  const [localPending, setLocalPending] = useState(false);
  const [handover, setHandover] = useState<{
    pubkey: string;
    destination: string;
  } | null>(null);
  useEffect(() => {
    // A handover belongs to the community in which its action was selected.
    setHandover((current) =>
      current?.destination === importDestination ? current : null,
    );
  }, [importDestination]);
  const [importSelection, setImportSelection] = useState<{
    destination: string;
    trigger: HTMLElement | null;
    pubkey: string;
    name: string;
    source?: ImportSource;
  } | null>(null);
  useEffect(() => {
    setImportSelection((current) =>
      current?.destination === importDestination ? current : null,
    );
  }, [importDestination]);
  const [importSections, setImportSections] = useState<string[]>([]);
  const [importedId, setImportedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    id: string;
    avatar?: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const edit = (agent: AgentView, avatar?: string) => {
    setSelected({ id: agent.id, ...(avatar ? { avatar } : {}) });
    if (editTarget) onCloseTarget?.();
  };
  const duplicate = (agent: AgentView) =>
    setAdding({
      destination: agent.relayUrl,
      owner: createOwner ?? "",
      source: agent,
    });
  const remove = (agent: AgentView) => setDeleting(agent.id);
  useAgentControlRefresh(control);
  const nativeState = useAgentControl(control);
  const state = localPending
    ? { ...nativeState, busy: true, pendingCredentialWrite: true }
    : nativeState;
  useEffect(() => {
    if (
      state.data?.agents.some(
        (agent) => agent.id === importedId && agent.enabled,
      )
    )
      setImportedId(null);
  }, [state.data, importedId]);
  const facts =
    state.data?.agents.map((agent) => ({
      pubkey: agent.pubkey,
      name: agent.name,
      isAgent: true,
    })) ?? [];
  const candidates = facts.map((agent) => agent.pubkey);
  // One identity may have separate configurations in different communities.
  // The edited row supplies its own configured name; control still uses agent.id.
  const label = (agent: AgentView) =>
    resolveName?.(agent.pubkey, agent.name, candidates, [
      ...facts,
      { pubkey: agent.pubkey, name: agent.name, isAgent: true },
    ]) ?? agent.name;
  const localSource =
    handover &&
    (state.data?.agents.find(
      (agent) =>
        agent.pubkey === handover.pubkey &&
        !!agent.relayUrl &&
        !!handover.destination &&
        relayOrigin(agent.relayUrl) === relayOrigin(handover.destination),
    ) ??
      state.data?.agents.find((agent) => agent.pubkey === handover.pubkey));
  // Route selection takes precedence over card-local editing. Never guess among
  // multiple native records for the same public identity in this community.
  const routed =
    editTarget && importDestination && createOwner
      ? sameCommunityAgents(
          state.data?.agents ?? [],
          `${importDestination}:${createOwner}`,
        ).filter((agent) => agent.pubkey === editTarget)
      : [];
  const editing = editTarget
    ? routed.length === 1
      ? routed[0]
      : undefined
    : state.data?.agents.find((agent) => agent.id === selected?.id);
  useEffect(() => {
    if (
      !editRequest ||
      editRequest.signal.aborted ||
      state.status === "loading" ||
      state.status === "idle"
    )
      return;
    if (state.status !== "ready") {
      editRequest.complete({ status: "failed", reason: "unavailable" });
    } else if (editing) {
      editRequest.complete({ status: "opened" });
    } else {
      editRequest.complete({ status: "failed", reason: "not-found" });
    }
  }, [editRequest, editing, state.status]);
  const deletion = state.data?.agents.find((agent) => agent.id === deleting);
  const needsRepair = !!state.data?.agents.some(
    (agent) => agent.needsTeamImport,
  );
  const importForm = state.data ? (
    <AgentImport
      // The inventory owns ordinary imports; this list only repairs team imports.
      repairOnly={state.data.parked !== undefined && !importSelection}
      key={`${importDestination}:${importSelection?.pubkey}:${importSelection?.source}`}
      control={control}
      initialSource={importSelection?.source ?? "installed"}
      selectedPubkey={importSelection?.pubkey}
      selectedName={importSelection?.name}
      onCancel={() => setImportSelection(null)}
      initialDestination={importDestination}
      managedAgents={state.data.agents}
      commitAvailable={
        state.status === "ready" && state.data.importAvailable !== false
      }
      disabled={state.busy}
      onClone={
        control.cloneSettings && createOwner && importDestination
          ? (initialSettings) => {
              setImportSelection(null);
              setAdding({
                destination: importDestination,
                owner: createOwner,
                initialSettings,
              });
            }
          : undefined
      }
      onImported={(agents) => {
        setImportedId(agents[0]?.id ?? null);
        setImportSections([]);
        setImportSelection(null);
      }}
    />
  ) : null;
  return (
    <section
      data-buzz-ui=""
      aria-label="Local agent controls"
      className="agent-controls flex min-w-0 flex-col gap-section-gap text-body text-primary"
    >
      {state.data && (
        <div className="flex justify-end">
          <Button
            variant="primary"
            aria-haspopup="dialog"
            disabled={localPending}
            onClick={() =>
              setAdding({
                destination: importDestination,
                owner: createOwner ?? "",
              })
            }
          >
            <PlusIcon size={16} aria-hidden="true" />
            Add agent
          </Button>
        </div>
      )}
      {(state.status === "idle" || state.status === "loading") && (
        <p role="status">Reading local agent status…</p>
      )}
      {state.error && (
        <p role={state.status === "unavailable" ? "status" : "alert"}>
          {state.error}
        </p>
      )}
      {state.status === "error" && state.data && (
        <p className="text-body-sm text-secondary">
          The agent statuses below may be out of date.
        </p>
      )}
      {state.status === "error" && (
        <Button onClick={() => void control.refresh()}>Retry status</Button>
      )}
      {state.busy && <p role="status">Waiting for the desktop app…</p>}
      {children ? (
        children(
          state,
          edit,
          duplicate,
          remove,
          importedId,
          label,
          (pubkey) => setHandover({ pubkey, destination: importDestination }),
          (pubkey, source) => {
            setImportSelection({
              destination: importDestination,
              trigger:
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null,
              pubkey,
              name:
                state.data?.parked?.find((agent) => agent.pubkey === pubkey)
                  ?.name ?? "agent",
              ...(source ? { source } : {}),
            });
            setImportSections(["old-buzz"]);
          },
        )
      ) : (
        <div className="agent-grid">
          {state.data?.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              name={label(agent)}
              identities={[agent]}
              editable={[agent]}
              onEdit={edit}
              onDuplicate={duplicate}
              onDelete={control.delete ? remove : undefined}
            />
          ))}
        </div>
      )}
      {state.data &&
        !importSelection &&
        (state.data.parked === undefined || needsRepair) && (
          <Accordion
            variant="activity"
            value={importSections}
            onValueChange={setImportSections}
            items={[
              {
                value: "old-buzz",
                title:
                  state.data.parked !== undefined
                    ? "Repair team import from another installation"
                    : needsRepair
                      ? "Import or repair from another installation"
                      : "Import from another installation",
                content: importSections.includes("old-buzz")
                  ? importForm
                  : null,
              },
            ]}
          />
        )}
      {state.data?.parked !== undefined &&
        importSelection &&
        importSelection.destination === importDestination && (
          <Dialog.Root
            open
            modal={!state.pendingCredentialWrite}
            disablePointerDismissal
            onOpenChange={(open, details) => {
              if (!open && state.busy) details.cancel();
              else if (!open) setImportSelection(null);
            }}
          >
            <Dialog.Portal>
              {!state.pendingCredentialWrite && (
                <Dialog.Backdrop
                  data-buzz-ui=""
                  className="buzz-dialog-backdrop"
                />
              )}
              <Dialog.Popup
                data-buzz-ui=""
                className="buzz-dialog agent-controls text-body"
                finalFocus={() => importSelection.trigger}
                aria-modal={!state.pendingCredentialWrite}
              >
                {importForm}
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      {state.data && handover && handover.destination === importDestination && (
        <Dialog.Root
          open
          modal={false}
          onOpenChange={(open) => {
            if (!open && !state.busy) setHandover(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Popup
              data-buzz-ui=""
              className="buzz-dialog agent-controls agent-dialog text-body"
            >
              <Dialog.Title className="text-heading">
                Set up agent here
              </Dialog.Title>
              <Dialog.Description className="text-body-sm text-secondary">
                Set up the imported agent in this community. It will not start
                yet.
              </Dialog.Description>
              {localSource && state.data.localInventoryActions ? (
                <LocalInventoryAction
                  key={`${handover.pubkey}:${handover.destination}:${createOwner}`}
                  control={control}
                  agent={localSource || undefined}
                  destination={handover.destination}
                  owner={createOwner ?? ""}
                  disabled={nativeState.busy || state.status !== "ready"}
                  onPending={setLocalPending}
                  onUsed={() => setHandover(null)}
                />
              ) : (
                <p>
                  This app cannot set up this agent yet. Import it first. If it
                  is already imported, update and restart the desktop app.
                </p>
              )}
              <Button disabled={state.busy} onClick={() => setHandover(null)}>
                Close
              </Button>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      {adding && (
        <AgentCreateDialog
          control={control}
          state={state}
          destination={adding.destination}
          owner={adding.owner}
          {...(adding.source ? { source: adding.source } : {})}
          {...(adding.initialSettings
            ? { initialSettings: adding.initialSettings }
            : {})}
          onClose={() => setAdding(null)}
          onOpenHarnesses={onOpenHarnesses}
        />
      )}
      {editing && (
        <AgentEditor
          key={editing.id}
          agent={editing}
          displayName={label(editing)}
          control={control}
          state={state}
          avatar={editTarget ? undefined : selected?.avatar}
          onOpenHarnesses={onOpenHarnesses}
          onClose={
            editTarget ? (onCloseTarget ?? (() => {})) : () => setSelected(null)
          }
        />
      )}
      {deletion && control.delete && (
        <AgentDeleteDialog
          agent={deletion}
          control={control}
          state={state}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
