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

let runtimePassword: string | null = null;
export function setRuntimePassword(pw: string | null): void {
  runtimePassword = pw;
}

let closeHookRegistered = false;
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
      if (!runtimePassword) return;
      event.preventDefault();
      try {
        await encryptDb(runtimePassword);
      } catch {
        /* best-effort; the .enc is only replaced atomically on success */
      }
      runtimePassword = null;
      await win.destroy();
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
