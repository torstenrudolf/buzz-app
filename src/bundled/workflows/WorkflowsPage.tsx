import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { WorkflowDefinition } from "../../features/workflows/types";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { WorkflowEditor } from "./WorkflowEditor";
import { DEFAULT_FORM_STATE, formStateToYaml } from "./workflowFormTypes";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Select } from "../../shared/design-system/ui/Select";
import { WorkflowChannelPicker } from "./WorkflowChannelPicker";
import { WorkflowChannel } from "./WorkflowChannel";
import { WorkflowWebhookSecrets } from "./WorkflowWebhookSecrets";
import { WorkflowLanding, workflowOperationLocked } from "./WorkflowLanding";
import "./workflows.css";

export function WorkflowsPage({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  return (
    <Panel aria-label="Workflows">
      <div className="workflows-page text-body">
        {connection.status === "ready" ? (
          <WorkflowCommunity
            key={`${connection.scope}:${connection.generation}`}
            session={connection.session}
            viewer={connection.viewer ?? ""}
          />
        ) : (
          <>
            <header className="workflow-page-header">
              <div>
                <h1 className="text-title">Workflows</h1>
                <p className="text-secondary">
                  Automations that keep your community moving.
                </p>
              </div>
            </header>
            <div className="workflow-page-state">
              <p>
                {connection.status === "connecting"
                  ? "Connecting to your community…"
                  : "Connect to a community to browse workflows."}
              </p>
              {connection.status === "error" && (
                <>
                  <p role="alert">{connection.error}</p>
                  <Button onClick={() => relay.retry()}>
                    Retry connection
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
export function WorkflowCommunity({
  session,
  viewer,
}: {
  session: RelaySession;
  viewer: string;
}) {
  const capability = session.workflows;
  const channels = useChannelList(session.channels);
  const [selected, setSelected] = useState("");
  const [selectedDefinition, setSelectedDefinition] = useState<
    WorkflowDefinition | "new" | undefined
  >();
  const [initialAction, setInitialAction] = useState<"run" | undefined>();
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [saveReadback, setSaveReadback] =
    useState<Pick<WorkflowDefinition, "channelId" | "revision">>();
  const deleting = useRef(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const channel = channels.channels.find((item) => item.id === selected);
  useEffect(() => {
    if (
      !selected ||
      channel ||
      channels.status !== "ready" ||
      channels.coverage === "partial"
    )
      return;
    setSelected("");
    setSelectedDefinition(undefined);
  }, [channel, channels.coverage, channels.status, selected]);
  if (!capability) {
    return (
      <>
        <WorkflowPageHeader />
        <p role="status">Workflow operations are unavailable from this host.</p>
      </>
    );
  }

  const openChannel = (
    next: string,
    definition?: WorkflowDefinition | "new",
    action?: "run",
  ) => {
    setInitialAction(action);
    setSelectedDefinition(definition);
    setSelected(next);
  };
  const changeChannel = (next: string) => {
    if (next === selected) return;
    openChannel(next);
  };
  const beginCreate = () => setCreateOpen(true);
  const deleteWorkflow = (definition: WorkflowDefinition) => {
    if (deleting.current) return;
    const locked = workflowOperationLocked(
      capability.operations.snapshot(),
      definition,
    );
    if (locked) {
      setDeleteError(
        "Another workflow change is still being confirmed. Refresh and try again.",
      );
      openChannel("");
      return;
    }
    if (definition.owner !== viewer || !capability.availability.delete) return;
    deleting.current = true;
    try {
      capability.delete(definition);
      setDeleteError(undefined);
    } catch (cause) {
      setDeleteError(
        cause instanceof Error
          ? cause.message
          : "Try again from the workflow menu.",
      );
    } finally {
      deleting.current = false;
      // Confirmation deliberately discards the editor draft, even if submission throws.
      openChannel("");
    }
  };

  return (
    <>
      <WorkflowPageHeader
        action={
          channel && selectedDefinition === undefined ? (
            <Button onClick={() => changeChannel("")} variant="ghost">
              <ArrowLeftIcon size={16} aria-hidden="true" />
              All workflows
            </Button>
          ) : (
            <IconButton
              aria-label="Refresh workflows"
              icon={<ArrowsClockwiseIcon size={18} aria-hidden="true" />}
              onClick={() => setRefreshRequest((request) => request + 1)}
            />
          )
        }
      />
      {channels.status === "loading" && !channels.channels.length && (
        <p role="status">Reading channels…</p>
      )}
      {channels.status === "error" && (
        <div className="workflow-page-state">
          <p role="alert" className="text-danger">
            {channels.error ?? "Channels could not be read."}
          </p>
          <Button onClick={() => session.channels.refreshList?.()}>
            Retry channels
          </Button>
        </div>
      )}
      {channels.channels.length > 0 && selectedDefinition === undefined && (
        <div className="workflow-page-filter">
          <Select
            label="Channel"
            value={channel?.id ?? ""}
            groups={[
              {
                label: "Community channels",
                options: [
                  { value: "", label: "All workflows" },
                  ...channels.channels.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ],
              },
            ]}
            onValueChange={changeChannel}
          />
        </div>
      )}
      {channels.status === "ready" && !channels.channels.length && (
        <div className="workflow-page-state">
          <p>No channels are available in this community.</p>
        </div>
      )}
      {channels.coverage === "partial" && (
        <p className="text-secondary">The channel list is partial.</p>
      )}
      {channels.channels.length > 0 && (
        <div hidden={!!channel && selectedDefinition === undefined}>
          <WorkflowLanding
            capability={capability}
            channels={channels.channels}
            onCreate={beginCreate}
            onDelete={deleteWorkflow}
            onOpen={(definition, nextChannel, action) =>
              openChannel(nextChannel.id, definition, action)
            }
            refreshRequest={refreshRequest}
            saveReadback={saveReadback}
            viewer={viewer}
          />
        </div>
      )}
      {deleteError && (
        <ToastNotice
          title="Couldn't start deletion"
          description={deleteError}
          onDismiss={() => setDeleteError(undefined)}
        />
      )}
      {channel ? (
        <WorkflowChannel
          key={`${channel.id}:${
            typeof selectedDefinition === "object"
              ? selectedDefinition.revision
              : (selectedDefinition ?? "browse")
          }`}
          capability={capability}
          channelId={channel.id}
          channelName={channel.name}
          initialSelection={selectedDefinition}
          initialAction={initialAction}
          onSaveReadback={setSaveReadback}
          onDelete={deleteWorkflow}
          viewer={viewer}
          {...(selectedDefinition === undefined
            ? {}
            : { onClose: () => openChannel("") })}
        />
      ) : null}
      <WorkflowWebhookSecrets capability={capability} />
      {createOpen && (
        <WorkflowEditor
          create
          chooseChannel
          yaml={formStateToYaml({
            ...DEFAULT_FORM_STATE,
            name: "Untitled workflow",
          })}
          onChange={() => {}}
          onSave={() => {}}
          onCancel={() => setCreateOpen(false)}
          scope={
            <WorkflowChannelPicker
              channels={channels.channels}
              onSelect={(id) => {
                setCreateOpen(false);
                openChannel(id, "new");
              }}
            />
          }
        />
      )}
    </>
  );
}

function WorkflowPageHeader({ action }: { action?: ReactNode }) {
  return (
    <header className="workflow-page-header">
      <div>
        <h1 className="text-title">Workflows</h1>
        <p className="text-secondary">
          Automations that keep your community moving.
        </p>
      </div>
      {action && <div className="workflow-page-action">{action}</div>}
    </header>
  );
}
