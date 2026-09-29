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

fn fixture_server(response: &'static str) -> (Url, std::thread::JoinHandle<(String, String)>) {
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
    let (url, task) = fixture_server("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
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
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
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
    let (mut url, task) = fixture_server("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
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


#[test]
fn native_write_commands_reach_handlers_through_production_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let requests = [
        (
            "relay_channel_sign",
            serde_json::json!({"community":"https://relay.test","route":"channel-lifecycle","event":{"kind":9002,"created_at":1700000010,"content":"","tags":[["h","11111111-1111-4111-8111-111111111111"],["archived","true"]]}}),
        ),
        (
            "relay_kit_prepare",
            serde_json::json!({"community":"https://relay.test","record":{"version":1,"community":"https://relay.test","deleted":false,"value":{"type":"team","id":"mine","name":"Mine","agents":[]}}}),
        ),
        (
            "relay_kit_decode",
            serde_json::json!({"community":"https://relay.test","events":[]}),
        ),
        (
            "relay_kit_sign",
            serde_json::json!({"community":"invalid","event":{"kind":30078,"created_at":1,"content":"","tags":[]}}),
        ),
        (
            "relay_channel_publish",
            serde_json::json!({"community":"invalid","route":"channel-lifecycle","event":{}}),
        ),
        (
            "relay_direct_message",
            serde_json::json!({"community":"invalid","pubkeys":[]}),
        ),
    ];
    for (command, body) in requests {
        let result = get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        );
        if let Err(error) = result {
            assert!(
                !error.to_string().contains("not allowed"),
                "{command} blocked by ACL: {error}"
            );
        }
    }
}

#[test]
fn channel_commands_reject_malformed_tags_through_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |tags: Vec<Vec<String>>| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_channel_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test", "route": "channel-lifecycle",
                    "event": { "kind": 9002, "created_at": 123, "content": "", "tags": tags }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let h = vec!["h".into(), uuid::Uuid::nil().to_string()];
    let archived = vec!["archived".into(), "true".into()];
    assert!(invoke(vec![h.clone(), archived.clone()]).is_ok());
    for tags in [
        vec![vec![], archived.clone()],
        vec![vec!["h".into()], archived.clone()],
        vec![h.clone(), vec!["archived".into()]],
        vec![h.clone(), h.clone()],
        vec![archived.clone(), h.clone()],
    ] {
        let error = match invoke(tags) {
            Ok(_) => panic!("invalid tag must reject"),
            Err(error) => error,
        };
        assert!(
            !error.to_string().contains("not allowed"),
            "ACL blocked command: {error}"
        );
    }
}

#[test]
fn creation_rejects_truncated_tags_through_existing_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    for tag in [vec![], vec!["h"]] {
        let response = get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test",
                    "event": { "kind": 9007, "created_at": 123, "content": "", "tags": [
                        tag, ["name", "Team"], ["visibility", "private"], ["channel_type", "stream"]
                    ] }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        );
        let error = match response {
            Ok(_) => panic!("malformed creation must reject before discovery"),
            Err(error) => error,
        };
        assert!(
            !error.to_string().contains("not allowed"),
            "ACL blocked command: {error}"
        );
    }
}

#[tokio::test]
async fn discovery_body_is_bounded_for_length_and_chunked_transfer() {
    for chunked in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0, "request ended before headers completed");
                bytes.extend_from_slice(&buffer[..count]);
                assert!(
                    bytes.len() <= 16 * 1024,
                    "request headers exceeded fixture limit"
                );
                if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            if chunked {
                socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
                // Valid chunked response, over the budget on the first chunk.
                socket
                    .write_all(format!("{:X}\r\n", MAX_BODY + 1).as_bytes())
                    .unwrap();
                socket.write_all(&vec![b'x'; MAX_BODY + 1]).unwrap();
                let _ = socket.write_all(b"\r\n0\r\n\r\n");
            } else {
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            MAX_BODY + 1
                        )
                        .as_bytes(),
                    )
                    .unwrap();
                // Headers alone must suffice: do not wait for the advertised body.
            }
        });
        let mut response = client().unwrap().get(url).send().await.unwrap();
        assert_eq!(
            read_bounded(&mut response, MAX_BODY, "interrupted", "oversized")
                .await
                .unwrap_err(),
            "oversized"
        );
        task.join().unwrap();
    }
}

#[test]
fn js_signs_emoji_sets_but_never_blossom_tokens() {
    let template = |kind| EventTemplate {
        kind,
        created_at: 1,
        content: "Upload attachment".into(),
        tags: vec![vec!["t".into(), "upload".into()]],
    };
    assert!(validate_event("https://relay.test", &template(30030)).is_ok());
    assert!(validate_event("https://relay.test", &template(24242)).is_err());
}

#[test]
fn media_proxy_only_reaches_relay_blobs() {
    let hash = "a".repeat(64);
    for target in [
        format!("https://relay.test/media/{hash}"),
        format!("https://relay.test/media/{hash}.png"),
        format!("https://relay.test:8443/media/{hash}.thumb.jpg"),
    ] {
        assert!(media_url(&target).is_some(), "{target}");
    }
    for target in [
        format!("http://relay.test/media/{hash}"),
        format!("https://u:p@relay.test/media/{hash}"),
        format!("https://relay.test/media/{hash}?x=1"),
        format!("https://relay.test/media/{hash}#x"),
        format!("https://relay.test/upload/{hash}"),
        format!("https://relay.test/media/{}", "A".repeat(64)),
        format!("https://relay.test/media/{hash}/../../query"),
        format!("https://relay.test/media/{hash}.PNG"),
        "https://relay.test/media/abc".into(),
        "file:///etc/passwd".into(),
    ] {
        assert!(media_url(&target).is_none(), "{target}");
    }
}

#[test]
fn media_ranges_are_single_and_bounded() {
    assert_eq!(media_range("bytes=0-").as_deref(), Some("bytes=0-4194303"));
    assert_eq!(media_range("bytes=10-20").as_deref(), Some("bytes=10-20"));
    assert_eq!(
        media_range("bytes=100-999999999").as_deref(),
        Some("bytes=100-4194403")
    );
    for value in [
        "bytes=-500",
        "bytes=5-1",
        "bytes=0-1,4-5",
        "items=0-1",
        "bytes=x-",
    ] {
        assert!(media_range(value).is_none(), "{value}");
    }
}

#[test]
fn media_types_render_only_images_video_and_audio() {
    assert_eq!(
        media_type(Some("image/PNG; x=1")),
        ("image/png".into(), false)
    );
    assert_eq!(media_type(Some("video/mp4")), ("video/mp4".into(), false));
    assert_eq!(media_type(Some("audio/mpeg")), ("audio/mpeg".into(), false));
    for value in [
        Some("image/svg+xml"),
        Some("text/html"),
        Some("image/"),
        None,
    ] {
        assert_eq!(
            media_type(value),
            ("application/octet-stream".into(), true),
            "{value:?}"
        );
    }
}

fn blossom_event(headers: &str) -> serde_json::Value {
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    verify(&event);
    event
}

fn tag<'a>(event: &'a serde_json::Value, name: &str) -> Vec<&'a str> {
    event["tags"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tag| tag[0] == name)
        .map(|tag| tag[1].as_str().unwrap())
        .collect()
}

/// The relay's strict NIP-FI rules: one each of `t`, `server`, `expiration`,
/// expiry within 60 s of creation, non-empty content.
fn assert_strict(event: &serde_json::Value, verb: &str, server: &str) {
    assert_eq!(event["kind"], 24242);
    assert_ne!(event["content"], "");
    assert_eq!(tag(event, "t"), [verb]);
    assert_eq!(tag(event, "server"), [server]);
    let expiration: u64 = tag(event, "expiration")[0].parse().unwrap();
    assert_eq!(tag(event, "expiration").len(), 1);
    assert_eq!(expiration, event["created_at"].as_u64().unwrap() + 60);
}

#[tokio::test]
async fn media_proxy_signs_a_fresh_get_and_forwards_only_the_range() {
    let (base, task) = fixture_server(
        "HTTP/1.1 206 Partial Content\r\nContent-Type: text/html\r\nContent-Range: bytes 0-3/10\r\nContent-Length: 4\r\nConnection: close\r\n\r\n<b>x",
    );
    let url = base.join(&format!("/media/{}", "a".repeat(64))).unwrap();
    let response = fetch_media(
        &IdentityHost::fixture(),
        url.clone(),
        Some("bytes=0-3".into()),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.body(), b"<b>x");
    let header = |name| response.headers().get(name).unwrap().to_str().unwrap();
    assert_eq!(header("content-type"), "application/octet-stream");
    assert_eq!(header("content-disposition"), "attachment");
    assert_eq!(header("x-content-type-options"), "nosniff");
    assert_eq!(header("content-range"), "bytes 0-3/10");
    let (headers, _) = task.join().unwrap();
    assert!(headers.starts_with(&format!("GET {} ", url.path())));
    assert!(headers.lines().any(|line| line == "range: bytes=0-3"));
    assert!(!headers.contains("cookie"));
    let server = &url[url::Position::BeforeHost..url::Position::AfterPort];
    assert_strict(&blossom_event(&headers), "get", server);
}

#[tokio::test]
async fn media_proxy_passes_relay_denials_through_without_a_body() {
    let (base, task) = fixture_server(
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
    let url = base.join(&format!("/media/{}", "b".repeat(64))).unwrap();
    assert_eq!(
        fetch_media(&IdentityHost::fixture(), url, None)
            .await
            .unwrap_err(),
        401
    );
    task.join().unwrap();
}

#[tokio::test]
async fn upload_signs_the_exact_bytes_it_sends() {
    let (base, task) = fixture_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
    let url = base.join("/upload").unwrap();
    // ASCII: the fixture server compares lengths on decoded text.
    let body = b"PNG fixture bytes".to_vec();
    let hash = format!("{:x}", Sha256::digest(&body));
    let result = upload(
        &IdentityHost::fixture(),
        url.clone(),
        Some("image/png"),
        body.clone(),
    )
    .await
    .unwrap();
    assert_eq!((result.status, result.body.as_str()), (200, "{}"));
    let (headers, sent) = task.join().unwrap();
    assert_eq!(sent.as_bytes(), body);
    assert!(headers.starts_with("PUT /upload "));
    assert!(headers
        .lines()
        .any(|line| line == format!("x-sha-256: {hash}")));
    assert!(headers
        .lines()
        .any(|line| line == "content-type: image/png"));
    let event = blossom_event(&headers);
    let server = &url[url::Position::BeforeHost..url::Position::AfterPort];
    assert_strict(&event, "upload", server);
    assert_eq!(tag(&event, "x"), [hash.as_str()]);
    assert!(upload(&IdentityHost::fixture(), url, None, Vec::new())
        .await
        .is_err());
}