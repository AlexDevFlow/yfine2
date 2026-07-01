mod auth;
mod crypto;

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
        .invoke_handler(tauri::generate_handler![
            auth::is_db_encrypted,
            auth::is_password_set,
            auth::auth_login,
            auth::encrypt_db,
            auth::set_password,
            auth::change_password,
            auth::remove_password,
            auth::crash_recovery,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
