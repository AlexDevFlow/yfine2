import { isTauri } from "./tauri";

/**
 * Save in-memory content to a file the user can find.
 *
 * In the browser preview we trigger the usual `<a download>` flow. In the Tauri
 * webview that anchor trick is a no-op (no download manager), which is why
 * exports silently "did nothing" — so there we write the file into the app data
 * directory under `exports/` and reveal it in the OS file manager. Returns the
 * saved absolute path on Tauri (for a confirming toast), or null in the browser.
 */
export async function downloadBytes(
  filename: string,
  bytes: Uint8Array,
  mime: string,
): Promise<string | null> {
  if (isTauri()) {
    const { BaseDirectory, mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
    await mkdir("exports", { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {});
    await writeFile(`exports/${filename}`, bytes, { baseDir: BaseDirectory.AppData });

    let full = `exports/${filename}`;
    try {
      const { appDataDir, join } = await import("@tauri-apps/api/path");
      full = await join(await appDataDir(), "exports", filename);
    } catch {
      /* path resolution is best-effort; the file is already written */
    }
    // Best-effort: reveal the file in the OS file manager (ignore if blocked).
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(full);
    } catch {
      /* not permitted on this platform — the path is still returned/toasted */
    }
    return full;
  }

  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}

export async function downloadText(
  filename: string,
  text: string,
  mime = "text/plain",
): Promise<string | null> {
  return downloadBytes(filename, new TextEncoder().encode(text), mime);
}
