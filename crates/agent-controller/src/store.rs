use crate::agent_defaults::AgentDefaults;
use crate::config::{Agent, AgentEdit, MAX_AGENTS, MAX_BYTES};
use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const MAX_DEFAULTS_BYTES: usize = 1024 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u32,
    agents: Vec<Agent>,
    #[serde(default)]
    parked: BTreeMap<String, ParkedIdentity>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}
/// Keyless inventory. Provenance is not proof of present key custody or membership.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedIdentity {
    pub pubkey: String,
    pub name: String,
    pub sources: Vec<crate::LegacySource>,
}
/// One native host owns this profile for its entire lifetime. A corrupt store is
/// an error, never a fresh library; there is no auto-reset or legacy write path.
pub struct Store {
    root: PathBuf,
    _lock: File,
    importing: Arc<AtomicBool>,
}
// Hold across unlocked credential I/O and the final store write. Dropping any
// intermediate import value releases the reservation, including on failure.
pub(crate) struct ImportReservation(Arc<AtomicBool>);
impl ImportReservation {
    pub(crate) fn belongs_to(&self, store: &Store) -> bool {
        Arc::ptr_eq(&self.0, &store.importing)
    }
}
impl Drop for ImportReservation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        if !root.is_absolute() {
            return Err("Agent storage requires an absolute directory".into());
        }
        fs::create_dir_all(&root).map_err(|_| "Could not create agent storage")?;
        if fs::symlink_metadata(&root)
            .map_err(|_| "Could not inspect agent storage")?
            .file_type()
            .is_symlink()
        {
            return Err("Agent storage cannot be a symbolic link".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Could not protect agent storage")?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let lock = options
            .open(root.join("controller.lock"))
            .map_err(|_| "Could not open agent storage lock")?;
        lock.try_lock()
            .map_err(|_| "Another Buzz app owns this agent storage")?;
        let store = Self {
            root,
            _lock: lock,
            importing: Arc::default(),
        };
        store.read()?;
        Ok(store)
    }
    pub(crate) fn reserve_import(&self) -> Result<ImportReservation> {
        self.importing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Another import is in progress; wait for it to finish")?;
        Ok(ImportReservation(self.importing.clone()))
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    fn path(&self) -> PathBuf {
        self.root.join("agents.json")
    }
    fn read(&self) -> Result<Document> {
        let path = self.path();
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Document {
                    version: 1,
                    ..Document::default()
                });
            }
            Err(_) => return Err("Could not inspect saved agents".into()),
            Ok(meta) if !meta.is_file() || meta.len() > MAX_BYTES as u64 => {
                return Err("Saved agents must be a bounded regular file; left unchanged".into());
            }
            Ok(_) => {}
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
            .map_err(|_| "Could not read saved agents")?;
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read saved agents")?;
        if bytes.len() > MAX_BYTES {
            return Err("Saved agents exceed the size limit; left unchanged".into());
        }
        let doc: Document = serde_json::from_slice(&bytes)
            .map_err(|_| "Saved agents are malformed; left unchanged")?;
        validate(&doc)?;
        Ok(doc)
    }
    fn write(&self, doc: &Document) -> Result<()> {
        self.write_with_backup(doc, true)
    }
    fn write_with_backup(&self, doc: &Document, backup: bool) -> Result<()> {
        validate(doc)?;
        let bytes =
            serde_json::to_vec_pretty(doc).map_err(|_| "Could not encode agent settings")?;
        if bytes.len() > MAX_BYTES {
            return Err("Agent settings exceed the size limit".into());
        }
        // Validate/read first: never replace a newly corrupted file on a later save.
        let old = self.read()?;
        if backup && self.path().exists() {
            let backup =
                serde_json::to_vec_pretty(&old).map_err(|_| "Could not back up agent settings")?;
            atomic_write(&self.root.join("agents.previous.json"), &backup)?;
        } else if !backup {
            // A successful delete must not leave the removed settings in the
            // previous-version file. Clear it before replacing the live file.
            match fs::remove_file(self.root.join("agents.previous.json")) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Could not clear previous agent settings".into()),
            }
        }
        atomic_write(&self.path(), &bytes)
    }
    /// Saved agents and parked identities from one read of the document.
    pub(crate) fn inventory(&self) -> Result<(Vec<Agent>, Vec<ParkedIdentity>)> {
        let doc = self.read()?;
        Ok((doc.agents, doc.parked.into_values().collect()))
    }
    pub(crate) fn agents(&self) -> Result<Vec<Agent>> {
        Ok(self.read()?.agents)
    }
    /// Device-wide defaults; absent means the built-in Buzz Agent defaults.
    pub(crate) fn defaults(&self) -> Result<AgentDefaults> {
        let path = self.root.join("defaults.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AgentDefaults::default())
            }
            Err(_) => return Err("Could not inspect agent defaults".into()),
            Ok(meta) if !meta.is_file() || meta.len() > MAX_DEFAULTS_BYTES as u64 => {
                return Err("Agent defaults must be a bounded regular file; left unchanged".into())
            }
            Ok(_) => {}
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut bytes = Vec::new();
        options
            .open(path)
            .and_then(|file| {
                file.take((MAX_DEFAULTS_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
            })
            .map_err(|_| "Could not read agent defaults")?;
        if bytes.len() > MAX_DEFAULTS_BYTES {
            return Err("Agent defaults exceed the size limit; left unchanged".into());
        }
        let defaults: AgentDefaults = serde_json::from_slice(&bytes)
            .map_err(|_| "Agent defaults are malformed; left unchanged")?;
        defaults.validate()?;
        Ok(defaults)
    }
    /// Owner-only (0600) atomic replacement, like saved agents.
    pub(crate) fn save_defaults(&self, defaults: &AgentDefaults) -> Result<()> {
        defaults.validate()?;
        self.defaults()?;
        let bytes =
            serde_json::to_vec_pretty(defaults).map_err(|_| "Could not encode agent defaults")?;
        if bytes.len() > MAX_DEFAULTS_BYTES {
            return Err("Agent defaults exceed the size limit".into());
        }
        atomic_write(&self.root.join("defaults.json"), &bytes)
    }
    pub fn snapshot(&self) -> Result<crate::ControlSnapshot> {
        let defaults = self.defaults()?;
        let doc = self.read()?;
        Ok(crate::ControlSnapshot {
            agents: doc.agents.iter().map(|a| a.view(&defaults)).collect(),
            parked: doc.parked.into_values().collect(),
            runtime_available: false,
            runtime_message: Some("Native runtime has not been connected".into()),
            default_settings: defaults.view(),
        })
    }
    /// Mirror only safe metadata, independently per source. Each readable source
    /// replaces its own entries, and a missing source no longer lists anything; an
    /// identity with no remaining source leaves the inventory. A damaged source
    /// keeps its previous entries and never prevents managing existing agents.
    pub fn migrate_legacy(&mut self, parent: &Path) -> Vec<String> {
        let mut warnings = Vec::new();
        for source in [
            crate::LegacySource::Installed,
            crate::LegacySource::Development,
        ] {
            let path = parent
                .join(source.app_directory())
                .join("agents/managed-agents.json");
            let result = (|| -> Result<()> {
                let candidates = match fs::symlink_metadata(&path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                    _ => {
                        crate::Imports::default()
                            .preview(source, parent.into(), self.root.clone(), "")?
                            .candidates
                    }
                };
                let mut doc = self.read()?;
                let before = doc.parked.clone();
                let listed: std::collections::BTreeSet<_> =
                    candidates.iter().map(|c| c.pubkey.clone()).collect();
                for row in doc.parked.values_mut() {
                    if !listed.contains(&row.pubkey) {
                        row.sources.retain(|listed| *listed != source);
                    }
                }
                for candidate in candidates {
                    let row = doc
                        .parked
                        .entry(candidate.pubkey.clone())
                        .or_insert_with(|| ParkedIdentity {
                            pubkey: candidate.pubkey,
                            name: candidate.name,
                            sources: Vec::new(),
                        });
                    if !row.sources.contains(&source) {
                        row.sources.push(source);
                    }
                }
                doc.parked.retain(|_, row| !row.sources.is_empty());
                if doc.parked != before {
                    self.write(&doc)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                warnings.push(format!(
                    "Could not update inventory from {}: {error}",
                    source.app_directory()
                ));
            }
        }
        warnings
    }
    /// Configure retained custody, never reread the old installation or move it.
    pub fn use_here(&mut self, id: &str, resolution: crate::CommunityResolution) -> Result<()> {
        let mut doc = self.read()?;
        let source = doc
            .agents
            .iter()
            .find(|agent| agent.id == id)
            .cloned()
            .ok_or("Imported identity no longer exists")?;
        resolution.verify(source.auth_tag.as_deref().unwrap_or(""))?;
        if resolution.pubkey != source.pubkey {
            return Err("Use here must preserve the imported identity".into());
        }
        let target_id = crate::config::agent_id(&source.pubkey, &resolution.relay_url);
        if doc.agents.iter().any(|agent| {
            agent.pubkey == source.pubkey && agent.configured() && agent.id != target_id
        }) {
            return Err("This identity is already configured in another community. Clone it to create a new identity here.".into());
        }
        if let Some(target) = doc.agents.iter_mut().find(|agent| agent.id == target_id) {
            resolution.verify(target.auth_tag.as_deref().unwrap_or(""))?;
            if !target.configured() {
                // Setup completes custody only; starting remains a separate
                // explicit action, so drop any retained startup intent.
                target.extra.insert("configured".into(), Value::Bool(true));
                target.enabled = false;
                target.start_on_app_launch = Some(false);
                target.revision = target
                    .revision
                    .checked_add(1)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or("Agent revision exhausted")?;
            }
        } else {
            // Explicit owner-signed setup of an existing identity/community pair.
            // Keep the source setup and credential reference; the new pair starts stopped.
            let mut target = source.clone();
            target.id = target_id;
            target.relay_url = resolution.relay_url;
            target.enabled = false;
            target.start_on_app_launch = Some(false);
            target.revision = 1;
            target.extra.insert("configured".into(), Value::Bool(true));
            doc.agents.push(target);
        }
        self.write(&doc)
    }
    pub fn save(&mut self, id: &str, revision: u64, edit: AgentEdit) -> Result<()> {
        let mut doc = self.read()?;
        let agent = doc
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if agent.revision != revision {
            return Err(
                "Agent settings changed. Reload before saving; your draft was not applied".into(),
            );
        }
        agent.apply(edit)?;
        self.write(&doc)
    }
    pub(crate) fn remove(&mut self, id: &str, revision: u64) -> Result<()> {
        let mut doc = self.read()?;
        let index = doc
            .agents
            .iter()
            .position(|agent| agent.id == id)
            .ok_or("Agent no longer exists")?;
        if doc.agents[index].revision != revision {
            return Err("Agent settings changed. Reload before deleting".into());
        }
        doc.agents.remove(index);
        self.write_with_backup(&doc, false)
    }
    pub(crate) fn enabled(&mut self, id: &str, enabled: bool) -> Result<()> {
        let mut doc = self.read()?;
        let agent = doc
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if enabled && !agent.configured() {
            return Err("Choose Use here before starting this imported identity".into());
        }
        agent.enabled = enabled;
        self.write(&doc)
    }
    /// A launch preference, not a harness setting: the revision is unchanged.
    pub(crate) fn start_on_app_launch(&mut self, id: &str, value: bool) -> Result<()> {
        let mut doc = self.read()?;
        let agent = doc
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        agent.start_on_app_launch = Some(value);
        self.write(&doc)
    }
    pub(crate) fn profile_published(&mut self, id: &str, revision: u64) -> Result<()> {
        let mut doc = self.read()?;
        let agent = doc
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if agent.revision != revision {
            return Err("Saved settings changed; retry the profile".into());
        }
        agent.extra.remove("profilePending");
        self.write(&doc)
    }
    /// One atomic import batch; repairs add only the missing team snapshot.
    pub(crate) fn import(
        &mut self,
        agents: Vec<Agent>,
        repairs: Vec<(String, u64, String)>,
    ) -> Result<()> {
        let mut doc = self.read()?;
        for (id, revision, instructions) in repairs {
            let agent = doc
                .agents
                .iter_mut()
                .find(|agent| agent.id == id)
                .ok_or("Agent no longer exists; preview again")?;
            if agent.revision != revision || !agent.needs_team_import() {
                return Err("Agent settings changed; preview the team import again".into());
            }
            agent.imported["teamInstructions"] = Value::String(instructions);
            agent.revision = agent
                .revision
                .checked_add(1)
                .ok_or("Agent revision exhausted")?;
        }
        doc.agents.extend(agents);
        self.write(&doc)
    }
    pub(crate) fn insert(&mut self, agents: Vec<Agent>) -> Result<()> {
        let mut doc = self.read()?;
        doc.agents.extend(agents);
        self.write(&doc)
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        // fork/dup shares the lock's open-file description until exec/close.
        // Releasing only our descriptor can leave the profile spuriously owned.
        let _ = self._lock.unlock();
    }
}
fn validate(doc: &Document) -> Result<()> {
    if doc.version != 1 || doc.agents.len() > MAX_AGENTS {
        return Err("Unsupported agent storage version or size; left unchanged".into());
    }
    if doc.parked.len() > MAX_AGENTS
        || doc.parked.iter().any(|(key, row)| {
            key != &row.pubkey || !crate::config::canonical_key(key) || row.sources.is_empty()
        })
    {
        return Err("Invalid parked identity inventory; left unchanged".into());
    }
    let mut ids = BTreeSet::new();
    for agent in &doc.agents {
        agent.validate()?;
        if !ids.insert(&agent.id) {
            return Err("Duplicate saved agent identity; left unchanged".into());
        }
    }
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing agent storage directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Could not prepare agent settings write")?;
    temp.write_all(bytes)
        .map_err(|_| "Could not write agent settings")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "Could not sync agent settings")?;
    temp.persist(path)
        .map_err(|_| "Could not replace agent settings")?;
    // A successful rename is visible even if directory fsync fails. Surface that
    // uncertainty, do not claim that a failed return means nothing was persisted.
    #[cfg(unix)]
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| {
            "Settings were replaced but durability is uncertain; reload before retrying"
        })?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
