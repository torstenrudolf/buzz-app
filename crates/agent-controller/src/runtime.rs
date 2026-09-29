use crate::bundle::RuntimeBundle;
use crate::config::Agent;
#[cfg(not(unix))]
use crate::process::Process;
#[cfg(unix)]
use crate::supervisor::Supervised;
use crate::{AgentEdit, ControlSnapshot, Credentials, ProcessStatus, Result, Store};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

impl RuntimeBundle {
    fn command(&self, agent: &Agent, key: &crate::Secret) -> Result<Command> {
        self.command_with_defaults(agent, key, &crate::build_defaults())
    }
    fn command_with_defaults(
        &self,
        agent: &Agent,
        key: &crate::Secret,
        defaults: &crate::BuildDefaults,
    ) -> Result<Command> {
        agent.validate()?;
        let harness = defaults.resolve(&agent.harness, &agent.environment);
        if key.pubkey() != agent.pubkey {
            return Err("Credential does not match the saved agent".into());
        }
        if !Path::new(&agent.workspace).is_dir() {
            return Err("Agent workspace does not exist".into());
        }
        let worker = if harness.command == "buzz-agent" {
            self.executable("buzz-agent")?
        } else {
            let path = PathBuf::from(&harness.command);
            if !path.is_absolute() {
                return Err("Choose the installed harness's absolute executable path".into());
            }
            executable(&path)?;
            path
        };
        let record = &agent.imported["record"];
        if record["backend"]["type"]
            .as_str()
            .is_some_and(|s| s != "local")
            || harness.provider == "relay-mesh"
            || !record["relay_mesh"].is_null()
        {
            return Err("This imported agent requires a remote/mesh integration not supported by the local controller".into());
        }
        if agent.needs_team_import() {
            return Err("Import this agent's team instructions from old Buzz under Agents → Import or repair from old Buzz → Repair team import before starting".into());
        }
        let team_instructions = crate::import::team_text(&agent.imported["teamInstructions"])?;
        let respond_to = agent.respond_to(defaults.owner_only)?;
        if agent.auth_tag.is_none() {
            return Err("This identity has no saved owner attestation; native owner binding is required before starting".into());
        }
        crate::secret::validate_attestation(
            agent.auth_tag.as_deref().unwrap_or(""),
            &agent.pubkey,
        )?;
        let mut command = Command::new(self.executable("buzz-acp")?);
        // Never inherit the current managed agent's key, owner, relay, replay floor,
        // process marker, git injection or provider credentials into the new agent.
        command
            .env_clear()
            .current_dir(&agent.workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for name in [
            "HOME",
            "TMPDIR",
            "USER",
            "LOGNAME",
            "LANG",
            "SSH_AUTH_SOCK",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let pi = (worker.file_name().and_then(|n| n.to_str()) == Some("buzz-pi-acp"))
            .then(|| {
                crate::pi::PiContext::new(&agent.harness, &agent.workspace, &agent.environment)
            })
            .transpose()?;
        let (args, environment, tools_path) = if let Some(pi) = &pi {
            (
                pi.adapter_args(&agent.harness)?,
                &pi.environment,
                pi.path.clone(),
            )
        } else {
            (
                agent.harness.args.clone(),
                &agent.environment,
                "/usr/bin:/bin:/usr/sbin:/sbin".into(),
            )
        };
        let path = std::env::join_paths(
            std::iter::once(self.directory.clone()).chain(std::env::split_paths(&tools_path)),
        )
        .map_err(|_| "Invalid runtime tools path")?;
        command.envs(environment).env("PATH", path);
        let key_hex = key.hex();
        command
            .env("BUZZ_PRIVATE_KEY", &*key_hex)
            .env("NOSTR_PRIVATE_KEY", &*key_hex)
            .env("BUZZ_RELAY_URL", &agent.relay_url)
            .env("BUZZ_AUTH_TAG", agent.auth_tag.as_deref().unwrap_or(""))
            .env("BUZZ_ACP_AGENT_COMMAND", worker)
            .env("BUZZ_ACP_AGENT_ARGS", args.join(","))
            .env("BUZZ_ACP_SYSTEM_PROMPT", &agent.system_prompt)
            .env("BUZZ_ACP_TEAM_INSTRUCTIONS", team_instructions)
            .env("BUZZ_ACP_DISPLAY_NAME", &agent.name)
            .env("BUZZ_ACP_LAZY_POOL", "true")
            .env("BUZZ_ACP_IDLE_POOL_SLEEP", "900")
            .env("BUZZ_ACP_SUBSCRIBE", "mentions")
            .env("BUZZ_ACP_RESPOND_TO", respond_to)
            .env(
                "BUZZ_ACP_SESSION_POLICY",
                agent.session_policy.unwrap_or_default().as_str(),
            )
            .env("BUZZ_ACP_DEDUP", "queue")
            .env("BUZZ_ACP_MULTIPLE_EVENT_HANDLING", "steer")
            .env("BUZZ_ACP_MCP_COMMAND", self.executable("buzz-dev-mcp")?)
            .env("BUZZ_ACP_RELAY_OBSERVER", "false");
        if defaults.owner_only {
            command
                .env("BUZZ_ACP_ALLOWED_RESPOND_TO", "owner-only")
                .env_remove("BUZZ_ACP_RESPOND_TO_ALLOWLIST");
        }
        let selected = crate::defaults::selectors(&harness, &agent.environment);
        let model = selected.model;
        if let Some((model_key, provider_key)) = selected.keys {
            if let Some(value) = model {
                command.env(model_key, value);
            }
            if let Some(value) = selected.provider {
                command.env(provider_key, value);
            }
        } else if pi.is_none() && !harness.provider.is_empty() {
            return Err("Set provider configuration through this external harness's environment; a provider selector mapping is not available".into());
        }
        if let Some(value) = model {
            let value = if pi.is_some() && !agent.harness.provider.is_empty() {
                format!("{}/{value}", agent.harness.provider)
            } else {
                value.to_owned()
            };
            command.env("BUZZ_ACP_MODEL", value);
        }
        if respond_to == "allowlist" {
            let values = record["respond_to_allowlist"]
                .as_array()
                .ok_or("Missing imported response allowlist")?;
            let mut keys = Vec::new();
            for value in values {
                let key = value
                    .as_str()
                    .filter(|k| crate::config::canonical_key(k))
                    .ok_or("Invalid imported response allowlist")?;
                keys.push(key);
            }
            if keys.is_empty() {
                return Err("Imported response allowlist is empty".into());
            }
            command.env("BUZZ_ACP_RESPOND_TO_ALLOWLIST", keys.join(","));
        }
        for (field, env) in [
            ("idle_timeout_seconds", "BUZZ_ACP_IDLE_TIMEOUT"),
            ("max_turn_duration_seconds", "BUZZ_ACP_MAX_TURN_DURATION"),
            ("parallelism", "BUZZ_ACP_AGENTS"),
        ] {
            if !record[field].is_null() {
                let n = record[field]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 86400)
                    .ok_or("Invalid imported execution limit")?;
                command.env(env, n.to_string());
            }
        }
        if let Some(effort) = crate::agent_defaults::effort(agent) {
            command.env("BUZZ_ACP_EFFORT_LEVEL", effort);
        }
        Ok(command)
    }
}
fn effective_databricks(agent: &Agent) -> Result<Option<crate::connection::DatabricksSettings>> {
    databricks_with_defaults(agent, &crate::build_defaults())
}
fn databricks_with_defaults(
    agent: &Agent,
    defaults: &crate::BuildDefaults,
) -> Result<Option<crate::connection::DatabricksSettings>> {
    let harness = defaults.resolve(&agent.harness, &agent.environment);
    let buzz_agent = Path::new(&harness.command)
        .file_name()
        .and_then(|s| s.to_str())
        == Some("buzz-agent");
    if !buzz_agent {
        return Ok(None);
    }
    if !harness.args.is_empty() {
        return Err(
            "Buzz Agent runs in ACP mode without arguments; use Connect for sign-in".into(),
        );
    }
    let provider = agent
        .environment
        .get("BUZZ_AGENT_PROVIDER")
        .unwrap_or(&harness.provider);
    if !matches!(
        provider.as_str(),
        "databricks_v2" | "databricks-v2" | "databricks"
    ) {
        return Ok(None);
    }
    if agent.environment.contains_key("DATABRICKS_TOKEN") {
        return Err("Remove DATABRICKS_TOKEN to use this app's persistent OAuth connection".into());
    }
    let mut settings = harness.databricks.clone().unwrap_or_default();
    if let Some(host) = agent.environment.get("DATABRICKS_HOST") {
        settings.host = host.clone();
    }
    if let Some(filter) = agent.environment.get("DATABRICKS_MODEL_FILTER") {
        settings.filter = filter.clone();
    }
    settings.host = crate::connection::origin(&settings.host)?;
    settings.validate()?;
    Ok(Some(settings))
}
/// App-owned npm shims and the pinned Node binary are separate from user-global tools.
/// `app_data` is Tauri's resolved app-data directory, never browser input.
pub fn managed_tool(app_data: &Path, name: &str) -> Option<PathBuf> {
    let path = match name {
        "pi" | "buzz-pi-acp" => app_data.join("node-tools/bin").join(name),
        "node" => app_data.join("runtimes/node/v24.18.0").join(
            match (std::env::consts::OS, std::env::consts::ARCH) {
                ("macos", "aarch64") => "darwin-arm64/bin/node",
                ("macos", "x86_64") => "darwin-x64/bin/node",
                ("linux", "aarch64") => "linux-arm64/bin/node",
                ("linux", "x86_64") => "linux-x64/bin/node",
                _ => return None,
            },
        ),
        _ => return None,
    };
    executable(&path).ok()?;
    Some(path)
}

pub fn installed(name: &str) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    dirs.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    dirs.into_iter()
        .filter(|p| p.is_absolute())
        .map(|p| p.join(name))
        .find(|p| executable(p).is_ok())
}

pub(crate) fn executable(path: &Path) -> Result<()> {
    let metadata = path
        .metadata()
        .map_err(|_| "Required runtime executable is missing")?;
    if !metadata.is_file() {
        return Err("Required runtime executable is not a file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("Runtime file is not executable".into());
        }
    }
    Ok(())
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Start,
    Stop,
    Restart,
}
struct Running {
    #[cfg(unix)]
    process: Supervised,
    #[cfg(not(unix))]
    process: Process,
    revision: u64,
    /// Native-only: holds environment values and is never serialized.
    spawned: serde_json::Value,
    databricks_host: Option<String>,
    #[cfg(all(test, unix))]
    temporary: Option<PathBuf>,
    #[cfg(not(unix))]
    _temporary: Option<tempfile::TempDir>,
    #[cfg(not(unix))]
    _ownership: crate::ownership::Ownership,
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.process.stop();
    }
}
/// Deliberately not serializable: only the native connection owner consumes it.
pub struct ModelContext {
    pub host: Option<String>,
    pub filter: Option<String>,
    pub model_overridden: bool,
}
/// Native-only Goose model context; environment values never enter a snapshot.
pub struct GooseModelContext {
    pub command: PathBuf,
    pub workspace: PathBuf,
    pub provider_id: String,
    pub model_id: String,
    pub environment: BTreeMap<String, String>,
    pub model_overridden: bool,
}
pub struct Controller {
    pub(crate) store: Store,
    credentials: Arc<dyn Credentials>,
    bundle: Result<RuntimeBundle>,
    running: BTreeMap<String, Running>,
    errors: BTreeMap<String, String>,
    ownership_root: PathBuf,
}
impl Controller {
    pub fn new(
        store: Store,
        credentials: Arc<dyn Credentials>,
        bundle: Result<RuntimeBundle>,
        ownership_root: PathBuf,
    ) -> Self {
        Self {
            store,
            credentials,
            bundle,
            running: BTreeMap::new(),
            errors: BTreeMap::new(),
            ownership_root,
        }
    }
    pub fn snapshot(&mut self) -> Result<ControlSnapshot> {
        let (saved, parked) = self.store.inventory()?;
        let defaults = self.store.defaults()?;
        let command = |name| {
            let path = self.bundle.as_ref().ok()?.display_path(name)?;
            Some(path.to_string_lossy().into_owned())
        };
        let (acp_command, mcp_command) = (command("buzz-acp"), command("buzz-dev-mcp"));
        let mut snapshot = ControlSnapshot {
            agents: saved.iter().map(|a| a.view(&defaults)).collect(),
            parked,
            runtime_available: self.bundle.is_ok(),
            runtime_message: self.bundle.as_ref().err().cloned(),
            default_settings: defaults.view(),
        };
        for (saved, agent) in saved.iter().zip(&mut snapshot.agents) {
            agent.acp_command.clone_from(&acp_command);
            agent.mcp_command.clone_from(&mcp_command);
            if let Some(run) = self.running.get_mut(&agent.id) {
                match run.process.alive() {
                    Ok(true) => {
                        agent.status = ProcessStatus::Running;
                        agent.running_revision = Some(run.revision);
                        // Effective settings, so inherited default changes count.
                        agent.restart_diff = crate::restart::diff(
                            &run.spawned,
                            &crate::restart::spawn_config(&crate::agent_defaults::effective(
                                saved, &defaults,
                            )),
                        );
                    }
                    Ok(false) => {
                        self.running.remove(&agent.id);
                        self.errors.insert(
                            agent.id.clone(),
                            "Agent listener exited; restart to retry".into(),
                        );
                    }
                    Err(error) => {
                        #[cfg(unix)]
                        if run.process.stopped() {
                            self.running.remove(&agent.id);
                        }
                        self.errors.insert(agent.id.clone(), error);
                    }
                }
            }
            if let Some(error) = self.errors.get(&agent.id) {
                agent.status = ProcessStatus::Failed;
                agent.error = Some(error.clone());
            }
        }
        Ok(snapshot)
    }
    /// Native-only catalog configuration. Never serialize environment values or
    /// lend runtime credentials to model discovery. Resolve an unsaved edit on a
    /// clone using the same validation and precedence as Save/runtime.
    fn edited_agent(&self, id: &str, revision: u64, edit: AgentEdit) -> Result<Agent> {
        let mut agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if agent.revision != revision {
            return Err(
                "Saved settings changed; discard or reconcile the draft before connecting".into(),
            );
        }
        agent.apply(edit)?;
        Ok(crate::agent_defaults::effective(
            &agent,
            &self.store.defaults()?,
        ))
    }
    pub fn model_context(&self, id: &str, revision: u64, edit: AgentEdit) -> Result<ModelContext> {
        let agent = self.edited_agent(id, revision, edit)?;
        model_context(&agent.harness, &agent.environment)
    }
    pub fn goose_model_context(
        &self,
        id: &str,
        revision: u64,
        edit: AgentEdit,
    ) -> Result<GooseModelContext> {
        let agent = self.edited_agent(id, revision, edit)?;
        goose_model_context(&agent.harness, &agent.workspace, &agent.environment)
    }
    pub fn pi_model_context(
        &self,
        id: &str,
        revision: u64,
        edit: AgentEdit,
    ) -> Result<crate::pi::PiContext> {
        let agent = self.edited_agent(id, revision, edit)?;
        crate::pi::PiContext::new(&agent.harness, &agent.workspace, &agent.environment)
    }
    /// Resolve unsaved Create drafts against the same native defaults as a saved start.
    pub fn effective_draft(&self, mut edit: AgentEdit) -> Result<AgentEdit> {
        let mut environment = draft_environment(edit.environment);
        crate::agent_defaults::effective_settings(
            &mut edit.harness,
            &mut environment,
            &self.store.defaults()?,
        );
        edit.environment = environment
            .into_iter()
            .map(|(key, value)| (key, Some(value)))
            .collect();
        Ok(edit)
    }
    pub fn draft_pi_model_context(edit: AgentEdit) -> Result<crate::pi::PiContext> {
        crate::pi::PiContext::new(
            &edit.harness,
            &edit.workspace,
            &draft_environment(edit.environment),
        )
    }
    pub fn draft_goose_model_context(edit: AgentEdit) -> Result<GooseModelContext> {
        let environment = draft_environment(edit.environment);
        goose_model_context(&edit.harness, &edit.workspace, &environment)
    }
    pub fn draft_model_context(edit: AgentEdit) -> Result<ModelContext> {
        let environment = draft_environment(edit.environment);
        model_context(&edit.harness, &environment)
    }
    pub fn requires_legacy_handover(&self, id: &str) -> Result<bool> {
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        Ok(
            agent.extra.get("nativeCreated") != Some(&serde_json::Value::Bool(true))
                || !agent.imported.is_null(),
        )
    }
    pub fn use_here(
        &mut self,
        id: &str,
        resolution: crate::CommunityResolution,
    ) -> Result<ControlSnapshot> {
        self.store.use_here(id, resolution)?;
        self.snapshot()
    }
    pub fn prepare_import(
        &self,
        imports: &mut crate::Imports,
        token: &str,
        ids: &[String],
    ) -> Result<crate::PreparedImport> {
        imports.prepare(token, ids, &self.store)
    }
    pub fn commit_import(&mut self, prepared: crate::CredentialedImport) -> Result<()> {
        prepared.commit(&mut self.store)
    }
    /// Check an exact saved instance has an unconditional signed owner attestation.
    /// This is not read authorization; the caller must still prove that owner key.
    pub fn log_target(&self, id: &str, pubkey: &str, relay_url: &str) -> Result<()> {
        let relay = crate::config::canonical_relay(relay_url)?;
        let agents = self.store.agents()?;
        let agent = agents
            .iter()
            .find(|agent| agent.id == id && agent.pubkey == pubkey && agent.relay_url == relay)
            .ok_or("Agent no longer exists")?;
        crate::secret::validate_attestation(
            agent
                .auth_tag
                .as_deref()
                .ok_or("Owner authorization is unavailable")?,
            pubkey,
        )
    }
    /// Read retained output for an exact locally managed identity and community.
    /// Raw output is never included in a snapshot or published to the relay.
    pub fn read_log(
        &self,
        id: &str,
        pubkey: &str,
        relay_url: &str,
        nonce: &str,
        signature: &str,
    ) -> Result<String> {
        let relay = crate::config::canonical_relay(relay_url)?;
        let agents = self.store.agents()?;
        let agent = agents
            .iter()
            .find(|agent| agent.id == id && agent.pubkey == pubkey && agent.relay_url == relay)
            .ok_or("Agent no longer exists")?;
        let auth = agent
            .auth_tag
            .as_deref()
            .ok_or("Owner authorization is unavailable")?;
        crate::secret::validate_attestation(auth, pubkey)?;
        let tag: Vec<String> =
            serde_json::from_str(auth).map_err(|_| "Owner authorization is unavailable")?;
        crate::logs::verify_owner_proof(&tag[1], id, pubkey, &relay, nonce, signature)?;
        let path = crate::logs::path(self.store.root(), id)?;
        crate::logs::read(&path)
    }
    pub fn save(&mut self, id: &str, revision: u64, edit: AgentEdit) -> Result<ControlSnapshot> {
        self.store.save(id, revision, edit)?;
        self.snapshot()
    }
    /// Native-only Agent defaults `DATABRICKS_HOST`, for Disconnect recovery of
    /// an inherited workspace the renderer never sees. Never serialized.
    pub fn inherited_workspace(&self) -> Result<Option<String>> {
        Ok(self
            .store
            .defaults()?
            .environment
            .get("DATABRICKS_HOST")
            .cloned())
    }
    pub fn save_defaults(&mut self, edit: crate::AgentDefaultsEdit) -> Result<ControlSnapshot> {
        let mut defaults = self.store.defaults()?;
        defaults.apply(edit)?;
        self.store.save_defaults(&defaults)?;
        self.snapshot()
    }
    /// Effective launch settings of each live agent, for restart-on-save. Values
    /// stay native; callers compare before/after a save.
    pub fn running_settings(&mut self) -> Result<BTreeMap<String, serde_json::Value>> {
        let defaults = self.store.defaults()?;
        let live: Vec<_> = self
            .snapshot()?
            .agents
            .into_iter()
            .filter(|a| a.enabled && a.status == ProcessStatus::Running)
            .map(|a| a.id)
            .collect();
        Ok(self
            .store
            .agents()?
            .iter()
            .filter(|a| live.contains(&a.id))
            .map(|a| {
                let effective = crate::agent_defaults::effective(a, &defaults);
                (a.id.clone(), crate::restart::spawn_config(&effective))
            })
            .collect())
    }
    pub fn delete(&mut self, id: &str, revision: u64) -> Result<ControlSnapshot> {
        let agents = self.store.agents()?;
        let agent = agents
            .iter()
            .find(|agent| agent.id == id)
            .cloned()
            .ok_or("Agent no longer exists")?;
        // Use here setups of one identity share its key; keep it for the others.
        let shared = agents.iter().any(|other| {
            other.id != agent.id
                && other.credential_id == agent.credential_id
                && other.pubkey == agent.pubkey
        });
        if agent.revision != revision {
            return Err("Agent settings changed. Reload before deleting".into());
        }
        if agent.deployed_remote() {
            return Err("Deployed remote agents can't be deleted from this app".into());
        }
        // Stop must be confirmed before removing custody or durable settings.
        self.stop(id)?;
        self.store.enabled(id, false)?;
        // A failed settings write leaves the card available for an explicit retry.
        // Credential deletion is idempotent, so that retry can finish cleanup.
        if !shared {
            self.credentials
                .delete(&agent.credential_id, &agent.pubkey)?;
        }
        self.store.remove(id, revision)?;
        self.errors.remove(id);
        self.snapshot()
    }
    pub fn action(&mut self, id: &str, action: Action) -> Result<ControlSnapshot> {
        // Start/restart still require a saved identity; Stop must not depend on it.
        if !matches!(action, Action::Stop) && !self.store.agents()?.iter().any(|a| a.id == id) {
            return Err("Agent no longer exists".into());
        }
        let mut disable_failed = false;
        let result = match action {
            Action::Stop => {
                // Stop even if disabling fails. Report cleanup first, but still
                // reject Stop when its durable disable did not succeed.
                let stopped = self.stop(id);
                let saved = self.store.enabled(id, false);
                disable_failed = saved.is_err();
                stopped.and(saved)
            }
            Action::Start => self.store.enabled(id, true).and_then(|_| self.start(id)),
            Action::Restart => self
                .store
                .enabled(id, true)
                .and_then(|_| self.stop(id))
                .and_then(|_| self.start(id)),
        };
        match &result {
            Ok(()) => {
                self.errors.remove(id);
            }
            Err(error) => {
                self.errors.insert(id.into(), error.clone());
            }
        }
        if disable_failed {
            result?;
        }
        self.snapshot()
    }
    /// Persists the launch preference only; the running process is unchanged.
    pub fn set_start_on_app_launch(&mut self, id: &str, value: bool) -> Result<ControlSnapshot> {
        self.store.start_on_app_launch(id, value)?;
        self.snapshot()
    }
    pub fn restore(&mut self) -> Result<ControlSnapshot> {
        for a in self
            .store
            .agents()?
            .into_iter()
            .filter(|a| a.starts_on_launch() && a.configured())
        {
            // Like the host restore, a launch preference is a Start: it enables.
            if let Err(error) = self
                .store
                .enabled(&a.id, true)
                .and_then(|_| self.start(&a.id))
            {
                self.errors.insert(a.id, error);
            }
        }
        self.snapshot()
    }
    pub fn credential_request(&self, id: &str) -> Result<(String, String, u64, Option<String>)> {
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        let agent = crate::agent_defaults::effective(&agent, &self.store.defaults()?);
        if !agent.configured() {
            return Err("Choose Use here before opening this identity’s credentials".into());
        }
        let workspace = effective_databricks(&agent)?.map(|s| s.host);
        self.bundle.as_ref().map_err(Clone::clone)?;
        Ok((agent.credential_id, agent.pubkey, agent.revision, workspace))
    }
    /// Record the action outcome; the native host projects one final snapshot.
    pub fn action_with_key(
        &mut self,
        id: &str,
        action: Action,
        revision: u64,
        key: &crate::Secret,
        replay_floor: Option<u64>,
    ) -> Result<()> {
        if self.credential_request(id)?.2 != revision {
            return Err("Saved settings changed while opening credentials; retry Start".into());
        }
        self.store.enabled(id, true)?;
        if matches!(action, Action::Restart) {
            if let Err(error) = self.stop(id) {
                self.errors.insert(id.into(), error);
                return Ok(());
            }
        }
        match self.start_with_key(id, Some(key), replay_floor) {
            Ok(()) => {
                self.errors.remove(id);
            }
            Err(error) => {
                self.errors.insert(id.into(), error);
            }
        }
        Ok(())
    }
    pub fn record_error(&mut self, id: &str, error: String) {
        self.errors.insert(id.into(), error);
    }
    pub fn launch_ids(&self) -> Result<Vec<String>> {
        Ok(self
            .store
            .agents()?
            .into_iter()
            .filter(|a| a.starts_on_launch() && a.configured())
            .map(|a| a.id)
            .collect())
    }
    fn start(&mut self, id: &str) -> Result<()> {
        self.start_with_key(id, None, None)
    }
    fn start_with_key(
        &mut self,
        id: &str,
        supplied: Option<&crate::Secret>,
        replay_floor: Option<u64>,
    ) -> Result<()> {
        if let Some(run) = self.running.get_mut(id) {
            if run.process.alive()? {
                return Ok(());
            }
        }
        self.running.remove(id);
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if !agent.configured() {
            return Err("Choose Use here before starting this imported identity".into());
        }
        if !agent.enabled {
            return Err("Agent is disabled".into());
        }
        // Blank fields inherit agent defaults at each start; never saved back.
        let agent = crate::agent_defaults::effective(&agent, &self.store.defaults()?);
        let bundle = self.bundle.as_ref().map_err(Clone::clone)?;
        #[cfg(not(unix))]
        let ownership = crate::ownership::Ownership::acquire(&self.ownership_root, &agent.id)?;
        let stored;
        let key = match supplied {
            Some(key) => key,
            None => {
                stored = self
                    .credentials
                    .read(&agent.credential_id, &agent.pubkey)?
                    .ok_or("Saved agent key is unavailable; nothing was started")?;
                &stored
            }
        };
        let settings = effective_databricks(&agent)?;
        let config = self.store.root();
        crate::connection::oauth_root(config)?;
        let runs = config.join("runs");
        crate::connection::private_directory(&runs)?;
        let temporary = tempfile::Builder::new()
            .prefix("agent-")
            .tempdir_in(&runs)
            .map_err(|_| "Could not create private runtime directory")?;
        let mut command = bundle.command(&agent, key)?;
        // Per-send startup input, never saved configuration or inherited environment.
        if let Some(floor) = replay_floor {
            command.env("BUZZ_ACP_REPLAY_FLOOR", floor.to_string());
        }
        // Last writer wins: neither user environment nor relay persona extra_env
        // may redirect credentials/temp signing material outside this app profile.
        command
            .env("BUZZ_AGENT_CONFIG_DIR", config)
            .env("TMPDIR", temporary.path())
            .env("TMP", temporary.path())
            .env("TEMP", temporary.path());
        if let Some(settings) = &settings {
            command
                .env("DATABRICKS_HOST", &settings.host)
                .env("DATABRICKS_MODEL_FILTER", &settings.filter)
                .env_remove("DATABRICKS_TOKEN");
        }
        // Disarm app-side deletion before a child can use this directory. The
        // supervisor deletes it only after confirmed whole-session teardown.
        #[cfg(unix)]
        let log_path = crate::logs::path(config, &agent.id)?;
        #[cfg(unix)]
        let temporary = temporary.keep();
        #[cfg(unix)]
        let process = Supervised::spawn(
            &command,
            &self.ownership_root,
            &agent.id,
            &temporary,
            &log_path,
        )?;
        #[cfg(not(unix))]
        let process = Process::spawn(&mut command)?;
        self.running.insert(
            id.into(),
            Running {
                process,
                revision: agent.revision,
                spawned: crate::restart::spawn_config(&agent),
                databricks_host: settings.map(|s| s.host),
                #[cfg(all(test, unix))]
                temporary: Some(temporary),
                #[cfg(not(unix))]
                _temporary: Some(temporary),
                #[cfg(not(unix))]
                _ownership: ownership,
            },
        );
        Ok(())
    }
    fn stop(&mut self, id: &str) -> Result<()> {
        if let Some(run) = self.running.get_mut(id) {
            let result = run.process.stop();
            #[cfg(unix)]
            if run.process.stopped() {
                // E confirms worker exit even when private-dir removal failed.
                self.running.remove(id);
            }
            result?;
        }
        self.running.remove(id);
        Ok(())
    }
    /// Caller holds the same native mutex used for Start/Restart. Use captured
    /// running settings, never a later saved edit, to determine credential users.
    pub fn disconnect(&mut self, workspace: &str) -> Result<()> {
        let workspace = crate::connection::origin(workspace)?;
        // Reap exits before deciding; failed teardown retains ownership and blocks.
        let ids: Vec<_> = self.running.keys().cloned().collect();
        for id in ids {
            let run = self.running.get_mut(&id).unwrap();
            if !run.process.alive()? {
                self.running.remove(&id);
            }
        }
        if self
            .running
            .values()
            .any(|r| r.databricks_host.as_deref() == Some(&workspace))
        {
            return Err("Stop agents using this Databricks workspace before Disconnect".into());
        }
        let cache = crate::connection::oauth_root(self.store.root())?;
        crate::connection::disconnect(&cache, &workspace)
    }
    pub fn shutdown(&mut self) -> Result<()> {
        let ids: Vec<_> = self.running.keys().cloned().collect();
        let mut result = Ok(());
        for id in ids {
            if let Err(e) = self.stop(&id) {
                result = Err(e);
            }
        }
        result
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
#[cfg(test)]
mod tests;

fn draft_environment(patch: BTreeMap<String, Option<String>>) -> BTreeMap<String, String> {
    patch
        .into_iter()
        .filter_map(|(key, value)| value.map(|v| (key, v)))
        .collect()
}

fn model_context(
    harness: &crate::HarnessEdit,
    environment: &BTreeMap<String, String>,
) -> Result<ModelContext> {
    model_context_with_defaults(harness, environment, &crate::build_defaults())
}
fn model_context_with_defaults(
    harness: &crate::HarnessEdit,
    environment: &BTreeMap<String, String>,
    defaults: &crate::BuildDefaults,
) -> Result<ModelContext> {
    let harness = defaults.resolve(harness, environment);
    if Path::new(&harness.command)
        .file_name()
        .and_then(|s| s.to_str())
        != Some("buzz-agent")
    {
        return Err("Model discovery requires the Buzz Agent harness".into());
    }
    let provider = environment
        .get("BUZZ_AGENT_PROVIDER")
        .unwrap_or(&harness.provider);
    if !matches!(provider.as_str(), "databricks_v2" | "databricks-v2") {
        return Err(
            "Effective provider is not Databricks v2; check the provider and environment overrides"
                .into(),
        );
    }
    if environment.contains_key("DATABRICKS_TOKEN") {
        return Err("A saved or draft token override conflicts with this app-isolated OAuth connection. Remove it explicitly or keep manual model entry".into());
    }
    Ok(ModelContext {
        host: environment
            .get("DATABRICKS_HOST")
            .cloned()
            .or_else(|| harness.databricks.as_ref().map(|s| s.host.clone())),
        filter: environment
            .get("DATABRICKS_MODEL_FILTER")
            .cloned()
            .or_else(|| harness.databricks.as_ref().map(|s| s.filter.clone())),
        model_overridden: environment.contains_key("BUZZ_AGENT_MODEL"),
    })
}

fn goose_model_context(
    harness: &crate::HarnessEdit,
    workspace: &str,
    environment: &BTreeMap<String, String>,
) -> Result<GooseModelContext> {
    crate::config::validate_environment(environment)?;
    let command = PathBuf::from(&harness.command);
    if command.file_name().and_then(|s| s.to_str()) != Some("goose") || !command.is_absolute() {
        return Err("Model discovery requires an absolute Goose executable path".into());
    }
    executable(&command)?;
    let provider = environment
        .get("GOOSE_PROVIDER")
        .unwrap_or(&harness.provider);
    if provider.trim().is_empty() || provider.len() > 128 || provider.chars().any(char::is_control)
    {
        return Err("Choose a valid Goose provider before browsing models".into());
    }
    Ok(GooseModelContext {
        command,
        workspace: workspace.into(),
        provider_id: provider.clone(),
        model_id: environment
            .get("GOOSE_MODEL")
            .unwrap_or(&harness.model)
            .clone(),
        environment: environment.clone(),
        model_overridden: environment.contains_key("GOOSE_MODEL"),
    })
}
