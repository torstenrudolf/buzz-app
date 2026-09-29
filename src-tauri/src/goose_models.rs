//! One-shot Goose ACP catalog lookup. The child never receives a Buzz identity.
use buzz_agent_controller::GooseModelContext;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEST_BYTES: u64 = 1024 * 1024;
const METHOD: &str = "_goose/unstable/providers/supported-models/list";
const TEST_FAILURE: &str = "Goose could not complete a request with this provider and model. Check its credentials, model and network, then test again.";

struct CheckChild(tokio::process::Child);
impl Drop for CheckChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.id() {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = self.0.start_kill();
    }
}

/// Run one Goose turn through its normal session path without saving a session
/// or loading extensions. Databricks rejects `info --check`'s empty system prompt.
/// The selected draft and write-only overrides are resolved by the controller.
pub(super) async fn test(context: GooseModelContext) -> Result<(), String> {
    if context.model_id.trim().is_empty()
        || context.model_id.len() > 512
        || context.model_id.chars().any(char::is_control)
    {
        return Err("Choose a valid Goose model to test".into());
    }
    if !context.workspace.is_absolute() || !context.workspace.is_dir() {
        return Err("Choose an existing absolute workspace before testing Goose".into());
    }
    let mut command = tokio::process::Command::new(context.command);
    command
        .args([
            "run",
            "--text",
            "Reply OK.",
            "--no-session",
            "--no-profile",
            "--max-turns",
            "1",
            "--quiet",
            "--output-format",
            "json",
        ])
        .current_dir(context.workspace)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for name in [
        "HOME",
        "TMPDIR",
        "USER",
        "LOGNAME",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .envs(context.environment)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    command
        .env("GOOSE_PROVIDER", context.provider_id)
        .env("GOOSE_MODEL", context.model_id)
        .env("GOOSE_MAX_TOKENS", "10")
        .env("GOOSE_THINKING_EFFORT", "off");
    #[cfg(unix)]
    command.process_group(0);
    let mut child = CheckChild(
        command
            .spawn()
            .map_err(|_| "Could not start Goose to test the model".to_owned())?,
    );
    let stdout = child.0.stdout.take().ok_or(TEST_FAILURE)?;
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut output = Vec::new();
        stdout
            .take(MAX_TEST_BYTES + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| TEST_FAILURE)?;
        if output.len() as u64 > MAX_TEST_BYTES {
            return Err(TEST_FAILURE.into());
        }
        let status = child.0.wait().await.map_err(|_| TEST_FAILURE)?;
        let response: Value = serde_json::from_slice(&output).map_err(|_| TEST_FAILURE)?;
        if status.success() && successful_reply(&response) {
            Ok(())
        } else {
            Err(TEST_FAILURE.into())
        }
    })
    .await
    .map_err(|_| {
        "Goose connection test timed out. Check the network, then test again.".to_owned()
    })?
}

fn successful_reply(response: &Value) -> bool {
    if response["metadata"]["status"] != "completed" {
        return false;
    }
    let Some(messages) = response["messages"].as_array() else {
        return false;
    };
    let mut replied = false;
    for content in messages
        .iter()
        .filter(|message| message["role"] == "assistant")
        .filter_map(|message| message["content"].as_array())
        .flatten()
    {
        if content["type"] == "error" {
            return false;
        }
        if content["type"] == "text"
            && content["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
        {
            replied = true;
        }
    }
    replied
}

pub(super) async fn fetch(context: GooseModelContext) -> Result<Vec<String>, String> {
    let provider_id = context.provider_id.clone();
    let mut command = tokio::process::Command::new(context.command);
    command
        .arg("acp")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for name in [
        "HOME",
        "TMPDIR",
        "USER",
        "LOGNAME",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .envs(context.environment)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start Goose to list models".to_owned())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Goose catalog input unavailable")?;
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": METHOD,
        "params": { "providerId": provider_id }
    });
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .map_err(|_| "Could not request Goose models".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Goose catalog output unavailable")?;
    let mut reader = BufReader::new(stdout.take(MAX_RESPONSE_BYTES + 1));
    let response = tokio::time::timeout(Duration::from_secs(60), async {
        for _ in 0..100 {
            let mut line = String::new();
            if reader
                .read_line(&mut line)
                .await
                .map_err(|_| "Could not read Goose models")?
                == 0
            {
                break;
            }
            let value: Value = serde_json::from_str(&line)
                .map_err(|_| "Goose returned an invalid model response")?;
            if value.get("id") == Some(&json!(1)) {
                return parse_response(&value, &provider_id);
            }
        }
        Err("Goose did not return a model list".to_owned())
    })
    .await
    .map_err(|_| "Goose model lookup timed out; retry explicitly".to_owned())?;
    drop(stdin);
    let _ = child.kill().await;
    let _ = child.wait().await;
    response
}

fn parse_response(value: &Value, provider_id: &str) -> Result<Vec<String>, String> {
    if let Some(error) = value.get("error") {
        if error.get("code").and_then(Value::as_i64) == Some(-32000) {
            return Err("Goose needs authentication for this provider. Enter its API key in Buzz if it uses one, then retry".into());
        }
        return Err("Goose could not list models for this provider. Check its credentials or try again when its API is available".into());
    }
    if value
        .get("result")
        .and_then(|result| result.get("providerId"))
        .and_then(Value::as_str)
        != Some(provider_id)
    {
        return Err("Goose returned models for a different provider".into());
    }
    let models = value
        .get("result")
        .and_then(|result| result.get("models"))
        .and_then(Value::as_array)
        .ok_or("Goose returned an invalid model list")?;
    if models.len() > 10_000 {
        return Err("Goose model list is too large to display".into());
    }
    models
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|name| {
                    !name.is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
                })
                .map(str::to_owned)
                .ok_or_else(|| "Goose returned an invalid model name".to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bounded_model_names() {
        assert_eq!(
            parse_response(
                &json!({"result":{"providerId":"anthropic","models":["claude-opus-4-8"]}}),
                "anthropic"
            )
            .unwrap(),
            vec!["claude-opus-4-8"]
        );
        assert!(parse_response(
            &json!({"result":{"providerId":"anthropic","models":["bad\nname"]}}),
            "anthropic"
        )
        .is_err());
        assert!(
            parse_response(&json!({"error":{"message":"secret"}}), "anthropic")
                .unwrap_err()
                .contains("Check its credentials")
        );
        let auth_error = parse_response(
            &json!({"error":{"code":-32000,"data":"secret"}}),
            "anthropic",
        )
        .unwrap_err();
        assert!(auth_error.contains("needs authentication"));
        assert!(!auth_error.contains("secret"));
        assert!(parse_response(
            &json!({"result":{"providerId":"openai","models":[]}}),
            "anthropic"
        )
        .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn one_shot_acp_request_reads_catalog_before_closing_stdin() {
        use std::{
            future::Future,
            io::{BufRead, Read, Write},
            os::{fd::FromRawFd, unix::fs::PermissionsExt},
        };
        const SOCKET: &str = "BUZZ_GOOSE_TEST_SOCKET";
        if let Ok(socket) = std::env::var(SOCKET) {
            // Re-enter this test as the fake Goose process. The wrapper reserves
            // fd 3 for protocol output and sends libtest's output to /dev/null.
            let mut request = String::new();
            std::io::stdin().lock().read_line(&mut request).unwrap();
            let request: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(
                request["method"],
                "_goose/unstable/providers/supported-models/list"
            );
            assert_eq!(request["params"]["providerId"], "openai");
            assert_eq!(request["id"], 1);
            assert_eq!(std::env::var("OPENAI_API_KEY").unwrap(), "test-key");
            let mut gate = std::os::unix::net::UnixStream::connect(socket).unwrap();
            gate.set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            gate.write_all(&[1]).unwrap();
            gate.read_exact(&mut [0]).unwrap();
            let mut input = libc::pollfd {
                fd: libc::STDIN_FILENO,
                events: libc::POLLIN | libc::POLLHUP,
                revents: 0,
            };
            // No data remains after the request. Readability now means premature EOF.
            assert_eq!(
                unsafe { libc::poll(&mut input, 1, 0) },
                0,
                "stdin closed before catalog response"
            );
            let mut output = unsafe { std::fs::File::from_raw_fd(3) };
            writeln!(output, "{}", json!({"jsonrpc":"2.0","id":1,"result":{"providerId":"openai","models":["gpt-6-sol"]}})).unwrap();
            return;
        }
        // Keep the socket pathname within macOS's sockaddr_un limit.
        let dir = tempfile::Builder::new()
            .prefix("goose-test")
            .tempdir_in("/tmp")
            .unwrap();
        let socket = dir.path().join("gate");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let command = dir.path().join("goose");
        std::fs::write(&command, r#"#!/bin/sh
[ "$1" = acp ] || exit 1
exec "$BUZZ_GOOSE_TEST_EXE" --exact goose_models::tests::one_shot_acp_request_reads_catalog_before_closing_stdin --nocapture 3>&1 >/dev/null
"#).unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
        let context = GooseModelContext {
            command,
            workspace: dir.path().into(),
            provider_id: "openai".into(),
            model_id: "gpt-6-sol".into(),
            environment: [
                ("OPENAI_API_KEY".into(), "test-key".into()),
                (SOCKET.into(), socket.to_str().unwrap().into()),
                (
                    "BUZZ_GOOSE_TEST_EXE".into(),
                    std::env::current_exe().unwrap().to_str().unwrap().into(),
                ),
            ]
            .into_iter()
            .collect(),
            model_overridden: false,
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut lookup = std::pin::pin!(fetch(context));
            let mut gate = tokio::select! {
                accepted = listener.accept() => accepted.unwrap().0,
                result = &mut lookup => panic!("lookup completed before request gate: {result:?}"),
            };
            let mut ready = [0];
            tokio::select! {
                ready = gate.read_exact(&mut ready) => { ready.unwrap(); },
                result = &mut lookup => panic!("lookup completed before request read: {result:?}"),
            }
            // Advance past write_all before the child inspects stdin. The child
            // cannot answer yet, so an early close is observable without sleeps.
            std::future::poll_fn(|cx| {
                assert!(lookup.as_mut().poll(cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            gate.write_all(&[1]).await.unwrap();
            assert_eq!(lookup.await.unwrap(), vec!["gpt-6-sol"]);
        })
        .await
        .expect("catalog fixture did not finish");
    }
}
