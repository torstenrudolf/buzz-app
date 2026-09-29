use buzzodz_plugins::{bundled_manifests, Manager};
use std::{fs, path::PathBuf};
fn fixture() -> (tempfile::TempDir, Manager, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    let source = temp.path().join("build");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    (temp, manager, source)
}
#[test]
fn install_enable_update_rollback_and_remove_survive_restart() {
    let (temp, manager, source) = fixture();
    let catalog = manager.install(&source).unwrap();
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    let first = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    assert!(manager.module("example.page", &first).is_err());
    manager.change("enable", "example.page").unwrap();
    fs::write(source.join("plugin.js"), "export const second = true;").unwrap();
    let next = manager.install(&source).unwrap();
    assert!(
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    assert_eq!(
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .previous
            .as_deref(),
        Some(first.as_str())
    );
    assert!(manager.module("example.page", &first).is_err());
    let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    assert_eq!(
        reopened
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision,
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision
    );
    reopened.change("rollback", "example.page").unwrap();
    assert!(reopened
        .module("example.page", &first)
        .unwrap()
        .contains("apply"));
    reopened.change("remove", "example.page").unwrap();
    assert_eq!(
        reopened.catalog().unwrap().plugins.len(),
        bundled_manifests().len()
    );
}
#[test]
fn folder_reload_updates_current_revision_and_preserves_disabled_state() {
    let (_temp, manager, source) = fixture();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    fs::write(source.join("plugin.js"), "export const reloaded = true;").unwrap();
    let catalog = manager.reload("example.page").unwrap();
    let plugin = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert!(!plugin.enabled);
    assert!(plugin.reloadable);
    assert_ne!(plugin.revision, first);
    assert_eq!(plugin.previous.as_deref(), Some(first.as_str()));
    manager.change("enable", "example.page").unwrap();
    assert!(manager
        .module("example.page", &plugin.revision)
        .unwrap()
        .contains("reloaded"));
}
#[test]
fn reload_rejects_invalid_sources_without_changing_revision() {
    let (temp, manager, source) = fixture();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    assert!(manager.reload("buzz.channels").is_err());
    assert!(manager.reload("missing.page").is_err());
    manager.change("enable", "example.page").unwrap();
    assert!(manager.reload("example.page").is_err());
    manager.change("disable", "example.page").unwrap();
    fs::remove_file(source.join("plugin.js")).unwrap();
    assert!(manager.reload("example.page").is_err());
    fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    fs::write(
        source.join("manifest.json"),
        r#"{"id":"example.other","name":"Other","apiVersion":1}"#,
    )
    .unwrap();
    assert!(manager.reload("example.page").is_err());
    assert_eq!(
        manager
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision,
        first
    );
    assert!(std::fs::write(
        temp.path().join("profiles/test/registry.json"),
        r#"{"version":1,"bundledEnabled":true,"bundledOverrides":{},"installed":{"example.page":{"manifest":{"id":"example.page","name":"Example","apiVersion":1},"current":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","currentSource":{"root":"/tmp","path":"../escape"},"previous":null,"enabled":false}}}"#
    )
    .is_ok());
    assert!(manager.reload("example.page").is_err());
}
#[cfg(unix)]
#[test]
fn reload_rejects_replaced_source_folder_symlink() {
    let (temp, manager, source) = fixture();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    fs::remove_dir_all(&source).unwrap();
    let replacement = temp.path().join("replacement");
    fs::create_dir(&replacement).unwrap();
    fs::write(
        replacement.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(
        replacement.join("plugin.js"),
        "export const escaped = true;",
    )
    .unwrap();
    std::os::unix::fs::symlink(&replacement, &source).unwrap();
    assert!(manager.reload("example.page").is_err());
    assert_eq!(
        manager
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision,
        first
    );
}
#[test]
fn rollback_swaps_reload_sources_and_same_byte_reload_refreshes_source() {
    let (temp, manager, source) = fixture();
    let first = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    let second_source = temp.path().join("second-build");
    fs::create_dir(&second_source).unwrap();
    fs::write(
        second_source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(
        second_source.join("plugin.js"),
        "export const second = true;",
    )
    .unwrap();
    let second = manager
        .install(&second_source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    assert_ne!(second, first);
    manager.change("rollback", "example.page").unwrap();
    fs::write(source.join("plugin.js"), "export const firstReload = true;").unwrap();
    let catalog = manager.reload("example.page").unwrap();
    let plugin = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_ne!(plugin.revision, first);
    assert_eq!(plugin.previous.as_deref(), Some(first.as_str()));
    let third_source = temp.path().join("third-build");
    fs::create_dir(&third_source).unwrap();
    fs::write(
        third_source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(
        third_source.join("plugin.js"),
        "export const firstReload = true;",
    )
    .unwrap();
    let same = manager.install(&third_source).unwrap();
    let plugin = same
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_eq!(plugin.previous.as_deref(), Some(first.as_str()));
    assert!(plugin.reloadable);
    let changed = "export const thirdReload = true;";
    fs::write(third_source.join("plugin.js"), changed).unwrap();
    let catalog = manager.reload("example.page").unwrap();
    let reloaded = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap();
    assert_ne!(reloaded.revision, plugin.revision);
    assert_eq!(reloaded.previous.as_deref(), Some(plugin.revision.as_str()));
    manager.change("enable", "example.page").unwrap();
    assert_eq!(
        manager.module("example.page", &reloaded.revision).unwrap(),
        changed
    );
}
#[test]
fn invalid_install_preserves_working_revision() {
    let (_temp, manager, source) = fixture();
    let before = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    for metadata in [
        r#"{"id":"../escape","name":"Invalid","apiVersion":1}"#,
        r#"{"id":"example.page","name":"Invalid","apiVersion":2}"#,
        "{broken}",
    ] {
        fs::write(source.join("manifest.json"), metadata).unwrap();
        assert!(manager.install(&source).is_err());
        assert_eq!(
            manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == "example.page")
                .unwrap()
                .revision,
            before
        );
    }
}
#[test]
fn corrupt_artifact_does_not_block_disable_or_remove() {
    let (temp, manager, source) = fixture();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    manager.change("enable", "example.page").unwrap();
    fs::write(
        temp.path().join(format!(
            "profiles/test/artifacts/example.page/{revision}.json"
        )),
        "broken",
    )
    .unwrap();
    assert!(manager.module("example.page", &revision).is_err());
    manager.change("disable", "example.page").unwrap();
    manager.change("remove", "example.page").unwrap();
}
#[test]
fn corrupt_settings_require_recovery_and_are_backed_up() {
    let (temp, manager, source) = fixture();
    manager.install(&source).unwrap();
    let root = temp.path().join("profiles/test");
    fs::write(root.join("registry.json"), "{broken}").unwrap();
    assert!(manager.catalog().is_err());
    assert!(manager.change("disable", "buzz.channels").is_err());
    manager.recover().unwrap();
    assert!(manager.catalog().is_ok());
    let backup = fs::read_dir(root)
        .unwrap()
        .filter_map(|p| p.ok())
        .find(|p| {
            p.file_name()
                .to_string_lossy()
                .starts_with("registry-backup-")
        })
        .unwrap();
    assert_eq!(fs::read_to_string(backup.path()).unwrap(), "{broken}");
}
#[test]
fn safe_mode_and_profiles_are_independent() {
    let (temp, manager, source) = fixture();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    manager.change("enable", "example.page").unwrap();
    let safe = Manager::open(Some(temp.path().into()), "test", true).unwrap();
    assert!(safe.module("example.page", &revision).is_err());
    assert!(safe.external_plugins_paused());
    assert!(!manager.external_plugins_paused());
    assert!(
        safe.catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    assert!(manager.module("example.page", &revision).is_ok());
    safe.change("disable", "example.page").unwrap();
    assert_eq!(
        Manager::open(Some(temp.path().into()), "other", false)
            .unwrap()
            .catalog()
            .unwrap()
            .plugins
            .len(),
        bundled_manifests().len()
    );
}
#[test]
fn concurrent_changes_do_not_lose_installs() {
    let (_temp, manager, source) = fixture();
    manager.install(&source).unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                for _ in 0..5 {
                    manager.change("disable", "buzz.github").unwrap();
                    manager.change("enable", "example.page").unwrap();
                }
            });
        }
    });
    let catalog = manager.catalog().unwrap();
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.github")
            .unwrap()
            .enabled
    );
    assert!(
        catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
}
#[test]
fn management_never_executes_code_and_protects_bundled_identity() {
    let (_temp, manager, source) = fixture();
    fs::write(
        source.join("plugin.js"),
        "throw new Error('broken'); while(true) {}",
    )
    .unwrap();
    manager.install(&source).unwrap();
    manager.change("enable", "example.page").unwrap();
    manager.change("disable", "example.page").unwrap();
    manager.change("remove", "example.page").unwrap();
    fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&bundled_manifests()[0]).unwrap(),
    )
    .unwrap();
    assert!(manager.install(&source).is_err());
    assert!(manager
        .change("remove", &bundled_manifests()[0].id)
        .is_err());
}

#[test]
fn bundled_plugins_have_independent_flags_and_all_ids_are_reserved() {
    let (root, manager, source) = fixture();
    manager.change("disable", "buzz.github").unwrap();
    let catalog = manager.catalog().unwrap();
    assert!(
        catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.channels")
            .unwrap()
            .enabled
    );
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.github")
            .unwrap()
            .enabled
    );
    for id in [
        "buzz.identity-naming",
        "buzz.terminal",
        "buzz.sessions",
        "buzz.inbox",
        "buzz.bestie",
        "buzz.projects",
        "buzz.agents",
        "buzz.emoji",
        "buzz.mentions",
        "buzz.links",
    ] {
        assert!(
            manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        manager.change("disable", id).unwrap();
        let reloaded = manager.catalog().unwrap();
        assert!(
            !reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        assert!(
            reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.channels")
                .unwrap()
                .enabled
        );
        manager.change("enable", id).unwrap();
        let reloaded = manager.catalog().unwrap();
        assert!(
            reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        assert!(
            !reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.github")
                .unwrap()
                .enabled
        );
        assert!(manager.change("remove", id).is_err());
    }
    assert!(manager.change("remove", "buzz.channels").is_err());
    for manifest in buzzodz_plugins::bundled_manifests() {
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(manager.install(&source).is_err());
    }
    drop(root);
}

#[test]
fn feedback_is_in_native_catalog() {
    let (root, manager, _source) = fixture();
    assert!(bundled_manifests().iter().any(|m| m.id == "buzz.feedback"));
    assert!(manager
        .catalog()
        .unwrap()
        .plugins
        .iter()
        .any(|p| p.manifest.id == "buzz.feedback" && p.enabled));
    drop(root);
}

#[test]
fn channels_is_required_even_with_saved_disabled_settings() {
    let (root, manager, _source) = fixture();
    manager.change("disable", "buzz.github").unwrap();
    let path = root.path().join("profiles/test/registry.json");
    let mut saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    saved["bundledOverrides"]["buzz.channels"] = serde_json::json!(false);
    let bytes = serde_json::to_vec(&saved).unwrap();
    fs::write(&path, &bytes).unwrap();
    for _ in 0..2 {
        let reopened = Manager::open(Some(root.path().into()), "test", false).unwrap();
        let catalog = reopened.catalog().unwrap();
        assert!(
            catalog
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.channels")
                .unwrap()
                .enabled
        );
        assert!(
            !catalog
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.github")
                .unwrap()
                .enabled
        );
        assert!(reopened
            .change("disable", "buzz.channels")
            .err()
            .unwrap()
            .contains("Channels is required"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    manager.change("enable", "buzz.github").unwrap();
    assert!(
        manager
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.channels")
            .unwrap()
            .enabled
    );
}
