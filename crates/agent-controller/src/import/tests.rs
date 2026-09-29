use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
#[derive(Default)]
struct Memory {
    keys: Mutex<BTreeMap<String, String>>,
    reads: AtomicUsize,
    fail: bool,
    sources: Mutex<Vec<LegacySource>>,
    expected_source: Option<LegacySource>,
}
impl Credentials for Memory {
    fn delete(&self, id: &str, _: &str) -> Result<()> {
        self.keys.lock().unwrap().remove(id);
        Ok(())
    }
    fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.sources.lock().unwrap().push(source);
        if self
            .expected_source
            .is_some_and(|expected| expected != source)
        {
            return Err("Selected fixture credential is absent".into());
        }
        Secret::parse(KEY, pubkey)
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        self.keys
            .lock()
            .unwrap()
            .get(id)
            .map(|key| Secret::parse(key, pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        if self.fail {
            return Err("Test credential store refused".into());
        }
        let mut keys = self.keys.lock().unwrap();
        if keys.contains_key(id) {
            return Err("Already exists".into());
        }
        keys.insert(id.into(), key.hex().to_string());
        Ok(())
    }
}
fn source(root: &Path) -> Vec<u8> {
    let root = root.join(LegacySource::Installed.app_directory());
    fs::create_dir_all(root.join("agents")).unwrap();
    let records = json!([
        {"pubkey":"", "slug":"brain", "system_prompt":"definition-prompt", "model":"definition-model", "runtime":"buzz-agent", "env_vars":{"DEF_VALUE":"definition"}},
        {"pubkey":PUB, "relay_url":"https://RELAY.example/", "name":"Brain", "persona_id":"brain", "system_prompt":"stale-prompt", "model":"stale-model", "agent_command":"goose", "agent_args":[], "auth_tag":"attestation", "env_vars":{"PRIVATE_PROVIDER_TOKEN":"never-project"}, "future":{"preserve":true}, "start_on_app_launch":true}
    ]);
    let bytes = serde_json::to_vec(&records).unwrap();
    fs::write(root.join("agents/managed-agents.json"), &bytes).unwrap();
    fs::write(
        root.join("agents/global-agent-config.json"),
        br#"{"provider":"global-provider","env_vars":{"GLOBAL_VALUE":"global"}}"#,
    )
    .unwrap();
    bytes
}
#[test]
fn preview_is_keyless_commit_resolves_preserves_and_never_enables_or_mutates_source() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let before = source(old.path());
    let mut imports = Imports::default();
    let keys = Memory::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://relay.example",
        )
        .unwrap();
    let serialized = serde_json::to_string(&preview).unwrap();
    for hidden in [
        "never-project",
        "definition-prompt",
        "attestation",
        "global-provider",
    ] {
        assert!(!serialized.contains(hidden));
    }
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    let mut store = Store::open(dest.path().into()).unwrap();
    imports
        .commit(
            &preview.token,
            &[preview.candidates[0].id.clone()],
            &mut store,
            &keys,
        )
        .unwrap();
    let saved = &store.agents().unwrap()[0];
    assert_eq!(saved.pubkey, PUB);
    assert!(!saved.enabled);
    // Source `start_on_app_launch: true` does not auto-start an imported record.
    assert_eq!(saved.start_on_app_launch, Some(false));
    assert!(saved.configured());
    assert_eq!(saved.relay_url, "wss://relay.example");
    assert_eq!(saved.system_prompt, "definition-prompt");
    assert_eq!(saved.harness.model, "definition-model");
    assert_eq!(saved.harness.provider, "global-provider");
    assert_eq!(saved.harness.command, "buzz-agent");
    assert_eq!(saved.environment.len(), 3);
    assert_eq!(saved.imported["record"]["future"]["preserve"], true);
    assert_eq!(saved.auth_tag.as_deref(), Some("attestation"));
    assert_eq!(
        fs::read(
            old.path()
                .join(LegacySource::Installed.app_directory())
                .join("agents/managed-agents.json")
        )
        .unwrap(),
        before
    );
    assert_eq!(keys.reads.load(Ordering::SeqCst), 1);
    let snapshot = serde_json::to_string(&store.snapshot().unwrap()).unwrap();
    assert!(!snapshot.contains("never-project"));
    assert!(!snapshot.contains(KEY));
    assert!(imports
        .commit(
            &preview.token,
            std::slice::from_ref(&saved.id),
            &mut store,
            &keys
        )
        .is_err());
}
#[test]
fn changed_source_duplicate_selection_and_credential_failure_do_not_commit() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let mut imports = Imports::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://relay.example",
        )
        .unwrap();
    let id = preview.candidates[0].id.clone();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    assert!(imports
        .commit(&preview.token, &[id.clone(), id.clone()], &mut store, &keys)
        .is_err());
    fs::write(
        old.path()
            .join(LegacySource::Installed.app_directory())
            .join("agents/global-agent-config.json"),
        b"{}",
    )
    .unwrap();
    assert!(imports
        .commit(&preview.token, std::slice::from_ref(&id), &mut store, &keys)
        .unwrap_err()
        .contains("Source changed"));
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://relay.example",
        )
        .unwrap();
    let unavailable = Memory {
        fail: true,
        ..Default::default()
    };
    assert!(imports
        .commit(&preview.token, &[id], &mut store, &unavailable)
        .is_err());
    assert!(store.agents().unwrap().is_empty());
}
#[test]
fn inline_key_is_verified_and_not_copied_to_native_config() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    let mut records: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    records[1]["private_key_nsec"] = json!(KEY);
    fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
    let mut imports = Imports::default();
    let keys = Memory::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://relay.example",
        )
        .unwrap();
    let mut store = Store::open(dest.path().into()).unwrap();
    imports
        .commit(
            &preview.token,
            &[preview.candidates[0].id.clone()],
            &mut store,
            &keys,
        )
        .unwrap();
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(
        !String::from_utf8(fs::read(dest.path().join("agents.json")).unwrap())
            .unwrap()
            .contains(KEY)
    );
    assert!(Secret::parse(KEY, &"aa".repeat(32)).is_err());
}
#[test]
fn orphan_or_reserved_env_refuses_before_any_key_read() {
    for update in [
        json!({"persona_id":"missing"}),
        json!({"env_vars":{"BUZZ_MANAGED_AGENT":"old-owner"}}),
    ] {
        let old = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        source(old.path());
        let path = old
            .path()
            .join(LegacySource::Installed.app_directory())
            .join("agents/managed-agents.json");
        let mut records: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for (k, v) in update.as_object().unwrap() {
            records[1][k] = v.clone();
        }
        fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
        let mut imports = Imports::default();
        let keys = Memory::default();
        let preview = imports
            .preview(
                LegacySource::Installed,
                old.path().into(),
                dest.path().into(),
                "wss://relay.example",
            )
            .unwrap();
        let mut store = Store::open(dest.path().into()).unwrap();
        assert!(imports
            .commit(
                &preview.token,
                &[preview.candidates[0].id.clone()],
                &mut store,
                &keys
            )
            .is_err());
        assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn chosen_source_binds_config_and_credentials_without_fallback() {
    for selected in [LegacySource::Installed, LegacySource::Development] {
        let old = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        source(old.path());
        let development = old.path().join(LegacySource::Development.app_directory());
        fs::create_dir_all(development.join("agents")).unwrap();
        fs::write(
            development.join("agents/managed-agents.json"),
            serde_json::to_vec(&json!([
                {"pubkey": PUB, "relay_url": "wss://development.example", "name": "Development"}
            ]))
            .unwrap(),
        )
        .unwrap();
        let mut imports = Imports::default();
        let preview = imports
            .preview(
                selected,
                old.path().into(),
                dest.path().into(),
                "wss://chosen.example",
            )
            .unwrap();
        assert!(preview.source_path.contains(selected.app_directory()));
        assert_eq!(preview.candidates[0].relay_url, "wss://chosen.example");
        let mut store = Store::open(dest.path().into()).unwrap();
        let other = match selected {
            LegacySource::Installed => LegacySource::Development,
            LegacySource::Development => LegacySource::Installed,
        };
        let keys = Memory {
            expected_source: Some(other),
            ..Default::default()
        };
        // Another service could satisfy this key, but it must never be consulted.
        assert!(imports
            .commit(
                &preview.token,
                &[preview.candidates[0].id.clone()],
                &mut store,
                &keys
            )
            .is_err());
        assert_eq!(*keys.sources.lock().unwrap(), vec![selected]);
        assert!(store.agents().unwrap().is_empty());
        let keys = Memory {
            expected_source: Some(selected),
            ..Default::default()
        };
        imports
            .commit(
                &preview.token,
                &[preview.candidates[0].id.clone()],
                &mut store,
                &keys,
            )
            .unwrap();
        assert_eq!(*keys.sources.lock().unwrap(), vec![selected]);
        assert_eq!(
            store.agents().unwrap()[0].relay_url,
            preview.candidates[0].relay_url
        );
    }
    assert_eq!(LegacySource::Installed.keyring_service(), "buzz-desktop");
    assert_eq!(
        LegacySource::Development.keyring_service(),
        "buzz-desktop-dev"
    );
}

#[test]
fn changed_source_during_credential_acquisition_never_commits_settings() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let mut imports = Imports::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://relay.example",
        )
        .unwrap();
    let mut store = Store::open(dest.path().into()).unwrap();
    let prepared = imports
        .prepare(&preview.token, &[preview.candidates[0].id.clone()], &store)
        .unwrap();
    let credentials = Memory::default();
    let acquired = prepared.acquire(&credentials).unwrap();
    fs::write(
        old.path()
            .join(LegacySource::Installed.app_directory())
            .join("agents/global-agent-config.json"),
        "{}",
    )
    .unwrap();
    assert!(acquired
        .commit(&mut store)
        .unwrap_err()
        .contains("Source changed"));
    assert!(store.agents().unwrap().is_empty());
    // Create-only app custody can remain after a cancelled/failed import; never
    // delete keys that a prior successful import may already reference.
    assert_eq!(credentials.keys.lock().unwrap().len(), 1);
}

#[test]
fn explicit_destination_replaces_legacy_pins_without_hiding_keys_or_reading_credentials() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    let pins = [
        Value::Null,
        json!(""),
        json!("  "),
        json!("not a URL"),
        json!("ws://insecure.example"),
        json!("wss://raw.example/path"),
        json!("wss://raw.example?private=query"),
        json!("wss://user:secret@raw.example"),
        json!("wss://stale.example"),
    ];
    let mut records = vec![json!({"pubkey":"", "slug":"keyless", "relay_url":""})];
    for (index, pin) in pins.iter().enumerate() {
        let mut record = json!({"pubkey": if index == 0 { PUB.into() } else { format!("{:064x}", index + 100) },
            "name":format!("Agent {index}"), "private_key_nsec":KEY, "system_prompt":"private-prompt"});
        if !pin.is_null() {
            record["relay_url"] = pin.clone();
        }
        records.push(record);
    }
    let bytes = serde_json::to_vec(&records).unwrap();
    fs::write(&path, &bytes).unwrap();
    let mut imports = Imports::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "https://CHOSEN.example/",
        )
        .unwrap();
    assert_eq!(preview.candidates.len(), pins.len());
    for candidate in &preview.candidates {
        assert_eq!(candidate.relay_url, "wss://chosen.example");
        assert_eq!(
            candidate.id,
            agent_id(&candidate.pubkey, "wss://chosen.example")
        );
    }
    let serialized = serde_json::to_string(&preview).unwrap();
    for hidden in [
        "raw.example",
        "insecure.example",
        "stale.example",
        "not a URL",
        "private-prompt",
        KEY,
    ] {
        assert!(!serialized.contains(hidden));
    }
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    // A missing legacy pin is ordinary source data, not a reason to skip this key.
    let selected = &preview.candidates[0];
    imports
        .commit(
            &preview.token,
            std::slice::from_ref(&selected.id),
            &mut store,
            &keys,
        )
        .unwrap();
    let saved = &store.agents().unwrap()[0];
    assert_eq!(saved.pubkey, PUB);
    assert_eq!(saved.relay_url, "wss://chosen.example");
    assert_eq!(saved.id, selected.id);
    assert_eq!(saved.credential_id, selected.id);
    assert!(!saved.enabled);
    assert_eq!(keys.keys.lock().unwrap().len(), 1);
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn commit_routes_blank_malformed_and_valid_stale_pins_only_to_the_confirmed_destination() {
    for pin in [
        "",
        "ws://insecure.example",
        "wss://stale.example",
        "wss://user:secret@raw.example/path?token=private",
    ] {
        let old = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        source(old.path());
        let path = old
            .path()
            .join(LegacySource::Installed.app_directory())
            .join("agents/managed-agents.json");
        let bytes =
            serde_json::to_vec(&json!([{"pubkey": PUB, "name":"Selected", "relay_url":pin}]))
                .unwrap();
        fs::write(&path, &bytes).unwrap();
        let mut imports = Imports::default();
        let keys = Memory::default();
        let mut store = Store::open(dest.path().into()).unwrap();
        let a = imports
            .preview(
                LegacySource::Installed,
                old.path().into(),
                dest.path().into(),
                "wss://first.example",
            )
            .unwrap();
        let b = imports
            .preview(
                LegacySource::Installed,
                old.path().into(),
                dest.path().into(),
                "https://CONFIRMED.example/",
            )
            .unwrap();
        assert_ne!(a.token, b.token);
        // An old token must not authorize even IDs from the new preview.
        assert!(imports
            .commit(&a.token, &[b.candidates[0].id.clone()], &mut store, &keys)
            .is_err());
        assert!(imports
            .commit(&a.token, &[a.candidates[0].id.clone()], &mut store, &keys)
            .is_err());
        assert!(imports
            .commit(&b.token, &[a.candidates[0].id.clone()], &mut store, &keys)
            .is_err());
        assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
        assert!(keys.keys.lock().unwrap().is_empty());
        imports
            .commit(&b.token, &[b.candidates[0].id.clone()], &mut store, &keys)
            .unwrap();
        let saved = &store.agents().unwrap()[0];
        assert_eq!(saved.relay_url, "wss://confirmed.example");
        assert_eq!(saved.id, agent_id(PUB, "wss://confirmed.example"));
        assert_eq!(saved.credential_id, saved.id);
        assert_eq!(saved.imported["record"]["relay_url"], pin);
        assert!(!saved.enabled);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn invalid_destination_discards_pending_without_echoing_inputs_or_acquiring_keys() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let bytes = source(old.path());
    let mut imports = Imports::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    for invalid in [
        " ",
        "not a URL",
        "ws://raw.example",
        "http://raw.example",
        "wss://user:secret@raw.example",
        "wss://raw.example/path",
        "wss://raw.example?token=private",
        "wss://raw.example#private",
    ] {
        let prior = imports
            .preview(
                LegacySource::Installed,
                old.path().into(),
                dest.path().into(),
                "wss://chosen.example",
            )
            .unwrap();
        assert_eq!(
            imports
                .preview(
                    LegacySource::Installed,
                    old.path().into(),
                    dest.path().into(),
                    invalid
                )
                .err()
                .unwrap(),
            "Choose a secure community origin without credentials, path or query"
        );
        assert!(imports
            .commit(
                &prior.token,
                &[prior.candidates[0].id.clone()],
                &mut store,
                &keys
            )
            .is_err());
    }
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert!(store.agents().unwrap().is_empty());
    assert_eq!(
        fs::read(
            old.path()
                .join(LegacySource::Installed.app_directory())
                .join("agents/managed-agents.json")
        )
        .unwrap(),
        bytes
    );
}

#[test]
fn duplicate_keys_ignore_pin_differences_and_source_pin_changes_still_invalidate() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    let mut imports = Imports::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    for other_pin in ["", "wss://stale.example", "wss://different.example"] {
        fs::write(&path, serde_json::to_vec(&json!([
            {"pubkey":PUB,"relay_url":"wss://stale.example"}, {"pubkey":PUB,"relay_url":other_pin}
        ])).unwrap()).unwrap();
        assert_eq!(
            imports
                .preview(
                    LegacySource::Installed,
                    old.path().into(),
                    dest.path().into(),
                    "wss://chosen.example"
                )
                .err()
                .unwrap(),
            "Source contains duplicate agent identities"
        );
    }
    let mut records = json!([{"pubkey":PUB,"relay_url":""}]);
    fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://chosen.example",
        )
        .unwrap();
    records[0]["relay_url"] = json!("wss://ignored-but-changed.example");
    fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
    assert!(imports
        .commit(
            &preview.token,
            &[preview.candidates[0].id.clone()],
            &mut store,
            &keys
        )
        .unwrap_err()
        .contains("Source changed"));
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert!(store.agents().unwrap().is_empty());
}

fn team_source(root: &Path, instructions: Value) -> PathBuf {
    source(root);
    let root = root.join(LegacySource::Installed.app_directory());
    let path = root.join("agents/managed-agents.json");
    let mut records: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    records[1]["team_id"] = json!("crew");
    records[1]["backend"] = json!({"type":"local"});
    fs::write(path, serde_json::to_vec(&records).unwrap()).unwrap();
    let teams = root.join("agents/teams.json");
    fs::write(
        &teams,
        serde_json::to_vec(&json!([{"id":"crew","instructions":instructions}])).unwrap(),
    )
    .unwrap();
    teams
}
fn team_preview(imports: &mut Imports, old: &Path, workspace: &Path) -> ImportPreview {
    imports
        .preview(
            LegacySource::Installed,
            old.into(),
            workspace.into(),
            "wss://relay.example",
        )
        .unwrap()
}
#[test]
fn team_import_snapshots_instructions_and_fences_both_source_changes() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let teams = team_source(old.path(), json!("  team prompt\n"));
    let before = fs::read(&teams).unwrap();
    let mut imports = Imports::default();
    let keys = Memory::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let preview = team_preview(&mut imports, old.path(), dest.path());
    let ids = [preview.candidates[0].id.clone()];
    assert!(!serde_json::to_string(&preview)
        .unwrap()
        .contains("team prompt"));
    fs::write(&teams, b"[]").unwrap();
    assert!(imports
        .prepare(&preview.token, &ids, &store)
        .err()
        .unwrap()
        .contains("Source changed"));
    fs::write(&teams, &before).unwrap();
    let prepared = imports
        .prepare(&preview.token, &ids, &store)
        .unwrap()
        .acquire(&keys)
        .unwrap();
    fs::write(&teams, b"[]").unwrap();
    assert!(prepared
        .commit(&mut store)
        .unwrap_err()
        .contains("Source changed"));
    assert!(store.agents().unwrap().is_empty());
    fs::write(&teams, &before).unwrap();
    imports
        .commit(&preview.token, &ids, &mut store, &keys)
        .unwrap();
    let agent = &store.agents().unwrap()[0];
    assert_eq!(agent.imported["teamInstructions"], "team prompt");
    assert_eq!(agent.imported["record"]["team_id"], "crew");
    assert!(!agent.needs_team_import());
    assert!(!agent.enabled);
    assert_eq!(fs::read(teams).unwrap(), before);
}
#[test]
fn repair_only_adds_team_snapshot_without_keys_or_overwriting_edits() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(old.path(), json!("team prompt"));
    let mut imports = Imports::default();
    let keys = Memory::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let preview = team_preview(&mut imports, old.path(), dest.path());
    let ids = [preview.candidates[0].id.clone()];
    let data = read_source(&old.path().join(LegacySource::Installed.app_directory())).unwrap();
    let mut agent = resolve(&data, &data.records[1], dest.path(), "wss://relay.example").unwrap();
    agent
        .imported
        .as_object_mut()
        .unwrap()
        .remove("teamInstructions");
    agent.name = "Edited name".into();
    agent.harness.model = "edited-model".into();
    agent.environment.insert("KEEP".into(), "private".into());
    agent.enabled = true;
    assert!(agent.view(&Default::default()).needs_team_import);
    let mut expected = serde_json::to_value(&agent).unwrap();
    expected["revision"] = json!(2);
    expected["imported"]["teamInstructions"] = json!("team prompt");
    store.insert(vec![agent]).unwrap();
    let prepared = imports.prepare(&preview.token, &ids, &store).unwrap();
    // Stop is allowed during an import wait; repair must not re-enable it.
    store.enabled(&ids[0], false).unwrap();
    expected["enabled"] = json!(false);
    prepared.acquire(&keys).unwrap().commit(&mut store).unwrap();
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(&store.agents().unwrap()[0]).unwrap(),
        expected
    );
    assert!(imports.prepare(&preview.token, &ids, &store).is_err());
}
#[test]
fn repair_refuses_changed_settings_and_wrong_source_team_binding() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(old.path(), json!("team prompt"));
    let mut imports = Imports::default();
    let keys = Memory::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let data = read_source(&old.path().join(LegacySource::Installed.app_directory())).unwrap();
    let mut agent = resolve(&data, &data.records[1], dest.path(), "wss://relay.example").unwrap();
    agent
        .imported
        .as_object_mut()
        .unwrap()
        .remove("teamInstructions");
    let ids = [agent.id.clone()];
    store.insert(vec![agent.clone()]).unwrap();
    let preview = team_preview(&mut imports, old.path(), dest.path());
    let prepared = imports
        .prepare(&preview.token, &ids, &store)
        .unwrap()
        .acquire(&keys)
        .unwrap();
    let mut doc: Value =
        serde_json::from_slice(&fs::read(dest.path().join("agents.json")).unwrap()).unwrap();
    doc["agents"][0]["revision"] = json!(2);
    fs::write(
        dest.path().join("agents.json"),
        serde_json::to_vec(&doc).unwrap(),
    )
    .unwrap();
    assert!(prepared
        .commit(&mut store)
        .unwrap_err()
        .contains("settings changed"));
    assert!(store.agents().unwrap()[0].needs_team_import());
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    let mut records: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    records[1]["team_id"] = json!("different");
    fs::write(path, serde_json::to_vec(&records).unwrap()).unwrap();
    let preview = team_preview(&mut imports, old.path(), dest.path());
    assert!(imports
        .prepare(&preview.token, &ids, &store)
        .err()
        .unwrap()
        .contains("binding differs"));
}
#[test]
fn team_snapshot_handles_empty_deleted_and_invalid_teams() {
    let old = tempfile::tempdir().unwrap();
    let teams = team_source(old.path(), json!("   "));
    let root = old.path().join(LegacySource::Installed.app_directory());
    let data = read_source(&root).unwrap();
    assert_eq!(team_instructions(&data, &data.records[1]).unwrap(), "");
    fs::remove_file(&teams).unwrap();
    let data = read_source(&root).unwrap();
    assert_eq!(team_instructions(&data, &data.records[1]).unwrap(), "");
    // A directory-only legacy binding does not resolve instructions in old Buzz.
    assert_eq!(
        team_instructions(&data, &json!({"persona_team_dir":"/old/pack"})).unwrap(),
        ""
    );
    for value in [json!({}), json!([{"id":"crew"},{"id":"crew"}])] {
        fs::write(&teams, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_source(&root).is_err());
    }
    for value in [
        json!(4),
        json!("nul\0text"),
        json!("x".repeat(128 * 1024 + 1)),
    ] {
        fs::write(
            &teams,
            serde_json::to_vec(&json!([{"id":"crew","instructions":value}])).unwrap(),
        )
        .unwrap();
        let data = read_source(&root).unwrap();
        assert!(team_instructions(&data, &data.records[1]).is_err());
    }
}
#[test]
fn local_browse_without_destination_cannot_commit_or_reuse_prior_authority() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let bytes = source(old.path());
    let mut imports = Imports::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    let prior = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://chosen.example",
        )
        .unwrap();
    let browse = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "",
        )
        .unwrap();
    assert_eq!(browse.candidates.len(), 1);
    assert_eq!(browse.candidates[0].pubkey, PUB);
    assert!(browse.candidates[0].relay_url.is_empty());
    assert!(browse.token.is_empty());
    for (token, id) in [
        (&browse.token, &browse.candidates[0].id),
        (&prior.token, &prior.candidates[0].id),
    ] {
        assert!(imports
            .commit(token, std::slice::from_ref(id), &mut store, &keys)
            .is_err());
    }
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert!(store.agents().unwrap().is_empty());
    assert_eq!(
        fs::read(
            old.path()
                .join(LegacySource::Installed.app_directory())
                .join("agents/managed-agents.json")
        )
        .unwrap(),
        bytes
    );
    let serialized = serde_json::to_string(&browse).unwrap();
    assert!(!serialized.contains("private_key"));
}

#[test]
fn clone_settings_projects_only_reviewed_text_without_source_or_credential_writes() {
    let old = tempfile::tempdir().unwrap();
    let before = source(old.path());
    let settings =
        Imports::clone_settings(LegacySource::Installed, old.path().into(), PUB).unwrap();
    assert_eq!(
        serde_json::to_value(settings).unwrap(),
        json!({
            "name": "Brain", "systemPrompt": "definition-prompt"
        })
    );
    assert_eq!(
        fs::read(
            old.path()
                .join(LegacySource::Installed.app_directory())
                .join("agents/managed-agents.json")
        )
        .unwrap(),
        before
    );
    assert!(Imports::clone_settings(LegacySource::Development, old.path().into(), PUB).is_err());
    assert!(
        Imports::clone_settings(LegacySource::Installed, old.path().into(), "../path").is_err()
    );
    assert!(
        Imports::clone_settings(LegacySource::Installed, old.path().into(), &"ab".repeat(32))
            .is_err()
    );
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    let mut records: Vec<Value> = serde_json::from_slice(&before).unwrap();
    records.push(records[1].clone());
    fs::write(path, serde_json::to_vec(&records).unwrap()).unwrap();
    assert!(Imports::clone_settings(LegacySource::Installed, old.path().into(), PUB).is_err());
}

#[test]
fn parked_migration_is_keyless_idempotent_and_follows_source_removal() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let before = source(old.path());
    let source_path = old.path().join(LegacySource::Installed.app_directory());
    let mut store = Store::open(dest.path().into()).unwrap();
    assert!(store.migrate_legacy(old.path()).is_empty());
    let saved = fs::read(dest.path().join("agents.json")).unwrap();
    assert!(store.migrate_legacy(old.path()).is_empty());
    assert_eq!(saved, fs::read(dest.path().join("agents.json")).unwrap());
    assert!(!dest.path().join("agents.previous.json").exists());
    let snapshot = store.snapshot().unwrap();
    assert!(snapshot.agents.is_empty()); // Nothing can be started/restored.
    assert_eq!(snapshot.parked.len(), 1);
    assert_eq!(snapshot.parked[0].pubkey, PUB);
    assert_eq!(snapshot.parked[0].sources, vec![LegacySource::Installed]);
    let text = String::from_utf8(saved).unwrap();
    for hidden in [
        "never-project",
        "definition-prompt",
        "attestation",
        "relay.example",
        "start_on_app_launch",
    ] {
        assert!(!text.contains(hidden));
    }
    assert_eq!(
        fs::read(source_path.join("agents/managed-agents.json")).unwrap(),
        before
    );
    drop(store);
    fs::remove_dir_all(source_path).unwrap();
    let mut reopened = Store::open(dest.path().into()).unwrap();
    assert_eq!(reopened.snapshot().unwrap().parked[0].name, "Brain");
    // A removed installation can no longer supply an import or a clone.
    assert!(reopened.migrate_legacy(old.path()).is_empty());
    assert!(reopened.snapshot().unwrap().parked.is_empty());
}

#[test]
fn parked_migration_replaces_each_source_and_keeps_other_sources() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let bytes = source(old.path());
    let development = old
        .path()
        .join(LegacySource::Development.app_directory())
        .join("agents");
    fs::create_dir_all(&development).unwrap();
    fs::write(development.join("managed-agents.json"), &bytes).unwrap();
    let mut store = Store::open(dest.path().into()).unwrap();
    assert!(store.migrate_legacy(old.path()).is_empty());
    assert_eq!(store.snapshot().unwrap().parked[0].sources.len(), 2);
    // The identity is deleted from Development only: it stays listed for Installed.
    fs::write(development.join("managed-agents.json"), b"[]").unwrap();
    assert!(store.migrate_legacy(old.path()).is_empty());
    assert_eq!(
        store.snapshot().unwrap().parked[0].sources,
        vec![LegacySource::Installed]
    );
    // Deleted from the last source that listed it: it leaves the inventory.
    let installed = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    fs::write(&installed, b"[]").unwrap();
    assert!(store.migrate_legacy(old.path()).is_empty());
    assert!(store.snapshot().unwrap().parked.is_empty());
}

#[test]
fn parked_migration_merges_sources_and_preserves_inventory_on_bad_source() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let bytes = source(old.path());
    let development = old
        .path()
        .join(LegacySource::Development.app_directory())
        .join("agents");
    fs::create_dir_all(&development).unwrap();
    fs::write(development.join("managed-agents.json"), &bytes).unwrap();
    let mut store = Store::open(dest.path().into()).unwrap();
    assert!(store.migrate_legacy(old.path()).is_empty());
    let snapshot = store.snapshot().unwrap();
    assert_eq!(snapshot.parked.len(), 1);
    assert_eq!(snapshot.parked[0].sources.len(), 2);
    fs::write(development.join("managed-agents.json"), b"broken").unwrap();
    assert_eq!(store.migrate_legacy(old.path()).len(), 1);
    assert_eq!(store.snapshot().unwrap().parked[0].sources.len(), 2);
    assert_eq!(
        fs::read(development.join("managed-agents.json")).unwrap(),
        b"broken"
    );
}

#[test]
fn import_excludes_overlapping_destinations_before_credentials_through_commit() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let keys = Memory::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let mut first = Imports::default();
    let preview = first
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://first.example",
        )
        .unwrap();
    let mut second = Imports::default();
    let other = second
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://second.example",
        )
        .unwrap();
    let ids = [preview.candidates[0].id.clone()];
    let other_ids = [other.candidates[0].id.clone()];
    let prepared = first.prepare(&preview.token, &ids, &store).unwrap();
    // Separate preview owners still share the same store reservation.
    assert!(second
        .prepare(&other.token, &other_ids, &store)
        .err()
        .unwrap()
        .contains("import is in progress"));
    assert!(keys.keys.lock().unwrap().is_empty());
    // Cancellation before credential access releases the reservation.
    drop(prepared);
    let prepared = first.prepare(&preview.token, &ids, &store).unwrap();
    let unavailable = Memory {
        fail: true,
        ..Default::default()
    };
    assert!(prepared.acquire(&unavailable).is_err());
    // Credential failure releases it too, so the same preview can be retried.
    let pending = first
        .prepare(&preview.token, &ids, &store)
        .unwrap()
        .acquire(&keys)
        .unwrap();
    let reads = keys.reads.load(Ordering::SeqCst);
    assert!(second
        .commit(&other.token, &other_ids, &mut store, &keys)
        .unwrap_err()
        .contains("import is in progress"));
    assert_eq!(keys.reads.load(Ordering::SeqCst), reads);
    assert_eq!(
        keys.keys
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ids
    );
    pending.commit(&mut store).unwrap();
    let before = fs::read(dest.path().join("agents.json")).unwrap();
    assert!(second
        .commit(&other.token, &other_ids, &mut store, &keys)
        .unwrap_err()
        .contains("already imported"));
    assert_eq!(keys.reads.load(Ordering::SeqCst), reads);
    assert_eq!(
        keys.keys
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ids
    );
    assert_eq!(fs::read(dest.path().join("agents.json")).unwrap(), before);
    assert_eq!(store.agents().unwrap().len(), 1);
}
