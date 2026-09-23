/**
 * Opt-in auto-update via Tauri's GitHub-releases updater.
 *
 * OFF by default — nothing here runs unless the user clicks "Check for updates"
 * or enables the launch check (settings.auto_update_check). That keeps Yfine's
 * offline-first promise intact: no network is touched at rest. Every path
 * degrades cleanly when there's no connection — it resolves to an `offline`/
 * `error` state and never throws into the UI.
 *
 * The feature becomes functional from the first *signed* release that publishes a
 * `latest.json` asset (see .github/workflows/release.yml). Until a non-draft
 * release with that asset exists, the GitHub endpoint 404s and a check reports
 * "couldn't reach the update server" — harmless. On Linux, Tauri's updater
 * applies to the AppImage build only (.deb/.rpm users update manually).
 *
 * The plugin modules are imported lazily so they stay out of the initial bundle
 * and never load in the browser preview.
 */
import { isTauri } from "@/lib/tauri";
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | { kind: "checking" }
  /** Running the newest version. */
  | { kind: "uptodate"; current: string }
  /** A newer version is available and staged in {@link installPendingUpdate}. */
  | { kind: "available"; current: string; version: string; notes: string | null; date: string | null }
  /** Not running under Tauri (browser preview) — updates don't apply. */
  | { kind: "unsupported" }
  /** No network / endpoint unreachable / no published release yet. */
  | { kind: "offline" }
  /** Anything else (with the raw message, so nothing is hidden). */
  | { kind: "error"; message: string };

/** Download progress: bytes received and the total when the server reports one. */
export type InstallProgress = (downloaded: number, total: number | null) => void;

// The Update handle from the last successful check, staged for install. Kept here
// (not in component state) so the Settings card and the launch watcher install the
// very same checked update without re-hitting the network.
let pending: Update | null = null;

/** Best-effort classification of a check failure into offline-vs-real-error. */
function classify(e: unknown): UpdateState {
  const msg = e instanceof Error ? e.message : String(e);
  // Network failures and a missing/draft-only release (404, no latest.json) all
  // mean "couldn't reach the update server" from the user's point of view.
  const offline =
    /network|fetch|request|connect|dns|timed?\s*out|timeout|unreachable|offline|resolve|tls|handshake|os error|sending request|404|not found|release json|no such host/i.test(
      msg,
    );
  return offline ? { kind: "offline" } : { kind: "error", message: msg };
}

/** Current app version, or "" if it can't be read (non-Tauri). */
export async function currentVersion(): Promise<string> {
  if (!isTauri()) return "";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "";
  }
}

/**
 * Ask GitHub whether a newer signed release exists. Never throws — returns a
 * discriminated {@link UpdateState}. On `available`, the update is staged for
 * {@link installPendingUpdate}.
 */
export async function checkForUpdate(): Promise<UpdateState> {
  if (!isTauri()) return { kind: "unsupported" };
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const { getVersion } = await import("@tauri-apps/api/app");
    const current = await getVersion();
    const update = await check();
    if (!update) {
      pending = null;
      return { kind: "uptodate", current };
    }
    pending = update;
    return {
      kind: "available",
      current,
      version: update.version,
      notes: update.body ?? null,
      date: update.date ?? null,
    };
  } catch (e) {
    return classify(e);
  }
}

/** True when a checked update is staged and ready to install. */
export function hasPendingUpdate(): boolean {
  return pending != null;
}

/**
 * Download + install the update staged by the last {@link checkForUpdate}, then
 * relaunch into the new version. Throws if nothing is staged or the download
 * fails (callers surface it as a toast). The process restarts on success, so
 * code after `relaunch()` does not run.
 *
 * The working database is re-encrypted BETWEEN download and install: on
 * Windows the installer step ends the process itself, without the window
 * close or exit events the encrypt-on-exit paths hang off, so an unlocked
 * session would otherwise be left plaintext on disk. Download first so a
 * failed download never costs the user their open session.
 */
export async function installPendingUpdate(onProgress?: InstallProgress): Promise<void> {
  if (!pending) throw new Error("no_update");
  let downloaded = 0;
  let total: number | null = null;
  await pending.download((ev) => {
    switch (ev.event) {
      case "Started":
        total = ev.data.contentLength ?? null;
        onProgress?.(0, total);
        break;
      case "Progress":
        downloaded += ev.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      case "Finished":
        onProgress?.(total ?? downloaded, total);
        break;
    }
  });
  const { encryptBeforeLeaving } = await import("@/lib/auth-bridge");
  await encryptBeforeLeaving(); // throws (user already notified) → install is skipped
  await pending.install();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
