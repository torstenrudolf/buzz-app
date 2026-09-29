//! Installation and settings never execute plugin code. Both desktop and CLI use this crate.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub mod imports;

pub type Result<T> = std::result::Result<T, String>;
const LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub api_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<HostGrants>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostGrants {
    #[serde(default)]
    pub commands: Vec<HostCommand>,
    #[serde(default)]
    pub network_origins: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostCommand {
    pub id: String,
    pub program: String,
    pub args: Vec<String>,
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        valid_id(&self.id)?;
        if self.name.trim().is_empty() || self.name.len() > 80 {
            return Err("Name must contain 1–80 bytes of text".into());
        }
        if self.api_version != 1 {
            return Err("Only page plugin API version 1 is supported".into());
        }
        if let Some(host) = &self.host {
            if host.commands.len() > 16 || host.network_origins.len() > 16 {
                return Err("Too many host declarations".into());
            }
            let mut command_ids = std::collections::HashSet::new();
            for command in &host.commands {
                valid_id(&command.id)?;
                if !command_ids.insert(&command.id)
                    || command.program.is_empty()
                    || command.program.len() > 80
                    || !command.program.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
                    || command.args.len() > 16
                    || command
                        .args
                        .iter()
                        .any(|argument| argument.len() > 1024 || argument.contains('\0'))
                {
                    return Err("Invalid host command declaration".into());
                }
            }
            let mut origins = std::collections::HashSet::new();
            for origin in &host.network_origins {
                let url = url::Url::parse(origin).map_err(err)?;
                if url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.origin().ascii_serialization() != *origin
                    || !origins.insert(origin)
                {
                    return Err("Invalid HTTPS origin declaration".into());
                }
            }
        }
        Ok(())
    }
}
pub fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 80
        || !id.as_bytes()[0].is_ascii_lowercase()
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
        || id.split(['.', '-']).any(str::is_empty)
    {
        return Err("Invalid identifier (use lowercase letters, digits, dots or hyphens)".into());
    }
    Ok(())
}
pub fn bundled_manifests() -> Vec<Manifest> {
    vec![
        serde_json::from_str(include_str!("../../../src/bundled/todos/manifest.json"))
            .expect("todos manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/diffs/manifest.json"))
            .expect("bundled diffs manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/channel-templates/manifest.json"
        ))
        .expect("channel templates manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/identity-naming/manifest.json"
        ))
        .expect("identity naming manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/agent-activity/manifest.json"
        ))
        .expect("agent activity manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/terminal/manifest.json"))
            .expect("terminal manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/profiles/manifest.json"))
            .expect("valid bundled Profiles manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/links/manifest.json"))
            .expect("links manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/mentions/manifest.json"))
            .expect("mentions manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/emoji/manifest.json"))
            .expect("emoji manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/channels/manifest.json"))
            .expect("channels manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/github/manifest.json"))
            .expect("github manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/inbox/manifest.json"))
            .expect("valid Inbox manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/bestie/manifest.json"))
            .expect("bestie manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/projects/manifest.json"))
            .expect("projects manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/agents/manifest.json"))
            .expect("agents manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/workflows/manifest.json"))
            .expect("workflows manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/feedback/manifest.json"))
            .expect("feedback manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/sessions/manifest.json"))
            .expect("sessions manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/hosted-communities/manifest.json"
        ))
        .expect("hosted communities manifest"),
        serde_json::from_str(include_str!(
            "../../../src/bundled/moderation/manifest.json"
        ))
        .expect("moderation manifest"),
    ]
}
fn is_bundled(id: &str) -> bool {
    bundled_manifests().iter().any(|manifest| manifest.id == id)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installed {
    manifest: Manifest,
    current: String,
    #[serde(default)]
    current_source: Option<ReloadSource>,
    previous: Option<String>,
    #[serde(default)]
    previous_source: Option<ReloadSource>,
    enabled: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReloadSource {
    root: PathBuf,
    path: String,
}
impl ReloadSource {
    pub fn folder(root: PathBuf, path: String) -> Result<Self> {
        if !root.is_absolute() {
            return Err("Reload source root must be absolute".into());
        }
        validate_candidate_path(&path)?;
        Ok(Self { root, path })
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u32,
    bundled_enabled: bool,
    #[serde(default)]
    bundled_overrides: BTreeMap<String, bool>,
    installed: BTreeMap<String, Installed>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 1,
            bundled_enabled: true,
            bundled_overrides: BTreeMap::new(),
            installed: BTreeMap::new(),
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    manifest: Manifest,
    code: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: Manifest,
    pub source: &'static str,
    pub enabled: bool,
    pub revision: String,
    pub previous: Option<String>,
    pub reloadable: bool,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub profile: String,
    pub location: String,
    pub plugins: Vec<PluginInfo>,
}
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InstallationResult {
    Ready {
        catalog: Catalog,
        #[serde(rename = "externalPluginsPaused")]
        external_plugins_paused: bool,
    },
    Recovery {
        reason: String,
        #[serde(rename = "canReset")]
        can_reset: bool,
    },
}
#[derive(Clone)]
pub struct Manager {
    root: PathBuf,
    profile: String,
    safe_mode: bool,
}
impl Manager {
    pub fn open(home: Option<PathBuf>, profile: &str, safe_mode: bool) -> Result<Self> {
        valid_id(profile)?;
        let home = home
            .or_else(|| std::env::var_os("BUZZODZ_HOME").map(PathBuf::from))
            .or_else(|| dirs::data_dir().map(|p| p.join("dev.local.buzz.foundation")))
            .ok_or("Cannot determine application data directory; set BUZZODZ_HOME")?;
        if !home.is_absolute() {
            return Err("Plugin home must be an absolute path".into());
        }
        Ok(Self {
            root: home.join("profiles").join(profile),
            profile: profile.into(),
            safe_mode,
        })
    }
    pub fn from_env() -> Result<Self> {
        Self::open(
            None,
            &std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into()),
            std::env::var("BUZZODZ_SAFE_MODE").as_deref() == Ok("1"),
        )
    }
    fn lock(&self) -> Result<File> {
        fs::create_dir_all(&self.root).map_err(err)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("registry.lock"))
            .map_err(err)?;
        file.lock().map_err(err)?;
        Ok(file)
    }
    fn read(&self) -> Result<Registry> {
        let path = self.root.join("registry.json");
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Registry::default())
            }
            Err(error) => return Err(err(error)),
        };
        let text = read_file_limited(file)?;
        let r: Registry = serde_json::from_str(&text).map_err(err)?;
        if r.version != 1 {
            return Err(
                "Unsupported settings version; use a compatible Buzz or recover settings".into(),
            );
        }
        for (id, p) in &r.installed {
            p.manifest.validate()?;
            if *id != p.manifest.id || is_bundled(id) {
                return Err("Invalid installed plugin identity".into());
            }
            valid_hash(&p.current)?;
            if let Some(h) = &p.previous {
                valid_hash(h)?;
            }
        }
        Ok(r)
    }
    fn save(&self, r: &Registry) -> Result<()> {
        atomic_write(
            &self.root.join("registry.json"),
            &serde_json::to_vec_pretty(r).map_err(err)?,
        )
    }
    fn artifact_path(&self, id: &str, revision: &str) -> PathBuf {
        self.root
            .join("artifacts")
            .join(id)
            .join(format!("{revision}.json"))
    }
    fn artifact(&self, id: &str, revision: &str) -> Result<Artifact> {
        valid_id(id)?;
        valid_hash(revision)?;
        let text = read_limited(&self.artifact_path(id, revision))?;
        if hash(text.as_bytes()) != revision {
            return Err(
                "Installed artifact failed its integrity check; reinstall or roll back".into(),
            );
        }
        let a: Artifact = serde_json::from_str(&text).map_err(err)?;
        a.manifest.validate()?;
        if a.manifest.id != id {
            return Err("Artifact identity mismatch".into());
        }
        Ok(a)
    }
    pub fn external_plugins_paused(&self) -> bool {
        self.safe_mode
    }
    pub fn catalog(&self) -> Result<Catalog> {
        let registry = self.lock().and_then(|_lock| self.read())?;
        let mut plugins: Vec<PluginInfo> = bundled_manifests()
            .into_iter()
            .map(|manifest| {
                // Required even when an older profile saved a disabled override.
                let enabled = manifest.id == "buzz.channels"
                    || registry
                        .bundled_overrides
                        .get(&manifest.id)
                        .copied()
                        .unwrap_or(!matches!(
                            manifest.id.as_str(),
                            "buzz.channel-templates" | "buzz.todos"
                        ));
                PluginInfo {
                    manifest,
                    source: "bundled",
                    enabled,
                    revision: "bundled".into(),
                    previous: None,
                    reloadable: false,
                    error: None,
                }
            })
            .collect();
        for (id, p) in registry.installed {
            // Catalog polling stays cheap; verify content hashes before enabling/loading.
            let error = fs::metadata(self.artifact_path(&id, &p.current))
                .map_err(err)
                .err();
            plugins.push(PluginInfo {
                manifest: p.manifest,
                source: "external",
                enabled: p.enabled,
                revision: p.current,
                previous: p.previous,
                reloadable: p.current_source.is_some(),
                error,
            });
        }
        Ok(Catalog {
            profile: self.profile.clone(),
            location: self.root.display().to_string(),
            plugins,
        })
    }
    pub fn install(&self, directory: &Path) -> Result<Catalog> {
        let source = ReloadSource::folder(directory.canonicalize().map_err(err)?, ".".into())?;
        self.install_artifact(&prepare_artifact(directory)?, Some(source))
    }
    fn install_artifact(&self, bytes: &[u8], source: Option<ReloadSource>) -> Result<Catalog> {
        let Artifact { manifest, .. } = serde_json::from_slice(bytes).map_err(err)?;
        let revision = hash(bytes);
        {
            let _lock = self.lock()?;
            let mut registry = self.read()?;
            let old = registry.installed.get(&manifest.id);
            let (previous, previous_source) = old.map_or((None, None), |p| {
                if p.current == revision {
                    (p.previous.clone(), p.previous_source.clone())
                } else {
                    (Some(p.current.clone()), p.current_source.clone())
                }
            });
            let enabled = old.is_some_and(|p| p.enabled);
            atomic_write(&self.artifact_path(&manifest.id, &revision), bytes)?;
            registry.installed.insert(
                manifest.id.clone(),
                Installed {
                    manifest,
                    current: revision,
                    current_source: source,
                    previous,
                    previous_source,
                    enabled,
                },
            );
            self.save(&registry)?;
        }
        self.catalog()
    }
    pub fn change(&self, action: &str, id: &str) -> Result<Catalog> {
        valid_id(id)?;
        {
            let _lock = self.lock()?;
            let mut registry = self.read()?;
            if is_bundled(id) {
                match action {
                    "enable" => {
                        registry.bundled_overrides.insert(id.into(), true);
                    }
                    "disable" => {
                        if id == "buzz.channels" {
                            return Err("Channels is required and cannot be disabled".into());
                        }
                        registry.bundled_overrides.insert(id.into(), false);
                    }
                    _ => return Err("Bundled pages can only be enabled or disabled".into()),
                }
            } else {
                let p = registry
                    .installed
                    .get_mut(id)
                    .ok_or("Plugin is not installed")?;
                match action {
                    "enable" => {
                        self.artifact(id, &p.current)?;
                        p.enabled = true;
                    }
                    "disable" => p.enabled = false,
                    "remove" => {
                        registry.installed.remove(id);
                    }
                    "rollback" => {
                        let previous = p.previous.clone().ok_or("No previous revision")?;
                        let a = self.artifact(id, &previous)?;
                        let previous_source = p.previous_source.clone();
                        p.previous = Some(p.current.clone());
                        p.previous_source = p.current_source.clone();
                        p.current = previous;
                        p.current_source = previous_source;
                        p.manifest = a.manifest;
                    }
                    _ => return Err("Unknown management action".into()),
                }
            }
            self.save(&registry)?;
            if action == "remove" {
                // Commit removal first. A cleanup failure cannot re-enable the plugin.
                let path = self.root.join("artifacts").join(id);
                if path.exists() {
                    fs::remove_dir_all(path)
                        .map_err(|e| format!("Plugin removed, but artifact cleanup failed: {e}"))?;
                }
            }
        }
        self.catalog()
    }
    pub fn reload(&self, id: &str) -> Result<Catalog> {
        self.reload_with_commit_hook(id, || {})
    }
    fn reload_with_commit_hook(&self, id: &str, before_commit: impl FnOnce()) -> Result<Catalog> {
        valid_id(id)?;
        if is_bundled(id) {
            return Err("Bundled plugins cannot be reloaded from disk".into());
        }
        let snapshot = {
            let _lock = self.lock()?;
            let registry = self.read()?;
            let plugin = registry
                .installed
                .get(id)
                .ok_or("Plugin is not installed")?;
            if plugin.enabled {
                return Err("Disable the plugin before reloading it from disk".into());
            }
            let source = plugin
                .current_source
                .clone()
                .ok_or("Plugin was not installed from a reloadable folder")?;
            (
                plugin.current.clone(),
                source,
                plugin.manifest.id.clone(),
                plugin.manifest.host.clone().unwrap_or_default(),
            )
        };
        let bytes = prepare_reload_artifact(&snapshot.1)?;
        let Artifact { manifest, .. } = serde_json::from_slice(&bytes).map_err(err)?;
        if manifest.id != snapshot.2 {
            return Err("Reloaded plugin manifest ID changed; import it as a new plugin".into());
        }
        if manifest.host.clone().unwrap_or_default() != snapshot.3 {
            return Err("Host access changed; use Load from folder to review it".into());
        }
        let revision = hash(&bytes);
        before_commit();
        {
            let _lock = self.lock()?;
            let mut registry = self.read()?;
            let plugin = registry
                .installed
                .get_mut(id)
                .ok_or("Plugin is not installed")?;
            if plugin.enabled {
                return Err("Disable the plugin before reloading it from disk".into());
            }
            if plugin.current != snapshot.0 || plugin.current_source.as_ref() != Some(&snapshot.1) {
                return Err("Plugin changed while reload was reading from disk; try again".into());
            }
            let (previous, previous_source) = if plugin.current == revision {
                (plugin.previous.clone(), plugin.previous_source.clone())
            } else {
                (Some(plugin.current.clone()), plugin.current_source.clone())
            };
            atomic_write(&self.artifact_path(&manifest.id, &revision), &bytes)?;
            plugin.manifest = manifest;
            plugin.current = revision;
            plugin.current_source = Some(snapshot.1);
            plugin.previous = previous;
            plugin.previous_source = previous_source;
            self.save(&registry)?;
        }
        self.catalog()
    }
    pub fn module(&self, id: &str, revision: &str) -> Result<String> {
        Ok(self.current_artifact(id, revision)?.code)
    }
    pub fn host_grants(&self, id: &str, revision: &str) -> Result<HostGrants> {
        Ok(self
            .current_artifact(id, revision)?
            .manifest
            .host
            .unwrap_or_default())
    }
    fn current_artifact(&self, id: &str, revision: &str) -> Result<Artifact> {
        if self.safe_mode {
            return Err("External plugins are disabled in safe mode".into());
        }
        let _lock = self.lock()?;
        let r = self.read()?;
        let p = r.installed.get(id).ok_or("Plugin is not installed")?;
        if !p.enabled || p.current != revision {
            return Err("Plugin was disabled or updated; refresh the catalog".into());
        }
        self.artifact(id, revision)
    }
    pub fn recover(&self) -> Result<Catalog> {
        {
            let _lock = self.lock()?;
            let path = self.root.join("registry.json");
            if path.exists() {
                let mut backup = tempfile::Builder::new()
                    .prefix("registry-backup-")
                    .suffix(".json")
                    .tempfile_in(&self.root)
                    .map_err(err)?;
                std::io::copy(&mut File::open(&path).map_err(err)?, &mut backup).map_err(err)?;
                backup.as_file().sync_all().map_err(err)?;
                backup.keep().map_err(err)?;
            }
            self.save(&Registry::default())?;
        }
        self.catalog()
    }
}
fn prepare_artifact(directory: &Path) -> Result<Vec<u8>> {
    artifact_from_text(
        &read_limited(&directory.join("manifest.json"))?,
        read_limited(&directory.join("plugin.js"))?,
    )
}
fn prepare_reload_artifact(source: &ReloadSource) -> Result<Vec<u8>> {
    let relative = validate_candidate_path(&source.path)?;
    if !fs::symlink_metadata(&source.root)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("Reload source root must be a regular folder".into());
    }
    let directory = cap_std::fs::Dir::open_ambient_dir(&source.root, cap_std::ambient_authority())
        .map_err(err)?;
    artifact_from_text(
        &imports::read_source_file(&directory, &relative.join("manifest.json"))?,
        imports::read_source_file(&directory, &relative.join("plugin.js"))?,
    )
}
fn validate_candidate_path(path: &str) -> Result<PathBuf> {
    let path = path.trim();
    if path.is_empty() {
        return Err("Reload source path is empty".into());
    }
    if path == "." {
        return Ok(PathBuf::new());
    }
    let path = Path::new(path);
    if !path.is_relative() {
        return Err("Reload source path must be relative".into());
    }
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => relative.push(part),
            _ => return Err("Reload source path must stay inside its folder".into()),
        }
    }
    if relative.as_os_str().is_empty() {
        return Err("Reload source path is empty".into());
    }
    Ok(relative)
}
fn artifact_from_text(manifest: &str, code: String) -> Result<Vec<u8>> {
    let manifest: Manifest = serde_json::from_str(manifest).map_err(err)?;
    manifest.validate()?;
    if is_bundled(&manifest.id) {
        return Err("Cannot replace a bundled plugin".into());
    }
    if code.trim().is_empty() {
        return Err("Plugin module is empty".into());
    }
    let bytes = serde_json::to_vec(&Artifact { manifest, code }).map_err(err)?;
    if bytes.len() as u64 > LIMIT {
        return Err("Plugin artifact exceeds 8 MiB".into());
    }
    Ok(bytes)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn valid_hash(s: &str) -> Result<()> {
    if s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        Ok(())
    } else {
        Err("Invalid artifact revision".into())
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_limited(path: &Path) -> Result<String> {
    if !fs::symlink_metadata(path)
        .map_err(err)?
        .file_type()
        .is_file()
    {
        return Err("Plugin files must be regular files, not symbolic links".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(err)?;
    if !file.metadata().map_err(err)?.is_file() {
        return Err("Plugin files must be regular files".into());
    }
    read_file_limited(file)
}
fn read_file_limited(file: File) -> Result<String> {
    let mut text = String::new();
    file.take(LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(err)?;
    if text.len() as u64 > LIMIT {
        return Err("File exceeds 8 MiB".into());
    }
    Ok(text)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(err)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    temp.write_all(bytes).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(path).map_err(err)?;
    #[cfg(unix)]
    File::open(parent).map_err(err)?.sync_all().map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{artifact_from_text, Manager, Manifest};
    use std::fs;

    #[test]
    fn validates_host_declarations_and_old_manifests() {
        let old: Manifest =
            serde_json::from_str(r#"{"id":"example.page","name":"Example","apiVersion":1}"#)
                .unwrap();
        assert_eq!(old.host, None);
        assert!(old.validate().is_ok());
        assert!(!serde_json::to_string(&old).unwrap().contains("host"));
        let manifest = serde_json::json!({
            "id": "example.page", "name": "Example", "apiVersion": 1,
            "host": {
                "commands": [{"id":"status","program":"example-cli","args":["status"]}],
                "networkOrigins": ["https://api.example.com"]
            }
        });
        assert!(artifact_from_text(&manifest.to_string(), "export const x = 1".into()).is_ok());
        for invalid_origin in [
            "http://api.example.com",
            "https://api.example.com/path",
            "https://user@api.example.com",
            "https://api.example.com:443",
        ] {
            let mut invalid = manifest.clone();
            invalid["host"]["networkOrigins"] = serde_json::json!([invalid_origin]);
            assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        }
        let mut invalid = manifest.clone();
        invalid["host"]["commands"][0]["program"] = serde_json::json!("/bin/sh");
        assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
        let mut invalid = manifest.clone();
        invalid["host"]["commands"]
            .as_array_mut()
            .unwrap()
            .push(manifest["host"]["commands"][0].clone());
        assert!(artifact_from_text(&invalid.to_string(), "export const x = 1".into()).is_err());
    }

    #[test]
    fn host_grants_follow_enabled_current_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("build");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1,"host":{"commands":[{"id":"first","program":"example-cli","args":["status"]}],"networkOrigins":["https://one.example"]}}"#,
        )
        .unwrap();
        let first = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap()
            .revision;
        assert!(manager.host_grants("example.page", &first).is_err());
        manager.change("enable", "example.page").unwrap();
        assert_eq!(
            manager
                .host_grants("example.page", &first)
                .unwrap()
                .commands[0]
                .id,
            "first"
        );

        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1,"host":{"commands":[{"id":"second","program":"example-cli","args":["status","--json"]}],"networkOrigins":["https://two.example"]}}"#,
        )
        .unwrap();
        let second = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap()
            .revision;
        assert!(manager.host_grants("example.page", &first).is_err());
        let grants = manager.host_grants("example.page", &second).unwrap();
        assert_eq!(grants.commands[0].id, "second");
        assert_eq!(grants.network_origins, ["https://two.example"]);
        manager.change("disable", "example.page").unwrap();
        assert!(manager.host_grants("example.page", &second).is_err());
    }

    #[test]
    fn reload_rejects_changed_host_grants_before_enable() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("build");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
        )
        .unwrap();
        let first = manager
            .install(&source)
            .unwrap()
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap()
            .revision
            .clone();

        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1,"host":{"commands":[{"id":"status","program":"example-cli","args":["status"]}]}}"#,
        )
        .unwrap();
        let error = match manager.reload("example.page") {
            Ok(_) => panic!("reload should reject changed host grants"),
            Err(error) => error,
        };
        assert!(error.contains("Load from folder"));

        let catalog = manager.catalog().unwrap();
        let plugin = catalog
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap();
        assert_eq!(plugin.revision, first);
        assert!(plugin.previous.is_none());
        manager.change("enable", "example.page").unwrap();
        assert!(manager
            .host_grants("example.page", &first)
            .unwrap()
            .commands
            .is_empty());
    }

    #[test]
    fn optional_plugins_default_off_and_preserve_explicit_overrides() {
        for id in ["buzz.todos", "buzz.channel-templates"] {
            let temp = tempfile::tempdir().unwrap();
            let manager = Manager::open(Some(temp.path().into()), "optional-test", false).unwrap();
            let enabled = |manager: &Manager| {
                manager
                    .catalog()
                    .unwrap()
                    .plugins
                    .into_iter()
                    .find(|plugin| plugin.manifest.id == id)
                    .unwrap()
                    .enabled
            };
            assert!(!enabled(&manager), "{id} defaults off");
            manager.change("enable", id).unwrap();
            let reopened = Manager::open(Some(temp.path().into()), "optional-test", false).unwrap();
            assert!(enabled(&reopened), "{id} retains enable after reopening");
            reopened.change("disable", id).unwrap();
            assert!(!enabled(&manager), "{id} exposes persisted disable");
        }
    }

    #[test]
    fn reload_rejects_enable_between_disk_read_and_commit() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("build");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
        )
        .unwrap();
        fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        let first = manager
            .install(&source)
            .unwrap()
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap()
            .revision
            .clone();
        fs::write(source.join("plugin.js"), "export const reloaded = true;").unwrap();

        let error = match manager.reload_with_commit_hook("example.page", || {
            manager.change("enable", "example.page").unwrap();
        }) {
            Ok(_) => panic!("reload should reject an enabled plugin at commit"),
            Err(error) => error,
        };

        assert!(error.contains("Disable the plugin before reloading"));
        let catalog = manager.catalog().unwrap();
        let plugin = catalog
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == "example.page")
            .unwrap();
        assert!(plugin.enabled);
        assert_eq!(plugin.revision, first);
        assert_eq!(plugin.previous, None);
    }
}
