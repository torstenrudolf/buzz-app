use super::*;
use crate::config::{agent_id, HarnessEdit};
#[cfg(unix)]
use crate::process::Process;
use crate::Secret;
use serde_json::json;
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::time::{Duration, Instant};
const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
struct Memory;
impl Credentials for Memory {
    fn delete(&self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    fn read_legacy(&self, _: crate::LegacySource, _: &str) -> Result<Secret> {
        panic!("Runtime must never import")
    }
    fn read(&self, _: &str, key: &str) -> Result<Option<Secret>> {
        Secret::parse(KEY, key).map(Some)
    }
    fn add(&self, _: &str, _: &Secret) -> Result<()> {
        panic!("Runtime must never write keys")
    }
}
fn agent(workspace: &Path) -> Agent {
    let relay_url = "wss://relay.example".to_owned();
    Agent {
        picture: None,
        id: agent_id(PUB, &relay_url),
        pubkey: PUB.into(),
        relay_url,
        name: "Test agent".into(),
        system_prompt: "test prompt".into(),
        session_policy: None,
        session_policy_inherit: false,
        workspace: workspace.display().to_string(),
        harness: HarnessEdit {
            databricks: None,
            command: "buzz-agent".into(),
            args: vec![],
            model: "test-model".into(),
            provider: "test-provider".into(),
        },
        environment: BTreeMap::from([("PROVIDER_TEST_SETTING".into(), "explicit-value".into())]),
        revision: 1,
        enabled: false,
        start_on_app_launch: None,
        credential_id: "test".into(),
        auth_tag: Some(crate::secret::test_attestation(PUB)),
        imported: json!({"record":{"respond_to":"owner-only","parallelism":2,"effort_level":"high"}}),
        extra: BTreeMap::new(),
    }
}
#[test]
fn delete_refuses_stale_revision_and_removes_stopped_agent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("config");
    let mut store = Store::open(root.clone()).unwrap();
    let saved = agent(dir.path());
    store.insert(vec![saved.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Err("No fixture runtime".into()),
        dir.path().join("ownership"),
    );
    assert!(controller.delete(&saved.id, saved.revision + 1).is_err());
    assert_eq!(controller.snapshot().unwrap().agents.len(), 1);
    assert!(controller
        .delete(&saved.id, saved.revision)
        .unwrap()
        .agents
        .is_empty());
    drop(controller);
    assert!(Store::open(root).unwrap().agents().unwrap().is_empty());
}
#[test]
fn delete_keeps_a_key_shared_by_another_setup_of_the_same_identity() {
    use std::sync::Mutex;
    #[derive(Default)]
    struct Tracked(Mutex<Vec<String>>);
    impl Credentials for Tracked {
        fn read_legacy(&self, _: crate::LegacySource, _: &str) -> Result<Secret> {
            unreachable!()
        }
        fn read(&self, _: &str, _: &str) -> Result<Option<Secret>> {
            unreachable!()
        }
        fn add(&self, _: &str, _: &Secret) -> Result<()> {
            unreachable!()
        }
        fn delete(&self, id: &str, _: &str) -> Result<()> {
            self.0.lock().unwrap().push(id.into());
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("config")).unwrap();
    let first = agent(dir.path());
    let mut second = first.clone();
    second.id = agent_id(PUB, "wss://other.example");
    second.relay_url = "wss://other.example".into();
    store.insert(vec![first.clone(), second.clone()]).unwrap();
    let credentials = Arc::new(Tracked::default());
    let mut controller = Controller::new(
        store,
        credentials.clone(),
        Err("No fixture runtime".into()),
        dir.path().join("ownership"),
    );
    controller.delete(&first.id, first.revision).unwrap();
    assert!(credentials.0.lock().unwrap().is_empty());
    assert!(controller
        .delete(&second.id, second.revision)
        .unwrap()
        .agents
        .is_empty());
    assert_eq!(*credentials.0.lock().unwrap(), vec![second.credential_id]);
}
#[test]
fn denied_credential_deletion_keeps_a_disabled_card_for_retry() {
    struct Denied;
    impl Credentials for Denied {
        fn read_legacy(&self, _: crate::LegacySource, _: &str) -> Result<Secret> {
            unreachable!()
        }
        fn read(&self, _: &str, _: &str) -> Result<Option<Secret>> {
            unreachable!()
        }
        fn add(&self, _: &str, _: &Secret) -> Result<()> {
            unreachable!()
        }
        fn delete(&self, _: &str, _: &str) -> Result<()> {
            Err("Credential deletion denied".into())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("config")).unwrap();
    let mut saved = agent(dir.path());
    saved.enabled = true;
    store.insert(vec![saved.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Denied),
        Err("No fixture runtime".into()),
        dir.path().join("ownership"),
    );
    assert!(controller
        .delete(&saved.id, saved.revision)
        .err()
        .unwrap()
        .contains("denied"));
    let remaining = controller.store.agents().unwrap();
    assert_eq!(remaining.len(), 1);
    assert!(!remaining[0].enabled);
}
#[cfg(unix)]
fn bundle(directory: &Path) -> RuntimeBundle {
    use std::os::unix::fs::PermissionsExt;
    for name in [
        "buzz-acp",
        "buzz-agent",
        "buzz-dev-mcp",
        "buzz",
        "git-credential-nostr",
    ] {
        let path = directory.join(name);
        fs::write(&path, r#"#!/bin/sh
printf '%s\n' "$BUZZ_ACP_LAZY_POOL" "$BUZZ_ACP_IDLE_POOL_SLEEP" "$BUZZ_ACP_SYSTEM_PROMPT" "$BUZZ_ACP_MODEL" "$BUZZ_ACP_AGENT_ARGS" "$BUZZ_RELAY_URL" "$BUZZ_ACP_RESPOND_TO" "$BUZZ_MANAGED_AGENT" "$BUZZ_ACP_REPLAY_FLOOR" "$PROVIDER_TEST_SETTING" >> starts
printf '%s' "$BUZZ_ACP_TEAM_INSTRUCTIONS" > team-instructions
printf '%s\n' "$BUZZ_AGENT_CONFIG_DIR" "$DATABRICKS_HOST" "$DATABRICKS_MODEL_FILTER" "${DATABRICKS_TOKEN-unset}" "$TMPDIR" "$PATH" > runtime-env
printf 'harness fixture output\n'
trap 'exit 0' TERM INT
while :; do [ -f "$BUZZ_AGENT_CONFIG_DIR/exit-listener" ] && exit 0; /bin/sleep 0.1; done
"#).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let files: BTreeMap<_, _> = [
        "buzz-acp",
        "buzz-agent",
        "buzz-dev-mcp",
        "buzz",
        "git-credential-nostr",
    ]
    .into_iter()
    .map(|name| {
        use sha2::{Digest, Sha256};
        (
            name,
            format!(
                "{:x}",
                Sha256::digest(fs::read(directory.join(name)).unwrap())
            ),
        )
    })
    .collect();
    let source: serde_json::Value =
        serde_json::from_str(include_str!("../../../../runtime/agent-runtime.json")).unwrap();
    fs::write(directory.join("manifest.json"), serde_json::to_vec(&json!({"version":1,"revision":source["revision"],"target":env!("BUZZ_RUNTIME_TARGET"),"files":files})).unwrap()).unwrap();
    RuntimeBundle::new(directory.into()).unwrap()
}
#[cfg(unix)]
fn wait_for_contents<T>(path: &Path, parse: impl Fn(&str) -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = fs::read_to_string(path).ok().and_then(|text| parse(&text)) {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "fixture did not publish complete output"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn fixture_worker(text: &str) -> Option<(i32, i32)> {
    let (leader, worker) = text.split_once(' ')?;
    let leader = leader.parse().ok()?;
    let worker = worker.parse().ok()?;
    (leader > 1 && worker > 1 && leader != worker).then_some((leader, worker))
}

// Independent of the production teardown being mutation-tested. The fixture
// records both PIDs in its private temp directory; verify session ownership
// before cleanup, including when an assertion unwinds.
#[cfg(unix)]
struct FixtureWorkerCleanup(PathBuf);
#[cfg(unix)]
impl Drop for FixtureWorkerCleanup {
    fn drop(&mut self) {
        if let Some((leader, worker)) = fs::read_to_string(&self.0)
            .ok()
            .and_then(|text| fixture_worker(&text))
        {
            if unsafe { libc::getsid(worker) } == leader {
                unsafe { libc::kill(worker, libc::SIGKILL) };
            }
        }
    }
}
#[test]
#[cfg(unix)]
fn log_reads_require_exact_instance_and_verified_owner_and_survive_stop() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("config")).unwrap();
    let agent = agent(dir.path());
    store.insert(vec![agent.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let nonce = "12345678-1234-1234-1234-123456789abc";
    let sign = |id: &str, pubkey: &str, relay: &str, nonce: &str| {
        use secp256k1::{Keypair, Secp256k1, SecretKey};
        use sha2::{Digest, Sha256};
        let secp = Secp256k1::new();
        let mut bytes = [0; 32];
        bytes[31] = 2; // owner key used by test_attestation
        let pair = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(bytes).unwrap());
        let digest = Sha256::digest(crate::logs::proof_message(id, pubkey, relay, nonce));
        secp.sign_schnorr_no_aux_rand(&digest, &pair).to_string()
    };
    let signature = sign(&agent.id, PUB, &agent.relay_url, nonce);
    let read = |controller: &Controller| {
        controller.read_log(&agent.id, PUB, &agent.relay_url, nonce, &signature)
    };
    assert_eq!(read(&controller).unwrap(), "");
    assert!(controller
        .log_target(&agent.id, PUB, &agent.relay_url)
        .is_ok());
    assert!(controller
        .log_target(&agent.id, PUB, "wss://another.example")
        .is_err());
    assert!(controller
        .read_log(&agent.id, PUB, &agent.relay_url, nonce, &"f".repeat(128))
        .is_err());
    assert!(controller
        .read_log(
            &agent.id,
            PUB,
            &agent.relay_url,
            "22345678-1234-1234-1234-123456789abc",
            &signature
        )
        .is_err());
    assert!(controller
        .read_log(&agent.id, PUB, "wss://another.example", nonce, &signature)
        .is_err());
    assert!(controller
        .read_log(
            &agent.id,
            &"f".repeat(64),
            &agent.relay_url,
            nonce,
            &signature
        )
        .is_err());
    let mut other = agent.clone();
    other.relay_url = "wss://another.example".into();
    other.id = agent_id(PUB, &other.relay_url);
    controller.store.insert(vec![other.clone()]).unwrap();
    assert!(controller
        .read_log(&other.id, PUB, &other.relay_url, nonce, &signature)
        .is_err());
    let cross_community = sign(&agent.id, PUB, &other.relay_url, nonce);
    assert!(controller
        .read_log(&agent.id, PUB, &agent.relay_url, nonce, &cross_community)
        .is_err());
    // An otherwise well-formed proof from the agent key is not an owner proof.
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use sha2::{Digest, Sha256};
    let secp = Secp256k1::new();
    let mut wrong_bytes = [0; 32];
    wrong_bytes[31] = 1;
    let wrong_key =
        Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(wrong_bytes).unwrap());
    let wrong_digest = Sha256::digest(crate::logs::proof_message(
        &agent.id,
        PUB,
        &agent.relay_url,
        nonce,
    ));
    let wrong_signature = secp
        .sign_schnorr_no_aux_rand(&wrong_digest, &wrong_key)
        .to_string();
    assert!(controller
        .read_log(&agent.id, PUB, &agent.relay_url, nonce, &wrong_signature)
        .is_err());
    controller.action(&agent.id, Action::Start).unwrap();
    let log_path = crate::logs::path(dir.path().join("config").as_path(), &agent.id).unwrap();
    wait_for_contents(&log_path, |text| (!text.is_empty()).then_some(()));
    controller.action(&agent.id, Action::Stop).unwrap();
    assert!(!read(&controller).unwrap().is_empty());
    controller.action(&agent.id, Action::Start).unwrap();
    controller.action(&agent.id, Action::Stop).unwrap();
    assert!(!read(&controller).unwrap().is_empty());
}

#[test]
#[cfg(unix)]
fn actual_spawn_save_restart_stop_and_restore_contract() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let store_root = dir.path().join("config");
    let mut store = Store::open(store_root.clone()).unwrap();
    let a = agent(dir.path());
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let snapshot = controller.action(&a.id, Action::Start).unwrap();
    assert!(matches!(snapshot.agents[0].status, ProcessStatus::Running));
    let first = wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 10).then(|| text.to_owned())
    });
    assert_eq!(first, "true\n900\ntest prompt\ntest-model\n\nwss://relay.example\nowner-only\n\n\nexplicit-value\n");
    controller.action(&a.id, Action::Start).unwrap();
    assert_eq!(controller.running.len(), 1);
    let edit = AgentEdit {
        picture: None,
        name: "Edited".into(),
        system_prompt: "changed prompt".into(),
        session_policy: Some(None),
        workspace: a.workspace.clone(),
        harness: a.harness.clone(),
        environment: BTreeMap::new(),
    };
    let saved = controller.save(&a.id, 1, edit).unwrap();
    assert_eq!(saved.agents[0].revision, 2);
    assert_eq!(saved.agents[0].running_revision, Some(1));
    let fields: Vec<_> = saved.agents[0]
        .restart_diff
        .iter()
        .map(|e| e.field.as_str())
        .collect();
    assert_eq!(fields, ["name", "system_prompt"]);
    assert_eq!(
        fs::read_to_string(dir.path().join("starts")).unwrap(),
        first
    );
    let restarted = controller.action(&a.id, Action::Restart).unwrap();
    assert_eq!(restarted.agents[0].running_revision, Some(2));
    assert!(restarted.agents[0].restart_diff.is_empty());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fs::read_to_string(dir.path().join("starts"))
        .unwrap()
        .contains("changed prompt")
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    controller.shutdown().unwrap();
    assert!(controller.store.agents().unwrap()[0].enabled);
    let restored = controller.restore().unwrap();
    assert!(matches!(restored.agents[0].status, ProcessStatus::Running));
    let stopped = controller.action(&a.id, Action::Stop).unwrap();
    assert!(!stopped.agents[0].enabled);
    assert!(matches!(stopped.agents[0].status, ProcessStatus::Stopped));
    drop(controller);
    let mut controller = Controller::new(
        Store::open(store_root).unwrap(),
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let restored = controller.restore().unwrap();
    assert!(!restored.agents[0].enabled);
    assert!(controller.running.is_empty());
    let preferred = controller.set_start_on_app_launch(&a.id, true).unwrap();
    assert!(preferred.agents[0].start_on_app_launch);
    assert!(controller.running.is_empty());
    let restored = controller.restore().unwrap();
    assert!(
        matches!(restored.agents[0].status, ProcessStatus::Running),
        "{:?}",
        restored.agents[0].error
    );
    controller.shutdown().unwrap();
    controller.set_start_on_app_launch(&a.id, false).unwrap();
    assert!(controller.store.agents().unwrap()[0].enabled);
    assert!(controller.launch_ids().unwrap().is_empty());
    controller.restore().unwrap();
    assert!(controller.running.is_empty());
    controller.action(&a.id, Action::Start).unwrap();
    assert_eq!(controller.running.len(), 1);
    assert!(controller.delete(&a.id, 2).unwrap().agents.is_empty());
    assert!(controller.running.is_empty());
}
#[test]
#[cfg(unix)]
fn new_records_launch_preference_is_independent_of_start_and_stop() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let owner: Vec<String> = serde_json::from_str(&crate::secret::test_attestation(PUB)).unwrap();
    let prepared = crate::NewAgent::prepare("wss://relay.example", &owner[1]).unwrap();
    let a = agent(dir.path());
    let mut controller = Controller::new(
        Store::open(dir.path().join("config")).unwrap(),
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let edit = AgentEdit {
        name: a.name.clone(),
        picture: None,
        system_prompt: a.system_prompt.clone(),
        session_policy: Some(None),
        workspace: a.workspace.clone(),
        harness: a.harness.clone(),
        environment: BTreeMap::new(),
    };
    let auth = crate::secret::test_attestation(prepared.key.pubkey());
    controller.create(&prepared, edit, &auth).unwrap();
    let created = &controller.store.agents().unwrap()[0];
    assert_eq!(created.start_on_app_launch, Some(false));
    // Start/Stop change execution intent only, never the launch preference.
    let mut explicit = a.clone();
    explicit.start_on_app_launch = Some(false);
    controller.store.insert(vec![explicit]).unwrap();
    controller.action(&a.id, Action::Start).unwrap();
    assert!(controller.launch_ids().unwrap().is_empty());
    controller.action(&a.id, Action::Stop).unwrap();
    controller.set_start_on_app_launch(&a.id, true).unwrap();
    controller.action(&a.id, Action::Stop).unwrap();
    assert_eq!(controller.launch_ids().unwrap(), vec![a.id.clone()]);
}
#[test]
#[cfg(unix)]
fn failed_temp_cleanup_reports_error_and_allows_explicit_retry() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let a = agent(dir.path());
    let mut store = Store::open(dir.path().join("config")).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let key = Secret::parse(KEY, PUB).unwrap();
    for action in [Action::Stop, Action::Restart] {
        assert!(matches!(
            controller.action(&a.id, Action::Start).unwrap().agents[0].status,
            ProcessStatus::Running
        ));
        let temp = controller.running[&a.id]
            .temporary
            .as_ref()
            .unwrap()
            .clone();
        let moved = temp.with_extension("moved");
        fs::rename(&temp, &moved).unwrap();
        fs::write(&temp, b"block directory removal").unwrap();
        let stopped = if matches!(action, Action::Restart) {
            controller
                .action_with_key(&a.id, action, 1, &key, None)
                .unwrap();
            controller.snapshot().unwrap()
        } else {
            controller.action(&a.id, action).unwrap()
        };
        let error = "Agent stopped, but its private runtime directory could not be removed";
        assert!(matches!(stopped.agents[0].status, ProcessStatus::Failed));
        assert_eq!(stopped.agents[0].error.as_deref(), Some(error));
        assert_eq!(
            controller.snapshot().unwrap().agents[0].error.as_deref(),
            Some(error)
        );
        assert!(controller.running.is_empty());
        fs::remove_file(temp).unwrap();
        let retry = controller.action(&a.id, Action::Start).unwrap();
        assert!(matches!(retry.agents[0].status, ProcessStatus::Running));
        controller.action(&a.id, Action::Stop).unwrap();
        fs::remove_dir_all(moved).unwrap();
    }
}

#[test]
#[cfg(unix)]
fn listener_self_exit_with_failed_cleanup_retires_entry_and_reports_error() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let a = agent(dir.path());
    let mut store = Store::open(dir.path().join("config")).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    controller.action(&a.id, Action::Start).unwrap();
    wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 10).then_some(())
    });
    let temp = controller.running[&a.id]
        .temporary
        .as_ref()
        .unwrap()
        .clone();
    let moved = temp.with_extension("moved");
    fs::rename(&temp, &moved).unwrap();
    fs::write(&temp, b"block directory removal").unwrap();
    controller.record_error(&a.id, "credential read failed".into());
    fs::write(dir.path().join("config/exit-listener"), b"").unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let snapshot = controller.snapshot().unwrap();
        if controller.running.is_empty() {
            assert_eq!(
                snapshot.agents[0].error.as_deref(),
                Some("Agent stopped, but its private runtime directory could not be removed")
            );
            break;
        }
        assert!(Instant::now() < deadline, "listener did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
    fs::remove_file(temp).unwrap();
    fs::remove_dir_all(moved).unwrap();
}

#[test]
#[cfg(unix)]
fn listener_exit_replaces_stale_credential_error() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let a = agent(dir.path());
    let mut store = Store::open(dir.path().join("config")).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    controller.action(&a.id, Action::Start).unwrap();
    wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 10).then_some(())
    });
    controller.record_error(&a.id, "credential read failed".into());
    fs::write(dir.path().join("config/exit-listener"), b"").unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let snapshot = controller.snapshot().unwrap();
        if controller.running.is_empty() {
            assert_eq!(
                snapshot.agents[0].error.as_deref(),
                Some("Agent listener exited; restart to retry")
            );
            break;
        }
        assert!(Instant::now() < deadline, "listener did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[cfg(unix)]
fn stop_reports_cleanup_before_durable_disable_failure() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    let mut store = Store::open(config.clone()).unwrap();
    let a = agent(dir.path());
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    controller.action(&a.id, Action::Start).unwrap();
    let temp = controller.running[&a.id]
        .temporary
        .as_ref()
        .unwrap()
        .clone();
    let moved = temp.with_extension("moved");
    fs::rename(&temp, &moved).unwrap();
    fs::write(&temp, b"block directory removal").unwrap();
    fs::write(config.join("agents.json"), b"{malformed").unwrap();
    assert!(
        matches!(controller.action(&a.id, Action::Stop), Err(ref error) if error == "Agent stopped, but its private runtime directory could not be removed")
    );
    assert!(controller.running.is_empty());
    assert_eq!(
        controller.errors[&a.id],
        "Agent stopped, but its private runtime directory could not be removed"
    );
    fs::remove_file(temp).unwrap();
    fs::remove_dir_all(moved).unwrap();
}

#[test]
#[cfg(unix)]
fn exact_command_has_no_ambient_identity_and_launch_failure_is_truthful() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let a = agent(dir.path());
    let runtime = bundle(tools.path());
    let command = runtime
        .command_with_defaults(
            &a,
            &Secret::parse(KEY, PUB).unwrap(),
            &crate::BuildDefaults::default(),
        )
        .unwrap();
    let env: BTreeMap<_, _> = command
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| {
                (
                    k.to_string_lossy().to_string(),
                    v.to_string_lossy().to_string(),
                )
            })
        })
        .collect();
    assert_eq!(env["BUZZ_PRIVATE_KEY"], KEY);
    assert_eq!(env["NOSTR_PRIVATE_KEY"], KEY);
    assert_eq!(env["BUZZ_AUTH_TAG"], crate::secret::test_attestation(PUB));
    assert_eq!(env["BUZZ_ACP_AGENTS"], "2");
    assert_eq!(env["BUZZ_ACP_EFFORT_LEVEL"], "high");
    for absent in [
        "BUZZ_MANAGED_AGENT",
        "BUZZ_MANAGED_AGENT_START_NONCE",
        "BUZZ_ACP_REPLAY_FLOOR",
        "BUZZ_API_TOKEN",
        "GIT_CONFIG_COUNT",
    ] {
        assert!(!env.contains_key(absent));
    }
    assert_eq!(command.get_current_dir(), Some(dir.path()));
    let mut store = Store::open(dir.path().join("config")).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Err("Runtime bundle is missing".into()),
        dir.path().join("ownership"),
    );
    let failed = controller.action(&a.id, Action::Start).unwrap();
    assert!(matches!(failed.agents[0].status, ProcessStatus::Failed));
    assert!(failed.agents[0].enabled);
    assert!(controller.running.is_empty());
    let stopped = controller.action(&a.id, Action::Stop).unwrap();
    assert!(!stopped.agents[0].enabled);
}
#[test]
#[cfg(unix)]
fn teardown_reaps_a_worker_in_a_separate_process_group() {
    // Python is an isolated fixture only, not a production runtime dependency.
    if !Path::new("/usr/bin/python3").is_file() {
        panic!("Fixture requires /usr/bin/python3");
    }
    let dir = tempfile::tempdir().unwrap();
    let mut command = Command::new("/usr/bin/python3");
    command
        .args([
            "-c",
            r#"import os, subprocess, time, signal
signal.signal(signal.SIGTERM, signal.SIG_IGN)
# A stopped orphan group may receive SIGHUP when its leader dies. Ignore it so
# killing only the leader cannot accidentally satisfy the containment assertion.
signal.signal(signal.SIGHUP, signal.SIG_IGN)
worker = subprocess.Popen(['/bin/sleep', '60'], preexec_fn=os.setpgrp)
with open('worker.tmp', 'w') as f: f.write(str(os.getpid()) + ' ' + str(worker.pid))
os.rename('worker.tmp', 'worker')
while True: time.sleep(.1)
"#,
        ])
        .current_dir(dir.path())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut process = Process::spawn(&mut command).unwrap();
    let cleanup = FixtureWorkerCleanup(dir.path().join("worker"));
    let (leader, pid) = wait_for_contents(&cleanup.0, fixture_worker);
    assert_eq!(unsafe { libc::getsid(pid) }, leader);
    assert_eq!(unsafe { libc::getpgid(pid) }, pid);
    process.stop().unwrap();
    assert!(!process.alive().unwrap());
    // No live worker; a transient zombie awaiting init's reap is already exited.
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "worker survived: {state}"
    );
}

#[test]
fn attestation_cannot_change_owner_identity_or_conditions() {
    let valid = crate::secret::test_attestation(PUB);
    assert!(crate::secret::validate_attestation(&valid, PUB).is_ok());
    assert!(crate::secret::validate_attestation(&valid, &"ab".repeat(32)).is_err());
    let mut tag: Vec<String> = serde_json::from_str(&valid).unwrap();
    tag[2] = "kind=9".into();
    assert!(
        crate::secret::validate_attestation(&serde_json::to_string(&tag).unwrap(), PUB).is_err()
    );
    assert!(crate::secret::validate_attestation("not-a-tag", PUB).is_err());
}

#[test]
#[cfg(unix)]
fn start_refuses_an_attestation_for_a_different_agent() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut a = agent(dir.path());
    a.auth_tag = Some(crate::secret::test_attestation(&"ab".repeat(32)));
    let mut store = Store::open(dir.path().join("config")).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let failed = controller.action(&a.id, Action::Start).unwrap();
    assert!(matches!(failed.agents[0].status, ProcessStatus::Failed));
    assert_eq!(
        failed.agents[0].error.as_deref(),
        Some("Owner attestation does not authorize this agent key")
    );
    assert_eq!(failed.agents[0].running_revision, None);
    assert!(controller.running.is_empty());
    assert!(!dir.path().join("starts").exists());
}

#[test]
#[cfg(unix)]
fn stop_reaches_owned_process_when_store_is_malformed_or_row_disappears() {
    for contents in ["{malformed", r#"{"version":1,"agents":[]}"#] {
        let dir = tempfile::tempdir().unwrap();
        let tools = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let mut store = Store::open(config.clone()).unwrap();
        let a = agent(dir.path());
        store.insert(vec![a.clone()]).unwrap();
        let mut controller = Controller::new(
            store,
            Arc::new(Memory),
            Ok(bundle(tools.path())),
            dir.path().join("ownership"),
        );
        controller.action(&a.id, Action::Start).unwrap();
        wait_for_contents(&dir.path().join("starts"), |text| {
            (text.lines().count() == 10).then_some(())
        });
        fs::write(config.join("agents.json"), contents).unwrap();
        assert!(
            controller.action(&a.id, Action::Stop).is_err(),
            "must report failed durable disable"
        );
        assert!(
            controller.running.is_empty(),
            "Stop must reach owned process despite invalid storage"
        );
        assert_eq!(
            fs::read_to_string(config.join("agents.json")).unwrap(),
            contents
        );
    }
}

#[test]
#[cfg(unix)]
fn delete_stops_the_listener_and_refuses_deployed_remote_records() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("config")).unwrap();
    let a = agent(dir.path());
    let mut remote = agent(dir.path());
    remote.relay_url = "wss://remote.example".into();
    remote.id = agent_id(PUB, &remote.relay_url);
    remote.imported = serde_json::json!({"record": {"backend": {"type": "provider"}, "backend_agent_id": "deployed"}});
    store.insert(vec![a.clone(), remote.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    controller.action(&a.id, Action::Start).unwrap();
    wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 10).then_some(())
    });
    controller.delete(&a.id, a.revision).unwrap();
    assert!(controller.running.is_empty());
    assert!(controller
        .delete(&a.id, a.revision)
        .err()
        .unwrap()
        .contains("no longer exists"));
    // Base Buzz refuses to orphan a deployed remote agent; the view says so
    // before any caller starts work that depends on deletion.
    assert!(
        remote.view(&Default::default()).deployed_remote
            && !a.view(&Default::default()).deployed_remote
    );
    assert!(controller
        .delete(&remote.id, remote.revision)
        .err()
        .unwrap()
        .contains("Deployed remote agents can't be deleted"));
    let remaining = controller.store.agents().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, remote.id);
    assert_eq!(remaining[0].enabled, remote.enabled);
}

#[test]
#[cfg(unix)]
fn explicit_provider_environment_wins_and_blank_selectors_do_not_erase_it() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let runtime = bundle(tools.path());
    fs::copy(tools.path().join("buzz-agent"), tools.path().join("goose")).unwrap();
    for (worker, model_key, provider_key) in [
        ("buzz-agent", "BUZZ_AGENT_MODEL", "BUZZ_AGENT_PROVIDER"),
        ("goose", "GOOSE_MODEL", "GOOSE_PROVIDER"),
    ] {
        for selectors in ["", "conflicting-selector"] {
            let mut a = agent(dir.path());
            if worker == "goose" {
                a.harness.command = tools.path().join(worker).display().to_string();
            }
            a.harness.provider = selectors.into();
            a.harness.model = selectors.into();
            a.environment
                .insert(provider_key.into(), "databricks".into());
            a.environment
                .insert(model_key.into(), "fixture-model".into());
            let command = runtime
                .command_with_defaults(
                    &a,
                    &Secret::parse(KEY, PUB).unwrap(),
                    &crate::BuildDefaults::default(),
                )
                .unwrap();
            let env: BTreeMap<_, _> = command
                .get_envs()
                .filter_map(|(k, v)| {
                    v.map(|v| {
                        (
                            k.to_string_lossy().into_owned(),
                            v.to_string_lossy().into_owned(),
                        )
                    })
                })
                .collect();
            assert_eq!(env[provider_key], "databricks");
            assert_eq!(env[model_key], "fixture-model");
            assert_eq!(env["BUZZ_ACP_MODEL"], "fixture-model");
        }
    }
}

#[test]
#[cfg(unix)]
fn blank_selectors_without_overrides_leave_harness_defaults_intact() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let runtime = bundle(tools.path());
    let mut a = agent(dir.path());
    a.harness.provider.clear();
    a.harness.model.clear();
    let command = runtime
        .command_with_defaults(
            &a,
            &Secret::parse(KEY, PUB).unwrap(),
            &crate::BuildDefaults::default(),
        )
        .unwrap();
    let env: BTreeMap<_, _> = command.get_envs().collect();
    for key in ["BUZZ_AGENT_PROVIDER", "BUZZ_AGENT_MODEL", "BUZZ_ACP_MODEL"] {
        assert!(!env.contains_key(std::ffi::OsStr::new(key)));
    }
}

#[test]
#[cfg(unix)]
fn start_and_restart_reject_missing_saved_identities() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut controller = Controller::new(
        Store::open(dir.path().join("config")).unwrap(),
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    for action in [Action::Start, Action::Restart] {
        assert!(controller.action("missing", action).is_err());
    }
    assert!(controller.running.is_empty());
}

#[test]
#[cfg(unix)]
fn shared_cache_spawn_capture_disconnect_snapshot_and_private_temp_cleanup() {
    use crate::connection::DatabricksSettings;
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut a = agent(dir.path());
    a.harness.provider = "databricks_v2".into();
    a.harness.databricks = Some(DatabricksSettings {
        host: "https://EXAMPLE.com:443/".into(),
        filter: "foo*".into(),
    });
    // TMPDIR and PATH can be supplied by settings, but the app's private runtime
    // storage and bundled tools are authoritative.
    a.environment
        .insert("TMPDIR".into(), "/unusable-user-override".into());
    let config = dir.path().join("config");
    let mut store = Store::open(config.clone()).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let runtime = bundle(tools.path());
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(runtime),
        dir.path().join("ownership"),
    );
    let started = controller.action(&a.id, Action::Start).unwrap();
    assert!(matches!(started.agents[0].status, ProcessStatus::Running));
    let env = wait_for_contents(&dir.path().join("runtime-env"), |text| {
        (text.lines().count() == 6).then(|| text.lines().map(str::to_owned).collect::<Vec<_>>())
    });
    assert_eq!(env[0], config.to_str().unwrap());
    assert_eq!(env[1], "https://example.com");
    assert_eq!(env[2], "foo*");
    assert_eq!(env[3], "unset");
    assert!(env[5].starts_with(tools.path().to_str().unwrap()));
    let run = &controller.running[&a.id];
    assert_eq!(run.databricks_host.as_deref(), Some("https://example.com"));
    let temp = run.temporary.as_ref().unwrap().to_owned();
    assert!(temp.starts_with(config.join("runs")));
    assert_eq!(env[4], temp.to_str().unwrap());
    let cache = config.join("buzz-agent/oauth/databricks");
    assert!(cache.is_dir());
    let edit = AgentEdit {
        picture: None,
        name: a.name.clone(),
        system_prompt: a.system_prompt.clone(),
        session_policy: Some(None),
        workspace: a.workspace.clone(),
        harness: HarnessEdit {
            databricks: Some(DatabricksSettings {
                host: "https://other.example.com".into(),
                filter: "".into(),
            }),
            ..a.harness.clone()
        },
        environment: BTreeMap::new(),
    };
    controller.save(&a.id, 1, edit).unwrap();
    assert!(controller
        .disconnect("https://example.com")
        .unwrap_err()
        .contains("Stop agents"));
    controller.disconnect("https://other.example.com").unwrap();
    controller.action(&a.id, Action::Stop).unwrap();
    assert!(!temp.exists());
    controller.disconnect("https://example.com").unwrap();
}

#[test]
#[cfg(unix)]
fn bundle_rejects_a_revision_different_from_the_runtime_spec() {
    let tools = tempfile::tempdir().unwrap();
    bundle(tools.path());
    let path = tools.path().join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["revision"] = json!("0".repeat(40));
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(matches!(
        RuntimeBundle::new(tools.path().into()),
        Err(error) if error == "Runtime target/revision does not match this app"
    ));
}

#[test]
#[cfg(unix)]
fn snapshots_project_configured_paths_but_starts_reverify_each_executable() {
    for name in ["buzz-acp", "buzz-dev-mcp", "buzz-agent"] {
        for removed in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let tools = tempfile::tempdir().unwrap();
            let a = agent(dir.path());
            let mut store = Store::open(dir.path().join("config")).unwrap();
            store.insert(vec![a.clone()]).unwrap();
            let mut controller = Controller::new(
                store,
                Arc::new(Memory),
                Ok(bundle(tools.path())),
                dir.path().join("ownership"),
            );
            let path = tools.path().join(name);
            if removed {
                fs::remove_file(path).unwrap();
            } else {
                fs::write(path, "tampered").unwrap();
            }
            // Projection retains configured paths even when runtime files cannot
            // be verified. No status poll may treat these as launch authority.
            let before = controller.snapshot().unwrap();
            assert!(before.runtime_available);
            assert_eq!(
                before.agents[0].acp_command.as_deref(),
                tools.path().join("buzz-acp").to_str()
            );
            assert_eq!(
                before.agents[0].mcp_command.as_deref(),
                tools.path().join("buzz-dev-mcp").to_str()
            );
            let key = Secret::parse(KEY, PUB).unwrap();
            controller
                .action_with_key(&a.id, Action::Start, 1, &key, None)
                .unwrap();
            let after = controller.snapshot().unwrap();
            assert!(matches!(after.agents[0].status, ProcessStatus::Failed));
            assert!(after.agents[0]
                .error
                .as_deref()
                .unwrap()
                .contains(if removed { "missing" } else { "integrity" }));
            assert!(after.agents[0].running_revision.is_none());
            assert!(controller.running.is_empty());
            assert!(!dir.path().join("starts").exists());
        }
    }
}

#[test]
#[cfg(unix)]
fn manifest_integrity_and_exact_identity_exclusion_across_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let a = agent(dir.path());
    let mut first = Store::open(dir.path().join("first")).unwrap();
    first.insert(vec![a.clone()]).unwrap();
    let mut second = Store::open(dir.path().join("second")).unwrap();
    second.insert(vec![a.clone()]).unwrap();
    let shared = dir.path().join("ownership");
    let mut first = Controller::new(
        first,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        shared.clone(),
    );
    let mut second = Controller::new(
        second,
        Arc::new(Memory),
        Ok(RuntimeBundle::new(tools.path().into()).unwrap()),
        shared,
    );
    first.action(&a.id, Action::Start).unwrap();
    let blocked = second.action(&a.id, Action::Start).unwrap();
    assert!(blocked.agents[0]
        .error
        .as_deref()
        .unwrap()
        .contains("Another buzz-app profile"));
    first.action(&a.id, Action::Stop).unwrap();
    assert!(matches!(
        second.action(&a.id, Action::Start).unwrap().agents[0].status,
        ProcessStatus::Running
    ));
    second.action(&a.id, Action::Stop).unwrap();
    fs::write(tools.path().join("buzz-agent"), "tampered").unwrap();
    let failed = second.action(&a.id, Action::Start).unwrap();
    assert!(failed.agents[0]
        .error
        .as_deref()
        .unwrap()
        .contains("integrity"));
    assert!(second.running.is_empty());
    assert!(RuntimeBundle::new(tools.path().into()).is_err());
}

#[test]
#[cfg(unix)]
#[ignore = "requires immutable staged runtime resources; run explicitly after build-agent-runtime"]
fn actual_bundled_acp_lazy_listener_start_restart_stop_and_quit_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/resources/agent-runtime")
        .canonicalize()
        .unwrap();
    let mut a = agent(dir.path());
    a.harness.provider = "databricks_v2".into();
    a.harness.databricks = Some(crate::connection::DatabricksSettings {
        host: "https://workspace.example.invalid".into(),
        filter: "".into(),
    });
    // Bind/retain a closed-to-WS listener locally: no external relay or live agent.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    a.relay_url = format!("wss://127.0.0.1:{}", listener.local_addr().unwrap().port());
    a.id = agent_id(PUB, &a.relay_url);
    let config = dir.path().join("config");
    let mut store = Store::open(config.clone()).unwrap();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        RuntimeBundle::new(tools),
        dir.path().join("ownership"),
    );
    for action in [Action::Start, Action::Restart] {
        let result = controller.action(&a.id, action).unwrap();
        assert!(
            matches!(result.agents[0].status, ProcessStatus::Running),
            "{:?}",
            result.agents[0].error
        );
        std::thread::sleep(Duration::from_millis(250));
        let result = controller.snapshot().unwrap();
        assert!(
            matches!(result.agents[0].status, ProcessStatus::Running),
            "{:?}",
            result.agents[0].error
        );
    }
    let temp = controller.running[&a.id]
        .temporary
        .as_ref()
        .unwrap()
        .to_owned();
    assert!(temp.exists());
    controller.action(&a.id, Action::Stop).unwrap();
    assert!(!temp.exists());
    assert!(!controller.store.agents().unwrap()[0].enabled);
    controller.action(&a.id, Action::Start).unwrap();
    let temp = controller.running[&a.id]
        .temporary
        .as_ref()
        .unwrap()
        .to_owned();
    controller.shutdown().unwrap();
    assert!(!temp.exists());
    assert!(controller.store.agents().unwrap()[0].enabled);
    assert!(controller.running.is_empty());
}

#[test]
#[cfg(unix)]
fn mention_start_forwards_replay_floor_without_persisting_or_restoring_it() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("config")).unwrap();
    let a = agent(dir.path());
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let key = Secret::parse(KEY, PUB).unwrap();
    controller
        .action_with_key(&a.id, Action::Start, 1, &key, Some(1234567890))
        .unwrap();
    let result = controller.snapshot().unwrap();
    assert!(result.agents[0].enabled);
    assert!(matches!(result.agents[0].status, ProcessStatus::Running));
    let output = wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 10).then(|| text.to_owned())
    });
    assert_eq!(output.lines().nth(8), Some("1234567890"));
    assert!(!fs::read_to_string(dir.path().join("config/agents.json"))
        .unwrap()
        .contains("1234567890"));
    controller.shutdown().unwrap();
    controller.restore().unwrap();
    let output = wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 20).then(|| text.to_owned())
    });
    assert_eq!(output.lines().nth(18), Some(""));
    controller.action(&a.id, Action::Stop).unwrap();
}

fn deployment_defaults() -> crate::BuildDefaults {
    crate::BuildDefaults {
        host: "https://build.example.com".into(),
        filter: "team-*".into(),
        model: "build-model".into(),
        provider: "databricks_v2".into(),
        owner_only: true,
    }
}

#[cfg(unix)]
#[test]
fn build_floor_agrees_at_command_oauth_and_discovery_without_rewriting_saved_agent() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = bundle(dir.path());
    let mut agent = agent(dir.path());
    agent.harness.provider.clear();
    agent.harness.model.clear();
    agent.imported["record"]["respond_to"] = json!("anyone");
    let before = serde_json::to_value(&agent).unwrap();
    let defaults = deployment_defaults();
    let key = Secret::parse(KEY, PUB).unwrap();
    let command = bundle
        .command_with_defaults(&agent, &key, &defaults)
        .unwrap();
    let env: BTreeMap<_, _> = command
        .get_envs()
        .map(|(k, v)| (k.to_str().unwrap(), v.and_then(|v| v.to_str())))
        .collect();
    assert_eq!(env["BUZZ_AGENT_PROVIDER"], Some("databricks_v2"));
    assert_eq!(env["BUZZ_AGENT_MODEL"], Some("build-model"));
    assert_eq!(env["BUZZ_ACP_MODEL"], Some("build-model"));
    assert_eq!(env["BUZZ_ACP_RESPOND_TO"], Some("owner-only"));
    assert_eq!(env["BUZZ_ACP_SESSION_POLICY"], Some("channel"));
    assert_eq!(env["BUZZ_ACP_ALLOWED_RESPOND_TO"], Some("owner-only"));
    assert_eq!(
        env.get("BUZZ_ACP_RESPOND_TO_ALLOWLIST").copied().flatten(),
        None
    );
    let settings = databricks_with_defaults(&agent, &defaults)
        .unwrap()
        .unwrap();
    let context =
        model_context_with_defaults(&agent.harness, &agent.environment, &defaults).unwrap();
    assert_eq!(context.host.as_deref(), Some(settings.host.as_str()));
    assert_eq!(context.filter.as_deref(), Some(settings.filter.as_str()));
    assert_eq!(settings.host, defaults.host);
    assert_eq!(serde_json::to_value(&agent).unwrap(), before);
    // Default-on is a presence capability; unmarked builds retain imported policy.
    let public = crate::BuildDefaults::default();
    let command = bundle.command_with_defaults(&agent, &key, &public).unwrap();
    assert!(command
        .get_envs()
        .any(|(k, v)| k == "BUZZ_ACP_RESPOND_TO" && v == Some(std::ffi::OsStr::new("anyone"))));
    agent.session_policy = Some(crate::config::SessionPolicy::Thread);
    let command = bundle.command_with_defaults(&agent, &key, &public).unwrap();
    assert!(command
        .get_envs()
        .any(|(k, v)| k == "BUZZ_ACP_SESSION_POLICY" && v == Some(std::ffi::OsStr::new("thread"))));
}

#[test]
fn databricks_workspace_errors_distinguish_missing_configuration_from_invalid_origins() {
    let dir = tempfile::tempdir().unwrap();
    let mut agent = agent(dir.path());
    agent.harness.provider = "databricks_v2".into();
    let defaults = crate::BuildDefaults::default();
    let error = databricks_with_defaults(&agent, &defaults).err().unwrap();
    assert!(error.contains("Databricks workspace is not configured"));
    assert!(error.contains("Edit the agent, open Advanced → Model"));
    assert!(error.contains("Databricks workspace (HTTPS origin)"));
    // Empty offline drafts remain saveable; runtime validation supplies guidance.
    crate::connection::DatabricksSettings::default()
        .validate()
        .unwrap();
    for host in [
        "http://workspace.example",
        "https://user:SYNTHETIC@workspace.example",
        "https://workspace.example/path",
    ] {
        agent
            .environment
            .insert("DATABRICKS_HOST".into(), host.into());
        let error = databricks_with_defaults(&agent, &defaults).err().unwrap();
        assert!(error.contains("Enter a Databricks HTTPS workspace origin"));
        assert!(!error.contains("SYNTHETIC"));
        assert!(!error.contains("not configured"));
    }
    agent.environment.insert(
        "DATABRICKS_HOST".into(),
        "https://WORKSPACE.example:443/".into(),
    );
    assert_eq!(
        databricks_with_defaults(&agent, &defaults)
            .unwrap()
            .unwrap()
            .host,
        "https://workspace.example"
    );
}

#[test]
fn saved_selectors_and_environment_override_build_floor_including_empty() {
    let dir = tempfile::tempdir().unwrap();
    let mut agent = agent(dir.path());
    let defaults = deployment_defaults();
    agent.harness.provider = "databricks_v2".into();
    agent.harness.databricks = Some(crate::connection::DatabricksSettings {
        host: "https://saved.example.com".into(),
        filter: "".into(),
    });
    let harness = defaults.resolve(&agent.harness, &agent.environment);
    assert_eq!(harness.model, "test-model");
    assert_eq!(
        databricks_with_defaults(&agent, &defaults)
            .unwrap()
            .unwrap()
            .host,
        "https://saved.example.com"
    );
    agent.environment.insert(
        "DATABRICKS_HOST".into(),
        "https://override.example.com".into(),
    );
    let context =
        model_context_with_defaults(&agent.harness, &agent.environment, &defaults).unwrap();
    assert_eq!(
        context.host.as_deref(),
        Some("https://override.example.com")
    );
    assert_eq!(context.filter.as_deref(), Some(""));
    agent
        .environment
        .insert("BUZZ_AGENT_MODEL".into(), "".into());
    assert!(defaults
        .resolve(&agent.harness, &agent.environment)
        .model
        .is_empty());
    agent
        .environment
        .insert("DATABRICKS_HOST".into(), "".into());
    assert!(databricks_with_defaults(&agent, &defaults).is_err());
    agent
        .environment
        .insert("BUZZ_AGENT_PROVIDER".into(), "".into());
    assert!(databricks_with_defaults(&agent, &defaults)
        .unwrap()
        .is_none());
    assert!(model_context_with_defaults(&agent.harness, &agent.environment, &defaults).is_err());
    agent.environment.remove("BUZZ_AGENT_PROVIDER");
    agent
        .environment
        .insert("DATABRICKS_TOKEN".into(), "SYNTHETIC".into());
    assert!(databricks_with_defaults(&agent, &defaults).is_err());
    assert!(model_context_with_defaults(&agent.harness, &agent.environment, &defaults).is_err());
}

#[test]
fn launch_selectors_show_defaults_blanks_and_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let mut agent = agent(dir.path());
    agent.harness.provider.clear();
    agent.harness.model.clear();
    let defaults = deployment_defaults();
    let resolved = defaults.resolve(&agent.harness, &agent.environment);
    let blank = crate::defaults::selectors(&resolved, &agent.environment);
    assert_eq!(blank.provider, Some(defaults.provider.as_str()));
    assert_eq!(blank.model, Some(defaults.model.as_str()));
    // Saved selector plus an explicit override: the override is launched.
    agent.harness.model = "saved-model".into();
    agent
        .environment
        .insert("BUZZ_AGENT_MODEL".into(), "override-model".into());
    // The view names the deciding override key, never its value.
    let view = agent.view(&Default::default());
    assert_eq!(view.harness.model, "saved-model");
    assert_eq!(view.launch_model, None);
    assert_eq!(view.launch_model_env, Some("BUZZ_AGENT_MODEL"));
    agent.harness.command = "/usr/local/bin/goose".into();
    agent.environment.clear();
    agent.harness.provider = "saved-provider".into();
    agent
        .environment
        .insert("GOOSE_PROVIDER".into(), "override-provider".into());
    let view = agent.view(&Default::default());
    assert_eq!(view.launch_model.as_deref(), Some("saved-model"));
    assert_eq!(view.launch_model_env, None);
    assert_eq!(view.launch_provider, None);
    assert_eq!(view.launch_provider_env, Some("GOOSE_PROVIDER"));
    agent.harness.model.clear();
    agent.environment.clear();
    agent.harness.provider.clear();
    let view = agent.view(&Default::default());
    assert!(view.launch_model.is_none() && view.launch_provider.is_none());
}

#[test]
fn external_harnesses_never_receive_buzz_agent_build_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let mut agent = agent(dir.path());
    agent.harness.command = "/usr/local/bin/goose".into();
    agent.harness.provider.clear();
    agent.harness.model.clear();
    let harness = deployment_defaults().resolve(&agent.harness, &agent.environment);
    assert!(harness.provider.is_empty());
    assert!(harness.model.is_empty());
    assert!(harness.databricks.is_none());
}

#[test]
#[cfg(unix)]
fn goose_model_context_uses_effective_draft_provider_without_projecting_secrets() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let goose = dir.path().join("goose");
    fs::write(&goose, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&goose, fs::Permissions::from_mode(0o700)).unwrap();
    let edit = |override_provider: Option<&str>| AgentEdit {
        picture: None,
        name: "Goose".into(),
        system_prompt: String::new(),
        session_policy: Some(None),
        workspace: dir.path().display().to_string(),
        harness: HarnessEdit {
            command: goose.display().to_string(),
            args: vec!["acp".into()],
            model: "short-name".into(),
            provider: "databricks_v2".into(),
            databricks: None,
        },
        environment: BTreeMap::from([
            (
                "DATABRICKS_HOST".into(),
                Some("https://workspace.example".into()),
            ),
            ("GOOSE_MODEL".into(), Some("effective-model".into())),
            (
                "GOOSE_PROVIDER".into(),
                override_provider.map(str::to_owned),
            ),
        ]),
    };
    let context = Controller::draft_goose_model_context(edit(None)).unwrap();
    assert_eq!(context.command, goose);
    assert_eq!(context.provider_id, "databricks_v2");
    assert_eq!(context.model_id, "effective-model");
    assert_eq!(context.workspace, dir.path());
    assert!(context.model_overridden);
    assert_eq!(
        context.environment["DATABRICKS_HOST"],
        "https://workspace.example"
    );
    assert!(!context.environment.contains_key("GOOSE_PROVIDER"));
    assert_eq!(
        Controller::draft_goose_model_context(edit(Some("openai")))
            .unwrap()
            .provider_id,
        "openai"
    );
}

#[test]
fn discovery_accepts_only_v2_from_saved_environment_or_build_provider() {
    let dir = tempfile::tempdir().unwrap();
    for provider in ["databricks_v2", "databricks-v2", "databricks"] {
        for source in ["saved", "environment", "build"] {
            let mut agent = agent(dir.path());
            let mut defaults = deployment_defaults();
            agent.harness.provider.clear();
            match source {
                "saved" => agent.harness.provider = provider.into(),
                "environment" => {
                    agent
                        .environment
                        .insert("BUZZ_AGENT_PROVIDER".into(), provider.into());
                }
                _ => defaults.provider = provider.into(),
            }
            let context =
                model_context_with_defaults(&agent.harness, &agent.environment, &defaults);
            assert_eq!(
                context.is_ok(),
                provider != "databricks",
                "{source}: {provider}"
            );
            // Legacy manual selection still resolves the same OAuth workspace for Start.
            assert_eq!(
                databricks_with_defaults(&agent, &defaults)
                    .unwrap()
                    .unwrap()
                    .host,
                defaults.host
            );
        }
    }
}

#[test]
#[cfg(unix)]
fn pi_selection_and_extensions_survive_save_reopen_and_reach_adapter() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let runtime = bundle(tools.path());
    let adapter = tools.path().join("buzz-pi-acp");
    fs::write(&adapter, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();
    let extension = tools.path().join("extension with spaces.ts");
    fs::write(&extension, "export default function() {};").unwrap();
    let mut a = agent(dir.path());
    a.harness.command = adapter.display().to_string();
    a.imported["record"]["respond_to"] = json!("anyone");
    a.harness.provider = "custom".into();
    a.harness.model = "namespace/exact.id".into();
    a.harness.args = vec![
        "--".into(),
        "--extension".into(),
        extension.display().to_string(),
    ];
    for tool in ["pi", "node"] {
        fs::copy(&adapter, tools.path().join(tool)).unwrap();
    }
    a.environment.insert(
        "PI_CODING_AGENT_DIR".into(),
        dir.path().display().to_string(),
    );
    let root = dir.path().join("config");
    Store::open(root.clone())
        .unwrap()
        .insert(vec![a.clone()])
        .unwrap();
    let store = Store::open(root).unwrap();
    let saved = store.agents().unwrap().remove(0);
    let key = Secret::parse(KEY, PUB).unwrap();
    let command = runtime
        .command_with_defaults(&saved, &key, &deployment_defaults())
        .unwrap();
    let env: BTreeMap<_, _> = command
        .get_envs()
        .filter_map(|(k, v)| v.map(|v| (k.to_str().unwrap(), v.to_str().unwrap())))
        .collect();
    assert_eq!(env["BUZZ_ACP_MODEL"], "custom/namespace/exact.id");
    assert_eq!(env["BUZZ_ACP_RESPOND_TO"], "owner-only");
    assert_eq!(env["BUZZ_ACP_ALLOWED_RESPOND_TO"], "owner-only");
    for key in [
        "BUZZ_AGENT_PROVIDER",
        "BUZZ_AGENT_MODEL",
        "DATABRICKS_HOST",
        "DATABRICKS_MODEL_FILTER",
    ] {
        assert!(!env.contains_key(key));
    }
    assert_eq!(
        env["BUZZ_ACP_AGENT_ARGS"],
        format!(
            "--,--extension,{},--provider,custom,--model,namespace/exact.id",
            extension.display()
        )
    );
    assert!(!env.contains_key("GOOSE_MODEL"));
    let controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(runtime),
        dir.path().join("ownership"),
    );
    let edit = AgentEdit {
        name: a.name.clone(),
        picture: None,
        system_prompt: a.system_prompt.clone(),
        session_policy: Some(None),
        workspace: a.workspace.clone(),
        harness: a.harness.clone(),
        environment: BTreeMap::new(),
    };
    let context = controller.pi_model_context(&a.id, 1, edit.clone()).unwrap();
    assert_eq!(context.args, a.harness.args[1..]);
    assert_eq!(
        context.environment["PI_CODING_AGENT_DIR"],
        dir.path().display().to_string()
    );
    assert!(controller.pi_model_context(&a.id, 2, edit.clone()).is_err());
    let mut patch = edit.clone();
    patch.environment.insert(
        "PI_CODING_AGENT_DIR".into(),
        Some("/override/config".into()),
    );
    let context = controller
        .pi_model_context(&a.id, 1, patch.clone())
        .unwrap();
    assert_eq!(
        context.environment["PI_CODING_AGENT_DIR"],
        "/override/config"
    );
    patch.environment.insert("PI_CODING_AGENT_DIR".into(), None);
    assert!(!controller
        .pi_model_context(&a.id, 1, patch)
        .unwrap()
        .environment
        .contains_key("PI_CODING_AGENT_DIR"));
    // Draft resolution did not mutate the saved override.
    assert_eq!(
        controller.store.agents().unwrap()[0].environment["PI_CODING_AGENT_DIR"],
        a.environment["PI_CODING_AGENT_DIR"]
    );
    for (provider, model) in [
        ("custom".to_owned(), "a,b".to_owned()),
        ("custom".to_owned(), "-model".to_owned()),
        ("custom,other".to_owned(), "model".to_owned()),
        ("-provider".to_owned(), "model".to_owned()),
        ("bad/provider".to_owned(), "model".to_owned()),
        ("p".repeat(129), "model".to_owned()),
        ("custom".to_owned(), "m".repeat(513)),
    ] {
        let mut invalid = saved.clone();
        invalid.harness.provider = provider;
        invalid.harness.model = model;
        assert!(controller
            .bundle
            .as_ref()
            .unwrap()
            .command(&invalid, &key)
            .is_err());
    }
    let mut configured = saved.clone();
    configured.harness.model.clear();
    assert!(controller
        .bundle
        .as_ref()
        .unwrap()
        .command(&configured, &key)
        .unwrap_err()
        .contains("Choose a Pi model"));
    configured.harness.provider.clear();
    configured.harness.args = vec![
        "--".into(),
        "--thinking".into(),
        "high".into(),
        "--skill".into(),
        "/local/skill".into(),
        "--tools".into(),
        "read".into(),
    ];
    let launch = controller
        .bundle
        .as_ref()
        .unwrap()
        .command_with_defaults(&configured, &key, &deployment_defaults())
        .unwrap();
    assert!(launch.get_envs().all(|(key, _)| key != "BUZZ_ACP_MODEL"));
    assert_eq!(
        launch
            .get_envs()
            .find(|(k, _)| *k == "BUZZ_ACP_AGENT_ARGS")
            .unwrap()
            .1
            .unwrap(),
        "--,--thinking,high,--skill,/local/skill,--tools,read"
    );
    let mut advanced = edit;
    advanced.harness.args = configured.harness.args.clone();
    let context = Controller::draft_pi_model_context(advanced.clone()).unwrap();
    assert_eq!(
        context.catalog_args().unwrap(),
        configured.harness.args[1..]
    );
    advanced.harness.args = vec![
        "--".into(),
        "--provider".into(),
        "old".into(),
        "--model".into(),
        "invalid".into(),
    ];
    assert!(Controller::draft_pi_model_context(advanced.clone())
        .unwrap()
        .catalog_args()
        .unwrap()
        .is_empty());
    for unsupported in [
        vec!["--custom-extension-flag"],
        vec!["--extension=/local/extension.ts"],
        vec!["--api-key", "synthetic-key"],
        vec!["a prompt"],
    ] {
        advanced.harness.args = std::iter::once("--")
            .chain(unsupported)
            .map(str::to_owned)
            .collect();
        assert!(Controller::draft_pi_model_context(advanced.clone())
            .unwrap()
            .catalog_args()
            .is_err());
        configured.harness.args = advanced.harness.args.clone();
        assert!(controller
            .bundle
            .as_ref()
            .unwrap()
            .command(&configured, &key)
            .is_ok());
    }
}

#[test]
#[cfg(unix)]
fn imported_team_reaches_acp_without_weakening_remote_mesh_or_owner_guards() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = bundle(dir.path());
    let key = Secret::parse(KEY, PUB).unwrap();
    let mut a = agent(dir.path());
    a.imported["record"]["team_id"] = json!("crew");
    a.imported["record"]["persona_team_dir"] = json!("/old/pack");
    assert!(runtime
        .command(&a, &key)
        .err()
        .unwrap()
        .contains("Repair team import"));
    for text in ["", "review carefully"] {
        a.imported["teamInstructions"] = json!(text);
        let command = runtime.command(&a, &key).unwrap();
        let env: BTreeMap<_, _> = command.get_envs().collect();
        assert_eq!(
            env[std::ffi::OsStr::new("BUZZ_ACP_TEAM_INSTRUCTIONS")],
            Some(std::ffi::OsStr::new(text))
        );
        assert_eq!(
            env[std::ffi::OsStr::new("BUZZ_ACP_SYSTEM_PROMPT")],
            Some(std::ffi::OsStr::new("test prompt"))
        );
    }
    for (field, value) in [
        ("backend", json!({"type":"provider"})),
        ("relay_mesh", json!({})),
    ] {
        let mut unsupported = a.clone();
        unsupported.imported["record"][field] = value;
        assert!(runtime
            .command(&unsupported, &key)
            .err()
            .unwrap()
            .contains("remote/mesh"));
    }
    let mut mesh = a.clone();
    mesh.harness.provider = "relay-mesh".into();
    assert!(runtime
        .command(&mesh, &key)
        .err()
        .unwrap()
        .contains("remote/mesh"));
    a.auth_tag = None;
    assert!(runtime
        .command(&a, &key)
        .err()
        .unwrap()
        .contains("owner attestation"));
}

#[test]
#[cfg(unix)]
fn import_and_repair_deliver_team_instructions_to_a_started_process() {
    for repairing in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let tools = tempfile::tempdir().unwrap();
        let old = tempfile::tempdir().unwrap();
        let source = old
            .path()
            .join(crate::LegacySource::Installed.app_directory())
            .join("agents");
        fs::create_dir_all(&source).unwrap();
        let mut saved = agent(dir.path());
        saved.imported["record"]["team_id"] = json!("crew");
        let record = json!({"pubkey":PUB,"private_key_nsec":KEY,"name":"Old name","team_id":"crew","auth_tag":saved.auth_tag,"system_prompt":"Old prompt"});
        fs::write(
            source.join("managed-agents.json"),
            serde_json::to_vec(&json!([record])).unwrap(),
        )
        .unwrap();
        let instructions = "Team instructions\nKeep the deployment contract.";
        fs::write(
            source.join("teams.json"),
            serde_json::to_vec(&json!([{"id":"crew","instructions":instructions}])).unwrap(),
        )
        .unwrap();
        let mut store = Store::open(dir.path().join("config")).unwrap();
        if repairing {
            store.insert(vec![saved.clone()]).unwrap();
        }
        let mut controller = Controller::new(
            store,
            Arc::new(Memory),
            Ok(bundle(tools.path())),
            dir.path().join("ownership"),
        );
        if repairing {
            let blocked = controller.action(&saved.id, Action::Start).unwrap();
            assert!(blocked.agents[0]
                .error
                .as_ref()
                .unwrap()
                .contains("Repair team import"));
            assert!(controller.running.is_empty());
            controller.action(&saved.id, Action::Stop).unwrap();
        }
        let mut imports = crate::Imports::default();
        let preview = imports
            .preview(
                crate::LegacySource::Installed,
                old.path().into(),
                dir.path().into(),
                &saved.relay_url,
            )
            .unwrap();
        let prepared = controller
            .prepare_import(&mut imports, &preview.token, &[saved.id.clone()])
            .unwrap();
        imports.discard();
        controller
            .commit_import(prepared.acquire(&Memory).unwrap())
            .unwrap();
        let snapshot = controller.snapshot().unwrap();
        assert!(!snapshot.agents[0].enabled);
        assert!(!snapshot.agents[0].needs_team_import);
        assert!(controller.running.is_empty());
        assert!(!dir.path().join("team-instructions").exists());
        if repairing {
            assert_eq!(snapshot.agents[0].name, saved.name);
            assert_eq!(snapshot.agents[0].revision, saved.revision + 1);
        }
        let started = controller.action(&saved.id, Action::Start).unwrap();
        assert!(
            matches!(started.agents[0].status, ProcessStatus::Running),
            "{:?}",
            started.agents[0].error
        );
        wait_for_contents(&dir.path().join("team-instructions"), |text| {
            (text == instructions).then_some(())
        });
        assert!(matches!(
            controller.action(&saved.id, Action::Stop).unwrap().agents[0].status,
            ProcessStatus::Stopped
        ));
        assert!(controller.running.is_empty());
    }
}

#[cfg(unix)]
#[test]
fn managed_prefix_detection_and_shim_launch_path_use_pinned_node() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let app_data = dir.path();
    let prefix = app_data.join("node-tools/bin");
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        _ => return,
    };
    let node_bin = app_data
        .join("runtimes/node/v24.18.0")
        .join(platform)
        .join("bin");
    fs::create_dir_all(&prefix).unwrap();
    fs::create_dir_all(&node_bin).unwrap();
    for path in [
        prefix.join("pi"),
        prefix.join("buzz-pi-acp"),
        node_bin.join("node"),
    ] {
        let script = if path.file_name().is_some_and(|name| name == "node") {
            "#!/bin/sh\nprintf 'managed-node\\n'\n"
        } else {
            "#!/usr/bin/env node\n"
        };
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert_eq!(
        managed_tool(app_data, "buzz-pi-acp"),
        Some(prefix.join("buzz-pi-acp"))
    );
    assert_eq!(managed_tool(app_data, "node"), Some(node_bin.join("node")));
    assert!(managed_tool(app_data, "goose").is_none());
    let mut harness = agent(dir.path()).harness;
    harness.command = prefix.join("buzz-pi-acp").display().to_string();
    harness.args.clear();
    let context =
        crate::pi::PiContext::new(&harness, dir.path().to_str().unwrap(), &BTreeMap::new())
            .unwrap();
    assert_eq!(context.command, prefix.join("pi"));
    assert_eq!(
        context.environment["PI_ACP_PI_COMMAND"],
        prefix.join("pi").display().to_string()
    );
    assert_eq!(
        std::env::split_paths(&context.path).next().unwrap(),
        node_bin
    );
    assert_eq!(std::env::split_paths(&context.path).nth(1).unwrap(), prefix);
    let output = std::process::Command::new(&context.command)
        .env_clear()
        .env("PATH", &context.path)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"managed-node\n");
    fs::remove_file(node_bin.join("node")).unwrap();
    assert!(
        crate::pi::PiContext::new(&harness, dir.path().to_str().unwrap(), &BTreeMap::new())
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn agent_value_beats_agent_default_which_beats_build_default() {
    let dir = tempfile::tempdir().unwrap();
    let bundle = bundle(dir.path());
    let key = Secret::parse(KEY, PUB).unwrap();
    let mut blank = agent(dir.path());
    blank.harness.provider.clear();
    blank.harness.model.clear();
    blank.imported["record"]
        .as_object_mut()
        .unwrap()
        .remove("effort_level");
    let env = |agent: &Agent| {
        let command = bundle
            .command_with_defaults(agent, &key, &deployment_defaults())
            .unwrap();
        command
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_str()?.to_owned(), v?.to_str()?.to_owned())))
            .collect::<BTreeMap<_, _>>()
    };
    // Build floor only.
    assert_eq!(env(&blank)["BUZZ_AGENT_MODEL"], "build-model");
    assert!(!env(&blank).contains_key("BUZZ_ACP_EFFORT_LEVEL"));
    let defaults = crate::agent_defaults::AgentDefaults {
        harness: "buzz-agent".into(),
        provider: "databricks_v2".into(),
        model: "global-model".into(),
        effort: "medium".into(),
        session_policy: crate::config::SessionPolicy::Channel,
        environment: BTreeMap::from([
            ("PROVIDER_TEST_SETTING".into(), "global-value".into()),
            ("GLOBAL_SETTING".into(), "global-value".into()),
        ]),
    };
    let inherited = env(&crate::agent_defaults::effective(&blank, &defaults));
    assert_eq!(inherited["BUZZ_AGENT_MODEL"], "global-model");
    assert_eq!(inherited["BUZZ_ACP_EFFORT_LEVEL"], "medium");
    assert_eq!(inherited["PROVIDER_TEST_SETTING"], "explicit-value");
    assert_eq!(inherited["GLOBAL_SETTING"], "global-value");
    let mut own = blank.clone();
    own.harness.model = "agent-model".into();
    own.imported["record"]["effort_level"] = json!("low");
    let own = env(&crate::agent_defaults::effective(&own, &defaults));
    assert_eq!(own["BUZZ_AGENT_MODEL"], "agent-model");
    assert_eq!(own["BUZZ_ACP_EFFORT_LEVEL"], "low");
}

#[test]
#[cfg(unix)]
fn inherited_default_changes_reach_restart_diff_and_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("config")).unwrap();
    let mut a = agent(dir.path());
    a.harness.model.clear();
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let edit = |model: &str| crate::AgentDefaultsEdit {
        harness: "buzz-agent".into(),
        provider: String::new(),
        model: model.into(),
        effort: String::new(),
        session_policy: Some(crate::config::SessionPolicy::Channel),
        environment: BTreeMap::new(),
    };
    controller.save_defaults(edit("first-default")).unwrap();
    controller.action(&a.id, Action::Start).unwrap();
    let first = wait_for_contents(&dir.path().join("starts"), |text| {
        (text.lines().count() == 10).then(|| text.to_owned())
    });
    assert_eq!(first.lines().nth(3), Some("first-default"));
    let before = controller.running_settings().unwrap();
    let saved = controller.save_defaults(edit("second-default")).unwrap();
    let fields: Vec<_> = saved.agents[0]
        .restart_diff
        .iter()
        .map(|e| e.field.as_str())
        .collect();
    assert_eq!(fields, ["model"]);
    assert_eq!(
        saved.agents[0].launch_model.as_deref(),
        Some("second-default")
    );
    assert_ne!(controller.running_settings().unwrap(), before);
    // An unrelated defaults edit leaves effective settings unchanged.
    let before = controller.running_settings().unwrap();
    let mut other = edit("second-default");
    other.environment = BTreeMap::from([("PROVIDER_TEST_SETTING".into(), Some("hidden".into()))]);
    controller.save_defaults(other).unwrap();
    assert_eq!(controller.running_settings().unwrap(), before);
    // A failed Stop can persist disabled intent while its listener remains live.
    // Saving defaults must not select it for a restart or re-enable it.
    controller.store.enabled(&a.id, false).unwrap();
    let disabled = controller.snapshot().unwrap();
    assert!(disabled.agents[0].status == ProcessStatus::Running);
    assert!(!disabled.agents[0].enabled);
    assert!(controller.running_settings().unwrap().is_empty());
    controller.shutdown().unwrap();
    assert!(controller.running_settings().unwrap().is_empty());
}

#[test]
#[cfg(unix)]
fn saved_databricks_workspace_launches_without_inheriting_global_host_or_restart() {
    let dir = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("config")).unwrap();
    let mut a = agent(dir.path());
    a.harness.provider = "databricks_v2".into();
    a.harness.databricks = Some(crate::connection::DatabricksSettings {
        host: "https://agent.example".into(),
        filter: "agent-*".into(),
    });
    store.insert(vec![a.clone()]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(bundle(tools.path())),
        dir.path().join("ownership"),
    );
    let edit = |host: &str, filter: &str| crate::AgentDefaultsEdit {
        harness: "buzz-agent".into(),
        provider: "databricks_v2".into(),
        model: String::new(),
        effort: String::new(),
        session_policy: Some(crate::config::SessionPolicy::Channel),
        environment: BTreeMap::from([
            ("DATABRICKS_HOST".into(), Some(host.into())),
            ("DATABRICKS_MODEL_FILTER".into(), Some(filter.into())),
        ]),
    };
    controller
        .save_defaults(edit("https://global.example", "global-*"))
        .unwrap();
    controller.action(&a.id, Action::Start).unwrap();
    let env = wait_for_contents(&dir.path().join("runtime-env"), |text| {
        (text.lines().count() == 6).then(|| text.to_owned())
    });
    assert_eq!(env.lines().nth(1), Some("https://agent.example"));
    assert_eq!(env.lines().nth(2), Some("agent-*"));
    assert_eq!(
        controller.running[&a.id].databricks_host.as_deref(),
        Some("https://agent.example")
    );
    let before = controller.running_settings().unwrap();
    let snapshot = controller
        .save_defaults(edit("https://next-global.example", "next-global-*"))
        .unwrap();
    assert_eq!(controller.running_settings().unwrap(), before);
    assert!(snapshot.agents[0].restart_diff.is_empty());

    let mut blank = a.clone();
    blank.harness.databricks = None;
    let inherited = crate::agent_defaults::effective(&blank, &controller.store.defaults().unwrap());
    let settings = effective_databricks(&inherited).unwrap().unwrap();
    assert_eq!(settings.host, "https://next-global.example");
    assert_eq!(settings.filter, "next-global-*");
    controller.shutdown().unwrap();
}

#[test]
fn restart_comparison_ignores_overridden_selectors_without_exposing_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = agent(dir.path());
    a.harness.command = "/usr/local/bin/goose".into();
    a.harness.model.clear();
    a.harness.provider.clear();
    a.environment
        .insert("GOOSE_MODEL".into(), "secret-model".into());
    a.environment
        .insert("GOOSE_PROVIDER".into(), "secret-provider".into());
    let defaults = |model: &str, provider: &str| crate::agent_defaults::AgentDefaults {
        harness: "goose".into(),
        provider: provider.into(),
        model: model.into(),
        ..Default::default()
    };
    let first = crate::restart::spawn_config(&crate::agent_defaults::effective(
        &a,
        &defaults("global-one", "provider-one"),
    ));
    let second = crate::restart::spawn_config(&crate::agent_defaults::effective(
        &a,
        &defaults("global-two", "provider-two"),
    ));
    assert_eq!(
        first, second,
        "overridden global selectors must not restart"
    );
    assert!(crate::restart::diff(&first, &second).is_empty());
    a.environment
        .insert("GOOSE_MODEL".into(), "other-secret".into());
    let changed = crate::restart::spawn_config(&crate::agent_defaults::effective(
        &a,
        &defaults("global-two", "provider-two"),
    ));
    let diff = serde_json::to_string(&crate::restart::diff(&first, &changed)).unwrap();
    assert!(diff.contains("GOOSE_MODEL"));
    assert!(!diff.contains("secret-model") && !diff.contains("other-secret"));
}

#[test]
fn databricks_environment_override_is_not_projected_as_a_restart_selector() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = agent(dir.path());
    a.harness.provider = "databricks_v2".into();
    a.harness.model.clear();
    a.environment
        .insert("DATABRICKS_MODEL".into(), "secret-model".into());
    a.environment
        .insert("DATABRICKS_HOST".into(), "https://private.example".into());
    a.harness.databricks = Some(crate::connection::DatabricksSettings {
        host: "https://old.example".into(),
        filter: String::new(),
    });
    let first = crate::restart::spawn_config(&a);
    let matching_default = crate::agent_defaults::AgentDefaults {
        harness: "buzz-agent".into(),
        model: "secret-model".into(),
        ..Default::default()
    };
    assert_eq!(
        first,
        crate::restart::spawn_config(&crate::agent_defaults::effective(&a, &matching_default)),
        "setting the same model must not restart even if the source changes"
    );
    a.harness.databricks.as_mut().unwrap().host = "https://new.example".into();
    let second = crate::restart::spawn_config(&a);
    assert_eq!(first, second, "env overrides the saved workspace host");
    a.environment
        .insert("DATABRICKS_MODEL".into(), "new-secret".into());
    let third = crate::restart::spawn_config(&a);
    let entries = crate::restart::diff(&first, &third);
    assert!(matches!(
        entries.iter().find(|e| e.field == "model").unwrap().change,
        crate::restart::RestartChange::Masked { .. }
    ));
    let wire = serde_json::to_string(&entries).unwrap();
    assert!(wire.contains("DATABRICKS_MODEL"));
    assert!(!wire.contains("secret-model") && !wire.contains("new-secret"));
}

#[test]
fn retained_import_cannot_enable_or_open_credentials_until_explicit_setup() {
    let root = tempfile::tempdir().unwrap();
    let mut imported = agent(root.path());
    imported.extra.insert("configured".into(), json!(false));
    let id = imported.id.clone();
    let mut store = Store::open(root.path().into()).unwrap();
    store.insert(vec![imported]).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Err("No runtime".into()),
        root.path().join("locks"),
    );
    assert!(controller.action(&id, Action::Start).unwrap().agents[0]
        .error
        .as_ref()
        .unwrap()
        .contains("Use here"));
    assert!(controller.credential_request(&id).is_err());
    assert!(controller.launch_ids().unwrap().is_empty());
    assert!(!controller.restore().unwrap().agents[0].enabled);
    let resolution = crate::community::tests::resolution("wss://relay.example");
    let snapshot = controller.use_here(&id, resolution).unwrap();
    assert!(snapshot.agents[0].configured);
    assert!(!snapshot.agents[0].enabled);
    assert_eq!(snapshot.agents[0].pubkey, PUB);
}
#[test]
fn use_here_clears_retained_startup_intent_until_an_explicit_start() {
    // (destination, explicit startup preference, legacy enabled)
    for (relay, explicit, legacy) in [
        ("wss://relay.example", Some(true), false),
        ("wss://other.example", Some(true), false),
        ("wss://relay.example", None, true),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut imported = agent(root.path());
        imported.extra.insert("configured".into(), json!(false));
        imported.start_on_app_launch = explicit;
        imported.enabled = legacy;
        let id = imported.id.clone();
        let mut store = Store::open(root.path().into()).unwrap();
        store.insert(vec![imported]).unwrap();
        let mut controller = Controller::new(
            store,
            Arc::new(Memory),
            Err("No runtime".into()),
            root.path().join("locks"),
        );
        assert!(controller.launch_ids().unwrap().is_empty(), "{relay}");
        let snapshot = controller
            .use_here(&id, crate::community::tests::resolution(relay))
            .unwrap();
        assert!(controller.launch_ids().unwrap().is_empty(), "{relay}");
        let target = agent_id(PUB, relay);
        let saved = snapshot.agents.iter().find(|a| a.id == target).unwrap();
        assert!(saved.configured);
        assert!(!saved.enabled);
        assert!(!saved.start_on_app_launch);
        // Reopening the saved state must not restore a running agent.
        drop(controller);
        let reopened = Controller::new(
            Store::open(root.path().into()).unwrap(),
            Arc::new(Memory),
            Err("No runtime".into()),
            root.path().join("locks"),
        );
        assert!(reopened.launch_ids().unwrap().is_empty(), "{relay}");
    }
}

#[test]
fn use_here_retry_keeps_a_configured_agent_startup_preference() {
    let root = tempfile::tempdir().unwrap();
    let mut configured = agent(root.path());
    configured.enabled = true;
    configured.start_on_app_launch = Some(true);
    let id = configured.id.clone();
    let mut store = Store::open(root.path().into()).unwrap();
    store.insert(vec![configured]).unwrap();
    let path = root.path().join("agents.json");
    let before = fs::read(&path).unwrap();
    store
        .use_here(
            &id,
            crate::community::tests::resolution("wss://relay.example"),
        )
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn use_here_rejects_configured_other_community_without_writes() {
    let root = tempfile::tempdir().unwrap();
    let mut original = agent(root.path());
    original.enabled = true;
    let id = original.id.clone();
    let mut store = Store::open(root.path().into()).unwrap();
    store.insert(vec![original]).unwrap();
    let path = root.path().join("agents.json");
    let before = fs::read(&path).unwrap();
    let error = store
        .use_here(
            &id,
            crate::community::tests::resolution("wss://other.example"),
        )
        .unwrap_err();
    assert!(error.contains("Clone"));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn use_here_recovers_incomplete_import_but_cannot_add_a_third_community() {
    let root = tempfile::tempdir().unwrap();
    let mut imported = agent(root.path());
    imported.extra.insert("configured".into(), json!(false));
    let id = imported.id.clone();
    let mut store = Store::open(root.path().into()).unwrap();
    store.insert(vec![imported]).unwrap();
    let path = root.path().join("agents.json");
    let before = fs::read(&path).unwrap();
    let mut forged = crate::community::tests::resolution("wss://other.example");
    forged.relay_url = "wss://attacker.example".into();
    assert!(store.use_here(&id, forged).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    store
        .use_here(
            &id,
            crate::community::tests::resolution("wss://other.example"),
        )
        .unwrap();
    let agents = store.agents().unwrap();
    assert!(!agents[0].configured());
    assert!(agents[1].configured());
    assert!(!agents[1].enabled);
    assert_eq!(agents[1].pubkey, agents[0].pubkey);
    assert_eq!(agents[1].credential_id, agents[0].credential_id);
    let after = fs::read(&path).unwrap();
    // A delayed retry of the completed recovery is harmless.
    store
        .use_here(
            &id,
            crate::community::tests::resolution("wss://other.example"),
        )
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), after);
    assert!(store
        .use_here(
            &id,
            crate::community::tests::resolution("wss://third.example")
        )
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), after);
}

#[test]
fn use_here_exhausted_revision_preserves_the_saved_import() {
    let root = tempfile::tempdir().unwrap();
    let mut imported = agent(root.path());
    imported.revision = 9_007_199_254_740_991;
    imported.extra.insert("configured".into(), json!(false));
    let id = imported.id.clone();
    let mut store = Store::open(root.path().into()).unwrap();
    store.insert(vec![imported]).unwrap();
    let path = root.path().join("agents.json");
    let before = fs::read(&path).unwrap();
    assert_eq!(
        store
            .use_here(
                &id,
                crate::community::tests::resolution("wss://relay.example")
            )
            .unwrap_err(),
        "Agent revision exhausted"
    );
    assert_eq!(fs::read(path).unwrap(), before);
    assert!(!store.snapshot().unwrap().agents[0].configured);
}
