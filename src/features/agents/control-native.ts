import { invoke, isTauri } from "@tauri-apps/api/core";
import { createAgentControl, type AgentControlHost } from "./control";

export function nativeAgentControlHost(): AgentControlHost | null {
  if (!isTauri()) return null;
  return {
    models: {
      begin: () => invoke("agent_models_begin"),
      run: (ticket, request) => invoke("agent_models_run", { ticket, request }),
      cancel: (ticket) => invoke("agent_models_cancel", { ticket }),
    },
    prepareCreate: (requestId, destination, owner) =>
      invoke("agent_control_create_prepare", { requestId, destination, owner }),
    commitCreate: (requestId, edit, auth) =>
      invoke("agent_control_create_commit", { requestId, edit, auth }),
    publishProfile: (id) => invoke("agent_control_creation_profile", { id }),
    setStartOnAppLaunch: (id, enabled) =>
      invoke("agent_control_start_on_app_launch", { id, enabled }),
    snapshot: () => invoke("agent_control_snapshot"),
    readLog: async ({ id, pubkey, relayUrl, authorize }) => {
      const nonce = await invoke<string>("agent_control_log_challenge", {
        id,
        pubkey,
        relayUrl,
      });
      const signature = await authorize({ id, pubkey, relayUrl }, nonce);
      return invoke<string>("agent_control_read_log", {
        id,
        pubkey,
        relayUrl,
        nonce,
        signature,
      });
    },
    installGoose: () => invoke("goose_install"),
    installPi: () => invoke("pi_install"),
    save: (id, expectedRevision, edit) =>
      invoke("agent_control_save", { id, expectedRevision, edit }),
    saveDefaults: (edit) => invoke("agent_control_save_defaults", { edit }),
    delete: (id, expectedRevision) =>
      invoke("agent_control_delete", { id, expectedRevision }),
    attachMention: (id, expectedRevision, replayFloor) =>
      invoke("agent_control_attach_mention", {
        id,
        expectedRevision,
        replayFloor,
      }),
    action: (id, action, replayFloor) =>
      invoke("agent_control_action", {
        id,
        action,
        ...(replayFloor === undefined ? {} : { replayFloor }),
      }),
    configureHere: (id, resolution) =>
      invoke("agent_control_use_here", { id, resolution }),
    cloneSettings: (source, pubkey) =>
      invoke("agent_control_clone_settings", { source, pubkey }),
    previewImport: (source, destination) =>
      invoke("agent_control_import_preview", { source, destination }),
    commitImport: (token, ids) =>
      invoke("agent_control_import_commit", { token, ids }),
  };
}

/** Composition owns this, not the Agents page or selected community. */
export function createNativeAgentControl() {
  return createAgentControl(nativeAgentControlHost());
}
