mod auth;
mod biometric;
mod crypto;
mod profiles;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init());

    // Auto-updater is desktop-only (not available on mobile targets); `process`
    // provides the relaunch used after an update installs. The feature is opt-in
    // at runtime — registering the plugins just makes the capability available;
    // nothing contacts the network unless the user triggers a check.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        // Rust-side session password: set on login / set_password /
        // change_password so the exit path below can re-encrypt without any
        // help from JS (see auth::RuntimeKey).
        .manage(auth::RuntimeKey::default())
        .invoke_handler(tauri::generate_handler![
            auth::is_db_encrypted,
            auth::is_password_set,
            auth::auth_login,
            auth::encrypt_db,
            auth::set_password,
            auth::change_password,
            auth::remove_password,
            auth::crash_recovery,
            biometric::biometric_status,
            profiles::profiles_get,
            profiles::profile_create,
            profiles::profile_update,
            profiles::profile_delete,
            profiles::profile_set_active,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Quit paths never emit the JS window CloseRequested event, so the
            // auth-bridge close hook can't run — this is the authoritative
            // encrypt-on-exit path. BOTH arms are required: ExitRequested fires
            // on last-window-destroy and programmatic exit/restart, but macOS
            // Cmd+Q / File→Quit goes through AppKit `terminate:` → tao emits
            // only LoopDestroyed → tauri maps it straight to RunEvent::Exit
            // WITHOUT an ExitRequested first. During Exit (inside
            // applicationWillTerminate) the async runtime is still alive, so
            // the synchronous encrypt completes before the process dies.
            // encrypt_on_exit is idempotent (take_runtime_key → None on the
            // second call), so hitting both arms — or the JS fast path having
            // already encrypted — is a no-op.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                auth::encrypt_on_exit(app);
            }
        });
}
