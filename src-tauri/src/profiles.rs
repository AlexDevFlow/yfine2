//! Multi-profile support. Each profile is a fully separate data universe: its
//! own SQLite DB, its own `.yfine-auth.json` (password + encryption salts) and
//! its own encrypted archive — nothing is shared between profiles.
//!
//! Layout (inside the app config dir, the same dir tauri-plugin-sql resolves
//! relative `sqlite:` paths against):
//!   profiles.json                 → { "active": "<id>", "profiles": [...] }
//!   yfine.db / .yfine-auth.json…  → the legacy/default profile (id "default"),
//!                                   kept at the root so existing installs keep
//!                                   working without any data migration.
//!   profiles/<id>/…               → every other profile's private data dir.
//!
//! All auth commands (auth.rs) resolve their paths through
//! `active_profile_dir`, so password/encryption state is per-profile for free.

use crate::crypto;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

pub const DEFAULT_PROFILE_ID: &str = "default";
const DEFAULT_COLOR: &str = "#4f46e5";

fn root_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn profiles_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(root_dir(app)?.join("profiles.json"))
}

/// Profile ids are generated server-side (hex) — but validate on every path
/// join anyway so a hand-edited profiles.json can never escape the data dir.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn default_config(default_name: &str) -> Value {
    json!({
        "active": DEFAULT_PROFILE_ID,
        "profiles": [{
            "id": DEFAULT_PROFILE_ID,
            "name": default_name,
            "color": DEFAULT_COLOR,
            "created_at": now_secs(),
        }],
    })
}

/// Normalize every way the config can be absent/corrupt: missing file, invalid
/// JSON, empty profile list, or an `active` id that no longer exists all
/// collapse back to a sane state (never an empty list). Pure — unit-tested.
fn normalize_config(raw: Option<Value>) -> Value {
    let mut cfg = raw.unwrap_or_else(|| default_config("Personal"));
    let has_profiles = cfg["profiles"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if !has_profiles {
        cfg = default_config("Personal");
    }
    let active_exists = cfg["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"].as_str() == cfg["active"].as_str());
    if !active_exists {
        cfg["active"] = cfg["profiles"][0]["id"].clone();
    }
    cfg
}

pub fn read_config(app: &tauri::AppHandle) -> Value {
    normalize_config(
        profiles_path(app)
            .ok()
            .and_then(|p| fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok()),
    )
}
/// Atomic replace (unique tmp → fsync → rename): a torn `profiles.json` would
/// be read back as "no config" and collapse the list to the default profile,
/// hiding every other profile's data dir from the switcher.
fn write_config(app: &tauri::AppHandle, cfg: &Value) -> Result<(), String> {
    use std::io::Write;
    let target = profiles_path(app)?;
    let bytes = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target.with_file_name(format!("profiles.json.{}.{}.tmp", std::process::id(), nanos));
    let write = (|| -> Result<(), String> {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, &target).map_err(|e| e.to_string())
    })();
    if let Err(e) = write {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    #[cfg(unix)]
    if let Some(dir) = target.parent() {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// The active profile's private data dir (created if missing). The default
/// profile lives at the app-config root — exactly where a pre-profiles install
/// left its yfine.db — so upgrading never moves anyone's data.
pub fn profile_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid profile id".into());
    }
    let dir = if id == DEFAULT_PROFILE_ID {
        root_dir(app)?
    } else {
        root_dir(app)?.join("profiles").join(id)
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn active_profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cfg = read_config(app);
    let id = cfg["active"].as_str().unwrap_or(DEFAULT_PROFILE_ID).to_string();
    profile_dir(app, &id)
}

/// Whether a profile has a password set (peeks at ITS auth file, not the
/// active one) — lets the switcher show a lock badge per profile.
fn profile_has_password(app: &tauri::AppHandle, id: &str) -> bool {
    let Ok(dir) = profile_dir(app, id) else { return false };
    fs::read(dir.join(".yfine-auth.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c.get("password_hash").and_then(|v| v.as_str()).map(|s| !s.is_empty()))
        .unwrap_or(false)
}

/// Full profiles state for the UI. `default_name` (localized, from the
/// frontend) names the lazily-created default profile on first run.
#[tauri::command]
pub fn profiles_get(app: tauri::AppHandle, default_name: Option<String>) -> Result<Value, String> {
    let existed = profiles_path(&app)?.exists();
    let mut cfg = read_config(&app);
    if !existed {
        if let Some(name) = default_name {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                cfg["profiles"][0]["name"] = json!(trimmed);
            }
        }
        write_config(&app, &cfg)?; // persist so ids/names are stable from now on
    }
    if let Some(list) = cfg["profiles"].as_array_mut() {
        for p in list.iter_mut() {
            let id = p["id"].as_str().unwrap_or("").to_string();
            p["has_password"] = json!(profile_has_password(&app, &id));
        }
    }
    Ok(cfg)
}

#[tauri::command]
pub fn profile_create(app: tauri::AppHandle, name: String, color: Option<String>) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("empty profile name".into());
    }
    let mut cfg = read_config(&app);
    let id = crypto::random_hex(8);
    let profile = json!({
        "id": id,
        "name": name,
        "color": color.unwrap_or_else(|| DEFAULT_COLOR.to_string()),
        "created_at": now_secs(),
    });
    cfg["profiles"]
        .as_array_mut()
        .ok_or("corrupt profiles config")?
        .push(profile.clone());
    profile_dir(&app, &id)?; // create its data dir up front
    write_config(&app, &cfg)?;
    Ok(profile)
}

#[tauri::command]
pub fn profile_update(
    app: tauri::AppHandle,
    id: String,
    name: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    let mut cfg = read_config(&app);
    let list = cfg["profiles"].as_array_mut().ok_or("corrupt profiles config")?;
    let p = list
        .iter_mut()
        .find(|p| p["id"].as_str() == Some(id.as_str()))
        .ok_or("profile not found")?;
    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() {
            return Err("empty profile name".into());
        }
        p["name"] = json!(n);
    }
    if let Some(c) = color {
        p["color"] = json!(c);
    }
    write_config(&app, &cfg)
}

/// Delete a profile AND all of its data. The active profile can't be deleted
/// (switch away first), which also guarantees the list never empties.
#[tauri::command]
pub fn profile_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut cfg = read_config(&app);
    if cfg["active"].as_str() == Some(id.as_str()) {
        return Err("cannot delete the active profile".into());
    }
    let list = cfg["profiles"].as_array_mut().ok_or("corrupt profiles config")?;
    let before = list.len();
    list.retain(|p| p["id"].as_str() != Some(id.as_str()));
    if list.len() == before {
        return Err("profile not found".into());
    }
    write_config(&app, &cfg)?;
    // Remove the data. Non-default profiles own a whole directory; the default
    // profile shares the root dir with profiles.json, so delete only its files.
    if id == DEFAULT_PROFILE_ID {
        let root = root_dir(&app)?;
        for f in [
            "yfine.db",
            "yfine.db-journal",
            "yfine.db-wal",
            "yfine.db-shm",
            "yfine.db.enc",
            "yfine.db.enc.tmp",
            ".yfine-auth.json",
            ".yfine-unlocked",
        ] {
            let _ = fs::remove_file(root.join(f));
        }
        // Unique-name ciphertext tmps (yfine.db.enc.<pid>.<nanos>.tmp) from a
        // crashed encrypt attempt live beside the fixed names — sweep them too.
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("yfine.db.enc.") && name.ends_with(".tmp") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    } else if valid_id(&id) {
        let _ = fs::remove_dir_all(root_dir(&app)?.join("profiles").join(&id));
    }
    // Attachment files live under the app DATA dir (the JS side's
    // BaseDirectory.AppData), namespaced per profile as attachments/<id>/ —
    // mirrors attachmentsDir() in src/db/repo/attachments.ts. Remove the
    // deleted profile's subdir too (best-effort, like the data dir above).
    if valid_id(&id) {
        if let Ok(data_dir) = app.path().app_data_dir() {
            let _ = fs::remove_dir_all(data_dir.join("attachments").join(&id));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_invalid_config_falls_back_to_default() {
        for raw in [None, Some(json!("garbage")), Some(json!({"profiles": []}))] {
            let cfg = normalize_config(raw);
            let list = cfg["profiles"].as_array().unwrap();
            assert_eq!(list.len(), 1);
            assert_eq!(list[0]["id"], DEFAULT_PROFILE_ID);
            assert_eq!(cfg["active"], DEFAULT_PROFILE_ID);
        }
    }

    #[test]
    fn stale_active_id_falls_back_to_first_profile() {
        let cfg = normalize_config(Some(json!({
            "active": "deleted-one",
            "profiles": [{"id": "abc123", "name": "Work", "color": "#000", "created_at": 0}],
        })));
        assert_eq!(cfg["active"], "abc123");
        assert_eq!(cfg["profiles"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn valid_config_passes_through_untouched() {
        let raw = json!({
            "active": "abc123",
            "profiles": [
                {"id": "default", "name": "Personal", "color": "#4f46e5", "created_at": 1},
                {"id": "abc123", "name": "Work", "color": "#059669", "created_at": 2},
            ],
        });
        assert_eq!(normalize_config(Some(raw.clone())), raw);
    }

    #[test]
    fn profile_ids_are_validated_for_path_safety() {
        assert!(valid_id("default"));
        assert!(valid_id("a1b2c3d4"));
        assert!(valid_id("with-dash"));
        assert!(!valid_id(""));
        assert!(!valid_id("../escape"));
        assert!(!valid_id("has/slash"));
        assert!(!valid_id("has\\backslash"));
        assert!(!valid_id("has space"));
        assert!(!valid_id(&"x".repeat(65)));
    }
}

#[tauri::command]
pub fn profile_set_active(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut cfg = read_config(&app);
    let exists = cfg["profiles"]
        .as_array()
        .map(|l| l.iter().any(|p| p["id"].as_str() == Some(id.as_str())))
        .unwrap_or(false);
    if !exists {
        return Err("profile not found".into());
    }
    profile_dir(&app, &id)?; // ensure the dir exists before the reload opens the DB
    // The Rust-side session password (if any) belongs to the OUTGOING profile:
    // drop it so no later exit path can encrypt the new profile's DB with the
    // old profile's key (encrypt_db already clears it on success — this covers
    // the switch-after-failed-encrypt path too).
    crate::auth::set_runtime_key(&app, None);
    cfg["active"] = json!(id);
    write_config(&app, &cfg)
}
