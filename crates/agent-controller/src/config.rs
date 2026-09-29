use crate::Result;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_AGENTS: usize = 2000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionPolicy {
    #[default]
    Channel,
    Thread,
}

impl SessionPolicy {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Thread => "thread",
        }
    }
}
fn is_false(value: &bool) -> bool {
    !value
}
fn policy_edit<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Option<SessionPolicy>>, D::Error> {
    Option::<SessionPolicy>::deserialize(deserializer).map(Some)
}

// Only these explicit projections may cross IPC. Environment values and unknown
// legacy fields remain native-only even when they do not look like credentials.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlSnapshot {
    pub agents: Vec<AgentView>,
    pub parked: Vec<crate::store::ParkedIdentity>,
    pub runtime_available: bool,
    pub runtime_message: Option<String>,
    /// Device-wide defaults; environment keys only.
    pub default_settings: crate::agent_defaults::AgentDefaultsView,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub id: String,
    pub pubkey: String,
    pub relay_url: String,
    pub name: String,
    #[serde(default)]
    pub picture: Option<String>,
    pub system_prompt: String,
    /// Saved choice; null uses Agent defaults unless an imported policy exists.
    pub session_policy: Option<SessionPolicy>,
    pub workspace: String,
    pub harness: HarnessView,
    pub revision: u64,
    pub running_revision: Option<u64>,
    pub enabled: bool,
    pub status: ProcessStatus,
    pub error: Option<String>,
    pub diagnostics: Vec<String>,
    pub profile_pending: bool,
    /// Effective launch restore intent; legacy records follow `enabled`.
    pub start_on_app_launch: bool,
    /// Effective response policy for the next start; `None` when it is invalid.
    pub respond_to: Option<String>,
    /// Imported provider backend id; local agents have none.
    pub backend: Option<String>,
    pub acp_command: Option<String>,
    pub mcp_command: Option<String>,
    /// Model/provider the next start passes to the worker from saved selectors,
    /// agent defaults or build defaults; `None` when an environment override decides it.
    pub launch_model: Option<String>,
    pub launch_provider: Option<String>,
    /// Environment key deciding that selector. Its value never leaves native.
    pub launch_model_env: Option<&'static str>,
    pub launch_provider_env: Option<&'static str>,
    /// Redacted saved-versus-running differences while the process is alive.
    pub restart_diff: Vec<crate::restart::RestartDiffEntry>,
    pub deployed_remote: bool,
    pub needs_team_import: bool,
    pub configured: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessView {
    pub command: String,
    pub args: Vec<String>,
    pub model: String,
    pub provider: String,
    pub environment_keys: Vec<String>,
    pub databricks: Option<crate::connection::DatabricksSettings>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStatus {
    Stopped,
    Waiting,
    Starting,
    Running,
    Stopping,
    Failed,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEdit {
    pub name: String,
    #[serde(default)]
    pub picture: Option<String>,
    pub system_prompt: String,
    /// Missing preserves the current choice; null explicitly inherits defaults.
    #[serde(default, deserialize_with = "policy_edit")]
    pub session_policy: Option<Option<SessionPolicy>>,
    pub workspace: String,
    pub harness: HarnessEdit,
    /// Absence preserves; null deletes; a value replaces. Never a read API.
    pub environment: BTreeMap<String, Option<String>>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessEdit {
    pub command: String,
    pub args: Vec<String>,
    pub model: String,
    pub provider: String,
    #[serde(default)]
    pub databricks: Option<crate::connection::DatabricksSettings>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Agent {
    pub id: String,
    pub pubkey: String,
    pub relay_url: String,
    pub name: String,
    #[serde(default)]
    pub picture: Option<String>,
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_policy: Option<SessionPolicy>,
    /// Distinguish an explicit default choice from a legacy imported policy.
    #[serde(default, skip_serializing_if = "is_false")]
    pub session_policy_inherit: bool,
    pub workspace: String,
    pub harness: HarnessEdit,
    pub environment: BTreeMap<String, String>,
    pub revision: u64,
    pub enabled: bool,
    /// Explicit launch preference. Absent keeps the legacy `enabled` restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_on_app_launch: Option<bool>,
    /// Credential reference only. Secret key resides in the native credential store.
    pub credential_id: String,
    pub auth_tag: Option<String>,
    /// Original source records/config; edits never rewrite or discard these fields.
    pub imported: Value,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
impl Agent {
    pub(crate) fn configured(&self) -> bool {
        self.extra.get("configured") != Some(&Value::Bool(false))
    }
    /// `inherited` supplies launch selectors; the saved harness is shown as saved.
    pub(crate) fn view(&self, inherited: &crate::agent_defaults::AgentDefaults) -> AgentView {
        let defaults = crate::build_defaults();
        let effective = crate::agent_defaults::effective(self, inherited);
        let launch = defaults.launch_view(&effective.harness, &effective.environment);
        AgentView {
            id: self.id.clone(),
            pubkey: self.pubkey.clone(),
            relay_url: self.relay_url.clone(),
            name: self.name.clone(),
            picture: self.picture.clone(),
            system_prompt: self.system_prompt.clone(),
            session_policy: self.selected_session_policy(),
            workspace: self.workspace.clone(),
            harness: HarnessView {
                command: self.harness.command.clone(),
                args: self.harness.args.clone(),
                model: self.harness.model.clone(),
                provider: self.harness.provider.clone(),
                environment_keys: self.environment.keys().cloned().collect(),
                databricks: self.harness.databricks.clone(),
            },
            revision: self.revision,
            running_revision: None,
            enabled: self.enabled,
            status: ProcessStatus::Stopped,
            error: None,
            diagnostics: Vec::new(),
            configured: self.configured(),
            profile_pending: self.extra.get("profilePending") == Some(&Value::Bool(true)),
            start_on_app_launch: self.starts_on_launch(),
            respond_to: self.respond_to(defaults.owner_only).ok().map(str::to_owned),
            backend: (self.imported["record"]["backend"]["type"] == "provider")
                .then(|| self.imported["record"]["backend"]["id"].as_str())
                .flatten()
                .map(str::to_owned),
            acp_command: None,
            mcp_command: None,
            launch_model: launch.model,
            launch_provider: launch.provider,
            launch_model_env: launch.model_env,
            launch_provider_env: launch.provider_env,
            restart_diff: Vec::new(),
            deployed_remote: self.deployed_remote(),
            needs_team_import: self.needs_team_import(),
        }
    }
    pub fn needs_team_import(&self) -> bool {
        let record = &self.imported["record"];
        ["team_id", "persona_team_dir"].iter().any(|field| {
            record[field]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        }) && self.imported.get("teamInstructions").is_none()
    }
    pub fn starts_on_launch(&self) -> bool {
        self.start_on_app_launch.unwrap_or(self.enabled)
    }
    pub(crate) fn selected_session_policy(&self) -> Option<SessionPolicy> {
        if self.session_policy_inherit {
            return None;
        }
        self.session_policy.or_else(|| {
            // Old Buzz omitted Channel on serialization; a linked definition
            // still wins over the record when its field is absent.
            let imported = self
                .imported
                .get("definition")
                .filter(|value| value.is_object())
                .or_else(|| {
                    self.imported
                        .get("record")
                        .filter(|value| value.is_object())
                })?;
            Some(match imported["session_policy"].as_str() {
                Some("thread") => SessionPolicy::Thread,
                _ => SessionPolicy::Channel,
            })
        })
    }
    pub fn respond_to(&self, owner_only: bool) -> Result<&str> {
        let respond_to = if owner_only {
            "owner-only"
        } else {
            self.imported["record"]["respond_to"]
                .as_str()
                .unwrap_or("owner-only")
        };
        if matches!(respond_to, "owner-only" | "allowlist" | "anyone") {
            Ok(respond_to)
        } else {
            Err("Invalid imported response policy".into())
        }
    }
    /// An imported record for an agent hosted by a remote backend.
    pub fn deployed_remote(&self) -> bool {
        let record = &self.imported["record"];
        record["backend"]["type"]
            .as_str()
            .is_some_and(|s| s != "local")
            && !record["backend_agent_id"].is_null()
    }
    pub fn apply(&mut self, edit: AgentEdit) -> Result<()> {
        if let Some(picture) = edit.picture {
            validate_picture(&picture)?;
            if self.picture.as_ref() != Some(&picture) {
                self.picture = Some(picture);
                self.extra
                    .insert("profilePending".into(), Value::Bool(true));
            }
        }
        self.name = edit.name;
        self.system_prompt = edit.system_prompt;
        if let Some(policy) = edit.session_policy {
            self.session_policy = policy;
            self.session_policy_inherit = policy.is_none();
        }
        self.workspace = edit.workspace;
        self.harness = edit.harness;
        for (key, value) in edit.environment {
            validate_env_key(&key)?;
            if let Some(value) = value {
                text(&value, 32 * 1024, "Environment value")?;
                self.environment.insert(key, value);
            } else {
                self.environment.remove(&key);
            }
        }
        self.revision = self
            .revision
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("Agent revision exhausted")?;
        self.validate()
    }
    pub fn validate(&self) -> Result<()> {
        if !canonical_key(&self.pubkey) || self.id != agent_id(&self.pubkey, &self.relay_url) {
            return Err("Invalid agent identity".into());
        }
        if canonical_relay(&self.relay_url)? != self.relay_url {
            return Err("Agent community must be canonical".into());
        }
        if self.revision == 0 || self.revision > 9_007_199_254_740_991 {
            return Err("Invalid agent revision".into());
        }
        if self.name.trim().is_empty() {
            return Err("Agent name is required".into());
        }
        text(&self.name, 256, "Agent name")?;
        if let Some(picture) = &self.picture {
            validate_picture(picture)?;
        }
        text(&self.system_prompt, 128 * 1024, "System prompt")?;
        text(&self.workspace, 4096, "Workspace")?;
        if !Path::new(&self.workspace).is_absolute() {
            return Err("Choose an absolute workspace path".into());
        }
        text(&self.harness.command, 4096, "Harness command")?;
        if self.harness.command.trim().is_empty() {
            return Err("Harness command is required".into());
        }
        if self.harness.args.len() > 128 {
            return Err("Too many harness arguments".into());
        }
        for arg in &self.harness.args {
            text(arg, 8192, "Harness argument")?;
            // Existing ACP uses clap's comma-delimited --agent-args transport.
            if arg.contains(',') || arg.is_empty() {
                return Err("ACP arguments must be nonempty and cannot contain commas".into());
            }
        }
        text(&self.harness.model, 512, "Model")?;
        text(&self.harness.provider, 128, "Provider")?;
        if let Some(settings) = &self.harness.databricks {
            settings.validate()?;
        }
        validate_environment(&self.environment)
    }
}
pub(crate) fn canonical_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(crate) fn canonical_relay(value: &str) -> Result<String> {
    let invalid =
        || "Choose a secure community origin without credentials, path or query".to_string();
    let mut url = url::Url::parse(value.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "https" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    url.set_scheme("wss").map_err(|_| invalid())?;
    let host = url
        .host_str()
        .ok_or_else(invalid)?
        .trim_end_matches('.')
        .to_owned();
    url.set_host(Some(&host)).map_err(|_| invalid())?;
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
pub(crate) fn agent_id(pubkey: &str, relay: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{pubkey}-{:x}", Sha256::digest(relay.as_bytes()))
}
fn text(value: &str, limit: usize, label: &str) -> Result<()> {
    if value.len() > limit || value.contains('\0') {
        Err(format!("{label} is too long or contains a NUL byte"))
    } else {
        Ok(())
    }
}
pub(crate) fn validate_environment(environment: &BTreeMap<String, String>) -> Result<()> {
    if environment.len() > 128 {
        return Err("Too many environment entries".into());
    }
    for (key, value) in environment {
        validate_env_key(key)?;
        text(value, 32 * 1024, "Environment value")?;
    }
    Ok(())
}
fn validate_env_key(key: &str) -> Result<()> {
    let upper = key.to_ascii_uppercase();
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
        || upper.starts_with("BUZZ_ACP_")
        || upper.starts_with("BUZZ_MANAGED_")
        || upper.starts_with("BUZZ_APP_")
        || upper.starts_with("GIT_CONFIG_")
        || matches!(
            upper.as_str(),
            "BUZZ_PRIVATE_KEY"
                | "NOSTR_PRIVATE_KEY"
                | "BUZZ_AUTH_TAG"
                | "BUZZ_RELAY_URL"
                | "BUZZ_API_TOKEN"
                | "BUZZ_AGENT_CONFIG_DIR"
                | "PI_ACP_PI_COMMAND"
        )
    {
        // Do not interpolate arbitrary user text into diagnostics.
        Err("Invalid or host-reserved environment key".into())
    } else {
        Ok(())
    }
}

fn validate_picture(value: &str) -> Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    if value.len() <= 2048 {
        if let Ok(url) = url::Url::parse(value) {
            if url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
            {
                return Ok(());
            }
        }
    }
    Err("Avatar must be an HTTPS image URL without credentials".into())
}
