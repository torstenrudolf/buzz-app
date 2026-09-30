use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

#[test]
fn routes_cannot_retarget_credentials_or_expand_http_access() {
    for community in [
        "http://relay.test",
        "https://u:p@relay.test",
        "https://relay.test/path",
        "https://relay.test/?q",
        "https://relay.test/#x",
    ] {
        assert!(request_url(community, "/query", "POST").is_err());
    }
    for path in [
        "//other.test/query",
        "/query?target=x",
        "/api/admin",
        "/../query",
        "https://other.test/query",
    ] {
        assert!(request_url("https://relay.test", path, "POST").is_err());
    }
    assert!(request_url("https://relay.test", "/events", "GET").is_err());
    assert_eq!(
        request_url("https://relay.test", "/query", "POST")
            .unwrap()
            .as_str(),
        "https://relay.test/query"
    );
}

#[test]
fn websocket_auth_is_bound_to_the_captured_community() {
    let mut event = EventTemplate {
        kind: 22242,
        created_at: 1,
        content: "".into(),
        tags: vec![
            vec!["relay".into(), "wss://relay.test".into()],
            vec!["challenge".into(), "nonce".into()],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    assert!(validate_event("https://other.test", &event).is_err());
    event
        .tags
        .push(vec!["relay".into(), "wss://other.test".into()]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.kind = 27235;
    assert!(validate_event("https://relay.test", &event).is_err());
}

fn fixture_server(response: String) -> (Url, std::thread::JoinHandle<(String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://{}/query", listener.local_addr().unwrap())).unwrap();
    let task = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            let text = String::from_utf8_lossy(&bytes);
            if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(0);
                if body.len() == length {
                    let result = (headers.into(), body.into());
                    socket.write_all(response.as_bytes()).unwrap();
                    return result;
                }
            }
        }
    });
    (url, task)
}

#[tokio::test]
async fn native_http_signs_exact_bytes_and_never_follows_redirects() {
    // HTTP is test-transport-only; the IPC boundary always requires HTTPS.
    let (url, task) = fixture_server("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into());
    let body = r#"[{"kinds":[0],"limit":5}]"#;
    let result = send(
        &IdentityHost::fixture(),
        url.clone(),
        "POST",
        Some(body.into()),
        true,
        MAX_RESPONSE,
    )
    .await
    .unwrap();
    assert_eq!(result.status, 302);
    let (headers, sent) = task.join().unwrap();
    assert_eq!(sent, body);
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!(event["kind"], 27235);
    assert_eq!(event["content"], "");
    assert_eq!(event["tags"][0], serde_json::json!(["u", url.as_str()]));
    assert_eq!(event["tags"][1], serde_json::json!(["method", "POST"]));
    assert_eq!(
        event["tags"][2],
        serde_json::json!(["payload", format!("{:x}", Sha256::digest(body.as_bytes()))])
    );
    verify(&event);
}

#[tokio::test]
async fn memory_response_limit_rejects_before_generic_transport_budget() {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        2 * 1024 * 1024 + 1,
        "x".repeat(2 * 1024 * 1024 + 1)
    );
    let (url, task) = fixture_server(response);
    let result = send(
        &IdentityHost::fixture(),
        url,
        "POST",
        Some("[]".into()),
        true,
        2 * 1024 * 1024,
    )
    .await;
    assert!(matches!(result, Err(ref message) if message == "Relay response is too large"));
    task.join().unwrap();
}

fn verify(event: &serde_json::Value) {
    let serialized = serde_json::to_vec(&serde_json::json!([
        0,
        event["pubkey"],
        event["created_at"],
        event["kind"],
        event["tags"],
        event["content"]
    ]))
    .unwrap();
    let hash = Sha256::digest(serialized);
    assert_eq!(event["id"], format!("{hash:x}"));
    let signature: secp256k1::schnorr::Signature = event["sig"].as_str().unwrap().parse().unwrap();
    let public: secp256k1::XOnlyPublicKey = event["pubkey"].as_str().unwrap().parse().unwrap();
    secp256k1::Secp256k1::verification_only()
        .verify_schnorr(&signature, &hash, &public)
        .unwrap();
}

#[test]
fn real_ipc_restores_identity_signs_and_rejects_invalid_requests() {
    // The path resolver reads HOME at runtime. Isolate it in a child rather
    // than changing process-global HOME under the parallel test runner.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "relay::tests::isolated_agent_ipc_probe",
        "--nocapture",
    ]);
    #[cfg(unix)]
    {
        let home = tempfile::tempdir().unwrap();
        #[cfg(target_os = "macos")]
        let path = home
            .path()
            .join("Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json");
        #[cfg(target_os = "linux")]
        let path = home
            .path()
            .join(".local/share/xyz.block.buzz.app/agents/managed-agents.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "[]").unwrap();
        child.env("HOME", home.path()).env_remove("XDG_DATA_HOME");
        let output = child.env("BUZZ_AGENT_IPC_PROBE", "1").output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(target_os = "windows")]
    {
        let output = child.env("BUZZ_AGENT_IPC_PROBE", "1").output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn isolated_agent_ipc_probe() {
    if std::env::var("BUZZ_AGENT_IPC_PROBE").as_deref() != Ok("1") {
        return;
    }
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    #[cfg(unix)]
    use tauri::Manager;
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    let public = invoke("identity_restore", serde_json::json!({})).unwrap();
    let event = invoke(
        "relay_sign",
        serde_json::json!({
            "community": "https://relay.test", "event": {
                "kind": 9, "created_at": 123, "tags": [["h", "channel"]], "content": "IPC message"
            }
        }),
    )
    .unwrap();
    assert_eq!(event["pubkey"], public);
    verify(&event);
    let target = serde_json::json!({"owner": public, "pubkey": "02".repeat(32)});
    let authorized = invoke(
        "relay_agent_authorize",
        serde_json::json!({
            "community": "https://relay.test", "target": target
        }),
    )
    .unwrap();
    assert_eq!(authorized["auth"][0], "auth");
    let resolved = invoke("relay_agent_resolve", serde_json::json!({
        "community": "https://relay.test", "target": {"owner": public, "pubkey": "02".repeat(32), "confirmed": true}
    })).unwrap();
    assert_eq!(resolved["relayUrl"], "wss://relay.test");
    #[cfg(unix)]
    {
        let library = invoke("relay_agent_library", serde_json::json!({})).unwrap();
        assert_eq!(
            library,
            serde_json::json!({"definitions": [], "identities": []})
        );
        assert!(app
            .path()
            .data_dir()
            .unwrap()
            .starts_with(std::env::var("HOME").unwrap()));
    }
    // Library IPC success is exercised against an isolated HOME on Unix.
    // Windows known-folder inventory is not isolated here; do not invoke its
    // reader until a test-only fixture can control that path.
    // Each must reach the command: a handler refusal is fine; an ACL refusal is not.
    for (command, input) in [
        (
            "relay_agent_memories_read",
            serde_json::json!({"community": "https://relay.test", "agent": public}),
        ),
        (
            "relay_agent_observer",
            serde_json::json!({"community": "https://relay.test", "event": {"id": "bad"}}),
        ),
        (
            "relay_agent_log_proof",
            serde_json::json!({"community": "https://relay.test", "target": {"id": "bad", "pubkey": public, "relayUrl": "wss://relay.test", "nonce": "bad"}}),
        ),
    ] {
        let result = invoke(command, input);
        assert!(
            !format!("{result:?}").contains(&format!("{command} not allowed")),
            "ACL blocked {command}"
        );
    }
    assert!(invoke("relay_http", serde_json::json!({
        "community": "https://relay.test", "path": "//other.test/query", "method": "POST", "body": "[]"
    })).is_err());
    assert!(invoke("relay_sign", serde_json::json!({
        "community": "https://relay.test", "event": {
            "kind": 22242, "created_at": 123, "tags": [["relay", "wss://other.test"], ["challenge", "nonce"]], "content": ""
        }
    })).is_err());
    let id = "11111111-1111-4111-8111-111111111111";
    assert!(invoke(
        "relay_sign",
        serde_json::json!({
            "community": "https://relay.test", "event": {
                "kind": 5, "created_at": 123,
                "tags": [["h", id], ["a", format!("30620:{}:{id}", "a".repeat(64))]], "content": ""
            }
        })
    )
    .is_err());
    let deletion = invoke("relay_sign", serde_json::json!({
        "community": "https://relay.test", "event": {
            "kind": 5, "created_at": 123,
            "tags": [["h", id], ["a", format!("30620:{}:{id}", public.as_str().unwrap())]], "content": ""
        }
    })).unwrap();
    verify(&deletion);
    assert!(invoke(
        "relay_workflow_runs",
        serde_json::json!({
            "community": "https://relay.test", "id": "../query", "cursor": null
        })
    )
    .unwrap_err()
    .to_string()
    .contains("Invalid workflow read"));
}

#[tokio::test]
async fn signing_is_verifiable_and_does_not_export_a_key() {
    let event = IdentityHost::fixture()
        .sign(EventTemplate {
            kind: 9,
            created_at: 123,
            tags: vec![vec!["h".into(), "channel".into()]],
            content: "Hello\nfrom native".into(),
        })
        .await
        .unwrap();
    verify(&event);
    assert_eq!(
        event["pubkey"],
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
    );
    assert!(!event.to_string().contains("nsec"));
    assert!(IdentityHost::default()
        .sign(EventTemplate {
            kind: 9,
            created_at: 0,
            tags: vec![],
            content: "".into()
        })
        .await
        .is_err());
}

#[test]
fn workflow_history_is_fixed_and_cannot_retarget_native_http() {
    let id = "11111111-1111-4111-8111-111111111111";
    let cursor = WorkflowCursor {
        before: "2026-09-29T20:00:00Z".into(),
        before_id: id.into(),
    };
    assert_eq!(workflow_runs_url("https://relay.test", id, Some(&cursor)).unwrap().as_str(),
        "https://relay.test/workflows/11111111-1111-4111-8111-111111111111/runs?limit=20&before=2026-09-29T20%3A00%3A00Z&before_id=11111111-1111-4111-8111-111111111111");
    for invalid in [
        "../query",
        "11111111-1111-4111-8111-111111111111?target=x",
        "11111111-1111-4111-8111-111111111111/../query",
    ] {
        assert!(workflow_runs_url("https://relay.test", invalid, None).is_err());
    }
    assert!(workflow_runs_url(
        "https://relay.test",
        id,
        Some(&WorkflowCursor {
            before: "2026-09-29T20:00:00Z&target=x".into(),
            before_id: id.into()
        })
    )
    .is_err());
    assert!(request_url(
        "https://relay.test",
        "/workflows/11111111-1111-4111-8111-111111111111/runs",
        "GET"
    )
    .is_err());
}

#[test]
fn workflow_signer_rejects_nonworkflow_deletes_and_invalid_commands() {
    let id = "11111111-1111-4111-8111-111111111111";
    let mut event = EventTemplate {
        kind: 5,
        created_at: 1,
        content: "".into(),
        tags: vec![
            vec!["h".into(), id.into()],
            vec!["a".into(), format!("30620:{}:{id}", "a".repeat(64))],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[1][1] = format!("30030:{}:{id}", "a".repeat(64));
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1][1] = format!("30620:{}:{id}", "a".repeat(64));
    event.tags.push(vec!["e".into(), "b".repeat(64)]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags.pop();
    event.kind = 46020;
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1] = vec!["d".into(), id.into()];
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.content = "not empty".into();
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[tokio::test]
async fn workflow_get_is_authenticated_without_payload_and_never_redirects() {
    let (mut url, task) = fixture_server("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into());
    url.set_path("/workflows/11111111-1111-4111-8111-111111111111/runs");
    url.set_query(Some("limit=20"));
    let response = send(
        &IdentityHost::fixture(),
        url.clone(),
        "GET",
        None,
        true,
        1024 * 1024,
    )
    .await
    .unwrap();
    assert_eq!(response.status, 302);
    let (headers, body) = task.join().unwrap();
    assert!(headers
        .starts_with("GET /workflows/11111111-1111-4111-8111-111111111111/runs?limit=20 HTTP/1.1"));
    assert!(body.is_empty());
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!(event["tags"][0], serde_json::json!(["u", url.as_str()]));
    assert_eq!(event["tags"][1], serde_json::json!(["method", "GET"]));
    assert_eq!(event["tags"].as_array().unwrap().len(), 3);
    verify(&event);
}

#[test]
fn shared_kind_five_signer_accepts_message_and_reaction_deletion_only_in_broker_shape() {
    let id = "a".repeat(64);
    let mut event = EventTemplate {
        kind: 5,
        created_at: 123,
        content: String::new(),
        tags: vec![
            vec!["h".into(), "room".into()],
            vec!["e".into(), id.clone()],
            vec!["k".into(), "9".into()],
            vec!["client-id".into(), "intent".into()],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.created_at = 9_007_199_254_740_992;
    assert!(validate_event("https://relay.test", &event).is_err());
    event.created_at = 123;
    event.content = "not empty".into();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.content.clear();
    event.tags[0][1].clear();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[0][1] = "😀".repeat(128);
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[0][1].push('😀');
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[0][1] = "room".into();
    event.tags[2][1] = "7".into();
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[2][1] = "40002".into();
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[2][1] = "30620".into();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[2][1] = "9".into();
    event.tags.push(vec!["e".into(), id.clone()]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags.pop();
    event.tags[1][1] = "A".repeat(64);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1][1] = id;
    event.tags.push(vec!["a".into(), "30620:other:id".into()]);
    assert!(validate_event("https://relay.test", &event).is_err());
}
