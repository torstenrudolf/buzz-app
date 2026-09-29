mod browser;
#[cfg(test)]
mod browser_permissions_tests;
use browser::{
    browser_action, browser_attach, browser_detach, browser_navigate, browser_set_bounds,
    browser_status,
};
mod agent_models;
mod agents;
mod deep_links;
mod dock;
mod host_command;
mod host_request;
mod identity;
mod notifications;
mod os_idle;
use os_idle::get_os_idle_seconds;
mod relay;
use identity::{identity_create, identity_export, identity_import, identity_restore, IdentityHost};
use relay::{relay_http, relay_sign};
mod terminal;
use agent_models::{agent_models_begin, agent_models_cancel, agent_models_run, ModelHost};
mod goose_models;
mod harness_setup;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod managed_pi;
mod pi_models;
use agents::{
    agent_control_action, agent_control_attach_mention, agent_control_clone_settings,
    agent_control_create_commit, agent_control_create_prepare, agent_control_creation_profile,
    agent_control_delete, agent_control_import_commit, agent_control_import_preview,
    agent_control_log_challenge, agent_control_read_log, agent_control_save,
    agent_control_save_defaults, agent_control_snapshot, agent_control_start_on_app_launch,
    agent_control_use_here, AgentHost,
};
use buzzodz_plugins::{
    imports::{prepare_folder, prepare_git, PreparedImport, Preview},
    Catalog, InstallationResult, Manager,
};
use deep_links::{deep_link_take, deep_link_watch, DeepLinks};
use dock::{dock_permission, unread_indicator_set};
use harness_setup::{goose_install, pi_install, HarnessSetup};
use host_command::plugin_host_run_command;
use host_request::plugin_host_request;
use notifications::{notification_show, Notifications};
#[cfg(target_os = "macos")]
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager as _;
use tauri_plugin_dialog::DialogExt;
use terminal::{
    terminal_close, terminal_close_owner, terminal_create_owner, terminal_read, terminal_resize,
    terminal_spawn, terminal_write, Terminals,
};

#[derive(Clone, Default)]
struct Imports(Arc<Mutex<Option<PreparedImport>>>);

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum TitleBarDoubleClickAction {
    Fill,
    Zoom,
    Minimize,
    None,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct TitleBarFrame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(any(target_os = "macos", test))]
impl TitleBarFrame {
    fn approximately_equals(self, other: Self) -> bool {
        const TOLERANCE: f64 = 0.5;
        (self.x - other.x).abs() <= TOLERANCE
            && (self.y - other.y).abs() <= TOLERANCE
            && (self.width - other.width).abs() <= TOLERANCE
            && (self.height - other.height).abs() <= TOLERANCE
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct TitleBarFillFrame {
    restore: TitleBarFrame,
    filled: TitleBarFrame,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct TitleBarFillFrames(Mutex<HashMap<String, TitleBarFillFrame>>);

#[cfg(any(target_os = "macos", test))]
fn title_bar_fill_target(
    current: TitleBarFrame,
    visible: TitleBarFrame,
    saved: Option<TitleBarFillFrame>,
) -> (TitleBarFrame, Option<TitleBarFillFrame>) {
    if let Some(saved) = saved.filter(|saved| current.approximately_equals(saved.filled)) {
        (saved.restore, None)
    } else {
        (
            visible,
            Some(TitleBarFillFrame {
                restore: current,
                filled: visible,
            }),
        )
    }
}

#[cfg(any(target_os = "macos", test))]
fn title_bar_double_click_action(preference: Option<&str>) -> TitleBarDoubleClickAction {
    match preference {
        Some("Maximize" | "Fill") => TitleBarDoubleClickAction::Fill,
        Some("Zoom") => TitleBarDoubleClickAction::Zoom,
        Some("Minimize") => TitleBarDoubleClickAction::Minimize,
        _ => TitleBarDoubleClickAction::None,
    }
}

#[cfg(target_os = "macos")]
fn title_bar_frame(rect: objc2_foundation::NSRect) -> TitleBarFrame {
    TitleBarFrame {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

#[cfg(target_os = "macos")]
fn ns_rect(frame: TitleBarFrame) -> objc2_foundation::NSRect {
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    NSRect::new(
        NSPoint::new(frame.x, frame.y),
        NSSize::new(frame.width, frame.height),
    )
}

#[cfg(target_os = "macos")]
fn toggle_title_bar_fill<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    frames: &TitleBarFillFrames,
) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window.cast() };
    let current = title_bar_frame(ns_window.frame());
    let visible = title_bar_frame(
        ns_window
            .screen()
            .ok_or("Could not resolve the window's current screen")?
            .visibleFrame(),
    );
    let mut frames = frames
        .0
        .lock()
        .map_err(|_| "Title-bar Fill state is unavailable")?;
    let (target, saved) = title_bar_fill_target(current, visible, frames.remove(window.label()));
    if let Some(saved) = saved {
        frames.insert(window.label().to_owned(), saved);
    }
    drop(frames);
    ns_window.setFrame_display_animate(ns_rect(target), true, true);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn title_bar_double_click<R: tauri::Runtime>(
    window: tauri::Window<R>,
    fill_frames: tauri::State<'_, TitleBarFillFrames>,
) -> Result<(), String> {
    use objc2_foundation::{ns_string, NSUserDefaults};

    let preference = NSUserDefaults::standardUserDefaults()
        .stringForKey(ns_string!("AppleActionOnDoubleClick"))
        .map(|value| value.to_string());
    match title_bar_double_click_action(preference.as_deref()) {
        TitleBarDoubleClickAction::Fill => toggle_title_bar_fill(&window, &fill_frames)?,
        TitleBarDoubleClickAction::Zoom => {
            let ns_window = window.ns_window().map_err(|error| error.to_string())?;
            let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window.cast() };
            ns_window.performZoom(None);
        }
        TitleBarDoubleClickAction::Minimize => {
            window.minimize().map_err(|error| error.to_string())?;
        }
        TitleBarDoubleClickAction::None => {}
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn title_bar_double_click<R: tauri::Runtime>(_window: tauri::Window<R>) {}

async fn prepare_import(
    imports: Imports,
    operation: impl FnOnce() -> Result<Option<PreparedImport>, String> + Send + 'static,
) -> Result<Option<Preview>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = imports
            .0
            .try_lock()
            .map_err(|_| "Another import is in progress")?;
        *pending = None;
        *pending = operation()?;
        Ok(pending.as_ref().map(|p| p.preview.clone()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn plugin_import_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    imports: tauri::State<'_, Imports>,
) -> Result<Option<Preview>, String> {
    prepare_import(imports.inner().clone(), move || {
        app.dialog()
            .file()
            .set_title("Choose a plugin folder")
            .blocking_pick_folder()
            .map(|folder| prepare_folder(&folder.into_path().map_err(|e| e.to_string())?))
            .transpose()
    })
    .await
}
#[tauri::command]
async fn plugin_import_git(
    imports: tauri::State<'_, Imports>,
    repository: String,
    reference: String,
) -> Result<Option<Preview>, String> {
    prepare_import(imports.inner().clone(), move || {
        prepare_git(&repository, &reference).map(Some)
    })
    .await
}
#[tauri::command]
async fn plugin_import_discard(
    imports: tauri::State<'_, Imports>,
    token: String,
) -> Result<(), String> {
    let mut pending = imports
        .0
        .try_lock()
        .map_err(|_| "Another import is in progress")?;
    if pending.as_ref().is_some_and(|p| p.preview.token == token) {
        *pending = None;
    }
    Ok(())
}
#[tauri::command]
async fn plugin_import_install(
    manager: tauri::State<'_, PluginManager>,
    imports: tauri::State<'_, Imports>,
    token: String,
    path: String,
) -> Result<InstallationResult, String> {
    let imports = imports.inner().clone();
    with_manager(manager, move |m| {
        let pending = imports
            .0
            .try_lock()
            .map_err(|_| "Another import is in progress")?;
        pending
            .as_ref()
            .ok_or("This import preview expired. Choose the source again.")?
            .install(&m, &token, &path)
            .map(|catalog| ready(&m, catalog))
    })
    .await
}

fn ready(manager: &Manager, catalog: Catalog) -> InstallationResult {
    InstallationResult::Ready {
        catalog,
        external_plugins_paused: manager.external_plugins_paused(),
    }
}

// Invalid environment configuration must not prevent the recovery shell from opening.
struct PluginManager(Result<Manager, String>);
async fn with_manager<T: Send + 'static>(
    state: tauri::State<'_, PluginManager>,
    operation: impl FnOnce(Manager) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let manager = state.0.clone()?;
    tauri::async_runtime::spawn_blocking(move || operation(manager))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn plugin_catalog(
    manager: tauri::State<'_, PluginManager>,
) -> Result<InstallationResult, String> {
    with_manager(manager, |m| {
        Ok(match m.catalog() {
            Ok(catalog) => ready(&m, catalog),
            Err(reason) => InstallationResult::Recovery {
                reason,
                can_reset: true,
            },
        })
    })
    .await
}
#[tauri::command]
async fn plugin_change(
    manager: tauri::State<'_, PluginManager>,
    action: String,
    id: String,
) -> Result<InstallationResult, String> {
    with_manager(manager, move |m| {
        m.change(&action, &id).map(|catalog| ready(&m, catalog))
    })
    .await
}
#[tauri::command]
async fn plugin_reload(
    manager: tauri::State<'_, PluginManager>,
    id: String,
) -> Result<InstallationResult, String> {
    with_manager(manager, move |m| {
        m.reload(&id).map(|catalog| ready(&m, catalog))
    })
    .await
}
#[tauri::command]
async fn plugin_module(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
) -> Result<String, String> {
    with_manager(manager, move |m| m.module(&id, &revision)).await
}
#[tauri::command]
async fn plugin_recover(
    manager: tauri::State<'_, PluginManager>,
) -> Result<InstallationResult, String> {
    with_manager(manager, |m| m.recover().map(|catalog| ready(&m, catalog))).await
}
/// Tauri's restart ignores `prevent_exit`, so confirm the same agent teardown
/// that gates Quit before requesting it; a failure keeps the app running.
#[tauri::command]
async fn update_restart<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle.state::<ModelHost>().shutdown();
        handle.state::<AgentHost>().shutdown()
    })
    .await
    .map_err(|_| "Agent shutdown could not be confirmed".to_owned())?
    .map_err(|error| {
        format!("Agent shutdown incomplete; restart Buzz to finish the update: {error}")
    })?;
    app.request_restart();
    Ok(())
}
fn commands<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        identity_restore,
        identity_import,
        identity_create,
        identity_export,
        relay_sign,
        relay_http,
        get_os_idle_seconds,
        plugin_import_folder,
        plugin_import_git,
        plugin_import_install,
        plugin_import_discard,
        plugin_catalog,
        plugin_change,
        plugin_reload,
        plugin_module,
        plugin_recover,
        plugin_host_run_command,
        plugin_host_request,
        agent_control_create_prepare,
        agent_control_create_commit,
        agent_control_creation_profile,
        agent_control_snapshot,
        agent_control_log_challenge,
        agent_control_read_log,
        goose_install,
        pi_install,
        agent_control_use_here,
        agent_control_save,
        agent_control_save_defaults,
        agent_control_delete,
        agent_control_action,
        agent_control_attach_mention,
        agent_control_start_on_app_launch,
        agent_control_clone_settings,
        agent_control_import_preview,
        agent_control_import_commit,
        agent_models_begin,
        agent_models_cancel,
        agent_models_run,
        title_bar_double_click,
        notification_show,
        deep_link_take,
        deep_link_watch,
        dock_permission,
        unread_indicator_set,
        terminal_create_owner,
        terminal_spawn,
        terminal_read,
        terminal_write,
        terminal_resize,
        terminal_close,
        terminal_close_owner,
        update_restart
    ]
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    let builder = if !tauri::is_dev() {
        // Single instance comes first, as its documentation requires. Its deep-link
        // feature forwards deep-link argv on Windows/Linux. macOS OS URLs reach
        // the registered bundle directly; cross-copy URL handoff is unsupported.
        // This callback only foregrounds the running window. Development launches
        // skip this so parallel worktrees can run side by side.
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            deep_links::focus_main(app);
        }))
    } else {
        builder
    };
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            deep_links::setup(app.handle());
            // Only app-owned storage is created. Preview uses the OS-resolved legacy
            // parent, never a browser-supplied path or a different environment source.
            let paths = (|| {
                let root = app
                    .path()
                    .app_data_dir()
                    .map_err(|_| "Could not resolve local agent storage")?
                    .join("agent-controller");
                let legacy = app
                    .path()
                    .data_dir()
                    .map_err(|_| "Could not resolve legacy library directory")?;
                let workspace = app
                    .path()
                    .home_dir()
                    .map_err(|_| "Could not resolve agent workspace")?
                    .join(".buzz");
                Ok((root, legacy, workspace))
            })();
            app.manage(ModelHost::new(
                paths
                    .as_ref()
                    .map(|(root, _, _)| root.clone())
                    .map_err(Clone::clone),
            ));
            let resources = app
                .path()
                .resource_dir()
                .map(|root| root.join("agent-runtime"))
                .map_err(|_| "Could not resolve app runtime resources".to_owned());
            app.manage(AgentHost::initialize(paths, resources));
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder.manage(TitleBarFillFrames::default());
    // Register the updater only in configured release builds; omit it locally.
    #[cfg(buzz_updater_enabled)]
    let builder = if tauri::is_dev() {
        builder
    } else {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    };
    builder
        .manage(IdentityHost::default())
        .manage(Imports::default())
        .manage(HarnessSetup::default())
        .manage(Terminals::default())
        .manage(Notifications::default())
        .manage(DeepLinks::default())
        .manage(PluginManager(Manager::from_env()))
        .invoke_handler({
            let application_commands = commands::<tauri::Wry>();
            let browser_commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                browser_attach,
                browser_set_bounds,
                browser_detach,
                browser_navigate,
                browser_action,
                browser_status
            ];
            // Browser embeds a real native view; existing commands also support MockRuntime.
            move |request: tauri::ipc::Invoke<tauri::Wry>| {
                if request.message.command().starts_with("browser_") {
                    browser_commands(request)
                } else {
                    application_commands(request)
                }
            }
        })
        .on_page_load(browser::page_load)
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Keep the webview and running agents alive until explicit Quit.
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Could not close Buzz window: {error}");
                    }
                    return;
                }
            }
            browser::window_event(window, event);
        })
        .build(app_context())
        .expect("failed to build Buzz Foundation")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                deep_links::focus_main(app);
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                app.state::<ModelHost>().shutdown();
                if app.state::<AgentHost>().shutdown().is_err() {
                    api.prevent_exit();
                    eprintln!("Agent shutdown incomplete; app exit was refused");
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<HarnessSetup>().shutdown();
                browser::shutdown();
                if let Err(error) = app.state::<Terminals>().shutdown() {
                    eprintln!("Terminal shutdown failed: {error}");
                }
                app.state::<ModelHost>().shutdown();
                if app.state::<AgentHost>().shutdown().is_err() {
                    eprintln!("Native agent shutdown could not be confirmed");
                }
            }
        });
}

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

#[cfg(test)]
mod tests {
    use super::{
        title_bar_double_click_action, title_bar_fill_target, TitleBarDoubleClickAction,
        TitleBarFillFrame, TitleBarFrame,
    };

    fn frame(x: f64, y: f64, width: f64, height: f64) -> TitleBarFrame {
        TitleBarFrame {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn title_bar_double_click_preferences_map_to_native_actions() {
        assert_eq!(
            title_bar_double_click_action(Some("Maximize")),
            TitleBarDoubleClickAction::Fill
        );
        assert_eq!(
            title_bar_double_click_action(Some("Fill")),
            TitleBarDoubleClickAction::Fill
        );
        assert_eq!(
            title_bar_double_click_action(Some("Zoom")),
            TitleBarDoubleClickAction::Zoom
        );
        assert_eq!(
            title_bar_double_click_action(Some("Minimize")),
            TitleBarDoubleClickAction::Minimize
        );
        assert_eq!(
            title_bar_double_click_action(Some("None")),
            TitleBarDoubleClickAction::None
        );
        assert_eq!(
            title_bar_double_click_action(None),
            TitleBarDoubleClickAction::None
        );
    }

    #[test]
    fn title_bar_fill_restores_only_an_unchanged_filled_window() {
        let original = frame(100.0, 100.0, 900.0, 700.0);
        let visible = frame(0.0, 25.0, 1512.0, 920.0);
        let saved = TitleBarFillFrame {
            restore: original,
            filled: visible,
        };

        assert_eq!(
            title_bar_fill_target(visible, visible, Some(saved)),
            (original, None)
        );

        let moved = frame(20.0, 25.0, 1492.0, 920.0);
        assert_eq!(
            title_bar_fill_target(moved, visible, Some(saved)),
            (
                visible,
                Some(TitleBarFillFrame {
                    restore: moved,
                    filled: visible,
                })
            )
        );
    }
}
