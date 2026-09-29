use super::*;
#[test]
fn catalog_keeps_exact_ids_and_provider_boundaries_and_redacts_errors() {
    let response = json!({"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"custom","id":"namespace/model.v1"}]}});
    assert_eq!(
        parse_response(&response).unwrap(),
        ["custom/namespace/model.v1"]
    );
    for bad in [
        json!({"success":false,"error":"secret"}),
        json!({"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"bad/provider","id":"model"}]}}),
    ] {
        let error = parse_response(&bad).unwrap_err();
        assert!(!error.contains("secret"));
    }
}
#[test]
fn catalog_rejects_selections_that_save_or_launch_cannot_accept() {
    for (provider, id) in [
        ("custom".to_owned(), "a,b".to_owned()),
        ("custom".to_owned(), "-model".to_owned()),
        ("custom,other".to_owned(), "model".to_owned()),
        ("-provider".to_owned(), "model".to_owned()),
        ("p".repeat(129), "model".to_owned()),
        ("custom".to_owned(), "m".repeat(513)),
    ] {
        let response = json!({"type":"response","command":"get_available_models","success":true,
            "data":{"models":[{"provider":provider,"id":id}]}});
        assert!(parse_response(&response).is_err(), "{provider}/{id}");
    }
    let provider = "p".repeat(128);
    let id = format!("namespace/{}", "m".repeat(502));
    let response = json!({"type":"response","command":"get_available_models","success":true,
        "data":{"models":[{"provider":provider,"id":id}]}});
    assert_eq!(
        parse_response(&response).unwrap(),
        [format!("{provider}/{id}")]
    );
}

#[cfg(unix)]
fn fixture(script: &str) -> (tempfile::TempDir, PiContext) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let command = dir.path().join("pi");
    std::fs::write(&command, format!("#!/bin/sh\n{script}")).unwrap();
    std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
    let context = PiContext {
        command,
        workspace: dir.path().into(),
        args: vec![],
        environment: Default::default(),
        path: "/usr/bin:/bin".into(),
    };
    (dir, context)
}
#[cfg(unix)]
#[tokio::test]
async fn reads_rpc_and_reports_exit_failure() {
    let (_dir, context) = fixture("read request\ncase \"$request\" in *get_available_models*) printf '%s\\n' '{\"id\":\"catalog\",\"type\":\"response\",\"command\":\"get_available_models\",\"success\":true,\"data\":{\"models\":[{\"provider\":\"p\",\"id\":\"exact/id\"}]}}';; esac\n");
    assert_eq!(fetch(context).await.unwrap(), ["p/exact/id"]);
    let (_dir, context) = fixture("exit 1\n");
    assert!(fetch(context).await.is_err());
}
#[cfg(unix)]
#[tokio::test]
async fn cancellation_kills_lookup_after_observed_start() {
    let (dir, context) = fixture("sleep 300 &\nhelper=$!\nprintf '%s %s\\n' \"$$\" \"$helper\" > started\nread request\nwait\n");
    let task = tokio::spawn(fetch(context));
    let pid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(dir.path().join("started")) {
                let pids: Vec<i32> = text
                    .split_whitespace()
                    .filter_map(|v| v.parse().ok())
                    .collect();
                if pids.len() == 2 {
                    break pids;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while pid.iter().any(|pid| unsafe { libc::kill(*pid, 0) } == 0) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn test_errors_map_to_fixed_text_without_echoing_keys() {
    // Captured from Pi 0.87 against each provider with a bad key or model.
    for (error, expected) in [
        (
            "No API key found for mistral.\n\nUse /login to log into a provider",
            "No API key found",
        ),
        (
            r#"OpenAI API error (401): {"message":"Incorrect API key provided: sk-bad*****1234","code":"invalid_api_key"}"#,
            "rejected the API key",
        ),
        (
            r#"401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
            "rejected the API key",
        ),
        (
            r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","reason":"API_KEY_INVALID"}}"#,
            "rejected the API key",
        ),
        (
            r#"401: {"message":"Missing Authentication header","code":401}"#,
            "rejected the API key",
        ),
        (
            r#"429 {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}"#,
            "out of credits",
        ),
        (
            "400 Your credit balance is too low to access the Anthropic API",
            "out of credits",
        ),
        ("429 Too Many Requests", "rate limiting"),
        (
            "databricks API error (404): 404 status code (no body)",
            "doesn’t recognize this model",
        ),
        ("socket hang up sk-4011234", "Connection test failed"),
    ] {
        let message = classify(error);
        assert!(message.contains(expected), "{error} -> {message}");
        assert!(!message.contains("sk-"));
    }
}
#[cfg(unix)]
#[tokio::test]
async fn test_prompts_the_selected_model_and_reports_its_reply() {
    let reply = |stop: &str, error: &str| {
        format!("printf '%s\\n' \"$*\" > args\nread request\nprintf '%s\\n' '{{\"type\":\"extension_ui_request\"}}' 'not json' '{{\"type\":\"message_end\",\"message\":{{\"role\":\"user\"}}}}' '{{\"type\":\"message_end\",\"message\":{{\"role\":\"assistant\",\"stopReason\":\"{stop}\",\"errorMessage\":\"{error}\"}}}}'\n")
    };
    let (dir, context) = fixture(&reply("stop", ""));
    test(context, "openai", "ns/gpt").await.unwrap();
    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    assert!(args.contains("--no-session"), "{args}");
    assert!(args.contains("--no-tools"), "{args}");
    assert!(!args.contains("--thinking off"), "{args}");
    assert!(
        args.ends_with("--provider openai --model ns/gpt\n"),
        "{args}"
    );
    let (_dir, context) = fixture(&reply("error", "401 Incorrect API key provided: sk-secret"));
    let error = test(context, "openai", "gpt").await.unwrap_err();
    assert!(error.contains("rejected the API key"), "{error}");
    assert!(!error.contains("secret"));
    let (_dir, context) = fixture("read request\nprintf '%s\\n' '{\"id\":\"test\",\"type\":\"response\",\"command\":\"prompt\",\"success\":false,\"error\":\"No API key found for openai.\"}'\n");
    let error = test(context, "openai", "gpt").await.unwrap_err();
    assert!(error.contains("No API key found"), "{error}");
    let (_dir, context) = fixture("exit 1\n");
    assert!(test(context, "openai", "gpt").await.is_err());
    let (_dir, context) = fixture("exit 1\n");
    assert!(test(context, "openai", "").await.is_err());
}

#[tokio::test]
#[ignore = "requires explicitly selected installed Pi/ACP and local configuration; no inference"]
async fn installed_pi_catalog_uses_production_context() {
    use buzz_agent_controller::{AgentEdit, Controller, HarnessEdit};
    use std::collections::BTreeMap;
    let adapter = std::env::var("BUZZ_TEST_PI_ADAPTER").expect("set BUZZ_TEST_PI_ADAPTER");
    let dir = tempfile::tempdir().unwrap();
    let context = Controller::draft_pi_model_context(AgentEdit {
        name: "Probe".into(),
        picture: None,
        system_prompt: String::new(),
        session_policy: Some(None),
        workspace: dir.path().display().to_string(),
        harness: HarnessEdit {
            command: adapter,
            args: vec!["--".into(), "--thinking".into(), "high".into()],
            model: String::new(),
            provider: String::new(),
            databricks: None,
        },
        environment: BTreeMap::new(),
    })
    .unwrap();
    let models = fetch(context).await.unwrap();
    assert!(!models.is_empty());
    println!(
        "Production Pi catalog: {} models, {} providers",
        models.len(),
        models
            .iter()
            .filter_map(|m| m.split('/').next())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
    );
}

#[tokio::test]
#[ignore = "requires installed Pi/ACP and a signed-in BUZZ_TEST_PI_PROVIDER; sends two tiny prompts"]
async fn installed_pi_connection_test_uses_production_context() {
    use buzz_agent_controller::{AgentEdit, Controller, HarnessEdit};
    let adapter = std::env::var("BUZZ_TEST_PI_ADAPTER").expect("set BUZZ_TEST_PI_ADAPTER");
    let provider = std::env::var("BUZZ_TEST_PI_PROVIDER").expect("set BUZZ_TEST_PI_PROVIDER");
    let model = std::env::var("BUZZ_TEST_PI_MODEL").expect("set BUZZ_TEST_PI_MODEL");
    let dir = tempfile::tempdir().unwrap();
    let context = |environment| {
        Controller::draft_pi_model_context(AgentEdit {
            name: "Probe".into(),
            picture: None,
            system_prompt: String::new(),
            session_policy: Some(None),
            workspace: dir.path().display().to_string(),
            harness: HarnessEdit {
                command: adapter.clone(),
                args: vec![],
                model: String::new(),
                provider: String::new(),
                databricks: None,
            },
            environment,
        })
        .unwrap()
    };
    test(context(Default::default()), &provider, &model)
        .await
        .unwrap();
    let bad_key = [(
        "OPENAI_API_KEY".to_owned(),
        Some("sk-buzz-invalid".to_owned()),
    )]
    .into();
    let error = test(context(bad_key), "openai", "gpt-4o-mini")
        .await
        .unwrap_err();
    assert!(error.contains("rejected the API key"), "{error}");
}
