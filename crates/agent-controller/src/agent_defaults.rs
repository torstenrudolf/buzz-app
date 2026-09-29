//! Device-wide agent defaults, editable in Settings → Agents. Native-only file;
//! environment values are write-only and never cross IPC.
use crate::config::{Agent, HarnessEdit, SessionPolicy};
use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// Native-only key on an effective (never saved) clone: effort inherited from
/// defaults when the agent has no imported effort of its own.
const INHERITED_EFFORT: &str = "inheritedEffort";

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentDefaults {
    #[serde(default = "buzz_agent")]
    pub harness: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub session_policy: SessionPolicy,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}
fn buzz_agent() -> String {
    "buzz-agent".into()
}
impl Default for AgentDefaults {
    fn default() -> Self {
        Self {
            harness: buzz_agent(),
            provider: String::new(),
            model: String::new(),
            effort: String::new(),
            session_policy: SessionPolicy::Channel,
            environment: BTreeMap::new(),
        }
    }
}

/// IPC projection: environment keys only.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaultsView {
    pub harness: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub session_policy: SessionPolicy,
    pub environment_keys: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDefaultsEdit {
    pub harness: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    /// Missing preserves the saved default; only an explicit choice replaces it.
    #[serde(default)]
    pub session_policy: Option<SessionPolicy>,
    /// Absence preserves; null deletes; a value replaces. Never a read API.
    pub environment: BTreeMap<String, Option<String>>,
}

impl AgentDefaults {
    pub(crate) fn view(&self) -> AgentDefaultsView {
        AgentDefaultsView {
            harness: self.harness.clone(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            session_policy: self.session_policy,
            environment_keys: self.environment.keys().cloned().collect(),
        }
    }
    pub(crate) fn apply(&mut self, edit: AgentDefaultsEdit) -> Result<()> {
        // Submitted values are explicit. The card clears model and effort when
        // the harness changes, so a value sent with a new harness was re-entered.
        let mut environment = self.environment.clone();
        for (key, value) in edit.environment {
            match value {
                Some(value) => environment.insert(key, value),
                None => environment.remove(&key),
            };
        }
        let next = Self {
            harness: edit.harness,
            provider: edit.provider,
            model: edit.model,
            effort: edit.effort,
            session_policy: edit.session_policy.unwrap_or(self.session_policy),
            environment,
        };
        next.validate()?;
        // Pi rejects a provider without a model only after Restart has stopped
        // the old process, so refuse that pair before it is saved or applied.
        if next.harness == "pi" {
            crate::pi::validate_selection(&next.provider, &next.model)?;
        }
        *self = next;
        Ok(())
    }
    pub(crate) fn validate(&self) -> Result<()> {
        if !matches!(self.harness.as_str(), "buzz-agent" | "goose" | "pi") {
            return Err("Choose Buzz Agent, Goose or Pi as the default harness".into());
        }
        for (value, limit, label) in [
            (&self.provider, 128, "Default provider"),
            (&self.model, 512, "Default model"),
            (&self.effort, 64, "Default effort"),
        ] {
            if value.len() > limit || value.chars().any(char::is_control) {
                return Err(format!("{label} is too long or invalid"));
            }
        }
        crate::config::validate_environment(&self.environment)
    }
}

/// Harness kind of a saved command, matching the default harness choices.
pub(crate) fn harness_kind(command: &str) -> Option<&'static str> {
    match Path::new(command).file_name().and_then(|s| s.to_str()) {
        Some("buzz-agent") => Some("buzz-agent"),
        Some("goose") => Some("goose"),
        Some("buzz-pi-acp") => Some("pi"),
        _ => None,
    }
}

/// Temporary launch copy: blank provider/model/effort inherit defaults for the
/// same harness; environment merges per key with the agent's key winning. The
/// build floor (`BuildDefaults::resolve`) still applies afterwards.
pub(crate) fn effective_settings(
    harness: &mut HarnessEdit,
    environment: &mut BTreeMap<String, String>,
    defaults: &AgentDefaults,
) -> bool {
    let same_harness = harness_kind(&harness.command) == Some(defaults.harness.as_str());
    if same_harness {
        if harness.provider.is_empty() {
            harness.provider.clone_from(&defaults.provider);
        }
        if harness.model.is_empty() {
            harness.model.clone_from(&defaults.model);
        }
    }
    // A saved Databricks workspace/filter is an agent-owned override, even
    // when the corresponding environment key was not set on that agent.
    let own_databricks =
        harness_kind(&harness.command) == Some("buzz-agent") && harness.databricks.is_some();
    for (key, value) in &defaults.environment {
        if own_databricks && matches!(key.as_str(), "DATABRICKS_HOST" | "DATABRICKS_MODEL_FILTER") {
            continue;
        }
        environment
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
    same_harness
}

pub(crate) fn effective(agent: &Agent, defaults: &AgentDefaults) -> Agent {
    let mut out = agent.clone();
    out.session_policy = Some(
        agent
            .selected_session_policy()
            .unwrap_or(defaults.session_policy),
    );
    if effective_settings(&mut out.harness, &mut out.environment, defaults)
        && !defaults.effort.is_empty()
    {
        out.extra.insert(
            INHERITED_EFFORT.into(),
            Value::String(defaults.effort.clone()),
        );
    }
    out
}

/// The agent's imported effort wins over an inherited default.
pub(crate) fn effort(agent: &Agent) -> Option<&str> {
    agent.imported["record"]["effort_level"]
        .as_str()
        .or_else(|| agent.extra.get(INHERITED_EFFORT)?.as_str())
}

#[cfg(test)]
#[path = "agent_defaults/tests.rs"]
mod tests;
