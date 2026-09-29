//! Redacted saved-versus-running differences for the restart-required notice.
//! Raw values are compared natively; only the redacted entries cross IPC.
use crate::config::Agent;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::Path;

const MASK: &str = "••••";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartDiffEntry {
    pub field: String,
    pub change: RestartChange,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestartChange {
    /// Safe scalar or array shown verbatim.
    Value {
        before: Value,
        after: Value,
    },
    /// Large text shown as character counts only.
    #[serde(rename_all = "camelCase")]
    Text {
        before_chars: Option<usize>,
        after_chars: Option<usize>,
    },
    /// Secret-bearing value shown only as a mask.
    Masked {
        before: Option<String>,
        after: Option<String>,
    },
    /// Environment key present only on one side; its value is never shown.
    Added,
    Removed,
}

/// Effective settings a start applies. Identity, relay and imported response
/// policy are immutable. Values stay native; `diff` redacts environment-derived
/// selectors before producing an IPC projection.
pub(crate) fn spawn_config(agent: &Agent) -> Value {
    let env = &agent.environment;
    let harness = crate::build_defaults().resolve(&agent.harness, env);
    let worker = Path::new(&harness.command)
        .file_name()
        .and_then(|name| name.to_str());
    let selected = crate::defaults::selectors(&harness, env);
    let provider = selected
        .provider
        .or_else(|| (!harness.provider.is_empty()).then_some(harness.provider.as_str()));
    let databricks = if worker == Some("buzz-agent")
        && matches!(
            provider,
            Some("databricks_v2" | "databricks-v2" | "databricks")
        ) {
        Some(harness.databricks.as_ref())
    } else {
        None
    };
    let host = databricks.and_then(|stored| {
        env.get("DATABRICKS_HOST")
            .map(String::as_str)
            .or_else(|| stored.map(|settings| settings.host.as_str()))
    });
    let filter = databricks.and_then(|stored| {
        env.get("DATABRICKS_MODEL_FILTER")
            .map(String::as_str)
            .or_else(|| stored.map(|settings| settings.filter.as_str()))
    });
    json!({
        "name": agent.name,
        "system_prompt": agent.system_prompt,
        "workspace": agent.workspace,
        "command": harness.command,
        "args": harness.args,
        "model": selected.model,
        "provider": provider,
        "databricks_host": host,
        "databricks_filter": filter,
        "env": env,
        "effort": crate::agent_defaults::effort(agent),
        "session_policy": agent.session_policy.unwrap_or_default(),
    })
}

pub(crate) fn diff(before: &Value, after: &Value) -> Vec<RestartDiffEntry> {
    // These selectors may be derived from private environment values. Compare
    // their actual values, but mask the corresponding field if either side used
    // an environment key; the env.* difference is always redacted as well.
    let masked: Vec<_> = [
        (
            "model",
            &["BUZZ_AGENT_MODEL", "GOOSE_MODEL", "DATABRICKS_MODEL"][..],
        ),
        ("provider", &["BUZZ_AGENT_PROVIDER", "GOOSE_PROVIDER"][..]),
        ("databricks_host", &["DATABRICKS_HOST"][..]),
        ("databricks_filter", &["DATABRICKS_MODEL_FILTER"][..]),
    ]
    .into_iter()
    .filter_map(|(field, keys)| {
        keys.iter()
            .any(|key| before["env"].get(key).is_some() || after["env"].get(key).is_some())
            .then_some(field)
    })
    .collect();
    let mut out = Vec::new();
    walk("", before, after, &masked, &mut out);
    out
}

fn walk(
    path: &str,
    before: &Value,
    after: &Value,
    masked: &[&str],
    out: &mut Vec<RestartDiffEntry>,
) {
    if before == after {
        return;
    }
    if let (Value::Object(before), Value::Object(after)) = (before, after) {
        for key in keys(before, after) {
            let child = if path.is_empty() {
                key.to_owned()
            } else {
                format!("{path}.{key}")
            };
            match (before.get(key), after.get(key)) {
                (Some(b), Some(a)) => walk(&child, b, a, masked, out),
                (None, _) => out.push(entry(child, RestartChange::Added)),
                (_, None) => out.push(entry(child, RestartChange::Removed)),
            }
        }
        return;
    }
    let change = match path {
        "system_prompt" => RestartChange::Text {
            before_chars: before.as_str().map(|s| s.chars().count()),
            after_chars: after.as_str().map(|s| s.chars().count()),
        },
        // Arguments and environment values may carry credentials.
        _ if path == "args" || path.starts_with("env.") || masked.contains(&path) => {
            RestartChange::Masked {
                before: (!before.is_null()).then(|| MASK.into()),
                after: (!after.is_null()).then(|| MASK.into()),
            }
        }
        _ => RestartChange::Value {
            before: before.clone(),
            after: after.clone(),
        },
    };
    out.push(entry(path.to_owned(), change));
}

fn keys<'a>(before: &'a Map<String, Value>, after: &'a Map<String, Value>) -> Vec<&'a str> {
    let mut keys: Vec<_> = before
        .keys()
        .chain(after.keys())
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    keys.dedup();
    keys
}

fn entry(field: String, change: RestartChange) -> RestartDiffEntry {
    RestartDiffEntry { field, change }
}

#[cfg(test)]
mod tests;
