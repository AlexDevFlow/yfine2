/**
 * Thin bridge to the Rust auth/encryption commands. No-ops gracefully in the
 * browser preview (no Tauri runtime, no encryption). The runtime password is
 * held in memory after login (or after enabling encryption in-session) so the
 * working DB can be re-encrypted on close.
 */
import { isTauri } from "./tauri";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export async function isDbEncrypted(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("is_db_encrypted") : false;
}
export async function isPasswordSet(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("is_password_set") : false;
}
export interface BiometricStatus {
  available: boolean;
  /** "ok" | "unsupported_platform" | "needs_signing" | "no_biometry" | "error" */
  reason: string;
  code: number | null;
}

/** Whether this build can unlock with Touch ID. See src-tauri/src/biometric.rs
 *  for why an unsigned bundle can't (and why we don't fake it). */
export async function biometricStatus(): Promise<BiometricStatus> {
  if (!isTauri()) return { available: false, reason: "unsupported_platform", code: null };
  try {
    return await invoke<BiometricStatus>("biometric_status");
  } catch {
    return { available: false, reason: "error", code: null };
  }
}

export async function authLogin(password: string): Promise<boolean> {
  return invoke<boolean>("auth_login", { password });
}
export async function setAppPassword(password: string): Promise<void> {
  return invoke<void>("set_password", { password });
}
export async function changeAppPassword(oldPassword: string, newPassword: string): Promise<boolean> {
  return invoke<boolean>("change_password", { oldPassword, newPassword });
}
export async function removeAppPassword(password: string): Promise<boolean> {
  return invoke<boolean>("remove_password", { password });
}
/**
 * Boot-time crash recovery: drop a stale plaintext DB left by a previous unclean
 * shutdown when the encrypted copy is canonical (mirrors handle_crash_recovery).
 * Must run before the DB connection is opened. No-ops outside Tauri.
 */
export async function runCrashRecovery(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke<void>("crash_recovery");
  } catch {
    /* best-effort; never block boot on recovery */
  }
}
async function encryptDb(password: string): Promise<void> {
  return invoke<void>("encrypt_db", { password });
}

/**
 * Close every tauri-plugin-sql pool (guest command `plugin:sql|close`; omitting
 * `db` closes ALL pools — covered by `sql:default`'s allow-close) so the Rust
 * snapshot reads a settled, single-file database instead of one that is still
 * open with an active journal. Best-effort here: the hardened `encrypt_db`
 * command closes the pools Rust-side too — this just front-runs it.
 */
async function closeSqlPools(): Promise<void> {
  try {
    await invoke<boolean>("plugin:sql|close");
  } catch {
    /* encrypt_db closes the pools itself */
  }
}

/**
 * Blocking user-visible failure notice. No dialog plugin is installed, so use
 * the webview-native alert (synchronous/blocking); always log too in case
 * alert is unavailable on the platform.
 */
function reportEncryptFailure(err: unknown): void {
  console.error("[yfine] database encryption failed:", err);
  const message =
    "Yfine could not encrypt your database.\n\n" +
    `${String(err)}\n\n` +
    "Your data is still stored UNENCRYPTED on disk and the window was kept open. " +
    "Try closing again; if the problem persists, back up your data before quitting.";
  try {
    window.alert(message);
  } catch {
    /* headless/odd webview — the console.error above is the fallback */
  }
}

let runtimePassword: string | null = null;
export function setRuntimePassword(pw: string | null): void {
  runtimePassword = pw;
}

/**
 * Bring the database back after an exit-path encryption FAILED. The pools were
 * closed for the snapshot and plugin-sql keeps the dead pool registered, so
 * every query would fail until the app restarted; re-loading the same path
 * replaces it. The plaintext is still on disk and still canonical (unlock
 * marker), so simply reconnecting is safe.
 */
async function reopenDbAfterFailedEncrypt(): Promise<void> {
  try {
    const { resetDbConnection } = await import("@/db/connection");
    resetDbConnection();
  } catch {
    /* nothing to reset */
  }
}

/**
 * Encrypt the working DB with the held session password because the process
 * is about to leave this profile (profile switch, an update installer that
 * exits without the window-close hooks). The password is kept until the
 * encryption SUCCEEDED: dropping it first would leave the database plaintext
 * with nothing left to encrypt it on the next close. On failure the user is
 * told, the database is reopened so the app keeps working, and the error is
 * rethrown so the caller aborts whatever it was about to do.
 */
export async function encryptBeforeLeaving(): Promise<void> {
  if (!isTauri()) return;
  const pw = runtimePassword;
  if (!pw) return;
  await closeSqlPools(); // settle yfine.db before the snapshot
  try {
    await encryptDb(pw);
  } catch (err) {
    await reopenDbAfterFailedEncrypt();
    reportEncryptFailure(err);
    throw err;
  }
  runtimePassword = null;
}

/**
 * Re-encrypt the active profile's working DB before switching to another
 * profile (same guarantee as the on-close hook, but without closing). No-op
 * when no runtime password is held. Throws — with the user already notified —
 * when encryption fails, so the switch is abandoned instead of leaving this
 * profile's database plaintext behind.
 */
export async function encryptForProfileSwitch(): Promise<void> {
  await encryptBeforeLeaving();
}

let closeHookRegistered = false;
/** A close request already running its encryption; a second one must not race it. */
let closing = false;
/** Re-encrypt the working DB when the window closes (mirrors the legacy atexit). */
export async function registerReencryptOnClose(): Promise<void> {
  if (!isTauri() || closeHookRegistered) return;
  closeHookRegistered = true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      // Re-encrypt whenever a runtime password is held — set on unlock AND on
      // enabling/changing the password during this session (gap 4), so a DB that
      // was made password-protected mid-session still gets encrypted on close.
      // This hook only covers window-close paths; Cmd+Q / File→Quit never emit
      // CloseRequested — those are handled Rust-side (RunEvent::ExitRequested
      // runs the same hardened routine with the Rust-held session password).
      if (!runtimePassword) return;
      event.preventDefault();
      // Two close requests in a row would run two encryptions at once: the
      // second one's tmp sweep deletes the first one's in-progress ciphertext
      // and one of them reports a false failure. Let the first finish.
      if (closing) return;
      closing = true;
      try {
        // Settle the DB file before the Rust snapshot (encrypt_db also closes the
        // pools itself; doing it here too keeps the fast path safe even if the
        // Rust-side close were ever to time out).
        await closeSqlPools();
        try {
          await encryptDb(runtimePassword);
        } catch (err) {
          // Never swallow this: the DB is still PLAINTEXT on disk. Reopen it so
          // the app keeps working, tell the user with a blocking notice and do
          // NOT destroy the window — closing again re-runs this hook (a retry),
          // and the unlock marker keeps the plaintext canonical if they
          // force-quit instead.
          await reopenDbAfterFailedEncrypt();
          reportEncryptFailure(err);
          return;
        }
        runtimePassword = null;
        await win.destroy();
      } finally {
        closing = false;
      }
    });
  } catch {
    /* window API unavailable — skip */
  }
}

/**
 * Arm the close-hook re-encrypt with a freshly set/changed password (gap 4).
 * Mirrors the original's set_runtime_password call inside set_password /
 * change_password: from now on the DB will be encrypted on the next clean close,
 * even though no .enc exists yet (so is_db_encrypted() is still false).
 */
export async function armEncryptionForSession(password: string): Promise<void> {
  setRuntimePassword(password);
  await registerReencryptOnClose();
}
