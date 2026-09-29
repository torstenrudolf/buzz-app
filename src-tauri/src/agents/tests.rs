use super::*;
use buzz_agent_controller::Secret;
use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime};

const RUNTIME_GATE: &str = "Synthetic runtime unavailable.";
const IMPORT_GATE: &str = "Synthetic credential refusal.";

// Test-only custody. Synthetic fixtures cannot reach PlatformCredentials.
struct RejectingCredentials;
impl Credentials for RejectingCredentials {
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        Err(IMPORT_GATE.into())
    }
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        Err(IMPORT_GATE.into())
    }
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
        Err(IMPORT_GATE.into())
    }
    fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
        Err(IMPORT_GATE.into())
    }
}

impl AgentHost {
    fn open(paths: Result<(PathBuf, PathBuf, PathBuf), String>) -> Self {
        Self(
            Arc::new(Mutex::new(paths.and_then(|(root, legacy, workspace)| {
                Host::open(
                    root,
                    legacy,
                    workspace,
                    Err(RUNTIME_GATE.into()),
                    Arc::new(RejectingCredentials),
                )
            }))),
            Arc::new(AtomicBool::new(false)),
            Arc::new(tokio::sync::Mutex::new(())),
        )
    }
}

pub(crate) fn fixture() -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    fixture_with_models(|dir| crate::agent_models::ModelHost::new(Ok(dir.join("store"))))
}
pub(crate) fn fixture_with_models(
    models: impl FnOnce(&std::path::Path) -> crate::agent_models::ModelHost,
) -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let dir = tempfile::tempdir().unwrap();
    let model_host = models(dir.path());
    let host = AgentHost::open(Ok((
        dir.path().join("store"),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let app = mock_builder()
        .manage(host.clone())
        .manage(crate::harness_setup::HarnessSetup::default())
        .manage(model_host)
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (dir, host, app, view)
}
pub(crate) fn invoke(
    view: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}
pub(crate) fn seed(dir: &std::path::Path) -> String {
    let id = format!(
        "{}-{}",
        "ab".repeat(32),
        "733db93c5a38b650794422a480fab67f1dd8f6f40112c360f9814dfaec3bfcbb"
    );
    // Public artificial identity and write-only sample environment; no key custody.
    std::fs::write(dir.join("store/agents.json"), serde_json::to_vec(&json!({"version":1,"agents":[{
        "id":id, "pubkey":"ab".repeat(32), "relayUrl":"wss://relay.example", "name":"Sample", "systemPrompt":"Original",
        "workspace":dir.to_str().unwrap(), "harness":{"command":"buzz-agent","args":[],"model":"sample","provider":"sample"},
        "environment":{"SAMPLE_TOKEN":"DO_NOT_PROJECT"},"revision":1,"enabled":true,"credentialId":"missing-fixture-key", "authTag":null, "imported":{}
    }]})).unwrap()).unwrap();
    id
}
#[test]
fn production_acl_allows_delete_to_reach_native_credentials() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let error = invoke(
        &view,
        "agent_control_delete",
        json!({"id": id, "expectedRevision": 1}),
    )
    .unwrap_err();
    assert_eq!(error, IMPORT_GATE);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(stored["agents"][0]["enabled"], false);
}
#[test]
fn harnesses_classify_cli_and_adapter_separately() {
    assert_eq!(pi_status(false, false, false), "cli-needed");
    assert_eq!(pi_status(false, true, true), "cli-needed");
    assert_eq!(pi_status(true, false, false), "cli-needed");
    assert_eq!(pi_status(true, true, false), "cli-needed");
    assert_eq!(pi_status(true, false, true), "adapter-needed");
    assert_eq!(pi_status(true, true, true), "ready");
}

#[test]
fn managed_pi_detection_prefers_a_complete_user_install_and_requires_managed_node() {
    let path = |name| Some(PathBuf::from(format!("/fixture/{name}")));
    let empty = || PiTools {
        cli: None,
        adapter: None,
        node: None,
    };
    let managed = || PiTools {
        cli: path("managed-pi"),
        adapter: path("managed-adapter"),
        node: path("managed-node"),
    };
    let (command, status) = pi_choice(empty(), managed());
    assert_eq!(command, path("managed-adapter"));
    assert_eq!(status, "ready");
    let (command, status) = pi_choice(
        PiTools {
            cli: path("user-pi"),
            adapter: path("user-adapter"),
            node: path("user-node"),
        },
        managed(),
    );
    assert_eq!(command, path("user-adapter"));
    assert_eq!(status, "ready");
    let (command, status) = pi_choice(
        PiTools {
            cli: path("user-pi"),
            ..empty()
        },
        PiTools {
            cli: None,
            ..managed()
        },
    );
    assert_eq!(command, path("managed-adapter"));
    assert_eq!(status, "ready");
    let (command, status) = pi_choice(
        empty(),
        PiTools {
            node: None,
            ..managed()
        },
    );
    assert!(command.is_none());
    assert_eq!(status, "cli-needed");
}

#[test]
fn restart_on_save_selects_only_live_agents_with_changed_effective_settings() {
    let before = BTreeMap::from([
        ("changed".to_owned(), json!({"model":"a"})),
        ("same".to_owned(), json!({"model":"a"})),
        ("stopped-after".to_owned(), json!({"model":"a"})),
    ]);
    let after = BTreeMap::from([
        ("changed".to_owned(), json!({"model":"b"})),
        ("same".to_owned(), json!({"model":"a"})),
        // Started during the save: not an effect of this save.
        ("started-after".to_owned(), json!({"model":"b"})),
    ]);
    assert_eq!(changed_running(before, after), ["changed"]);
}

#[test]
fn save_restart_failures_are_reported_separately_from_benign_skips() {
    let (dir, host, _app, _view) = fixture();
    let id = seed(dir.path());
    let snapshot = |enabled: bool, status, error: Option<&str>| {
        let mut snapshot = host.with(|host| host.snapshot()).unwrap();
        let agent = &mut snapshot.data.agents[0];
        agent.enabled = enabled;
        agent.status = status;
        agent.error = error.map(str::to_owned);
        Ok(snapshot)
    };
    use buzz_agent_controller::ProcessStatus::{Failed, Running, Stopped};
    assert_eq!(
        restart_outcome(&id, snapshot(true, Running, None)),
        RestartOutcome::Restarted
    );
    // A denied credential prompt returns a snapshot with the old process
    // still running the previous settings: nothing was restarted.
    let mut stale = snapshot(true, Running, Some("Keychain access was denied"));
    if let Ok(stale) = &mut stale {
        stale.data.agents[0].restart_diff = vec![buzz_agent_controller::RestartDiffEntry {
            field: "model".into(),
            change: buzz_agent_controller::RestartChange::Added,
        }];
    }
    assert_eq!(restart_outcome(&id, stale), RestartOutcome::Failed);
    // The settings were saved, but the new launch failed: warn, don't hide it.
    assert_eq!(
        restart_outcome(&id, snapshot(true, Failed, Some("Invalid launch"))),
        RestartOutcome::Failed
    );
    assert_eq!(
        restart_outcome(&id, Err("Saved agent key is unavailable".into())),
        RestartOutcome::Failed
    );
    // No longer needed, an explicit Stop, or a newer action are not failures.
    assert_eq!(
        restart_outcome(&id, Err(NO_SAVE_RESTART.into())),
        RestartOutcome::Skipped
    );
    assert_eq!(
        restart_outcome(&id, Err(START_CANCELLED.into())),
        RestartOutcome::Skipped
    );
    assert_eq!(
        restart_outcome(&id, snapshot(false, Stopped, None)),
        RestartOutcome::Skipped
    );
}

#[test]
fn disabled_live_agent_is_not_eligible_for_a_save_restart() {
    let (dir, host, _app, _view) = fixture();
    seed(dir.path());
    let mut agent = host
        .with(|host| Ok(host.controller.snapshot()?.agents.remove(0)))
        .unwrap();
    agent.status = buzz_agent_controller::ProcessStatus::Running;
    assert!(is_running(&agent));
    // A user Stop/Start after Save may already have applied the new settings.
    assert!(!needs_save_restart(&agent));
    agent.enabled = false;
    assert!(!is_running(&agent));
    assert!(!needs_save_restart(&agent));
}

#[test]
fn create_draft_model_browsing_inherits_native_provider_and_environment() {
    let (dir, host, _app, _view) = fixture();
    host.with(|host| {
        host.controller
            .save_defaults(
                serde_json::from_value(json!({
                    "harness":"buzz-agent", "provider":"databricks_v2", "model":"",
                    "effort":"", "environment":{"DATABRICKS_HOST":"https://models.example",
                        "DATABRICKS_MODEL_FILTER":"inherited-*"}
                }))
                .unwrap(),
            )
            .map(drop)
    })
    .unwrap();
    let draft = json!({
        "name":"New agent", "systemPrompt":"", "workspace":dir.path(),
        "harness":{"command":"buzz-agent","args":[],"provider":"","model":""},
        "environment":{}
    });
    let context = tauri::async_runtime::block_on(host.model_context(
        None,
        None,
        serde_json::from_value(draft.clone()).unwrap(),
    ))
    .unwrap();
    assert_eq!(context.host.as_deref(), Some("https://models.example"));
    assert_eq!(context.filter.as_deref(), Some("inherited-*"));
    let mut own = draft;
    own["harness"]["databricks"] = json!({"host":"https://own.example", "filter":"own-*"});
    let context = tauri::async_runtime::block_on(host.model_context(
        None,
        None,
        serde_json::from_value(own).unwrap(),
    ))
    .unwrap();
    assert_eq!(context.host.as_deref(), Some("https://own.example"));
    assert_eq!(context.filter.as_deref(), Some("own-*"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let goose = dir.path().join("goose");
        std::fs::write(&goose, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&goose, std::fs::Permissions::from_mode(0o700)).unwrap();
        host.with(|host| {
            host.controller
                .save_defaults(
                    serde_json::from_value(json!({
                        "harness":"goose", "provider":"openai", "model":"",
                        "effort":"", "environment":{"GOOSE_API_KEY":"write-only-key"}
                    }))
                    .unwrap(),
                )
                .map(drop)
        })
        .unwrap();
        let draft = json!({
            "name":"New agent", "systemPrompt":"", "workspace":dir.path(),
            "harness":{"command":goose,"args":["acp"],"provider":"","model":""},
            "environment":{}
        });
        let context = tauri::async_runtime::block_on(host.goose_model_context(
            None,
            None,
            serde_json::from_value(draft).unwrap(),
        ))
        .unwrap();
        assert_eq!(context.provider_id, "openai");
        assert_eq!(context.environment["GOOSE_API_KEY"], "write-only-key");
    }
}

#[test]
fn an_invalid_pi_defaults_switch_is_refused_before_persisting_or_restarting() {
    let (dir, _host, _app, view) = fixture();
    seed(dir.path());
    let save = |edit: Value| invoke(&view, "agent_control_save_defaults", json!({"edit":edit}));
    save(
        json!({"harness":"buzz-agent","provider":"anthropic","model":"m","effort":"",
        "environment":{}}),
    )
    .unwrap();
    let before = std::fs::read(dir.path().join("store/defaults.json")).unwrap();
    // Harness-only switch: the card clears model/effort but keeps the provider.
    let error = save(
        json!({"harness":"pi","provider":"anthropic","model":"","effort":"",
        "environment":{}}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("Choose a Pi model"), "{error}");
    // Nothing was committed, so no effective change can trigger a Restart.
    assert_eq!(
        std::fs::read(dir.path().join("store/defaults.json")).unwrap(),
        before
    );
}

#[test]
fn saving_defaults_never_starts_or_enables_stopped_agents() {
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["enabled"] = json!(false);
    saved["agents"][0]["harness"]["model"] = json!("");
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let result = invoke(
        &view,
        "agent_control_save_defaults",
        json!({"edit":{"harness":"buzz-agent","provider":"","model":"new-default","effort":"high",
            "environment":{"GLOBAL_TOKEN":"DO_NOT_PROJECT"}}}),
    )
    .unwrap();
    assert_eq!(result["restarted"], 0);
    assert_eq!(result["restartFailures"], 0);
    assert_eq!(result["defaultSettings"]["model"], "new-default");
    assert_eq!(
        result["defaultSettings"]["environmentKeys"],
        json!(["GLOBAL_TOKEN"])
    );
    assert!(!result.to_string().contains("DO_NOT_PROJECT"));
    assert_eq!(result["agents"][0]["status"], "stopped");
    assert_eq!(result["agents"][0]["launchModel"], "new-default");
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["agents"][0]["enabled"], false);
    assert_eq!(saved["agents"][0]["harness"]["model"], "");
    // The guard refuses a restart for an agent that is not live.
    let refused = tauri::async_runtime::block_on(start_guarded(
        host,
        id,
        Action::Restart,
        false,
        None,
        Some((needs_save_restart, "Agent no longer needs a save restart")),
    ));
    assert_eq!(
        refused.err().as_deref(),
        Some("Agent no longer needs a save restart")
    );
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["agents"][0]["enabled"], false);
}

#[test]
fn real_ipc_snapshot_save_cas_stop_and_launch_gate() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let before = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(before["runtimeAvailable"], false);
    assert_eq!(before["importAvailable"], cfg!(target_os = "macos"));
    assert_eq!(
        before["harnessOptions"][0],
        json!({
            "command":"buzz-agent", "label":"Buzz Agent",
            "available":true, "status":"ready", "defaultArgs":[],
            "providers":[{"value":"databricks_v2", "label":"Databricks v2"}]
        })
    );
    assert_eq!(before["harnessOptions"].as_array().unwrap().len(), 3);
    assert_eq!(before["harnessOptions"][2]["label"], "Pi");
    assert_eq!(
        before["harnessOptions"][2]["available"],
        before["harnessOptions"][2]["status"] == "ready"
    );
    assert_eq!(before["harnessOptions"][2]["defaultArgs"], json!([]));
    // Pi's signed-in providers come from its catalog, never a static list.
    assert_eq!(before["harnessOptions"][2]["providers"], json!([]));
    assert_eq!(
        before["harnessOptions"][2]["status"],
        pi_status(
            buzz_agent_controller::installed("pi").is_some(),
            buzz_agent_controller::installed("buzz-pi-acp").is_some(),
            buzz_agent_controller::installed("node").is_some(),
        )
    );
    assert_eq!(before["harnessOptions"][1]["label"], "Goose");
    assert_eq!(
        before["harnessOptions"][1]["installSupported"],
        cfg!(any(target_os = "macos", target_os = "linux"))
    );
    assert_eq!(before["harnessOptions"][1]["defaultArgs"], json!(["acp"]));
    assert_eq!(
        before["harnessOptions"][1]["status"],
        if installed_goose().is_some() {
            "ready"
        } else {
            "cli-needed"
        }
    );
    assert_eq!(
        before["harnessOptions"][1]["available"],
        installed_goose().is_some()
    );
    assert_eq!(
        before["harnessOptions"][1]["command"],
        installed_goose().map_or_else(|| json!("goose"), |path| json!(path.to_string_lossy()))
    );
    assert!(
        before["harnessOptions"][1]["providers"]
            .as_array()
            .unwrap()
            .len()
            > 5
    );
    assert!(before["harnessOptions"][1]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|provider| provider["value"] == "databricks"));
    assert_eq!(before["agents"][0]["name"], "Sample");
    assert_eq!(before["agents"][0]["enabled"], true);
    assert_eq!(before["agents"][0]["status"], "stopped");
    assert!(!before.to_string().contains("DO_NOT_PROJECT"));
    for action in ["start", "restart"] {
        let err = invoke(
            &view,
            "agent_control_action",
            json!({"id":id,"action":action}),
        )
        .unwrap_err();
        assert_eq!(err, RUNTIME_GATE);
    }
    let edit = json!({"name":"Edited","systemPrompt":"Saved via IPC","workspace":dir.path().to_str().unwrap(),
        "harness":{"command":"buzz-agent","args":["--literal space"],"model":"chosen","provider":"databricks_v2"},"environment":{}});
    let saved = invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit}),
    )
    .unwrap();
    assert_eq!(saved["harnessOptions"], before["harnessOptions"]);
    assert_eq!(saved["runtimeAvailable"], false);
    assert_eq!(saved["importAvailable"], cfg!(target_os = "macos"));
    assert_eq!(saved["agents"][0]["harness"]["provider"], "databricks_v2");
    assert_eq!(
        saved["agents"][0]["harness"]["args"],
        json!(["--literal space"])
    );
    assert_eq!(saved["agents"][0]["revision"], 2);
    assert_eq!(saved["agents"][0]["systemPrompt"], "Saved via IPC");
    assert!(invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit})
    )
    .is_err());
    let stopped = invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert_eq!(stopped["harnessOptions"], before["harnessOptions"]);
    assert_eq!(stopped["agents"][0]["enabled"], false);
    assert_eq!(stopped["agents"][0]["revision"], 2);
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(disk["agents"][0]["systemPrompt"], "Saved via IPC");
    assert_eq!(disk["agents"][0]["harness"]["provider"], "databricks_v2");
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap()["agents"][0]["harness"],
        saved["agents"][0]["harness"]
    );
    assert_eq!(disk["agents"][0]["enabled"], false);
    assert_eq!(
        disk["agents"][0]["environment"]["SAMPLE_TOKEN"],
        "DO_NOT_PROJECT"
    );
}
#[test]
fn real_ipc_preview_source_no_import_and_shutdown_fence() {
    let (dir, host, _app, view) = fixture();
    let source = dir.path().join("legacy/xyz.block.buzz.app.dev/agents");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("managed-agents.json"),
        serde_json::to_vec(&json!([{
            "pubkey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "name":"Synthetic", "agent_command":"buzz-agent", "agent_args":[]
        }]))
        .unwrap(),
    )
    .unwrap();
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://chosen.example"}),
    )
    .unwrap();
    assert!(preview["sourcePath"]
        .as_str()
        .unwrap()
        .ends_with("xyz.block.buzz.app.dev/agents/managed-agents.json"));
    assert!(invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"installed","destination":"wss://chosen.example"})
    )
    .is_err());
    assert_eq!(
        invoke(
            &view,
            "agent_control_import_commit",
            json!({"token":preview["token"],"ids":[preview["candidates"][0]["id"]]})
        )
        .unwrap_err(),
        "Import preview expired; choose the source again"
    );
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://chosen.example"}),
    )
    .unwrap();
    assert_eq!(
        invoke(
            &view,
            "agent_control_import_commit",
            json!({"token":preview["token"],"ids":[preview["candidates"][0]["id"]]})
        )
        .unwrap_err(),
        IMPORT_GATE
    );
    host.shutdown().unwrap();
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap_err(),
        "Agent host is shutting down"
    );
}
#[test]
fn queued_restore_skips_agent_stopped_after_launch() {
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["startOnAppLaunch"] = json!(true);
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    // Restore captured this id, then the user stopped it before its turn.
    let queued = host.with(|h| h.controller.launch_ids()).unwrap();
    assert_eq!(queued, vec![id.clone()]);
    let stopped = invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert_eq!(stopped["agents"][0]["startOnAppLaunch"], true);
    let restored =
        tauri::async_runtime::block_on(start(host.clone(), id, Action::Start, true, None, None));
    assert_eq!(
        restored.err().as_deref(),
        Some("Agent disabled before restore")
    );
    let after = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(after["agents"][0]["enabled"], false);
    // Fenced before credential/runtime checks: nothing was attempted or recorded.
    assert!(after["agents"][0]["error"].is_null());
}

// Unix-only: the synthetic bundle relies on executable-mode scripts.
#[cfg(unix)]
mod overlap {
    use super::*;

    const REFUSAL: &str = "Synthetic credential refusal";

    // Verified manifest over inert scripts. Credential refusal precedes any spawn.
    fn synthetic_bundle(directory: &std::path::Path) -> RuntimeBundle {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(directory).unwrap();
        let source: Value =
            serde_json::from_str(include_str!("../../../runtime/agent-runtime.json")).unwrap();
        let mut files = BTreeMap::new();
        for tool in source["tools"].as_array().unwrap() {
            let name = tool.as_str().unwrap();
            let path = directory.join(name);
            std::fs::write(&path, "#!/bin/sh\nexit 1\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            let digest = Sha256::digest(std::fs::read(&path).unwrap());
            files.insert(name.to_owned(), format!("{digest:x}"));
        }
        let manifest = json!({"version":1, "revision":source["revision"],
            "target":env!("TAURI_ENV_TARGET_TRIPLE"), "files":files});
        std::fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        RuntimeBundle::new(directory.into()).unwrap()
    }

    // Each credential read reports entry, then blocks until the test releases that
    // exact credential id; an unplanned read fails fast instead of hanging.
    struct Gated {
        entered: std::sync::mpsc::Sender<String>,
        release: Mutex<BTreeMap<String, std::sync::mpsc::Receiver<()>>>,
    }
    impl Credentials for Gated {
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            panic!("not a deletion")
        }
        fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
            panic!("not an import")
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            panic!("not a write")
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            self.entered.send(id.to_owned()).unwrap();
            let gate = self.release.lock().unwrap().remove(id);
            gate.ok_or("Unplanned credential read")?.recv().unwrap();
            if pubkey == "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" {
                Secret::parse(
                    "0000000000000000000000000000000000000000000000000000000000000001",
                    pubkey,
                )
                .map(Some)
            } else {
                Err(REFUSAL.into())
            }
        }
    }
    struct Gate {
        entered: Arc<Mutex<std::sync::mpsc::Receiver<String>>>,
        release: BTreeMap<String, std::sync::mpsc::Sender<()>>,
    }
    impl Gate {
        fn install(host: &AgentHost, dir: &std::path::Path, ids: &[&str]) -> Self {
            let (entered, receive) = std::sync::mpsc::channel();
            let (mut release, mut wait) = (BTreeMap::new(), BTreeMap::new());
            for id in ids {
                let (send, receive) = std::sync::mpsc::channel();
                release.insert((*id).to_owned(), send);
                wait.insert((*id).to_owned(), receive);
            }
            let credentials: Arc<dyn Credentials> = Arc::new(Gated {
                entered,
                release: Mutex::new(wait),
            });
            host.with(|h| {
                // Drop the fixture's store lock before reopening the same store.
                h.controller = Controller::new(
                    Store::open(dir.join("replacement"))?,
                    credentials.clone(),
                    Err("placeholder".into()),
                    dir.join("ownership"),
                );
                h.controller = Controller::new(
                    Store::open(dir.join("store"))?,
                    credentials.clone(),
                    Ok(synthetic_bundle(&dir.join("tools"))),
                    dir.join("ownership"),
                );
                h.credentials = credentials;
                h.legacy_check = || Ok(());
                Ok(())
            })
            .unwrap();
            Self {
                entered: Arc::new(Mutex::new(receive)),
                release,
            }
        }
        async fn entered(&self) -> String {
            let entered = self.entered.clone();
            tokio::task::spawn_blocking(move || {
                entered
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
            })
            .await
            .unwrap()
            .expect("credential read did not start")
        }
        fn idle(&self) -> bool {
            self.entered.lock().unwrap().try_recv().is_err()
        }
    }
    // Two launch-enabled agents with distinct credential ids.
    fn seed_pair(dir: &std::path::Path) -> Vec<String> {
        let suffix = "733db93c5a38b650794422a480fab67f1dd8f6f40112c360f9814dfaec3bfcbb";
        let agents: Vec<Value> = ["ab", "cd"]
            .iter()
            .map(|byte| {
                let pubkey = byte.repeat(32);
                json!({"id":format!("{pubkey}-{suffix}"), "pubkey":pubkey, "relayUrl":"wss://relay.example",
                    "name":format!("Sample {byte}"), "systemPrompt":"Original", "workspace":dir.to_str().unwrap(),
                    "harness":{"command":"buzz-agent","args":[],"model":"sample","provider":"sample"},
                    "environment":{}, "revision":1, "enabled":true, "startOnAppLaunch":true,
                    "credentialId":format!("cred-{byte}"), "authTag":null, "imported":{}})
            })
            .collect();
        let ids = agents
            .iter()
            .map(|a| a["id"].as_str().unwrap().to_owned())
            .collect();
        std::fs::write(
            dir.join("store/agents.json"),
            serde_json::to_vec(&json!({"version":1,"agents":agents})).unwrap(),
        )
        .unwrap();
        ids
    }
    fn credential(id: &str) -> String {
        format!("cred-{}", &id[..2])
    }
    fn agent<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
        snapshot["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id)
            .unwrap()
    }
    async fn within<T>(task: tokio::task::JoinHandle<T>) -> T {
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("task did not finish")
            .unwrap()
    }

    // A is ahead of B in restore's sorted queue; only B has a usable test key.
    fn seed_replay_pair(dir: &std::path::Path) -> (String, String) {
        seed_pair(dir);
        let path = dir.join("store/agents.json");
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut ids = Vec::new();
        for (i, pubkey) in [
            "11".repeat(32),
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798".into(),
        ]
        .iter()
        .enumerate()
        {
            let id = saved["agents"][i]["id"].as_str().unwrap().replacen(
                &if i == 0 { "ab" } else { "cd" }.repeat(32),
                pubkey,
                1,
            );
            saved["agents"][i]["id"] = json!(id);
            saved["agents"][i]["pubkey"] = json!(pubkey);
            ids.push(id);
        }
        std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
        (ids.remove(0), ids.remove(0))
    }

    #[tokio::test]
    async fn mentions_coalesce_through_queued_waiting_and_starting_into_launch_input() {
        let (dir, host, _app, view) = fixture();
        let (_, id) = seed_replay_pair(dir.path());
        let gate = Gate::install(&host, dir.path(), &["cred-ab", "cred-cd"]);
        let owner = host.clone();
        let restore = tokio::spawn(async move { owner.restore().await });
        assert_eq!(gate.entered().await, "cred-ab");
        // A confirmed send already thirty seconds old, well beyond the runner's
        // five-second default window. No wall-clock sleep controls this ordering.
        let sent = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 30;
        for floor in [sent + 2, sent, sent + 1] {
            invoke(
                &view,
                "agent_control_attach_mention",
                json!({"id":id,"expectedRevision":1,"replayFloor":floor}),
            )
            .unwrap();
        }
        assert!(
            gate.idle(),
            "attaching a queued mention must not acquire credentials"
        );
        gate.release["cred-ab"].send(()).unwrap();
        assert_eq!(gate.entered().await, "cred-cd");
        assert_eq!(
            host.with(|h| Ok(h.starts[&id].replay_floor)).unwrap(),
            Some(sent)
        );
        invoke(
            &view,
            "agent_control_attach_mention",
            json!({"id":id,"expectedRevision":1,"replayFloor":sent - 1}),
        )
        .unwrap();
        // Starting is still before final launch admission and must accept input.
        host.with(|h| {
            h.starts.get_mut(&id).unwrap().status = ProcessStatus::Starting;
            Ok(())
        })
        .unwrap();
        invoke(
            &view,
            "agent_control_attach_mention",
            json!({"id":id,"expectedRevision":1,"replayFloor":sent - 2}),
        )
        .unwrap();
        // Consume the exact input at final admission without launching a native
        // test harness as the app supervisor. Controller's subprocess regression
        // separately checks action_with_key forwards this input into the runner.
        let replay = host
            .with(|h| {
                let ticket = h.starts[&id].ticket;
                h.take_start(&id, ticket)
            })
            .unwrap();
        gate.release["cred-cd"].send(()).unwrap();
        within(restore).await;
        assert_eq!(replay.replay_floor, Some(sent - 2));
        assert!(gate.idle());
        assert!(host.with(|h| Ok(h.starts.is_empty())).unwrap());
        assert!(invoke(
            &view,
            "agent_control_attach_mention",
            json!({"id":id,"expectedRevision":1,"replayFloor":sent})
        )
        .is_err());
        assert!(
            !std::fs::read_to_string(dir.path().join("store/agents.json"))
                .unwrap()
                .contains(&(sent - 2).to_string())
        );
    }

    #[tokio::test]
    async fn queued_replay_cannot_survive_stop_or_revision_change() {
        for stop in [true, false] {
            let (dir, host, _app, view) = fixture();
            let (_, id) = seed_replay_pair(dir.path());
            let gate = Gate::install(&host, dir.path(), &["cred-ab"]);
            let owner = host.clone();
            let restore = tokio::spawn(async move { owner.restore().await });
            assert_eq!(gate.entered().await, "cred-ab");
            invoke(
                &view,
                "agent_control_attach_mention",
                json!({"id":id,"expectedRevision":1,"replayFloor":100}),
            )
            .unwrap();
            if stop {
                invoke(
                    &view,
                    "agent_control_action",
                    json!({"id":id,"action":"stop"}),
                )
                .unwrap();
                assert!(invoke(
                    &view,
                    "agent_control_attach_mention",
                    json!({"id":id,"expectedRevision":1,"replayFloor":90})
                )
                .is_err());
            } else {
                let path = dir.path().join("store/agents.json");
                let mut saved: Value =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                saved["agents"][1]["revision"] = json!(2);
                std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
                assert!(invoke(
                    &view,
                    "agent_control_attach_mention",
                    json!({"id":id,"expectedRevision":2,"replayFloor":90})
                )
                .is_err());
            }
            gate.release["cred-ab"].send(()).unwrap();
            within(restore).await;
            assert!(
                gate.idle(),
                "cancelled/changed queued replay must not acquire credentials"
            );
            let observed = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
            assert_eq!(
                agent(&observed, &id)["status"],
                if stop { "stopped" } else { "failed" }
            );
        }
    }

    #[tokio::test]
    async fn restore_read_failure_clears_seeded_waiting_and_allows_explicit_retry() {
        let (dir, host, _app, _view) = fixture();
        let id = seed_pair(dir.path())[0].clone();
        // Reopen so Host::open, not the test, seeds the queue.
        *host.0.lock().unwrap() = Err("retired".into());
        let fresh = AgentHost::open(Ok((
            dir.path().join("store"),
            dir.path().join("legacy"),
            dir.path().join("workspace"),
        )));
        assert!(fresh
            .with(|h| Ok(h.snapshot()?.data.agents[0].status == ProcessStatus::Waiting))
            .unwrap());
        let path = dir.path().join("store/agents.json");
        let saved = std::fs::read(&path).unwrap();
        std::fs::write(&path, "malformed").unwrap();
        fresh.restore().await;
        std::fs::write(path, saved).unwrap();
        let snapshot = fresh.with(|h| h.snapshot()).unwrap();
        assert!(snapshot
            .data
            .agents
            .iter()
            .all(|a| a.status == ProcessStatus::Failed
                && a.error.as_deref() == Some("Saved agents are malformed; left unchanged")));
        assert!(fresh.with(|h| Ok(h.queued.is_empty())).unwrap());
        let gate = Gate::install(&fresh, dir.path(), &["cred-ab"]);
        gate.release["cred-ab"].send(()).unwrap();
        let retried = start(fresh.clone(), id.clone(), Action::Start, false, None, None)
            .await
            .unwrap();
        assert_eq!(gate.entered().await, "cred-ab");
        assert_eq!(
            retried
                .data
                .agents
                .iter()
                .find(|a| a.id == id)
                .unwrap()
                .error
                .as_deref(),
            Some(REFUSAL)
        );
    }

    #[tokio::test]
    async fn queued_start_preparation_cannot_overtake_a_later_stop() {
        let (dir, host, _app, _view) = fixture();
        let id = seed_pair(dir.path())[0].clone();
        let credential = credential(&id);
        let gate = Gate::install(&host, dir.path(), &[&credential]);
        let admission = host.2.clone().lock_owned().await;
        let mut starting = std::pin::pin!(start(
            host.clone(),
            id.clone(),
            Action::Start,
            false,
            None,
            None
        ));
        assert_pending(starting.as_mut()).await;
        let target = id.clone();
        let mut stopping =
            std::pin::pin!(run(host.clone(), move |h| h.action(&target, Action::Stop)));
        assert_pending(stopping.as_mut()).await;
        drop(admission);
        let release = async {
            assert_eq!(gate.entered().await, credential);
            let stopped = stopping.await;
            // Always release the credential wait before asserting the result.
            gate.release[&credential].send(()).unwrap();
            assert!(
                !stopped
                    .unwrap()
                    .data
                    .agents
                    .iter()
                    .find(|a| a.id == id)
                    .unwrap()
                    .enabled
            );
        };
        let (started, ()) = tokio::join!(starting, release);
        assert_eq!(
            started.err().as_deref(),
            Some("Start cancelled by a newer action")
        );
    }

    #[tokio::test]
    async fn overlapping_restore_honors_intervening_stop_and_start_then_fresh_host_resets() {
        let (dir, host, _app, view) = fixture();
        let ids = seed_pair(dir.path());
        let creds: Vec<String> = ids.iter().map(|id| credential(id)).collect();
        let gate = Gate::install(&host, dir.path(), &[&creds[0], &creds[1]]);
        let queued = host.with(|h| h.controller.launch_ids()).unwrap();
        let (first, second) = (queued[0].clone(), queued[1].clone());
        let owner = host.clone();
        let restore = tokio::spawn(async move { owner.restore().await });
        // Restore waits on the first agent's credential while the user acts.
        assert_eq!(gate.entered().await, credential(&first));
        let waiting = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
        assert_eq!(agent(&waiting, &first)["status"], "waiting");
        assert_eq!(agent(&waiting, &second)["status"], "waiting");
        // Native admission, not only disabled buttons, rejects overlapping Start.
        let duplicate = start(
            host.clone(),
            first.clone(),
            Action::Start,
            false,
            None,
            None,
        )
        .await;
        assert_eq!(
            duplicate.err().as_deref(),
            Some("Agent start already in progress; use Stop to cancel")
        );
        assert!(gate.idle());
        let stopped = invoke(
            &view,
            "agent_control_action",
            json!({"id":first,"action":"stop"}),
        )
        .unwrap();
        assert_eq!(agent(&stopped, &first)["enabled"], false);
        let explicit = tokio::task::spawn_blocking({
            let (view, second) = (view.clone(), second.clone());
            move || {
                invoke(
                    &view,
                    "agent_control_action",
                    json!({"id":second,"action":"start"}),
                )
            }
        });
        assert_eq!(gate.entered().await, credential(&second));
        // Late completion of the stopped restore; restore then reaches the agent
        // the user started and must neither read again nor cancel that Start.
        gate.release[&credential(&first)].send(()).unwrap();
        within(restore).await;
        assert!(
            gate.idle(),
            "restore read a credential after an explicit action"
        );
        assert!(host.with(|h| Ok(h.starts.contains_key(&second))).unwrap());
        let middle = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
        assert!(agent(&middle, &first)["error"].is_null());
        assert_eq!(agent(&middle, &first)["enabled"], false);
        assert_eq!(agent(&middle, &first)["status"], "stopped");
        assert_eq!(agent(&middle, &second)["status"], "waiting");
        gate.release[&credential(&second)].send(()).unwrap();
        let started = within(explicit).await.unwrap();
        assert_eq!(agent(&started, &second)["error"], REFUSAL);
        assert_eq!(agent(&started, &second)["status"], "failed");
        assert!(agent(&started, &first)["error"].is_null());

        // A fresh host has no action history: both launch preferences restore.
        *host.0.lock().unwrap() = Err("retired".into());
        let fresh = AgentHost::open(Ok((
            dir.path().join("store"),
            dir.path().join("legacy"),
            dir.path().join("workspace"),
        )));
        let gate = Gate::install(&fresh, dir.path(), &[&creds[0], &creds[1]]);
        let owner = fresh.clone();
        let restore = tokio::spawn(async move { owner.restore().await });
        for id in [&first, &second] {
            assert_eq!(gate.entered().await, credential(id));
            gate.release[&credential(id)].send(()).unwrap();
        }
        within(restore).await;
        let after = fresh.with(|h| h.snapshot()).unwrap();
        let after = serde_json::to_value(after).unwrap();
        for id in [&first, &second] {
            assert_eq!(agent(&after, id)["error"], REFUSAL);
            assert_eq!(agent(&after, id)["startOnAppLaunch"], true);
        }
        fresh.shutdown().unwrap();
    }

    #[tokio::test]
    async fn refused_acquisition_never_projects_starting_between_admissions() {
        let (dir, host, _app, _view) = fixture();
        let id = seed_pair(dir.path())[0].clone();
        let credential = credential(&id);
        let gate = Gate::install(&host, dir.path(), &[&credential]);
        let mut pending = std::pin::pin!(start(
            host.clone(),
            id.clone(),
            Action::Start,
            false,
            None,
            None
        ));
        tokio::select! {
            result = &mut pending => panic!("start finished before credential release: {}", result.is_ok()),
            entered = gate.entered() => assert_eq!(entered, credential),
        }
        let waiting = host.with(|h| h.snapshot()).unwrap();
        assert_eq!(
            agent(&serde_json::to_value(waiting).unwrap(), &id)["status"],
            "waiting"
        );
        gate.release[&credential].send(()).unwrap();
        // Drive only one poll of Start between snapshots. FIFO admission makes
        // each scheduled transition observable before Start can schedule another,
        // including the former erroneous Starting admission after refusal.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let completed = std::future::poll_fn(|cx| {
                    use std::future::Future;
                    std::task::Poll::Ready(match pending.as_mut().poll(cx) {
                        std::task::Poll::Ready(result) => Some(result),
                        std::task::Poll::Pending => None,
                    })
                })
                .await;
                let snapshot = run(host.clone(), |h| h.snapshot()).await.unwrap();
                let snapshot = serde_json::to_value(snapshot).unwrap();
                assert_ne!(agent(&snapshot, &id)["status"], "starting");
                if let Some(result) = completed {
                    result.unwrap();
                    assert_eq!(agent(&snapshot, &id)["status"], "failed");
                    assert_eq!(agent(&snapshot, &id)["error"], REFUSAL);
                    break;
                }
            }
        })
        .await
        .expect("refused start did not settle");
    }

    #[tokio::test]
    async fn native_start_projects_launch_integrity_failure_after_acquiring_key() {
        let (dir, host, _app, view) = fixture();
        seed_pair(dir.path());
        let path = dir.path().join("store/agents.json");
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let pubkey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        let id = saved["agents"][0]["id"]
            .as_str()
            .unwrap()
            .replacen(&"ab".repeat(32), pubkey, 1);
        saved["agents"][0]["pubkey"] = json!(pubkey);
        saved["agents"][0]["id"] = json!(id);
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let gate = Gate::install(&host, dir.path(), &["cred-ab"]);
        // Bundle initialization succeeded, but launch must recheck these bytes.
        std::fs::write(dir.path().join("tools/buzz-agent"), "tampered").unwrap();
        let pending = tokio::task::spawn_blocking({
            let (view, id) = (view.clone(), id.clone());
            move || {
                invoke(
                    &view,
                    "agent_control_action",
                    json!({"id":id,"action":"start"}),
                )
            }
        });
        assert_eq!(gate.entered().await, "cred-ab");
        gate.release["cred-ab"].send(()).unwrap();
        let result = within(pending).await.unwrap();
        let failed = agent(&result, &id);
        assert_eq!(failed["status"], "failed");
        assert!(failed["error"].as_str().unwrap().contains("integrity"));
        assert!(failed["runningRevision"].is_null());
        assert_eq!(failed["enabled"], true);
        assert_eq!(failed["startOnAppLaunch"], true);
        assert!(host.with(|h| Ok(h.starts.is_empty())).unwrap());
        let observed = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
        assert_eq!(agent(&observed, &id), failed);
    }

    #[tokio::test]
    async fn acquired_key_cannot_escape_stop_quit_or_saved_revision_fences() {
        for boundary in ["stop", "quit", "save"] {
            let (dir, host, _app, view) = fixture();
            seed_pair(dir.path());
            let path = dir.path().join("store/agents.json");
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let pubkey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
            let id =
                saved["agents"][0]["id"]
                    .as_str()
                    .unwrap()
                    .replacen(&"ab".repeat(32), pubkey, 1);
            saved["agents"][0]["pubkey"] = json!(pubkey);
            saved["agents"][0]["id"] = json!(id);
            std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
            let gate = Gate::install(&host, dir.path(), &["cred-ab"]);
            let (owner, target) = (host.clone(), id.clone());
            let pending = tokio::spawn(async move {
                start(owner, target, Action::Start, false, None, None).await
            });
            assert_eq!(gate.entered().await, "cred-ab");
            let waiting = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
            assert_eq!(agent(&waiting, &id)["status"], "waiting");
            invoke(
                &view,
                "agent_control_attach_mention",
                json!({"id":id,"expectedRevision":1,"replayFloor":100}),
            )
            .unwrap();
            match boundary {
                "stop" => {
                    invoke(
                        &view,
                        "agent_control_action",
                        json!({"id":id,"action":"stop"}),
                    )
                    .unwrap();
                }
                "quit" => {
                    host.shutdown().unwrap();
                }
                _ => {
                    saved["agents"][0]["revision"] = json!(2);
                    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
                }
            }
            gate.release["cred-ab"].send(()).unwrap();
            let result = within(pending).await;
            if boundary == "save" {
                let result = serde_json::to_value(result.unwrap()).unwrap();
                assert_eq!(agent(&result, &id)["status"], "failed");
                assert!(agent(&result, &id)["error"]
                    .as_str()
                    .unwrap()
                    .contains("Saved settings changed"));
                assert!(agent(&result, &id)["runningRevision"].is_null());
            } else {
                assert!(result.is_err());
            }
        }
    }

    // Eligibility can lapse while the OS credential prompt is open (e.g. the
    // listener exits). The guard must be re-checked before Restart enables it.
    #[test]
    fn save_restart_rechecks_eligibility_after_the_credential_prompt() {
        use std::sync::atomic::{AtomicBool, Ordering};
        const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
        const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        static ELIGIBLE: AtomicBool = AtomicBool::new(true);
        struct Lapsing;
        impl Credentials for Lapsing {
            fn delete(&self, _: &str, _: &str) -> Result<(), String> {
                panic!("not a deletion")
            }
            fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
                panic!("not an import")
            }
            fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
                panic!("not a write")
            }
            fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
                ELIGIBLE.store(false, Ordering::SeqCst);
                Secret::parse(KEY, pubkey).map(Some)
            }
        }
        fn eligible(_: &buzz_agent_controller::AgentView) -> bool {
            ELIGIBLE.load(Ordering::SeqCst)
        }
        let (dir, host, _app, _view) = fixture();
        let id = seed(dir.path());
        let path = dir.path().join("store/agents.json");
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let id = id.replacen(&"ab".repeat(32), PUB, 1);
        saved["agents"][0]["id"] = json!(id);
        saved["agents"][0]["pubkey"] = json!(PUB);
        saved["agents"][0]["credentialId"] = json!(id);
        saved["agents"][0]["enabled"] = json!(false);
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let credentials: Arc<dyn Credentials> = Arc::new(Lapsing);
        host.with(|h| {
            h.controller = Controller::new(
                Store::open(dir.path().join("replacement"))?,
                credentials.clone(),
                Err("placeholder".into()),
                dir.path().join("ownership"),
            );
            h.controller = Controller::new(
                Store::open(dir.path().join("store"))?,
                credentials.clone(),
                Ok(synthetic_bundle(&dir.path().join("tools"))),
                dir.path().join("ownership"),
            );
            h.credentials = credentials;
            h.legacy_check = || Ok(());
            Ok(())
        })
        .unwrap();
        let result = tauri::async_runtime::block_on(start_guarded(
            host,
            id,
            Action::Restart,
            false,
            None,
            Some((eligible, "Agent no longer needs a save restart")),
        ));
        assert_eq!(
            result.err().as_deref(),
            Some("Agent no longer needs a save restart")
        );
        // Restart never ran, so it did not enable the agent.
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["agents"][0]["enabled"], false);
    }

    // A genuinely eligible agent: its Start failed on the missing Goose CLI.
    // Stop during the download must win over the install's late restart.
    #[test]
    fn install_restart_does_not_reenable_a_stopped_goose_or_pi_agent() {
        const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
        const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        struct Stored;
        impl Credentials for Stored {
            fn delete(&self, _: &str, _: &str) -> Result<(), String> {
                panic!("not a deletion")
            }
            fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
                panic!("not an import")
            }
            fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
                panic!("not a write")
            }
            fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
                Secret::parse(KEY, pubkey).map(Some)
            }
        }
        for (harness, is_goose) in [("goose", true), ("buzz-pi-acp", false)] {
            let (dir, host, _app, view) = fixture();
            let id = seed(dir.path());
            let path = dir.path().join("store/agents.json");
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let id = id.replacen(&"ab".repeat(32), PUB, 1);
            saved["agents"][0]["id"] = json!(id);
            saved["agents"][0]["pubkey"] = json!(PUB);
            saved["agents"][0]["credentialId"] = json!(id);
            saved["agents"][0]["harness"]["command"] =
                json!(dir.path().join("missing").join(harness));
            saved["agents"][0]["harness"]["args"] =
                json!(if is_goose { vec!["acp"] } else { vec![] });
            std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
            let credentials: Arc<dyn Credentials> = Arc::new(Stored);
            host.with(|h| {
                h.controller = Controller::new(
                    Store::open(dir.path().join("replacement"))?,
                    credentials.clone(),
                    Err("placeholder".into()),
                    dir.path().join("ownership"),
                );
                h.controller = Controller::new(
                    Store::open(dir.path().join("store"))?,
                    credentials.clone(),
                    Ok(synthetic_bundle(&dir.path().join("tools"))),
                    dir.path().join("ownership"),
                );
                h.credentials = credentials;
                h.legacy_check = || Ok(());
                Ok(())
            })
            .unwrap();
            let started = tauri::async_runtime::block_on(start(
                host.clone(),
                id.clone(),
                Action::Start,
                false,
                None,
                None,
            ))
            .unwrap();
            assert_eq!(
                started.data.agents[0].error.as_deref(),
                Some("Required runtime executable is missing")
            );
            let waiting = if is_goose {
                tauri::async_runtime::block_on(host.waiting_for_goose()).unwrap()
            } else {
                tauri::async_runtime::block_on(host.waiting_for_pi()).unwrap()
            };
            assert_eq!(waiting, vec![id.clone()]);
            invoke(
                &view,
                "agent_control_action",
                json!({"id":id,"action":"stop"}),
            )
            .unwrap();
            assert!(if is_goose {
                tauri::async_runtime::block_on(host.waiting_for_goose()).unwrap()
            } else {
                tauri::async_runtime::block_on(host.waiting_for_pi()).unwrap()
            }
            .is_empty());
            let result = tauri::async_runtime::block_on(start(
                host,
                id,
                Action::Restart,
                false,
                None,
                Some(if is_goose {
                    InstallRestart::Goose
                } else {
                    InstallRestart::Pi
                }),
            ));
            assert_eq!(
                result.err().as_deref(),
                Some(if is_goose {
                    NOT_WAITING_FOR_GOOSE
                } else {
                    NOT_WAITING_FOR_PI
                })
            );
            let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(saved["agents"][0]["enabled"], false);
        }
    }
}

#[cfg(unix)]
#[test]
fn real_ipc_start_on_app_launch_persists_reopens_and_recovers_from_write_failure() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    let store = dir.path().join("store");
    let disk = || -> Value {
        serde_json::from_slice(&std::fs::read(store.join("agents.json")).unwrap()).unwrap()
    };
    let set = |enabled: bool| {
        invoke(
            &view,
            "agent_control_start_on_app_launch",
            json!({"id":id,"enabled":enabled}),
        )
    };
    // Legacy record: no explicit preference follows `enabled`.
    let before = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(before["agents"][0]["startOnAppLaunch"], true);
    let off = set(false).unwrap();
    assert_eq!(off["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(off["agents"][0]["enabled"], true);
    assert_eq!(off["agents"][0]["revision"], 1);
    assert_eq!(disk()["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(disk()["agents"][0]["revision"], 1);
    assert!(host.with(|h| h.controller.launch_ids()).unwrap().is_empty());
    // A failed write reports an error and leaves the confirmed value.
    std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o500)).unwrap();
    let failed = set(true);
    std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        failed.unwrap_err(),
        "Could not prepare agent settings write"
    );
    let current = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(current["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(disk()["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(
        invoke(
            &view,
            "agent_control_start_on_app_launch",
            json!({"id":"missing","enabled":true})
        )
        .unwrap_err(),
        "Agent no longer exists"
    );
    let retried = set(true).unwrap();
    assert_eq!(retried["agents"][0]["startOnAppLaunch"], true);
    // A fresh host reads the persisted preference and restores from it.
    *host.0.lock().unwrap() = Err("retired".into());
    let fresh = AgentHost::open(Ok((
        store.clone(),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let reopened = serde_json::to_value(fresh.with(|h| h.snapshot()).unwrap()).unwrap();
    assert_eq!(reopened["agents"][0]["startOnAppLaunch"], true);
    assert_eq!(reopened["agents"][0]["revision"], 1);
    assert_eq!(fresh.with(|h| h.controller.launch_ids()).unwrap(), vec![id]);
    fresh.shutdown().unwrap();
}

#[test]
fn malformed_store_does_not_prevent_native_host_construction() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("agents.json"), "RAW_SECRET_INVALID").unwrap();
    let host = AgentHost::open(Ok((
        dir.path().into(),
        dir.path().into(),
        dir.path().into(),
    )));
    let error = host.with(|h| h.snapshot()).err().unwrap();
    assert!(!error.contains("RAW_SECRET"));
    assert!(error.contains("malformed"));
    host.shutdown().unwrap();
}

#[test]
fn native_quit_preserves_enabled_intent() {
    let (dir, host, _app, view) = fixture();
    seed(dir.path());
    assert!(invoke(&view, "agent_control_snapshot", json!({})).is_ok());
    host.shutdown().unwrap();
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(disk["agents"][0]["enabled"], true);
    for (command, body) in [
        (
            "agent_control_action",
            json!({"id":"sample","action":"stop"}),
        ),
        (
            "agent_control_import_preview",
            json!({"source":"installed","destination":"wss://chosen.example"}),
        ),
    ] {
        assert_eq!(
            invoke(&view, command, body).unwrap_err(),
            "Agent host is shutting down"
        );
    }
}

#[test]
fn legacy_guard_is_process_path_evidence_not_name_substring_or_coexistence_claim() {
    for listing in [
        " 100 /Applications/Buzz.app/Contents/MacOS/buzz-desktop",
        " 200 /checkout/target/debug/buzz-desktop",
    ] {
        assert!(refuse_legacy_listing(listing).is_err());
    }
    assert!(refuse_legacy_listing(
        "123 /tmp/buzz-agent\n456 /tmp/buzz-foundation\n789 /tmp/buzz-desktop-notes"
    )
    .is_ok());
}

#[tokio::test]
#[ignore = "requires staged immutable runtime resources; run explicitly after build-agent-runtime"]
async fn native_start_restore_disconnect_stop_and_quit_fence_late_credentials() {
    struct Delayed {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Credentials for Delayed {
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            panic!("not a delete")
        }
        fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
            panic!("not an import")
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            panic!("not a write")
        }
        fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Err("Synthetic credential refusal".into())
        }
    }
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    // Use the actual resource manifest when staged; no child is spawned and no
    // PlatformCredentials method is ever called by this fixture.
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent-runtime");
    assert!(
        tools.join("manifest.json").is_file(),
        "Build immutable runtime resources first"
    );
    let (entered, receive) = std::sync::mpsc::channel();
    let receive = Arc::new(Mutex::new(receive));
    let (release, wait) = std::sync::mpsc::channel();
    let credentials: Arc<dyn Credentials> = Arc::new(Delayed {
        entered,
        release: Mutex::new(wait),
    });
    host.with(|h| {
        let replacement = Store::open(dir.path().join("replacement"))?;
        // Reopen the same durable fixture only after replacing/dropping its owner.
        h.controller = Controller::new(
            replacement,
            credentials.clone(),
            Err("placeholder".into()),
            dir.path().join("ownership"),
        );
        h.controller = Controller::new(
            Store::open(dir.path().join("store"))?,
            credentials.clone(),
            RuntimeBundle::new(tools),
            dir.path().join("ownership"),
        );
        h.credentials = credentials;
        h.legacy_check = || Ok(());
        Ok(())
    })
    .unwrap();
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["harness"]["provider"] = json!("databricks_v2");
    saved["agents"][0]["harness"]["databricks"] =
        json!({"host":"https://workspace.example", "filter":""});
    std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
    for action in ["disconnect", "stop", "quit"] {
        if action == "quit" {
            let path = dir.path().join("store/agents.json");
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            saved["agents"][0]["enabled"] = json!(true);
            std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
            // A fresh launch has no explicit actions yet.
            host.with(|h| {
                h.acted.clear();
                Ok(())
            })
            .unwrap();
        }
        let owner = host.clone();
        let agent_id = id.clone();
        let running = tokio::spawn(async move {
            if action == "quit" {
                owner.restore().await;
                Err("restore completed".into())
            } else {
                start(owner, agent_id, Action::Start, false, None, None).await
            }
        });
        tokio::task::spawn_blocking({
            let receive = receive.clone();
            move || {
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
            }
        })
        .await
        .unwrap()
        .unwrap();
        if action == "quit" {
            host.shutdown().unwrap();
        } else if action == "disconnect" {
            host.disconnect("https://workspace.example").await.unwrap();
        } else {
            invoke(
                &view,
                "agent_control_action",
                json!({"id":id,"action":"stop"}),
            )
            .unwrap();
        }
        release.send(()).unwrap();
        assert!(running.await.unwrap().is_err());
        if action == "quit" {
            let mut state = host.0.lock().unwrap();
            let h = state.as_mut().unwrap_or_else(|_| panic!("fixture host"));
            let snapshot = h.controller.snapshot().unwrap();
            assert!(snapshot.agents[0].error.is_none());
            assert!(snapshot.agents[0].enabled);
        }
    }
}

#[test]
fn real_ipc_import_uses_selected_memory_custody_and_stays_disabled() {
    const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    #[derive(Default)]
    struct Memory(Mutex<BTreeMap<String, String>>, Mutex<Vec<LegacySource>>);
    impl Credentials for Memory {
        fn delete(&self, id: &str, _: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
        fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret, String> {
            assert!(matches!(source, LegacySource::Development));
            self.1.lock().unwrap().push(source);
            Secret::parse(KEY, pubkey)
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .map(|v| Secret::parse(v, pubkey))
                .transpose()
        }
        fn add(&self, id: &str, key: &Secret) -> Result<(), String> {
            assert!(self
                .0
                .lock()
                .unwrap()
                .insert(id.into(), key.hex().to_string())
                .is_none());
            Ok(())
        }
    }
    let (dir, host, _app, view) = fixture();
    let source = dir.path().join("legacy/xyz.block.buzz.app.dev/agents");
    std::fs::create_dir_all(&source).unwrap();
    let bytes = serde_json::to_vec(&json!([
        {"pubkey":PUB, "auth_tag":"[\"auth\",\"c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5\",\"\",\"6fd97eb61e46846e184a567429e66cbb76e84aa4f70b51cdf41e18b423679952433e952ae1fc344c74c6beaad0055a7a276d512823fcba8c6512407bb1558dce\"]", "relay_url":"", "name":"Selected", "agent_command":"buzz-agent", "agent_args":[], "start_on_app_launch":true},
        {"pubkey":"ab".repeat(32), "relay_url":"wss://stale.example", "name":"Not selected"},
        {"pubkey":"cd".repeat(32), "relay_url":"wss://user:secret@raw.example/path", "name":"Unsupported old pin"}
    ])).unwrap();
    std::fs::write(source.join("managed-agents.json"), &bytes).unwrap();
    let memory = Arc::new(Memory::default());
    host.with(|h| {
        h.credentials = memory.clone();
        Ok(())
    })
    .unwrap();
    // Required IPC destination: a missing argument must not use a legacy pin.
    assert!(invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development"})
    )
    .is_err());
    let invalid = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://user:private@raw.example/path"}),
    )
    .unwrap_err();
    assert_eq!(
        invalid,
        "Choose a secure community origin without credentials, path or query"
    );
    let prior = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://prior.example"}),
    )
    .unwrap();
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"https://CHOSEN.example/"}),
    )
    .unwrap();
    assert!(invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":prior["token"],"ids":[prior["candidates"][0]["id"]]})
    )
    .is_err());
    assert!(memory.1.lock().unwrap().is_empty());
    assert!(memory.0.lock().unwrap().is_empty());
    assert_eq!(preview["candidates"].as_array().unwrap().len(), 3);
    for candidate in preview["candidates"].as_array().unwrap() {
        assert_eq!(candidate["relayUrl"], "wss://chosen.example");
    }
    for hidden in ["raw.example", "stale.example", "user:secret", KEY] {
        assert!(!preview.to_string().contains(hidden));
    }
    let selected = preview["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["pubkey"] == PUB)
        .unwrap();
    let imported = invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":preview["token"],"ids":[selected["id"]]}),
    )
    .unwrap();
    assert_eq!(imported["agents"].as_array().unwrap().len(), 1);
    assert_eq!(imported["agents"][0]["pubkey"], PUB);
    assert_eq!(imported["agents"][0]["relayUrl"], "wss://chosen.example");
    assert_eq!(imported["agents"][0]["id"], selected["id"]);
    assert!(memory
        .0
        .lock()
        .unwrap()
        .contains_key(selected["id"].as_str().unwrap()));
    assert_eq!(imported["agents"][0]["configured"], true);
    assert_eq!(imported["agents"][0]["enabled"], false);
    assert_eq!(imported["agents"][0]["status"], "stopped");
    assert!(!imported.to_string().contains(KEY));
    assert_eq!(memory.1.lock().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(source.join("managed-agents.json")).unwrap(),
        bytes
    );
    assert!(invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":preview["token"],"ids":[selected["id"]]})
    )
    .is_err());
    host.shutdown().unwrap();
}

// The log path must pass the generated desktop ACL, not the permissive mock context.
fn log_acl_fixture() -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let dir = tempfile::tempdir().unwrap();
    let host = AgentHost::open(Ok((
        dir.path().join("store"),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let app = mock_builder()
        .manage(host.clone())
        .manage(crate::agent_models::ModelHost::new(Ok(dir
            .path()
            .join("store"))))
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (dir, host, app, view)
}

#[test]
fn log_ipc_requires_fresh_exact_owner_proof_and_consumes_challenge() {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use sha2::{Digest, Sha256};
    let (dir, host, _app, view) = log_acl_fixture();
    let key = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    let relay = "wss://relay.example";
    let id = format!("{key}-{:x}", Sha256::digest(relay.as_bytes()));
    let secp = Secp256k1::new();
    let mut owner_bytes = [0; 32];
    owner_bytes[31] = 2;
    let owner = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(owner_bytes).unwrap());
    let tag_digest = Sha256::digest(format!("nostr:agent-auth:{key}:"));
    let tag = serde_json::to_string(&[
        "auth",
        &owner.x_only_public_key().0.to_string(),
        "",
        &secp
            .sign_schnorr_no_aux_rand(&tag_digest, &owner)
            .to_string(),
    ])
    .unwrap();
    let row = |auth: Option<&str>| json!({"id":id,"pubkey":key,"relayUrl":relay,"name":"Fixture","systemPrompt":"","workspace":dir.path().to_str().unwrap(),"harness":{"command":"buzz-agent","args":[],"model":"","provider":""},"environment":{},"revision":1,"enabled":false,"credentialId":"fixture","authTag":auth,"imported":{}});
    let store = dir.path().join("store/agents.json");
    std::fs::write(
        &store,
        serde_json::to_vec(&json!({"version":1,"agents":[row(None)]})).unwrap(),
    )
    .unwrap();
    let target = json!({"id":id,"pubkey":key,"relayUrl":relay});
    assert!(invoke(&view, "agent_control_log_challenge", target.clone()).is_err());
    std::fs::write(
        &store,
        serde_json::to_vec(&json!({"version":1,"agents":[row(Some(&tag))]})).unwrap(),
    )
    .unwrap();
    for bad in [
        json!({"id":format!("{}-{}", "a".repeat(64), "b".repeat(64)),"pubkey":key,"relayUrl":relay}),
        json!({"id":id,"pubkey":key,"relayUrl":"wss://elsewhere.example"}),
    ] {
        assert!(invoke(&view, "agent_control_log_challenge", bad).is_err());
    }
    let challenge = || {
        invoke(&view, "agent_control_log_challenge", target.clone())
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    };
    let proof = |nonce: &str, id: &str, relay: &str, pair: &Keypair| {
        let digest = Sha256::digest(format!(
            "buzz-app:harness-log:v1:{id}:{key}:{relay}:{nonce}"
        ));
        secp.sign_schnorr_no_aux_rand(&digest, pair).to_string()
    };
    let read = |nonce: &str, sig: &str, id: &str, relay: &str| {
        invoke(
            &view,
            "agent_control_read_log",
            json!({"id":id,"pubkey":key,"relayUrl":relay,"nonce":nonce,"signature":sig}),
        )
    };
    let nonce = challenge();
    let signature = proof(&nonce, &id, relay, &owner);
    assert_eq!(read(&nonce, &signature, &id, relay).unwrap(), "");
    assert!(read(&nonce, &signature, &id, relay).is_err());
    let nonce = challenge();
    assert!(read(
        &nonce,
        &proof(&nonce, &id, relay, &owner),
        &id,
        "wss://elsewhere.example"
    )
    .is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    assert!(read(
        &nonce,
        &proof(&nonce, &id, relay, &owner),
        "wrong-id",
        relay
    )
    .is_err());
    let nonce = challenge();
    let mut wrong_bytes = [0; 32];
    wrong_bytes[31] = 1;
    let wrong_owner =
        Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(wrong_bytes).unwrap());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &wrong_owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    host.with(|h| {
        h.log_challenges.get_mut(&nonce).unwrap().issued -= std::time::Duration::from_secs(21);
        Ok(())
    })
    .unwrap();
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    let second = challenge();
    assert_ne!(nonce, second);
    assert_eq!(
        read(&second, &proof(&second, &id, relay, &owner), &id, relay).unwrap(),
        ""
    );
    assert_eq!(
        read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).unwrap(),
        ""
    );
    assert!(read(&second, &proof(&second, &id, relay, &owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let pending: Vec<_> = (0..4).map(|_| challenge()).collect();
    assert!(invoke(&view, "agent_control_log_challenge", target).is_err());
    assert_eq!(
        read(
            &pending[0],
            &proof(&pending[0], &id, relay, &owner),
            &id,
            relay
        )
        .unwrap(),
        ""
    );
}

#[cfg(unix)]
#[test]
fn pi_model_lookup_waits_out_brief_host_contention() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, host, _app, view) = fixture();
    let tools = dir.path().join("tools");
    std::fs::create_dir(&tools).unwrap();
    for tool in ["pi", "node", "buzz-pi-acp"] {
        let file = tools.join(tool);
        std::fs::write(&file, "#!/bin/sh\nread request\nprintf '%s\\n' '{\"id\":\"catalog\",\"type\":\"response\",\"command\":\"get_available_models\",\"success\":true,\"data\":{\"models\":[{\"provider\":\"databricks\",\"id\":\"model-a\"}]}}'\n").unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    // Another native operation (for example a snapshot refresh) briefly holds
    // the host while the lookup reads its settings.
    let (locked, wait) = std::sync::mpsc::channel();
    let holder = {
        let lock = host.0.clone();
        std::thread::spawn(move || {
            let _guard = lock.lock().unwrap();
            locked.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(400));
        })
    };
    wait.recv().unwrap();
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let result = invoke(
        &view,
        "agent_models_run",
        json!({"ticket":ticket,"request":{
            "host":"","filter":"","action":"connect","edit":{
                "name":"Pi draft","systemPrompt":"","workspace":dir.path(),
                "harness":{"command":tools.join("buzz-pi-acp"),"args":[],"provider":"","model":""},
                "environment":{}
            }
        }}),
    )
    .unwrap();
    holder.join().unwrap();
    assert_eq!(
        result["models"],
        json!([{"id":"databricks/model-a","name":"databricks/model-a"}])
    );
}

#[cfg(unix)]
#[test]
fn pi_connection_test_prompts_the_draft_selection() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, _host, _app, view) = fixture();
    let tools = dir.path().join("tools");
    std::fs::create_dir(&tools).unwrap();
    for tool in ["pi", "node", "buzz-pi-acp"] {
        let file = tools.join(tool);
        std::fs::write(&file, "#!/bin/sh\nread request\ncase \"$*\" in *'--model model-a'*) stop=stop;; *) stop=error;; esac\nprintf '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"%s\",\"errorMessage\":\"401\"}}\\n' \"$stop\"\n").unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let test = |model: &str| {
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":{
                "host":"","filter":"","action":"test","edit":{
                    "name":"Pi draft","systemPrompt":"","workspace":dir.path(),
                    "harness":{"command":tools.join("buzz-pi-acp"),"args":[],"provider":"databricks","model":model},
                    "environment":{}
                }
            }}),
        )
    };
    assert_eq!(test("model-a").unwrap()["models"], json!([]));
    let error = test("model-b").unwrap_err();
    assert!(
        error.as_str().unwrap().contains("rejected the API key"),
        "{error}"
    );
}

async fn assert_pending<F: std::future::Future>(mut future: std::pin::Pin<&mut F>) {
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn native_admission_waits_in_order_without_replaying_operations() {
    let (_dir, host, _app, _view) = fixture();
    let gate = host.2.clone().lock_owned().await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let first_calls = calls.clone();
    let mut first = std::pin::pin!(run(host.clone(), move |h| {
        first_calls.lock().unwrap().push("snapshot");
        h.snapshot()
    }));
    assert_pending(first.as_mut()).await;
    let second_calls = calls.clone();
    let mut second = std::pin::pin!(run(host.clone(), move |_| {
        second_calls.lock().unwrap().push("command");
        Err::<(), _>("Synthetic uncertain write".into())
    }));
    assert_pending(second.as_mut()).await;
    assert!(calls.lock().unwrap().is_empty());
    drop(gate);
    let (snapshot, command) = tokio::join!(first, second);
    assert!(snapshot.is_ok());
    assert_eq!(command.unwrap_err(), "Synthetic uncertain write");
    assert_eq!(*calls.lock().unwrap(), ["snapshot", "command"]);
}

#[tokio::test]
async fn queued_native_operation_observes_shutdown_before_mutation() {
    let (_dir, host, _app, _view) = fixture();
    let gate = host.2.clone().lock_owned().await;
    let mut pending = std::pin::pin!(run(host.clone(), |_| {
        panic!("a queued write must not run after shutdown")
    }));
    assert_pending(pending.as_mut()).await;
    host.shutdown().unwrap();
    drop(gate);
    let result: Result<(), String> = pending.await;
    assert_eq!(result.unwrap_err(), "Agent host is shutting down");
}

#[test]
fn poisoned_native_state_is_not_reported_as_transient_contention() {
    let (_dir, host, _app, _view) = fixture();
    let owner = host.clone();
    assert!(std::thread::spawn(move || {
        let _guard = owner.0.lock().unwrap();
        panic!("synthetic native failure");
    })
    .join()
    .is_err());
    let error = host.with(|_| Ok(())).unwrap_err();
    assert!(error.contains("restart the app"));
    assert!(!error.contains("operation is in progress"));
}

#[tokio::test]
async fn native_create_waits_for_a_snapshot_and_keeps_its_prepared_identity() {
    use tauri::Manager;
    let (_dir, host, app, _view) = fixture();
    let (entered, acquired) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let snapshot = tokio::spawn(run(host.clone(), move |h| {
        entered.send(()).unwrap();
        wait.recv().unwrap();
        h.snapshot()
    }));
    acquired.await.unwrap();
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut creating = std::pin::pin!(agent_control_create_prepare(
        app.state(),
        request_id.clone(),
        "wss://relay.example".into(),
        "ab".repeat(32),
    ));
    assert_pending(creating.as_mut()).await;
    release.send(()).unwrap();
    let prepared = creating.await.unwrap();
    assert!(snapshot.await.unwrap().is_ok());
    let retried = agent_control_create_prepare(
        app.state(),
        request_id,
        "wss://relay.example".into(),
        "ab".repeat(32),
    )
    .await
    .unwrap();
    assert_eq!(prepared, retried);
}

#[tokio::test]
async fn dropped_caller_does_not_release_a_running_native_operation() {
    let (_dir, host, _app, _view) = fixture();
    let (entered, acquired) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = tokio::spawn(run(host.clone(), move |_| {
        entered.send(()).unwrap();
        wait.recv().unwrap();
        Ok(())
    }));
    acquired.await.unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    // The caller has definitively dropped; the worker is still explicitly gated.
    assert!(host.2.try_lock().is_err());
    let mut next = std::pin::pin!(run(host.clone(), |h| h.snapshot()));
    assert_pending(next.as_mut()).await;
    release.send(()).unwrap();
    assert!(next.await.is_ok());
}

#[tokio::test]
async fn restore_uses_serialized_launch_preference_not_enabled_alone() {
    let (dir, host, _app, _view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut data: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    data["agents"][0]["startOnAppLaunch"] = json!(false);
    std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    host.restore().await;
    let data = host.with(|h| h.snapshot()).unwrap().data;
    assert!(data.agents[0].enabled);
    assert!(!data.agents[0].start_on_app_launch);
    assert!(data.agents[0].status == ProcessStatus::Stopped);
    assert!(data.agents[0].error.is_none());
    host.with(|h| h.controller.set_start_on_app_launch(&id, true))
        .unwrap();
    host.restore().await;
    let data = host.with(|h| h.snapshot()).unwrap().data;
    assert!(data.agents[0].start_on_app_launch);
    assert!(data.agents[0].status == ProcessStatus::Failed);
    assert_eq!(data.agents[0].error.as_deref(), Some(RUNTIME_GATE));
}

#[test]
fn startup_parks_metadata_without_credentials_or_runtime_and_follows_removal() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("store");
    let legacy = dir.path().join("legacy");
    let source = legacy
        .join(LegacySource::Installed.app_directory())
        .join("agents");
    std::fs::create_dir_all(&source).unwrap();
    let bytes = serde_json::to_vec(&json!([{
        "pubkey": "ab".repeat(32), "name": "Parked fixture",
        "start_on_app_launch": true, "auth_tag": "DO_NOT_COPY",
        "env_vars": {"TOKEN": "DO_NOT_COPY"}
    }]))
    .unwrap();
    std::fs::write(source.join("managed-agents.json"), &bytes).unwrap();
    let paths = || Ok((root.clone(), legacy.clone(), dir.path().join("workspace")));
    let host = AgentHost::open(paths());
    let snapshot = host.with(|host| host.snapshot()).unwrap();
    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(value["parked"][0]["name"], "Parked fixture");
    assert_eq!(value["agents"], json!([]));
    assert_eq!(value["inventoryWarnings"], json!([]));
    assert!(!value.to_string().contains("DO_NOT_COPY"));
    assert_eq!(
        std::fs::read(source.join("managed-agents.json")).unwrap(),
        bytes
    );
    drop(host);
    std::fs::remove_dir_all(&legacy).unwrap();
    let host = AgentHost::open(paths());
    let reopened = serde_json::to_value(host.with(|host| host.snapshot()).unwrap()).unwrap();
    // Without the old installation nothing is importable, so nothing is listed.
    assert_eq!(reopened["parked"], json!([]));
    assert_eq!(reopened["agents"], json!([]));
    assert_eq!(reopened["inventoryWarnings"], json!([]));
}
