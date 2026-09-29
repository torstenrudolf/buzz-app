import type { AgentControlHost, AgentView, ControlSnapshot } from "./control";

/** Synthetic public identity only; no local library, credentials, relay or child processes. */
export function controlFixture() {
  const agent: AgentView = {
    id: "fixture-agent",
    pubkey: "ab".repeat(32),
    relayUrl: "wss://relay.example.test",
    name: "Fixture agent",
    systemPrompt: "Help with the project.",
    sessionPolicy: null,
    workspace: "/fixture/workspace",
    harness: {
      command: "fixture-acp",
      args: ["--literal", "two words", 'quoted "value"'],
      model: "fixture-model",
      provider: "fixture-provider",
      environmentKeys: ["EXAMPLE_TOKEN"],
    },
    revision: 1,
    runningRevision: 1,
    enabled: true,
    status: "running",
    error: null,
    diagnostics: ["Listener process started; readiness is unverified."],
    startOnAppLaunch: true,
    respondTo: "owner-only",
    backend: null,
    acpCommand: "/fixture/bin/buzz-acp",
    mcpCommand: "/fixture/bin/buzz-dev-mcp",
    launchModel: "fixture-model",
    launchProvider: "fixture-provider",
    launchModelEnv: null,
    launchProviderEnv: null,
    restartDiff: [],
  };
  const data: ControlSnapshot = {
    localInventoryActions: true,
    runtimeAvailable: true,
    avatarEditingAvailable: true,
    agents: [agent],
    // Simulates the native snapshot; never imported by production UI.
    harnessOptions: [
      {
        command: "buzz-agent",
        label: "Buzz Agent",
        providers: [{ value: "databricks_v2", label: "Databricks v2" }],
      },
    ],
  };
  const calls: { action: string; payload?: unknown }[] = [];
  let failSave = false;
  let failStartOnAppLaunch = false;
  let failProfile = false;
  let importDestination = "";
  const host: AgentControlHost = {
    async publishProfile(id) {
      calls.push({ action: "profile", payload: { id } });
      if (failProfile) throw "The fixture could not publish the profile.";
      agent.profilePending = false;
      return structuredClone(data);
    },
    async configureHere(id, resolution) {
      calls.push({ action: "configure", payload: { id, resolution } });
      const target = data.agents.find((a) => a.id === id);
      if (!target) throw Error("Missing identity");
      target.configured = true;
      return structuredClone(data);
    },
    async snapshot() {
      calls.push({ action: "snapshot" });
      return structuredClone(data);
    },
    async save(id, expectedRevision, edit) {
      calls.push({ action: "save", payload: { id, expectedRevision, edit } });
      if (failSave) throw "The host could not save settings.";
      if (expectedRevision !== agent.revision)
        throw "Saved settings changed. Refresh before saving.";
      const keys = new Set(agent.harness.environmentKeys);
      for (const [key, value] of Object.entries(edit.environment)) {
        if (value === null) keys.delete(key);
        else keys.add(key);
      }
      Object.assign(agent, {
        name: edit.name,
        ...(edit.picture === undefined || edit.picture === agent.picture
          ? {}
          : { picture: edit.picture, profilePending: true }),
        systemPrompt: edit.systemPrompt,
        workspace: edit.workspace,
        harness: { ...edit.harness, environmentKeys: [...keys] },
        revision: agent.revision + 1,
      });
      return structuredClone(data);
    },
    async saveDefaults(edit) {
      calls.push({ action: "saveDefaults", payload: { edit } });
      const keys = new Set(data.defaultSettings?.environmentKeys ?? []);
      for (const [key, value] of Object.entries(edit.environment)) {
        if (value === null) keys.delete(key);
        else keys.add(key);
      }
      const { environment: _values, ...fields } = edit;
      data.defaultSettings = { ...fields, environmentKeys: [...keys].sort() };
      return { ...structuredClone(data), restarted: 0 };
    },
    async setStartOnAppLaunch(id, enabled) {
      calls.push({ action: "startOnAppLaunch", payload: { id, enabled } });
      if (failStartOnAppLaunch) throw "The host could not save settings.";
      agent.startOnAppLaunch = enabled;
      return structuredClone(data);
    },
    async action(id, action) {
      calls.push({ action, payload: { id } });
      agent.enabled = action !== "stop";
      agent.status = action === "stop" ? "stopped" : "running";
      agent.runningRevision = action === "stop" ? null : agent.revision;
      return structuredClone(data);
    },
    async delete(id, expectedRevision) {
      calls.push({ action: "delete", payload: { id, expectedRevision } });
      const index = data.agents.findIndex((item) => item.id === id);
      if (index < 0) throw "Agent no longer exists";
      if (data.agents[index]?.revision !== expectedRevision)
        throw "Agent settings changed. Reload before deleting";
      data.agents.splice(index, 1);
      return structuredClone(data);
    },
    async previewImport(source, destination) {
      calls.push({ action: "preview", payload: { source, destination } });
      importDestination = destination;
      return {
        token: destination ? "fixture-preview" : "",
        sourcePath: `/fixture/${source}/managed-agents.json`,
        warnings: ["Fixture source only."],
        candidates: [
          {
            id: "second-fixture",
            name: "Fixture agent",
            pubkey: "cd".repeat(32),
            relayUrl: importDestination,
          },
        ],
      };
    },
    async commitImport(token, ids) {
      calls.push({ action: "import", payload: { token, ids } });
      data.agents.push({
        ...structuredClone(agent),
        configured: true,
        id: "second-fixture",
        pubkey: "cd".repeat(32),
        relayUrl: importDestination,
        status: "stopped",
        enabled: false,
        runningRevision: null,
      });
      return structuredClone(data);
    },
  };
  return {
    host,
    agent,
    data,
    calls,
    failProfile(value: boolean) {
      failProfile = value;
    },
    failSave(value: boolean) {
      failSave = value;
    },
    failStartOnAppLaunch(value: boolean) {
      failStartOnAppLaunch = value;
    },
  };
}
