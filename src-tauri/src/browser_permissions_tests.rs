use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewBuilder, WebviewUrl, WindowBuilder,
};

fn invoke(
    webview: &tauri::Webview<MockRuntime>,
    command: &str,
    origin: &str,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    struct BorrowedWebview<'a>(&'a tauri::Webview<MockRuntime>);
    impl AsRef<tauri::Webview<MockRuntime>> for BorrowedWebview<'_> {
        fn as_ref(&self) -> &tauri::Webview<MockRuntime> {
            self.0
        }
    }
    get_ipc_response(
        &BorrowedWebview(webview),
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

#[test]
fn native_command_permissions_allow_only_main_webview() {
    let app = mock_builder()
        // A marker handler proves which requests pass the real generated ACL,
        // without starting terminals, importing plugins or showing notifications.
        .invoke_handler(|request| {
            request.resolver.resolve("authorized");
            true
        })
        .build(super::app_context())
        .unwrap();
    let main_window = WindowBuilder::new(&app, "main").build().unwrap();
    let main = main_window
        .add_child(
            WebviewBuilder::new("main", WebviewUrl::default()),
            tauri::LogicalPosition::new(0, 0),
            tauri::LogicalSize::new(800, 600),
        )
        .unwrap();
    // Production uses a raw Wry guest with no IPC. A simulated Tauri sibling
    // catches accidental window-wide grants in the main window's capability.
    let guest = main_window
        .add_child(
            WebviewBuilder::new("browser-content", WebviewUrl::default()),
            tauri::LogicalPosition::new(500, 80),
            tauri::LogicalSize::new(300, 500),
        )
        .unwrap();

    let application_commands = [
        "identity_restore",
        "identity_import",
        "identity_create",
        "identity_export",
        "relay_sign",
        "relay_http",
        "get_os_idle_seconds",
        "plugin_import_folder",
        "plugin_import_git",
        "plugin_import_install",
        "plugin_import_discard",
        "plugin_catalog",
        "plugin_change",
        "plugin_reload",
        "plugin_module",
        "plugin_recover",
        "plugin_host_run_command",
        "plugin_host_request",
        "agent_control_create_prepare",
        "agent_control_create_commit",
        "agent_control_creation_profile",
        "agent_control_snapshot",
        "agent_control_log_challenge",
        "agent_control_read_log",
        "goose_install",
        "pi_install",
        "agent_control_save",
        "agent_control_save_defaults",
        "agent_control_start_on_app_launch",
        "agent_control_delete",
        "agent_control_action",
        "agent_control_import_preview",
        "agent_control_import_commit",
        "agent_control_clone_settings",
        "agent_control_use_here",
        "agent_models_begin",
        "agent_models_cancel",
        "agent_models_run",
        "title_bar_double_click",
        "notification_show",
        "dock_permission",
        "unread_indicator_set",
        "deep_link_take",
        "deep_link_watch",
        "terminal_create_owner",
        "terminal_spawn",
        "terminal_read",
        "terminal_write",
        "terminal_resize",
        "terminal_close",
        "terminal_close_owner",
        "update_restart",
        "browser_attach",
        "browser_set_bounds",
        "browser_detach",
        "browser_navigate",
        "browser_action",
        "browser_status",
    ];
    let local_origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    for command in application_commands {
        assert!(invoke(&main, command, local_origin).is_ok(), "{command}");
        for origin in [local_origin, "https://example.org", "http://localhost:1430"] {
            assert!(
                invoke(&guest, command, origin).is_err(),
                "guest must reject {command} from {origin}"
            );
        }
        assert!(
            invoke(&main, command, "https://example.org").is_err(),
            "remote content must not use main grants: {command}"
        );
    }
}
