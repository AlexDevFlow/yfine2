//! Auth / encryption Tauri commands. Operate on files in the app config dir
//! (same dir tauri-plugin-sql resolves `sqlite:yfine.db` against), keeping secrets
//! in `.yfine-auth.json` OUTSIDE the encrypted DB so the app can boot and prompt.

use crate::crypto;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn auth_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(".yfine-auth.json"))
}
fn enc_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("yfine.db.enc"))
}
fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("yfine.db"))
}
fn marker_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(".yfine-unlocked"))
}

fn read_config(app: &tauri::AppHandle) -> Value {
    auth_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_else(|| json!({}))
}
fn write_config(app: &tauri::AppHandle, cfg: &Value) -> Result<(), String> {
    let p = auth_path(app)?;
    fs::write(p, serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn is_db_encrypted(app: tauri::AppHandle) -> bool {
    enc_path(&app).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn is_password_set(app: tauri::AppHandle) -> bool {
    read_config(&app)
        .get("password_hash")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Verify the password and, if the DB is encrypted, decrypt it into place.
/// Returns true on success, false on wrong password; Err on decrypt failure.
// `(async)` runs this off the main/UI thread: the verify + key derivation are two
// 480k-iteration PBKDF2 hashes that would otherwise freeze the webview (no repaint →
// the unlock progress animation never shows). They're independent (same password,
// different salts), so when a decrypt is needed they run on parallel threads — a
// normal unlock costs one derivation of wall-clock, not two.
#[tauri::command(async)]
pub fn auth_login(app: tauri::AppHandle, password: String) -> Result<bool, String> {
    let cfg = read_config(&app);
    let hash = cfg["password_hash"].as_str().ok_or("no password set")?;
    let psalt = cfg["password_salt"].as_str().ok_or("no password salt")?;
    // If a deliberate-unlock marker is present alongside a plaintext DB, the previous
    // session unlocked and then crashed before re-encrypting: the plaintext is the
    // CANONICAL, newest copy (crash_recovery keeps it) and the `.enc` is stale.
    // Decrypting the stale archive over it here would silently discard that session's
    // edits — so only verify the password and keep the plaintext.
    let plaintext_canonical = marker_path(&app)?.exists() && db_path(&app)?.exists();
    if enc_path(&app)?.exists() && !plaintext_canonical {
        // The password hash and the AES key are two INDEPENDENT 480k-iteration PBKDF2
        // derivations — same password, different salts, neither needs the other's
        // output. Derive the key on a side thread while we verify on this one, so a
        // normal unlock costs ONE derivation of wall-clock instead of two. The decrypt
        // stays gated on verify succeeding (a wrong password discards the derived key
        // and writes nothing), and a real decrypt failure is still distinct from a
        // wrong password (Err vs Ok(false)).
        let esalt_hex = cfg["encryption_salt"].as_str().ok_or("no encryption salt")?;
        let esalt = hex::decode(esalt_hex).map_err(|e| e.to_string())?;
        let (verified, key) = std::thread::scope(|s| {
            let derived = s.spawn(|| crypto::derive_key(&password, &esalt));
            let verified = crypto::verify_password(&password, hash, psalt);
            (verified, derived.join().unwrap())
        });
        if !verified {
            return Ok(false);
        }
        let archive = fs::read(enc_path(&app)?).map_err(|e| e.to_string())?;
        match crypto::decrypt(&archive, &key) {
            Ok(plain) => {
                // A failed write (disk full / I/O error) can leave a truncated plaintext
                // without the unlock marker; remove it before returning Err so no partial
                // yfine.db survives this session (mirrors the decrypt-Err cleanup below).
                if let Err(e) = fs::write(db_path(&app)?, plain) {
                    let _ = fs::remove_file(db_path(&app)?);
                    return Err(e.to_string());
                }
                let _ = fs::write(marker_path(&app)?, b"unlocked");
            }
            Err(e) => {
                let _ = fs::remove_file(db_path(&app)?); // never leave a partial plaintext
                return Err(e);
            }
        }
    } else if !crypto::verify_password(&password, hash, psalt) {
        // No archive to decrypt (or the plaintext is canonical): a single verify is
        // already the minimum work — nothing to parallelize.
        return Ok(false);
    }
    Ok(true)
}

/// Re-encrypt the working DB to `yfine.db.enc` (atomic) and wipe the plaintext.
/// Called on app exit when a password is set.
// `(async)` — off-main-thread: key derivation + AES of the whole DB on close.
#[tauri::command(async)]
pub fn encrypt_db(app: tauri::AppHandle, password: String) -> Result<(), String> {
    let cfg = read_config(&app);
    let esalt_hex = cfg["encryption_salt"].as_str().ok_or("no encryption salt")?;
    let esalt = hex::decode(esalt_hex).map_err(|e| e.to_string())?;
    let dbp = db_path(&app)?;
    if !dbp.exists() {
        return Ok(());
    }
    let key = crypto::derive_key(&password, &esalt);
    let plain = fs::read(&dbp).map_err(|e| e.to_string())?;
    let archive = crypto::encrypt(&plain, &key)?;
    let tmp = data_dir(&app)?.join("yfine.db.enc.tmp");
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&archive).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?; // fsync: ciphertext durable on disk
    }
    // durable before deleting plaintext; clean up the tmp ciphertext if the swap fails.
    if let Err(e) = fs::rename(&tmp, enc_path(&app)?) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    let _ = fs::remove_file(&dbp);
    let _ = fs::remove_file(marker_path(&app)?);
    Ok(())
}

/// Set a password for the first time (generates hashes + salts + session secret).
// `(async)` — off-main-thread: hash_password runs a 480k-iter PBKDF2 derivation.
#[tauri::command(async)]
pub fn set_password(app: tauri::AppHandle, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("empty password".into());
    }
    let mut cfg = read_config(&app);
    // First-time set only. Re-running this on an already-encrypted app would rotate
    // encryption_salt and permanently orphan the old-salt `yfine.db.enc`. Use
    // change_password to rotate an existing password (it guards the plaintext).
    if cfg["password_hash"].as_str().map(|h| !h.is_empty()).unwrap_or(false) {
        return Err("password already set".into());
    }
    let (h, s) = crypto::hash_password(&password);
    cfg["password_hash"] = json!(h);
    cfg["password_salt"] = json!(s);
    cfg["encryption_salt"] = json!(crypto::random_hex(32));
    cfg["session_secret"] = json!(crypto::random_hex(32));
    write_config(&app, &cfg)
}

/// Change the password (verifies old, rotates hash + salts, sets the .enc up to
/// be rewritten with the new key on next clean shutdown). Mirrors
/// `security.change_password`: when the plaintext DB is present the stale `.enc`
/// (keyed to the OLD encryption salt and now undecryptable) is wiped and a fresh
/// unlock marker is written, so a crash before clean shutdown can never leave
/// only an unreadable archive. Returns false on wrong old password.
// `(async)` — off-main-thread: verify (derive) + rehash (derive) on the UI action.
#[tauri::command(async)]
pub fn change_password(
    app: tauri::AppHandle,
    old_password: String,
    new_password: String,
) -> Result<bool, String> {
    if new_password.is_empty() {
        return Err("empty password".into());
    }
    let mut cfg = read_config(&app);
    let hash = cfg["password_hash"].as_str().unwrap_or("");
    let psalt = cfg["password_salt"].as_str().unwrap_or("");
    if hash.is_empty() || !crypto::verify_password(&old_password, hash, psalt) {
        return Ok(false);
    }
    // Refuse BEFORE mutating anything if the working plaintext DB is absent. Rotating
    // encryption_salt while the only readable copy is the .enc (keyed to the OLD salt)
    // would strand it permanently — no path can recover the previous salt. The plaintext
    // is the precondition for re-encrypting with the new key on next clean shutdown.
    if !db_path(&app)?.exists() {
        return Err("cannot change password while locked (no decrypted database)".into());
    }
    // Arm the deliberate-unlock marker BEFORE rotating the salt. crash_recovery
    // deletes the plaintext when `.enc` + `yfine.db` coexist without a marker; if we
    // persisted the new salt first and crashed before writing the marker, recovery
    // would drop the plaintext and leave only the old-salt `.enc` — now undecryptable.
    // With the marker first, any crash in this window keeps the plaintext, which is
    // re-encrypted with the new salt on next clean shutdown.
    let _ = fs::write(marker_path(&app)?, b"unlocked");
    let (h, s) = crypto::hash_password(&new_password);
    cfg["password_hash"] = json!(h);
    cfg["password_salt"] = json!(s);
    // Rotate the encryption salt (NOT the session secret — matches the original).
    cfg["encryption_salt"] = json!(crypto::random_hex(32));
    write_config(&app, &cfg)?;
    // The old .enc is keyed to the previous salt and would be undecryptable with the
    // new password: wipe it (the plaintext, guaranteed by the precondition, is canonical).
    let _ = fs::remove_file(enc_path(&app)?);
    Ok(true)
}

/// Boot-time crash recovery (mirrors `security.handle_crash_recovery`, run before
/// the DB is opened). Three-way logic keyed on the deliberate-unlock marker:
///   - no password set  → remove any stale marker, return.
///   - password set AND both `yfine.db.enc` and `yfine.db` exist AND the marker
///     is ABSENT → a previous run crashed mid encrypt/decrypt cycle; the `.enc`
///     is canonical, so the stale plaintext `yfine.db` is deleted.
///   - otherwise (marker present = deliberate unlock, or only one file) → no-op.
#[tauri::command]
pub fn crash_recovery(app: tauri::AppHandle) -> Result<(), String> {
    if !is_password_set(app.clone()) {
        let _ = fs::remove_file(marker_path(&app)?);
        return Ok(());
    }
    if enc_path(&app)?.exists() && db_path(&app)?.exists() && !marker_path(&app)?.exists() {
        // Both files present, no deliberate-unlock marker → crashed mid-cycle.
        // The encrypted copy is canonical; drop the stale plaintext.
        let _ = fs::remove_file(db_path(&app)?);
    }
    Ok(())
}

/// Remove the password and decrypt at rest (verifies current password first).
// `(async)` — off-main-thread: verify_password runs a 480k-iter PBKDF2 derivation.
#[tauri::command(async)]
pub fn remove_password(app: tauri::AppHandle, password: String) -> Result<bool, String> {
    let cfg = read_config(&app);
    let hash = cfg["password_hash"].as_str().unwrap_or("");
    let psalt = cfg["password_salt"].as_str().unwrap_or("");
    if !crypto::verify_password(&password, hash, psalt) {
        return Ok(false);
    }
    let _ = fs::remove_file(enc_path(&app)?);
    let _ = fs::remove_file(marker_path(&app)?);
    let port = cfg.get("port").cloned();
    let mut new_cfg = json!({});
    if let Some(p) = port {
        new_cfg["port"] = p;
    }
    write_config(&app, &new_cfg)?;
    Ok(true)
}
