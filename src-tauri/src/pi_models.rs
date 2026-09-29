//! Ephemeral Pi RPC catalog and connection test. No Buzz identity or saved
//! Pi session; only the test sends a prompt.
use buzz_agent_controller::pi::PiContext;
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const FAILURE: &str = "Pi models unavailable. Check Pi sign-in and extension configuration, then retry or enter a custom ID";

// Extensions may spawn helpers. Cancellation must retire the whole lookup group.
struct LookupChild(tokio::process::Child);
impl Drop for LookupChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.0.start_kill();
    }
}

type Output = BufReader<tokio::io::Take<tokio::process::ChildStdout>>;
fn spawn(
    context: PiContext,
    args: Vec<String>,
) -> Result<(LookupChild, tokio::process::ChildStdin, Output), String> {
    let mut command = tokio::process::Command::new(&context.command);
    command
        .args(["--mode", "rpc", "--no-session", "--no-themes"])
        .args(args)
        .current_dir(&context.workspace)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for key in [
        "HOME",
        "TMPDIR",
        "USER",
        "LOGNAME",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.envs(context.environment).env("PATH", context.path);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = LookupChild(command.spawn().map_err(|_| "Could not start Pi")?);
    let stdin = child.0.stdin.take().ok_or(FAILURE)?;
    let stdout = child.0.stdout.take().ok_or(FAILURE)?;
    Ok((
        child,
        stdin,
        BufReader::new(stdout.take(8 * 1024 * 1024 + 1)),
    ))
}

pub(super) async fn fetch(context: PiContext) -> Result<Vec<String>, String> {
    let args = context.catalog_args()?;
    let (child, mut stdin, mut reader) = spawn(context, args)?;
    stdin
        .write_all(b"{\"id\":\"catalog\",\"type\":\"get_available_models\"}\n")
        .await
        .map_err(|_| FAILURE)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        for _ in 0..100 {
            let mut line = String::new();
            if reader.read_line(&mut line).await.map_err(|_| FAILURE)? == 0 {
                break;
            }
            let value: Value = serde_json::from_str(&line).map_err(|_| FAILURE)?;
            if value.get("id") == Some(&json!("catalog")) {
                return parse_response(&value);
            }
        }
        Err(FAILURE.into())
    })
    .await
    .map_err(|_| "Pi model lookup timed out; retry explicitly")?;
    drop(stdin);
    // Drop kills helpers too, even after a successful response.
    drop(child);
    result
}

const TEST_FAILURE: &str =
    "Connection test failed. Check the provider, model and network, then test again.";

/// Sends one tiny prompt through the agent's Pi setup. The first assistant
/// reply decides the result, so Pi never gets to retry a failing request.
pub(super) async fn test(context: PiContext, provider: &str, model: &str) -> Result<(), String> {
    if provider.is_empty() || model.is_empty() {
        return Err("Choose a provider and model to test".into());
    }
    buzz_agent_controller::pi::validate_selection(provider, model)?;
    let mut args = context.catalog_args()?;
    args.extend(
        [
            "--no-tools",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--system-prompt",
            "Reply with OK.",
            "--provider",
            provider,
            "--model",
            model,
        ]
        .map(String::from),
    );
    let (child, mut stdin, mut reader) = spawn(context, args)?;
    stdin
        .write_all(b"{\"id\":\"test\",\"type\":\"prompt\",\"message\":\"Reply with OK.\"}\n")
        .await
        .map_err(|_| TEST_FAILURE)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        for _ in 0..10_000 {
            let mut line = String::new();
            if reader
                .read_line(&mut line)
                .await
                .map_err(|_| TEST_FAILURE)?
                == 0
            {
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value["id"] == "test" && value["success"] == false {
                return Err(classify(value["error"].as_str().unwrap_or_default()));
            }
            let message = &value["message"];
            if value["type"] == "message_end" && message["role"] == "assistant" {
                return match message["stopReason"].as_str() {
                    Some("error" | "aborted") => Err(classify(
                        message["errorMessage"].as_str().unwrap_or_default(),
                    )),
                    _ => Ok(()),
                };
            }
        }
        Err(TEST_FAILURE.into())
    })
    .await
    .map_err(|_| "Connection test timed out. Check the network, then test again.")?;
    drop(stdin);
    drop(child);
    result
}

/// Provider errors can echo part of the key, so only fixed text leaves here.
fn classify(error: &str) -> String {
    let error = error.to_lowercase();
    let words: Vec<&str> = error.split(|c: char| !c.is_ascii_alphanumeric()).collect();
    let any = |codes: &[&str], phrases: &[&str]| {
        codes.iter().any(|code| words.contains(code))
            || phrases.iter().any(|phrase| error.contains(phrase))
    };
    if any(&[], &["no api key"]) {
        "No API key found for this provider. Add its API key, or sign in with Pi."
    } else if any(&["402"], &["quota", "credit", "billing"]) {
        "The provider account is out of credits or quota. Check its billing, then test again."
    } else if any(
        &["401", "403"],
        &[
            "invalid_api_key",
            "api key not valid",
            "api_key_invalid",
            "invalid x-api-key",
            "incorrect api key",
            "authentication",
            "unauthorized",
        ],
    ) {
        "The provider rejected the API key. Check the key, then test again."
    } else if any(&["429"], &["rate limit", "rate_limit", "too many requests"]) {
        "The provider is rate limiting requests. Wait a moment, then test again."
    } else if any(
        &["404"],
        &["model not found", "model_not_found", "does not exist"],
    ) {
        "The provider doesn’t recognize this model. Choose another model."
    } else {
        TEST_FAILURE
    }
    .into()
}
fn parse_response(value: &Value) -> Result<Vec<String>, String> {
    if value["type"] != "response"
        || value["command"] != "get_available_models"
        || value["success"] != true
    {
        return Err(FAILURE.into());
    }
    let models = value["data"]["models"].as_array().ok_or(FAILURE)?;
    if models.len() > 10_000 {
        return Err("Pi model catalog is too large".into());
    }
    let mut result = Vec::new();
    for model in models {
        let provider = model["provider"].as_str().ok_or(FAILURE)?;
        let id = model["id"].as_str().ok_or(FAILURE)?;
        if provider.is_empty() || id.is_empty() {
            return Err("Pi returned an invalid model ID".into());
        }
        buzz_agent_controller::pi::validate_selection(provider, id)
            .map_err(|_| "Pi returned an invalid model ID")?;
        result.push(format!("{provider}/{id}"));
    }
    result.sort();
    result.dedup();
    Ok(result)
}

#[cfg(test)]
mod tests;
