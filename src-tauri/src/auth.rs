//! Auth / encryption Tauri commands. Operate on files in the ACTIVE PROFILE's
//! data dir (the app config dir for the default profile — same dir
//! tauri-plugin-sql resolves `sqlite:yfine.db` against — or profiles/<id>/ for
//! the others), keeping secrets in `.yfine-auth.json` OUTSIDE the encrypted DB
//! so the app can boot and prompt. Password/encryption state is therefore fully
//! per-profile: every command below reads and writes only the active profile.

use crate::crypto;
use crate::profiles;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// Session password held in Rust managed state — set on successful auth_login /
/// set_password / change_password, cleared on remove_password and after a
/// successful exit encryption. The JS close hook keeps its own copy as a fast
/// path, but macOS Cmd+Q / File→Quit / programmatic exit never emit the JS
/// `CloseRequested` event — the `RunEvent::ExitRequested` handler in lib.rs
/// reads THIS state so those quit paths still re-encrypt.
#[derive(Default)]
pub struct RuntimeKey(Mutex<Option<String>>);

pub(crate) fn set_runtime_key(app: &tauri::AppHandle, pw: Option<String>) {
    if let Some(state) = app.try_state::<RuntimeKey>() {
        *state.0.lock().unwrap() = pw;
    }
}

fn take_runtime_key(app: &tauri::AppHandle) -> Option<String> {
    app.try_state::<RuntimeKey>()
        .and_then(|state| state.0.lock().unwrap().take())
}

/// fsync the containing directory so a just-created/renamed entry itself
/// survives power loss. Unix-only: std can't open a directory handle on
/// Windows (needs FILE_FLAG_BACKUP_SEMANTICS) — best-effort no-op there.
fn fsync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Sibling tmp path unique per process+instant (`<name>.<pid>.<nanos>.tmp`) so
/// two racing writers can never clobber each other's half-written tmp.
fn unique_tmp(target: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "yfine".into());
    name.push_str(&format!(".{}.{}.tmp", std::process::id(), nanos));
    target.with_file_name(name)
}

/// Atomic durable replace: write a unique tmp → fsync it → rename over the
/// target → fsync the directory. A crash at any point leaves either the old
/// file or the new file on disk, never a torn one.
fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = unique_tmp(target);
    let write = (|| -> Result<(), String> {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, target).map_err(|e| e.to_string())
    })();
    if let Err(e) = write {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Some(dir) = target.parent() {
        fsync_dir(dir);
    }
    Ok(())
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    profiles::active_profile_dir(app)
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
    // Atomic replace: a torn `.yfine-auth.json` loses encryption_salt, which
    // permanently orphans any existing `yfine.db.enc` (its key derives from it).
    write_atomic(
        &auth_path(app)?,
        &serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?,
    )
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
    let mut cfg = read_config(&app);
    // Persistent brute-force throttle (5 wrong passwords per 5 minutes locks the
    // profile for 5 minutes). It lives in the auth config, not in the window's
    // memory, so a relaunch does not reset it. Reported as "locked:<seconds>"
    // so the login screen can show the countdown.
    let now_s = unix_now();
    if let Some(until) = cfg["lock_until"].as_u64() {
        if now_s < until {
            return Err(format!("locked:{}", until - now_s));
        }
    }
    let hash = cfg["password_hash"].as_str().ok_or("no password set")?.to_string();
    let psalt = cfg["password_salt"].as_str().ok_or("no password salt")?.to_string();
    let (hash, psalt) = (hash.as_str(), psalt.as_str());
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
            record_failed_attempt(&app, &mut cfg, now_s);
            return Ok(false);
        }
        let archive = fs::read(enc_path(&app)?).map_err(|e| e.to_string())?;
        match crypto::decrypt(&archive, &key) {
            Ok(plain) => {
                // Durable plaintext BEFORE the unlock marker exists: create +
                // write_all + sync_all + dir fsync, so a crash right after the
                // marker appears can never leave a truncated yfine.db as the
                // canonical copy. A failed write (disk full / I/O error) is
                // cleaned up before Err so no partial plaintext survives this
                // session (mirrors the decrypt-Err cleanup below).
                let write = (|| -> Result<(), String> {
                    use std::io::Write;
                    let mut f = fs::File::create(db_path(&app)?).map_err(|e| e.to_string())?;
                    f.write_all(&plain).map_err(|e| e.to_string())?;
                    f.sync_all().map_err(|e| e.to_string())
                })();
                if let Err(e) = write {
                    let _ = fs::remove_file(db_path(&app)?);
                    return Err(e);
                }
                if let Some(dir) = db_path(&app)?.parent() {
                    fsync_dir(dir);
                }
                // The marker is what protects this session's edits from
                // crash_recovery: if it can't be persisted, fail the unlock
                // (dropping the fresh plaintext — the `.enc` stays canonical)
                // rather than risk a later boot silently discarding changes.
                if let Err(e) = write_atomic(&marker_path(&app)?, b"unlocked") {
                    let _ = fs::remove_file(db_path(&app)?);
                    return Err(e);
                }
            }
            Err(e) => {
                let _ = fs::remove_file(db_path(&app)?); // never leave a partial plaintext
                return Err(e);
            }
        }
    } else if !crypto::verify_password(&password, hash, psalt) {
        // No archive to decrypt (or the plaintext is canonical): a single verify is
        // already the minimum work — nothing to parallelize.
        record_failed_attempt(&app, &mut cfg, now_s);
        return Ok(false);
    }
    // A correct password clears the throttle bookkeeping.
    if cfg.get("failed_attempts").is_some() || cfg.get("lock_until").is_some() {
        if let Some(obj) = cfg.as_object_mut() {
            obj.remove("failed_attempts");
            obj.remove("lock_until");
        }
        let _ = write_config(&app, &cfg);
    }
    // Arm the Rust-side session key so the ExitRequested path can re-encrypt
    // even when the JS close hook never fires (Cmd+Q / File→Quit).
    set_runtime_key(&app, Some(password));
    Ok(true)
}

/// Login throttle: at most `LOGIN_MAX_ATTEMPTS` wrong passwords within
/// `LOGIN_WINDOW_SECS`, then the profile is locked for `LOGIN_WINDOW_SECS`.
const LOGIN_MAX_ATTEMPTS: usize = 5;
const LOGIN_WINDOW_SECS: u64 = 300;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Pure throttle step over the auth config: prune attempts outside the window,
/// record this one, and lock when the limit is reached. Returns true when a
/// lock was just set. Unit-tested; `record_failed_attempt` persists the result.
fn note_failed_attempt(cfg: &mut Value, now_s: u64) -> bool {
    let mut attempts: Vec<u64> = cfg["failed_attempts"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default();
    attempts.retain(|t| now_s.saturating_sub(*t) < LOGIN_WINDOW_SECS);
    attempts.push(now_s);
    if attempts.len() >= LOGIN_MAX_ATTEMPTS {
        cfg["lock_until"] = json!(now_s + LOGIN_WINDOW_SECS);
        if let Some(obj) = cfg.as_object_mut() {
            obj.remove("failed_attempts");
        }
        true
    } else {
        cfg["failed_attempts"] = json!(attempts);
        false
    }
}

fn record_failed_attempt(app: &tauri::AppHandle, cfg: &mut Value, now_s: u64) {
    note_failed_attempt(cfg, now_s);
    // Best-effort: a failed write only weakens the throttle, never the login.
    let _ = write_config(app, cfg);
}

#[cfg(test)]
mod throttle_tests {
    use super::*;

    #[test]
    fn locks_after_five_wrong_passwords_inside_the_window() {
        let mut cfg = json!({});
        for i in 0..4 {
            assert!(!note_failed_attempt(&mut cfg, 1000 + i));
        }
        assert_eq!(cfg["failed_attempts"].as_array().unwrap().len(), 4);
        assert!(note_failed_attempt(&mut cfg, 1004));
        assert_eq!(cfg["lock_until"].as_u64(), Some(1004 + LOGIN_WINDOW_SECS));
        assert!(cfg.get("failed_attempts").is_none());
    }

    #[test]
    fn attempts_outside_the_window_are_forgotten() {
        let mut cfg = json!({ "failed_attempts": [1, 2, 3, 4] });
        assert!(!note_failed_attempt(&mut cfg, 1000));
        assert_eq!(cfg["failed_attempts"].as_array().unwrap().len(), 1);
    }
}

/// Close every tauri-plugin-sql pool before touching yfine.db on disk. The
/// plugin's managed `DbInstances` state is public (`pub RwLock<HashMap<String,
/// DbPool>>`) and this app enables only the `sqlite` feature, so the single
/// `DbPool::Sqlite` variant exposes the underlying `sqlx::Pool` whose public
/// `close()` gracefully drains and closes every connection — releasing the
/// file handle (the Windows sharing-violation source) and, with the app's
/// `PRAGMA journal_mode=DELETE`, leaving a complete single-file database.
/// The close runs on the async runtime while we wait on a channel with a
/// bounded timeout so a wedged pool can never hang exit; if it times out, the
/// `-journal` guard and the CHECKED plaintext delete in `encrypt_db_inner`
/// still prevent a torn snapshot or a half-deleted plaintext.
fn close_sql_pools(app: &tauri::AppHandle) {
    use tauri_plugin_sql::{DbInstances, DbPool};
    if app.try_state::<DbInstances>().is_none() {
        return; // plugin not initialized — nothing to close
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let instances = handle.state::<DbInstances>();
        let pools = instances.0.read().await;
        for pool in pools.values() {
            #[allow(irrefutable_let_patterns)] // single variant with only `sqlite` enabled
            if let DbPool::Sqlite(p) = pool {
                p.close().await;
            }
        }
        drop(pools);
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(std::time::Duration::from_secs(10));
}

/// The exit-path encryption routine shared by the `encrypt_db` command (JS
/// close hook / profile switch) and `encrypt_on_exit` (Cmd+Q, File→Quit).
/// Hardened: pools are closed first (no torn snapshot of an open DB), a
/// `-journal`/`-wal` sidecar refuses the snapshot, the ciphertext lands via
/// unique-tmp → fsync → rename → dir-fsync, and the plaintext delete is
/// CHECKED — on failure the fresh `.enc` is kept and Err reports that the
/// plaintext is still on disk (Windows sharing violation, etc.).
fn encrypt_db_inner(app: &tauri::AppHandle, password: &str) -> Result<(), String> {
    let cfg = read_config(app);
    let esalt_hex = cfg["encryption_salt"].as_str().ok_or("no encryption salt")?;
    let esalt = hex::decode(esalt_hex).map_err(|e| e.to_string())?;
    let dbp = db_path(app)?;
    if !dbp.exists() {
        return Ok(());
    }
    close_sql_pools(app);
    // A journal/WAL sidecar after the pool close means uncommitted or
    // uncheckpointed state: snapshotting yfine.db alone would encrypt a torn
    // database. Refuse — the plaintext (plus its unlock marker) stays
    // canonical and a later clean close retries.
    let dir = data_dir(app)?;
    for sidecar in ["yfine.db-journal", "yfine.db-wal"] {
        if dir.join(sidecar).exists() {
            return Err(format!(
                "refusing to encrypt: {sidecar} exists (database still open or not cleanly committed)"
            ));
        }
    }
    // Sweep tmp ciphertexts stranded by a crash mid-encrypt (unique names,
    // plus the legacy fixed `yfine.db.enc.tmp` which matches the same pattern).
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("yfine.db.enc.") && name.ends_with(".tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let key = crypto::derive_key(password, &esalt);
    let plain = fs::read(&dbp).map_err(|e| e.to_string())?;
    let archive = crypto::encrypt(&plain, &key)?;
    write_atomic(&enc_path(app)?, &archive)?;
    // CHECKED delete: on Windows an open handle fails this with a sharing
    // violation — report it instead of silently leaving the plaintext next to
    // the `.enc`. The `.enc` is kept (it's valid); with the unlock marker
    // still present the plaintext stays canonical for the next boot.
    fs::remove_file(&dbp).map_err(|e| {
        format!("encrypted archive written, but the plaintext database could not be removed: {e}")
    })?;
    let _ = fs::remove_file(marker_path(app)?);
    Ok(())
}

/// Re-encrypt the working DB to `yfine.db.enc` (atomic) and wipe the plaintext.
/// Called by the JS close hook / profile switch; the Rust `ExitRequested`
/// handler (lib.rs) runs the same routine for quit paths that never reach JS.
// `(async)` — off-main-thread: key derivation + AES of the whole DB on close.
#[tauri::command(async)]
pub fn encrypt_db(app: tauri::AppHandle, password: String) -> Result<(), String> {
    encrypt_db_inner(&app, &password)?;
    // Successful exit/switch encryption: the session key has served its purpose
    // (keeping it would risk re-use against another profile's paths).
    set_runtime_key(&app, None);
    Ok(())
}

/// Exit-path re-encryption for quit paths that never emit a JS
/// `CloseRequested` (macOS Cmd+Q / File→Quit, programmatic exit/restart).
/// Runs synchronously inside `RunEvent::ExitRequested` (lib.rs) BEFORE the
/// event loop dies. No-op unless a runtime password is held AND a password is
/// actually set. On failure the plaintext (with its unlock marker) stays
/// canonical: the next boot shows the lock screen and re-encrypts on close.
pub fn encrypt_on_exit(app: &tauri::AppHandle) {
    let Some(pw) = take_runtime_key(app) else {
        return;
    };
    if !is_password_set(app.clone()) {
        return;
    }
    if let Err(e) = encrypt_db_inner(app, &pw) {
        eprintln!(
            "yfine: exit encryption failed — plaintext database left on disk \
             (unlock marker keeps it canonical for next boot): {e}"
        );
    }
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
    // An archive with NO password in config means `.yfine-auth.json` was lost
    // or torn: minting a fresh encryption_salt here would permanently orphan
    // that `yfine.db.enc` (its key derives from the lost salt) — refuse so the
    // user can restore the config or deliberately delete the archive first.
    if enc_path(&app)?.exists() {
        return Err(
            "an encrypted database archive exists but its configuration is missing; \
             refusing to overwrite its encryption salt"
                .into(),
        );
    }
    let (h, s) = crypto::hash_password(&password);
    cfg["password_hash"] = json!(h);
    cfg["password_salt"] = json!(s);
    cfg["encryption_salt"] = json!(crypto::random_hex(32));
    cfg["session_secret"] = json!(crypto::random_hex(32));
    write_config(&app, &cfg)?;
    // Arm the RUST session key immediately: the DB deliberately STAYS plaintext
    // (and open/usable) until close, but from this moment the ExitRequested
    // path re-encrypts on Cmd+Q / File→Quit even if JS never armed its close
    // hook. Remaining exposure: a hard kill / power loss before the next clean
    // close leaves the plaintext protected only by the lock screen (no
    // marker/.enc exists yet, so no data can be lost — the next clean close
    // encrypts it).
    set_runtime_key(&app, Some(password));
    Ok(())
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
    // re-encrypted with the new salt on next clean shutdown. Checked + durable:
    // silently losing this marker would reopen exactly that crash window.
    write_atomic(&marker_path(&app)?, b"unlocked")?;
    let (h, s) = crypto::hash_password(&new_password);
    cfg["password_hash"] = json!(h);
    cfg["password_salt"] = json!(s);
    // Rotate the encryption salt (NOT the session secret — matches the original).
    cfg["encryption_salt"] = json!(crypto::random_hex(32));
    write_config(&app, &cfg)?;
    // The old .enc is keyed to the previous salt and would be undecryptable with the
    // new password: wipe it (the plaintext, guaranteed by the precondition, is canonical).
    let _ = fs::remove_file(enc_path(&app)?);
    // Same session-key arming as set_password: quit paths without the JS hook
    // must re-encrypt with the NEW password/salt from this moment on.
    set_runtime_key(&app, Some(new_password));
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
    // Mirror change_password's guard: while locked the `.enc` is the ONLY copy
    // of the data — deleting it without a decrypted yfine.db present would
    // destroy the database, not "remove the password".
    if enc_path(&app)?.exists() && !db_path(&app)?.exists() {
        return Err("cannot remove password while locked (no decrypted database)".into());
    }
    let _ = fs::remove_file(enc_path(&app)?);
    let _ = fs::remove_file(marker_path(&app)?);
    let port = cfg.get("port").cloned();
    let mut new_cfg = json!({});
    if let Some(p) = port {
        new_cfg["port"] = p;
    }
    write_config(&app, &new_cfg)?;
    // Encryption is off from here: drop the session key so no exit path
    // re-encrypts the now deliberately-plaintext DB.
    set_runtime_key(&app, None);
    Ok(true)
}
