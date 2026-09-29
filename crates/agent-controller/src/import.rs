//! Snapshot import, not a second writer of the old library. Chosen files are
//! re-read before commit; key access happens only after explicit selection.
use crate::config::{
    agent_id, canonical_key, canonical_relay, Agent, HarnessEdit, MAX_AGENTS, MAX_BYTES,
};
use crate::{Credentials, Result, Secret, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LegacySource {
    Installed,
    Development,
}
impl LegacySource {
    pub fn keyring_service(self) -> &'static str {
        match self {
            Self::Installed => "buzz-desktop",
            Self::Development => "buzz-desktop-dev",
        }
    }
    pub fn app_directory(self) -> &'static str {
        match self {
            Self::Installed => "xyz.block.buzz.app",
            Self::Development => "xyz.block.buzz.app.dev",
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub token: String,
    pub source_path: String,
    pub candidates: Vec<Candidate>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub pubkey: String,
    pub relay_url: String,
    pub name: String,
}
/// Reviewed text only. Never project legacy environment, commands, arguments,
/// credentials, paths, owner authorization or retained source records for cloning.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneSettings {
    pub name: String,
    pub system_prompt: String,
}
#[derive(Clone)]
struct Pending {
    preview: ImportPreview,
    source: PathBuf,
    source_kind: LegacySource,
    digest: String,
    workspace: PathBuf,
}
#[derive(Default, Clone)]
pub struct Imports {
    sequence: u64,
    pending: Option<Pending>,
}
struct Source {
    records: Vec<Value>,
    global: Value,
    teams: Vec<Value>,
    custom: BTreeMap<String, Value>,
    digest: String,
}
impl Imports {
    pub fn clone_settings(
        source_kind: LegacySource,
        app_data_parent: PathBuf,
        pubkey: &str,
    ) -> Result<CloneSettings> {
        if !canonical_key(pubkey) {
            return Err("Invalid source identity".into());
        }
        let data = read_source(&app_data_parent.join(source_kind.app_directory()))?;
        let records: Vec<_> = data
            .records
            .iter()
            .filter(|record| string(record, "pubkey") == pubkey)
            .collect();
        if records.len() != 1 {
            return Err("Choose one existing source identity".into());
        }
        let record = records[0];
        let definition = source_definition(&data, record)?;
        Ok(CloneSettings {
            name: string(record, "name").into(),
            system_prompt: string(definition, "system_prompt").into(),
        })
    }
    pub fn discard(&mut self) {
        self.pending = None;
    }
    /// Native resolves the app-data parent, never from a browser-supplied path.
    /// Bind config directory and credential service to the same explicit choice.
    pub fn preview(
        &mut self,
        source_kind: LegacySource,
        app_data_parent: PathBuf,
        workspace: PathBuf,
        destination: &str,
    ) -> Result<ImportPreview> {
        self.pending = None;
        // Browsing local files needs no destination and grants no import authority.
        let relay = if destination.is_empty() {
            String::new()
        } else {
            canonical_relay(destination)?
        };
        let source = app_data_parent.join(source_kind.app_directory());
        let data = read_source(&source)?;
        let mut candidates = Vec::new();
        let mut seen = BTreeSet::new();
        for record in &data.records {
            let key = string(record, "pubkey");
            if key.is_empty() {
                continue;
            }
            if !canonical_key(key) {
                return Err("Source contains an invalid agent identity".into());
            }
            let id = agent_id(key, &relay);
            if !seen.insert(id.clone()) {
                return Err("Source contains duplicate agent identities".into());
            }
            candidates.push(Candidate {
                id,
                pubkey: key.into(),
                relay_url: relay.clone(),
                name: string(record, "name").into(),
            });
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("Import preview exhausted")?;
        let mut preview = ImportPreview {
            token: format!("{}-{}", self.sequence, data.digest),
            source_path: source.join("agents/managed-agents.json").display().to_string(),
            candidates,
            warnings: vec![
                "Import uses the destination shown below, not old saved relay values. Community membership is not established by importing.".into(),
                "Imports stay disabled. Stop old Buzz before enabling an imported identity.".into(),
                "Provider defaults baked into the old app cannot be inferred from these files; review the imported harness before starting.".into(),
                "This copies selected identities and resolved settings; old Buzz remains unchanged.".into(),
            ],
        };
        if relay.is_empty() {
            preview.token.clear();
            preview.warnings = vec![
                "Local identities only. Choose a destination before reviewing an import.".into(),
            ];
            return Ok(preview);
        }
        self.pending = Some(Pending {
            preview: preview.clone(),
            source,
            source_kind,
            digest: data.digest,
            workspace,
        });
        Ok(preview)
    }
    pub fn prepare(
        &mut self,
        token: &str,
        ids: &[String],
        store: &Store,
    ) -> Result<PreparedImport> {
        let pending = self
            .pending
            .as_ref()
            .filter(|p| p.preview.token == token)
            .ok_or("Import preview expired; choose the source again")?;
        if ids.is_empty()
            || ids.len() > MAX_AGENTS
            || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
        {
            return Err("Select distinct identities to import".into());
        }
        let data = read_source(&pending.source)?;
        if data.digest != pending.digest {
            return Err("Source changed after preview; preview it again".into());
        }
        let reservation = store.reserve_import()?;
        let existing = store.agents()?;
        let mut agents = Vec::new();
        let mut repairs = Vec::new();
        for id in ids {
            let candidate = pending
                .preview
                .candidates
                .iter()
                .find(|c| &c.id == id)
                .ok_or("Identity was not in this preview")?;
            let record = data
                .records
                .iter()
                .find(|r| string(r, "pubkey") == candidate.pubkey)
                .ok_or("Import identity disappeared")?;
            if let Some(saved) = existing.iter().find(|a| a.id == *id) {
                if !saved.needs_team_import() {
                    return Err("Selected identity is already imported".into());
                }
                let original = &saved.imported["record"];
                if ["team_id", "persona_team_dir"]
                    .iter()
                    .any(|field| string(original, field) != string(record, field))
                {
                    return Err("Source team binding differs from the imported agent; choose its original library".into());
                }
                repairs.push((
                    saved.id.clone(),
                    saved.revision,
                    team_instructions(&data, original)?,
                ));
                continue;
            }
            if existing.iter().any(|a| a.pubkey == candidate.pubkey) {
                return Err("Selected identity is already imported".into());
            }
            let agent = resolve(&data, record, &pending.workspace, &candidate.relay_url)?;
            agent.validate()?;
            agents.push((agent, string(record, "private_key_nsec").to_owned()));
        }
        Ok(PreparedImport {
            reservation,
            agents,
            repairs,
            source_kind: pending.source_kind,
            source: pending.source.clone(),
            digest: pending.digest.clone(),
        })
    }
    pub fn commit(
        &mut self,
        token: &str,
        ids: &[String],
        store: &mut Store,
        credentials: &dyn Credentials,
    ) -> Result<()> {
        let prepared = self.prepare(token, ids, store)?;
        prepared.acquire(credentials)?.commit(store)?;
        self.pending = None;
        Ok(())
    }
}
/// Native-only import plan; never serialized. Credential operations can happen
/// outside the controller mutex. The source snapshot is copied, never mutated.
pub struct PreparedImport {
    reservation: crate::store::ImportReservation,
    agents: Vec<(Agent, String)>,
    repairs: Vec<(String, u64, String)>,
    source_kind: LegacySource,
    source: PathBuf,
    digest: String,
}
pub struct CredentialedImport {
    reservation: crate::store::ImportReservation,
    agents: Vec<Agent>,
    repairs: Vec<(String, u64, String)>,
    source: PathBuf,
    digest: String,
}
impl PreparedImport {
    pub fn acquire(self, credentials: &dyn Credentials) -> Result<CredentialedImport> {
        let agents = self.agents;
        // All config validation precedes credential writes. Retry can reuse a
        // verified identical key saved by a partial prior attempt, never replace it.
        for (agent, inline) in &agents {
            let key = if inline.is_empty() {
                credentials.read_legacy(self.source_kind, &agent.pubkey)?
            } else {
                Secret::parse(inline, &agent.pubkey)?
            };
            if let Some(saved) = credentials.read(&agent.credential_id, &agent.pubkey)? {
                if *saved.hex() != *key.hex() {
                    return Err("Saved credential differs; refusing to overwrite it".into());
                }
            } else {
                credentials.add(&agent.credential_id, &key)?;
            }
            let saved = credentials
                .read(&agent.credential_id, &agent.pubkey)?
                .ok_or("Credential read-back failed; import was not completed")?;
            if *saved.hex() != *key.hex() {
                return Err("Credential read-back differed; import was not completed".into());
            }
        }
        Ok(CredentialedImport {
            reservation: self.reservation,
            agents: agents.into_iter().map(|(a, _)| a).collect(),
            repairs: self.repairs,
            source: self.source,
            digest: self.digest,
        })
    }
}
impl CredentialedImport {
    pub fn commit(self, store: &mut Store) -> Result<()> {
        if !self.reservation.belongs_to(store) {
            return Err("Import belongs to another agent store".into());
        }
        if read_source(&self.source)?.digest != self.digest {
            return Err("Source changed during credential access; preview again".into());
        }
        let existing = store.agents()?;
        if self
            .agents
            .iter()
            .any(|incoming| existing.iter().any(|saved| saved.pubkey == incoming.pubkey))
        {
            return Err("Selected identity is already imported".into());
        }
        let agents = self
            .agents
            .into_iter()
            .map(|mut agent| {
                agent.extra.insert("configured".into(), Value::Bool(true));
                agent.enabled = false;
                agent
            })
            .collect();
        store.import(agents, self.repairs)
    }
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn object(value: &Value) -> Result<BTreeMap<String, String>> {
    if value.is_null() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_value(value.clone())
        .map_err(|_| "Source environment must contain string values".into())
}
fn source_definition<'a>(data: &'a Source, record: &'a Value) -> Result<&'a Value> {
    Ok(if string(record, "persona_id").is_empty() {
        record
    } else {
        data.records
            .iter()
            .find(|r| {
                string(r, "pubkey").is_empty() && string(r, "slug") == string(record, "persona_id")
            })
            .ok_or("Linked agent definition is missing; source left unchanged")?
    })
}
fn resolve(data: &Source, record: &Value, workspace: &Path, destination: &str) -> Result<Agent> {
    let definition = source_definition(data, record)?;
    let fallback = |key| {
        let selected = string(definition, key);
        if selected.trim().is_empty() {
            string(&data.global, key).to_owned()
        } else {
            selected.to_owned()
        }
    };
    // Legacy spawn's actual resolver is record-first, not its outdated comment:
    // override > record runtime > linked definition runtime > buzz-agent.
    let runtime_id = record
        .get("runtime")
        .and_then(Value::as_str)
        .or_else(|| definition.get("runtime").and_then(Value::as_str));
    let custom = runtime_id.and_then(|id| data.custom.get(id));
    let command = if !string(record, "agent_command_override").trim().is_empty() {
        string(record, "agent_command_override").trim().to_owned()
    } else {
        match (runtime_id, custom) {
            (_, Some(c)) => string(c, "command").to_owned(),
            (Some("claude"), _) => "claude-agent-acp".into(),
            (Some("codex"), _) => "codex-acp".into(),
            (Some("goose"), _) => "goose".into(),
            (None | Some("buzz-agent"), _) => "buzz-agent".into(),
            _ => return Err("Source uses an unsupported harness definition; restore its custom definition before importing".into()),
        }
    };
    let mut env = custom
        .map(|c| object(&c["env"]))
        .transpose()?
        .unwrap_or_default();
    env.extend(object(&data.global["env_vars"])?);
    if !std::ptr::eq(definition, record) {
        env.extend(object(&definition["env_vars"])?);
    }
    env.extend(object(&record["env_vars"])?);
    let args: Vec<String> = match record
        .get("agent_args")
        .filter(|v| v.as_array().is_none_or(|a| !a.is_empty()))
    {
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|_| "Invalid source harness arguments")?
        }
        None => match custom.and_then(|c| c.get("args")) {
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|_| "Invalid custom harness arguments")?,
            None if command == "goose" => vec!["acp".into()],
            None => vec![],
        },
    };
    let pubkey = string(record, "pubkey").to_owned();
    // Legacy pins are ignored by old Buzz at runtime. Only the destination
    // confirmed in this native preview may route the imported identity.
    let relay_url = destination.to_owned();
    let id = agent_id(&pubkey, &relay_url);
    let mut retained = record.clone();
    if let Some(record) = retained.as_object_mut() {
        record.remove("private_key_nsec");
    }
    Ok(Agent {
        picture: None,
        id: id.clone(),
        pubkey,
        relay_url,
        name: string(record, "name").into(),
        system_prompt: string(definition, "system_prompt").into(),
        session_policy: None,
        session_policy_inherit: false,
        workspace: workspace.display().to_string(),
        harness: HarnessEdit {
            databricks: None,
            command,
            args,
            model: fallback("model"),
            provider: fallback("provider"),
        },
        environment: env,
        revision: 1,
        enabled: false,
        start_on_app_launch: Some(false),
        credential_id: id,
        auth_tag: record
            .get("auth_tag")
            .and_then(Value::as_str)
            .map(str::to_owned),
        imported: json!({ "record": retained, "definition": if std::ptr::eq(definition, record) { Value::Null } else { definition.clone() }, "global": data.global, "harness": custom, "teamInstructions": team_instructions(data, record)? }),
        extra: BTreeMap::new(),
    })
}
// Match old Buzz's deployment-team lookup: a deleted team contributes no section.
fn team_instructions(data: &Source, record: &Value) -> Result<String> {
    let id = string(record, "team_id");
    let team = data
        .teams
        .iter()
        .find(|team| !id.is_empty() && string(team, "id") == id);
    team_text(
        team.map(|team| &team["instructions"])
            .unwrap_or(&Value::Null),
    )
    .map(str::to_owned)
}
pub(crate) fn team_text(value: &Value) -> Result<&str> {
    let text = if value.is_null() {
        ""
    } else {
        value.as_str().ok_or("Invalid source team instructions")?
    };
    if text.len() > 128 * 1024 || text.contains('\0') {
        return Err("Invalid source team instructions".into());
    }
    Ok(text.trim())
}
fn read_source(root: &Path) -> Result<Source> {
    let records = read_json(&root.join("agents/managed-agents.json"), false)?;
    let global = read_json(&root.join("agents/global-agent-config.json"), true)?;
    let records: Vec<Value> =
        serde_json::from_value(records).map_err(|_| "Source agent library must be an array")?;
    if records.len() > MAX_AGENTS || records.iter().any(|r| !r.is_object()) {
        return Err("Invalid source agent library".into());
    }
    if !global.is_object() {
        return Err("Invalid source global configuration".into());
    }
    let team_path = root.join("agents/teams.json");
    let teams: Vec<Value> = if records
        .iter()
        .any(|record| !string(record, "team_id").is_empty())
    {
        match fs::symlink_metadata(&team_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            _ => serde_json::from_value(read_json(&team_path, false)?)
                .map_err(|_| "Source team library must be an array")?,
        }
    } else {
        Vec::new()
    };
    let mut team_ids = BTreeSet::new();
    if teams.len() > MAX_AGENTS
        || teams.iter().any(|team| {
            let id = string(team, "id");
            !team.is_object() || id.is_empty() || !team_ids.insert(id)
        })
    {
        return Err("Invalid or duplicate source teams".into());
    }
    let mut custom = BTreeMap::new();
    let directory = root.join("custom_harnesses");
    match fs::read_dir(directory) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|_| "Could not read source harness definitions")?;
                if entry.path().extension().is_none_or(|e| e != "json") {
                    continue;
                }
                if custom.len() >= 128 {
                    return Err("Too many source harness definitions".into());
                }
                let value = read_json(&entry.path(), false)?;
                let id = string(&value, "id").to_owned();
                if id.is_empty() || custom.insert(id, value).is_some() {
                    return Err("Invalid or duplicate source harness definition".into());
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not read source harness definitions".into()),
    }
    let bytes = serde_json::to_vec(&(&records, &global, &teams, &custom))
        .map_err(|_| "Could not snapshot import source")?;
    if bytes.len() > MAX_BYTES {
        return Err("Import source exceeds size limit".into());
    }
    Ok(Source {
        records,
        global,
        teams,
        custom,
        digest: format!("{:x}", Sha256::digest(bytes)),
    })
}
fn read_json(path: &Path, optional: bool) -> Result<Value> {
    let meta = match fs::symlink_metadata(path) {
        Err(e) if optional && e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => return Err("Could not read chosen Buzz source".into()),
        Ok(meta) => meta,
    };
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Err("Import files must be bounded regular files".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "Could not open import source")?;
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read import source")?;
    if bytes.len() > MAX_BYTES {
        return Err("Import source exceeds size limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Import source is malformed; left unchanged".into())
}
#[cfg(test)]
mod tests;
