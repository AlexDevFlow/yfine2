/** True when running inside the Tauri runtime (vs a plain browser dev preview). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Open a URL in the system browser. Uses Tauri's opener plugin in the app
 * (so links escape the webview); falls back to window.open in a browser preview.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
