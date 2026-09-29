use super::*;
use crate::agents::tests::{fixture, invoke, seed};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct Fake {
    opened: Mutex<Vec<(String, PathBuf)>>,
    connects: AtomicUsize,
    catalogs: AtomicUsize,
    failure: AtomicUsize,
}
impl Factory for Arc<Fake> {
    fn open(
        &self,
        workspace: &str,
        cache: &std::path::Path,
        _: Arc<dyn BrowserOpener>,
    ) -> Result<Box<dyn Connection>, String> {
        self.opened
            .lock()
            .unwrap()
            .push((workspace.into(), cache.into()));
        Ok(Box::new(self.clone()))
    }
}
impl Connection for Arc<Fake> {
    fn connect(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async {
            self.connects.fetch_add(1, Ordering::SeqCst);
            if self.failure.load(Ordering::SeqCst) == 1 {
                Err("Synthetic auth rejected".into())
            } else {
                Ok(())
            }
        })
    }
    fn models(
        &self,
        filter: Option<DatabricksModelFilter>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Vec<buzz_agent::catalog::ModelEntry>, AgentError>,
                > + Send
                + '_,
        >,
    > {
        Box::pin(async move {
            self.catalogs.fetch_add(1, Ordering::SeqCst);
            match self.failure.load(Ordering::SeqCst) {
                1 => return Err(AgentError::LlmAuth("Synthetic auth rejected".into())),
                2 => return Err(AgentError::Llm("Synthetic catalog rejected".into())),
                6 if self.connects.load(Ordering::SeqCst) == 0 => {
                    return Err(AgentError::LlmAuth("No cached token".into()))
                }
                3 => return Ok(vec![]),
                4 => {
                    return Ok(vec![buzz_agent::catalog::ModelEntry {
                        id: "not-discovered".into(),
                        name: "Known (default catalog)".into(),
                    }])
                }
                5 => {
                    return Ok(vec![buzz_agent::catalog::ModelEntry {
                        id: "a".repeat(513),
                        name: "Oversized".into(),
                    }])
                }
                _ => {}
            }
            Ok([
                ("catalog.schema.model-service", "Model Service"),
                ("endpoint-two", "Endpoint Two"),
            ]
            .into_iter()
            .filter(|(id, _)| filter.as_ref().is_none_or(|f| f.matches(id)))
            .map(|(id, name)| buzz_agent::catalog::ModelEntry {
                id: id.into(),
                name: name.into(),
            })
            .collect())
        })
    }
}
fn request(dir: &std::path::Path, id: &str, action: &str) -> Value {
    json!({"id":id,"expectedRevision":1,"host":"https://workspace.example.com","filter":"", "action":action,
    "edit":{"name":"Sample","systemPrompt":"Original","workspace":dir.to_str().unwrap(),"harness":{"command":"buzz-agent","args":[],"model":"custom-unchanged","provider":"databricks_v2","databricks":{"host":"https://workspace.example.com","filter":""}},"environment":{}}})
}

#[test]
#[cfg(unix)]
fn goose_databricks_models_load_through_native_ipc_for_an_unsaved_agent() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, _, _app, view) = fixture();
    let goose = dir.path().join("goose");
    let invoked = dir.path().join("invoked");
    std::fs::write(
        &goose,
        format!(
            "#!/bin/sh\n: > '{}'\nread request\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"providerId\":\"databricks_v2\",\"models\":[\"catalog.schema.goose-glm-5-3\"]}}}}'\n",
            invoked.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&goose, std::fs::Permissions::from_mode(0o700)).unwrap();
    let edit = json!({"name":"Goose","systemPrompt":"","workspace":dir.path(),
        "harness":{"command":goose,"args":["acp"],"provider":"databricks_v2","model":""},
        "environment":{}});
    let refresh_ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    assert!(invoke(
        &view,
        "agent_models_run",
        json!({"ticket":refresh_ticket,"request":{
            "host":"", "filter":"", "action":"refresh", "edit":edit
        }})
    )
    .unwrap_err()
    .to_string()
    .contains("explicit Browse or Retry"));
    assert!(!invoked.exists());
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let result = invoke(
        &view,
        "agent_models_run",
        json!({"ticket":ticket,"request":{
            "host":"", "filter":"", "action":"connect",
            "edit":edit
        }}),
    )
    .unwrap();
    assert!(invoked.exists());
    assert_eq!(result["models"][0]["id"], "catalog.schema.goose-glm-5-3");
    assert_eq!(result["host"], "");
}

#[test]
#[cfg(unix)]
fn goose_connection_test_uses_the_draft_model_and_environment() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, _, _app, view) = fixture();
    let goose = dir.path().join("goose");
    let script = r#"#!/bin/sh
[ "$1 $2 $3" = 'run --text Reply OK.' ] || exit 1
[ "$4 $5 $6 $7 $8 $9" = '--no-session --no-profile --max-turns 1 --quiet --output-format' ] || exit 1
[ "${10}" = 'json' ] || exit 1
[ "$GOOSE_PROVIDER" = 'openai' ] || exit 1
[ "$GOOSE_MODEL" = 'effective-model' ] || exit 1
[ "$GOOSE_MAX_TOKENS" = '10' ] || exit 1
[ "$GOOSE_THINKING_EFFORT" = 'off' ] || exit 1
[ "$(pwd)" = '__WORKSPACE__' ] || exit 1
if [ "$OPENAI_API_KEY" = 'draft-key' ]; then
  printf '%s\n' '{"metadata":{"status":"completed"},"messages":[{"role":"assistant","content":[{"type":"text","text":"OK"}]}]}'
else
  printf '%s\n' '{"metadata":{"status":"completed"},"messages":[{"role":"assistant","content":[{"type":"error","error":"authentication failed"}]}]}'
fi
"#
    .replace(
        "__WORKSPACE__",
        &dir.path().canonicalize().unwrap().display().to_string(),
    );
    std::fs::write(&goose, script).unwrap();
    std::fs::set_permissions(&goose, std::fs::Permissions::from_mode(0o700)).unwrap();
    let edit = json!({"name":"Goose","systemPrompt":"","workspace":dir.path(),
        "harness":{"command":goose,"args":["acp"],"provider":"openai","model":"visible-model"},
        "environment":{"GOOSE_MODEL":"effective-model","OPENAI_API_KEY":"draft-key"}});
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let result = invoke(
        &view,
        "agent_models_run",
        json!({"ticket":ticket,"request":{
            "host":"","filter":"","action":"test","edit":edit
        }}),
    );
    assert_eq!(result.unwrap()["models"], json!([]));
    let mut bad = edit;
    bad["environment"]["OPENAI_API_KEY"] = json!("bad-key");
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let error = invoke(
        &view,
        "agent_models_run",
        json!({"ticket":ticket,"request":{
            "host":"","filter":"","action":"test","edit":bad
        }}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("could not complete a request"));
}
#[test]
fn real_ipc_explicit_only_projection_overrides_retry_disconnect_and_gates() {
    let fake = Arc::new(Fake::default());
    let (dir, _, _app, view) = crate::agents::tests::fixture_with_models(|dir| {
        let host = ModelHost::new(Ok(dir.join("store")));
        ModelHost {
            state: host.state,
            factory: Arc::new(fake.clone()),
        }
    });
    let id = seed(dir.path());
    let call = |req: Value| {
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":req}),
        )
    };
    for _ in 0..3 {
        invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    }
    assert!(fake.opened.lock().unwrap().is_empty());
    let req = request(dir.path(), &id, "refresh");
    let result = call(req.clone()).unwrap();
    assert_eq!(fake.connects.load(Ordering::SeqCst), 0);
    assert_eq!(result["models"][0]["id"], "catalog.schema.model-service");
    assert_eq!(result["models"][0]["name"], "Model Service");
    assert!(!result.to_string().contains("DO_NOT_PROJECT"));
    let mut filtered = req.clone();
    filtered["filter"] = json!("endpoint-*");
    filtered["edit"]["harness"]["databricks"]["filter"] = filtered["filter"].clone();
    let filtered_result = call(filtered).unwrap();
    assert_eq!(
        filtered_result["models"],
        json!([{"id":"endpoint-two","name":"Endpoint Two"}])
    );
    let first_cache = fake.opened.lock().unwrap()[0].1.clone();
    assert_eq!(first_cache, dir.path().join("store/buzz-agent/oauth"));
    let mut connect = req.clone();
    connect["action"] = json!("connect");
    call(connect.clone()).unwrap();
    assert_eq!(fake.connects.load(Ordering::SeqCst), 0); // cached discovery does not sign in
    fake.failure.store(6, Ordering::SeqCst);
    assert!(call(req.clone()).is_err()); // Refresh must stay headless
    assert_eq!(fake.connects.load(Ordering::SeqCst), 0);
    call(connect.clone()).unwrap();
    assert_eq!(fake.connects.load(Ordering::SeqCst), 1);
    fake.failure.store(1, Ordering::SeqCst);
    assert!(call(connect.clone()).is_err());
    fake.failure.store(0, Ordering::SeqCst);
    call(connect).unwrap();
    for mode in [2, 3, 4, 5] {
        fake.failure.store(mode, Ordering::SeqCst);
        let response = call(req.clone());
        if mode == 2 || mode == 5 {
            assert!(response.is_err());
        } else {
            assert_eq!(response.unwrap()["models"], json!([]));
        }
    }
    fake.failure.store(0, Ordering::SeqCst);
    let mut other = req.clone();
    other["host"] = json!("https://other.example.com");
    other["edit"]["harness"]["databricks"]["host"] = other["host"].clone();
    call(other).unwrap();
    assert_eq!(fake.opened.lock().unwrap().last().unwrap().1, first_cache);
    let count = fake.opened.lock().unwrap().len();
    for patch in [
        json!({"DATABRICKS_TOKEN":"NEVER_PRINT"}),
        json!({"BUZZ_AGENT_PROVIDER":"other"}),
        json!({"DATABRICKS_HOST":"https://other.example.com"}),
        json!({"DATABRICKS_MODEL_FILTER":"other*"}),
    ] {
        let mut conflict = req.clone();
        conflict["edit"]["environment"] = patch;
        let error = call(conflict).unwrap_err().to_string();
        assert!(!error.contains("NEVER_PRINT"));
    }
    let mut stale = req.clone();
    stale["expectedRevision"] = json!(2);
    assert!(call(stale).is_err());
    assert_eq!(fake.opened.lock().unwrap().len(), count);
    let mut overridden = req.clone();
    overridden["edit"]["environment"] = json!({"BUZZ_AGENT_MODEL":"PRIVATE_MODEL"});
    let projected = call(overridden).unwrap();
    assert_eq!(projected["modelOverridden"], true);
    assert!(!projected.to_string().contains("PRIVATE_MODEL"));
    std::fs::create_dir_all(&first_cache).unwrap();
    let cache_key = "https://workspace.example.com/oidc/.well-known/oauth-authorization-server|databricks-cli|all-apis,offline_access";
    use sha2::{Digest, Sha256};
    let cached = first_cache
        .join("databricks")
        .join(format!("{:x}.json", Sha256::digest(cache_key.as_bytes())));
    std::fs::write(&cached, "SYNTHETIC").unwrap();
    let sentinel = dir.path().join("legacy-sentinel");
    std::fs::write(&sentinel, "UNCHANGED").unwrap();
    let mut disconnect = req;
    disconnect["action"] = json!("disconnect");
    disconnect.as_object_mut().unwrap().remove("edit");
    assert_eq!(call(disconnect).unwrap()["disconnected"], true);
    assert!(!cached.exists());
    assert!(first_cache.exists());
    assert!(sentinel.exists());
    let snapshot = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(snapshot["agents"][0]["harness"]["model"], "sample");
    assert_eq!(snapshot["runtimeAvailable"], false);
    assert_eq!(snapshot["importAvailable"], cfg!(target_os = "macos"));
    invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert!(invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"start"})
    )
    .is_err());
}
#[test]
fn browse_uses_write_only_agent_defaults_workspace_and_filter_through_ipc() {
    let fake = Arc::new(Fake::default());
    let (dir, _, _app, view) = crate::agents::tests::fixture_with_models(|dir| {
        let host = ModelHost::new(Ok(dir.join("store")));
        ModelHost {
            state: host.state,
            factory: Arc::new(fake.clone()),
        }
    });
    let id = seed(dir.path());
    invoke(
        &view,
        "agent_control_save_defaults",
        json!({"edit":{"harness":"buzz-agent","provider":"databricks_v2","model":"","effort":"",
            "environment":{"DATABRICKS_HOST":"https://inherited.example.com",
                "DATABRICKS_MODEL_FILTER":"endpoint-*"}}}),
    )
    .unwrap();
    let call = |req: Value| {
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":req}),
        )
    };
    // The UI cannot see write-only defaults, so it sends blanks and native
    // supplies the inherited workspace and filter.
    let mut req = request(dir.path(), &id, "refresh");
    req["host"] = json!("");
    req["inheritWorkspace"] = json!(true);
    req["edit"]["harness"]["provider"] = json!("");
    req["edit"]["harness"]
        .as_object_mut()
        .unwrap()
        .remove("databricks");
    let result = call(req.clone()).unwrap();
    assert_eq!(
        result["models"],
        json!([{"id":"endpoint-two","name":"Endpoint Two"}])
    );
    assert_eq!(result["host"], ""); // The write-only inherited URL stays native.
    assert!(!result.to_string().contains("https://inherited.example.com"));
    assert!(!result.to_string().contains("endpoint-*"));
    assert_eq!(
        fake.opened.lock().unwrap().last().unwrap().0,
        "https://inherited.example.com"
    );
    // An explicit, different workspace still conflicts instead of silently
    // browsing a workspace the launch would not use.
    req["host"] = json!("https://other.example.com");
    assert!(call(req.clone()).is_err());
    req["host"] = json!("");
    req["filter"] = json!("other-*");
    assert!(call(req.clone()).is_err());
    // Without the flag a blank is explicit and still conflicts with the
    // inherited workspace, as before.
    req["filter"] = json!("");
    req["inheritWorkspace"] = json!(false);
    assert!(call(req.clone()).is_err());

    // An explicit per-agent workspace cannot be bypassed by a caller that
    // manually sets inheritWorkspace, even while global env defaults exist.
    req["edit"]["harness"]["databricks"] = json!({
        "host":"https://agent.example.com", "filter":"agent-*"
    });
    req["inheritWorkspace"] = json!(true);
    assert!(call(req.clone()).is_err());
    req["inheritWorkspace"] = json!(false);
    req["host"] = json!("https://agent.example.com");
    req["filter"] = json!("agent-*");
    let result = call(req).unwrap();
    assert_eq!(result["host"], "https://agent.example.com");
    assert_eq!(
        fake.opened.lock().unwrap().last().unwrap().0,
        "https://agent.example.com"
    );
}

#[test]
fn disconnect_recovers_an_inherited_workspace_without_revealing_it() {
    let fake = Arc::new(Fake::default());
    let (dir, _, _app, view) = crate::agents::tests::fixture_with_models(|dir| {
        let host = ModelHost::new(Ok(dir.join("store")));
        ModelHost {
            state: host.state,
            factory: Arc::new(fake.clone()),
        }
    });
    let id = seed(dir.path());
    invoke(
        &view,
        "agent_control_save_defaults",
        json!({"edit":{"harness":"buzz-agent","provider":"databricks_v2","model":"","effort":"",
            "environment":{"DATABRICKS_HOST":"https://inherited.example.com"}}}),
    )
    .unwrap();
    let call = |req: Value| {
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":req}),
        )
    };
    // Browse signs in against the inherited workspace.
    let mut browse = request(dir.path(), &id, "refresh");
    browse["host"] = json!("");
    browse["inheritWorkspace"] = json!(true);
    browse["edit"]["harness"]
        .as_object_mut()
        .unwrap()
        .remove("databricks");
    call(browse).unwrap();
    let cache = dir.path().join("store/buzz-agent/oauth/databricks");
    std::fs::create_dir_all(&cache).unwrap();
    let key = "https://inherited.example.com/oidc/.well-known/oauth-authorization-server|databricks-cli|all-apis,offline_access";
    use sha2::{Digest, Sha256};
    let cached = cache.join(format!("{:x}.json", Sha256::digest(key.as_bytes())));
    std::fs::write(&cached, "SYNTHETIC").unwrap();
    // Disconnect carries no draft and a blank host, like the picker sends.
    let disconnect = json!({"host":"","filter":"","action":"disconnect","inheritWorkspace":true});
    let result = call(disconnect.clone()).unwrap();
    assert_eq!(result["disconnected"], true);
    assert_eq!(result["host"], "");
    assert!(!result.to_string().contains("inherited.example.com"));
    assert!(!cached.exists());
    // Without the flag, a blank host is still refused.
    let mut unflagged = disconnect;
    unflagged["inheritWorkspace"] = json!(false);
    assert!(call(unflagged).is_err());
}

#[test]
fn native_discovery_preserves_absolute_harness_and_saved_or_draft_provider_overrides() {
    let fake = Arc::new(Fake::default());
    let (dir, _, _app, view) = crate::agents::tests::fixture_with_models(|dir| {
        let host = ModelHost::new(Ok(dir.join("store")));
        ModelHost {
            state: host.state,
            factory: Arc::new(fake.clone()),
        }
    });
    let id = seed(dir.path());
    let call = |req: Value| {
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":req}),
        )
    };
    let mut req = request(dir.path(), &id, "connect");
    req["edit"]["harness"]["command"] = json!("/fixture/bin/buzz-agent");
    call(req.clone()).unwrap();
    req["edit"]["harness"]["provider"] = json!("selector-other");
    req["edit"]["environment"] = json!({"BUZZ_AGENT_PROVIDER":"databricks_v2"});
    call(req.clone()).unwrap();
    invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":req["edit"]}),
    )
    .unwrap();
    req["expectedRevision"] = json!(2);
    req["edit"]["environment"] = json!({}); // saved native override remains authoritative
    call(req.clone()).unwrap();
    let opens = fake.opened.lock().unwrap().len();
    req["edit"]["environment"] = json!({"BUZZ_AGENT_PROVIDER":null});
    assert!(call(req).is_err()); // effective unsupported provider never reaches auth
    assert_eq!(fake.opened.lock().unwrap().len(), opens);
    assert_eq!(fake.connects.load(Ordering::SeqCst), 0);
}

#[test]
fn runtime_factory_no_ambient_auth_on_construction_or_empty_headless_refresh() {
    struct NoBrowser;
    impl BrowserOpener for NoBrowser {
        fn open(&self, _: &str) -> Result<(), String> {
            panic!("Passive browser launch");
        }
    }
    let dir = tempfile::tempdir().unwrap();
    // No live endpoint can be contacted with an empty app-isolated token cache.
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let connection = RuntimeFactory
            .open(
                "https://workspace.example.invalid",
                dir.path(),
                Arc::new(NoBrowser),
            )
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), connection.models(None))
            .await
            .unwrap();
        assert!(result.is_err());
        // Actual production connect forwarding cannot silently become a no-op.
        // Own the listener until it observes a TLS attempt, then close it rather
        // than depending on platform-specific refused-connection retry timing.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let connection = RuntimeFactory
            .open(
                &format!("https://127.0.0.1:{port}"),
                dir.path(),
                Arc::new(NoBrowser),
            )
            .unwrap();
        let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(connection.connect(), async move {
                let (peer, _) = listener.accept().await.unwrap();
                let mut hello = [0u8; 1];
                assert_eq!(peer.peek(&mut hello).await.unwrap(), 1);
            })
        })
        .await
        .unwrap();
        assert!(result.is_err());
    });
    assert!(RuntimeFactory
        .open(
            "http://workspace.example.com",
            dir.path(),
            Arc::new(NoBrowser)
        )
        .is_err());
}
#[tokio::test]
async fn cancel_fences_begin_run_and_waits_for_drop_without_blocking_stop() {
    let (dir, _, _app, view) = fixture();
    let id = seed(dir.path());
    let host = ModelHost::new(Ok(dir.path().join("models")));
    let ticket = host.begin().unwrap();
    host.cancel(ticket).unwrap();
    assert!(host
        .run(ticket, async { panic!("Cancelled ticket ran") })
        .await
        .is_err());
    let ticket = host.begin().unwrap();
    let dropped = Arc::new(AtomicUsize::new(0));
    struct DropGuard(Arc<AtomicUsize>);
    impl Drop for DropGuard {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let guard = DropGuard(dropped.clone());
    let owner = host.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        owner
            .run(ticket, async move {
                let _guard = guard;
                let _ = started.send(());
                std::future::pending().await
            })
            .await
    });
    ready.await.unwrap();
    invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert!(host.begin().is_err());
    host.cancel(ticket).unwrap();
    assert!(host.begin().is_err()); // cancellation is requested, not retirement
    assert!(tokio::time::timeout(Duration::from_secs(2), running)
        .await
        .expect("Cancellation did not drop actual native work")
        .unwrap()
        .is_err());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    let next = host.begin().unwrap();
    host.cancel(ticket).unwrap(); // stale cancel cannot cancel next
    assert!(host.begin().is_err());
    host.cancel(next).unwrap();
    host.shutdown();
    assert!(host.begin().is_err());
}
#[test]
fn workspace_policy_and_cache_are_canonical_and_separate() {
    assert_eq!(
        origin("https://EXAMPLE.com:443/").unwrap(),
        "https://example.com"
    );
    for raw in [
        "",
        "http://example.com",
        "https://u:p@example.com",
        "https://example.com/path",
        "https://example.com?token=SECRET",
        "https://example.com#x",
        "https://example.com/../",
        " https://example.com",
        "https://example.com\\evil",
    ] {
        let error = origin(raw).unwrap_err();
        assert!(!error.contains("SECRET"));
    }
    let dir = tempfile::tempdir().unwrap();
    let a = ModelHost::new(Ok(dir.path().join("app-a")));
    let b = ModelHost::new(Ok(dir.path().join("app-b")));
    assert_ne!(
        a.cache("https://example.com").unwrap(),
        b.cache("https://example.com").unwrap()
    );
}

#[cfg(unix)]
#[test]
fn linked_cache_is_refused_before_credential_work() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = dir.path().join("models");
    std::os::unix::fs::symlink(other.path(), &root).unwrap();
    assert!(ModelHost::new(Ok(root))
        .cache("https://example.com")
        .is_err());
}

#[cfg(unix)]
#[test]
fn real_ipc_refuses_linked_helper_namespace_before_opening_connection() {
    let fake = Arc::new(Fake::default());
    let (dir, _, _app, view) = crate::agents::tests::fixture_with_models(|dir| {
        let host = ModelHost::new(Ok(dir.join("store")));
        ModelHost {
            state: host.state,
            factory: Arc::new(fake.clone()),
        }
    });
    let id = seed(dir.path());
    let other = tempfile::tempdir().unwrap();
    let sentinel = other.path().join("untouched");
    std::fs::write(&sentinel, "SYNTHETIC").unwrap();
    let cache = ModelHost::new(Ok(dir.path().join("store")))
        .cache("https://workspace.example.com")
        .unwrap();
    let namespace = cache.join("databricks");
    std::fs::create_dir_all(&namespace).unwrap();
    std::fs::remove_dir(&namespace).unwrap();
    std::os::unix::fs::symlink(other.path(), namespace).unwrap();
    for action in ["connect", "refresh", "disconnect"] {
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        assert!(invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":request(dir.path(), &id, action)})
        )
        .is_err());
    }
    assert!(fake.opened.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "SYNTHETIC");
}

#[tokio::test]
async fn unstarted_ticket_expires_and_old_run_cannot_claim_its_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let host = ModelHost::new(Ok(dir.path().join("models")));
    let expired = host.begin().unwrap();
    host.state.lock().unwrap().pending.as_mut().unwrap().created =
        std::time::Instant::now() - Duration::from_secs(16);
    assert!(host
        .run(expired, async { panic!("Expired ticket ran") })
        .await
        .is_err());
    let next = host.begin().unwrap();
    assert_ne!(next, expired);
    assert!(host
        .run(expired, async { panic!("Stale ticket ran") })
        .await
        .is_err());
    host.cancel(next).unwrap();
    assert!(host.begin().is_ok());
}

#[cfg(unix)]
#[test]
fn pi_catalog_uses_native_ticket_and_draft_configuration_without_saving() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, _host, _app, view) = fixture();
    std::fs::create_dir(dir.path().join("local-config")).unwrap();
    let tools = dir.path().join("tools");
    std::fs::create_dir(&tools).unwrap();
    for tool in ["pi", "node", "buzz-pi-acp"] {
        let file = tools.join(tool);
        std::fs::write(&file, r#"#!/bin/sh
read request
[ "$PI_CODING_AGENT_DIR" -ef "./local-config" ] || exit 1
[ "$BUZZ_PRIVATE_KEY" = "" ] || exit 1
printf '%s\n' '{"id":"catalog","type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"extension","id":"namespace/model.v1"}]}}'
"#).unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let result=invoke(&view,"agent_models_run",json!({"ticket":ticket,"request":{
        "host":"","filter":"","action":"connect","edit":{
            "name":"Pi draft","systemPrompt":"","workspace":dir.path(),
            "harness":{"command":tools.join("buzz-pi-acp"),"args":[],"provider":"extension","model":"invalid-old-id"},
            "environment":{"PI_CODING_AGENT_DIR":dir.path().join("local-config")}
        }
    }})).unwrap();
    assert_eq!(
        result["models"],
        json!([{"id":"extension/namespace/model.v1","name":"extension/namespace/model.v1"}])
    );
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap()["agents"],
        json!([])
    );
}
