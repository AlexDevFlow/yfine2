/**
 * Movement attachments — files stored on disk under
 * $APPDATA/attachments/<profileId>/ via the Tauri fs plugin (the DB keeps only
 * metadata: filename, stored_name, mime, size). Tauri-only; the browser
 * preview has no filesystem. Schema unchanged from the legacy app
 * (movement_attachments).
 *
 * Upload validation mirrors services/attachments.py: max 5 per movement, max
 * 10 MB each, no empty files, and only PNG/JPEG/WebP/HEIC/PDF (resolved by mime
 * with a filename-extension fallback). The stored mime is normalized to the
 * canonical mime for the resolved extension.
 */
import { BaseDirectory, exists, mkdir, readDir, readFile, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import type { SqlExecutor } from "../types";
import { DomainError } from "../errors";

const BASE_DIR = "attachments";
const now = () => new Date().toISOString();

/**
 * Attachment files are namespaced PER PROFILE — attachments/<profileId>/ — with
 * the id derived from the same active-profile resolution the DB path uses
 * (lib/profiles.ts getActiveProfileId), so a profile's files always live beside
 * the DB rows that reference them and one profile's restore/prune can never
 * touch another's. The Rust side removes this subdir on profile_delete
 * (src-tauri/src/profiles.rs). Resolved once per session: switching profiles
 * reloads the webview, exactly like the DB connection.
 */
let dirPromise: Promise<string> | null = null;
export function attachmentsDir(): Promise<string> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const { getActiveProfileId } = await import("@/lib/profiles");
      const dir = `${BASE_DIR}/${await getActiveProfileId()}`;
      await migrateLegacyFlatFiles(dir);
      return dir;
    })().catch((e) => {
      dirPromise = null; // don't cache a transient failure
      throw e;
    });
  }
  return dirPromise;
}

/**
 * One-time layout migration: pre-profiles versions stored files FLAT under
 * attachments/. Move any such stragglers into the ACTIVE profile's subdir —
 * legacy installs predate multi-profile so they had exactly one profile, which
 * makes this lossless. Best-effort sequential renames: a failed one leaves the
 * file behind for the next run; a browser preview (no fs) is a no-op.
 */
async function migrateLegacyFlatFiles(dir: string): Promise<void> {
  try {
    if (!(await exists(BASE_DIR, { baseDir: BaseDirectory.AppData }))) return;
    const legacy = (await readDir(BASE_DIR, { baseDir: BaseDirectory.AppData })).filter((e) => e.isFile);
    if (!legacy.length) return;
    await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true });
    for (const e of legacy) {
      try {
        await rename(`${BASE_DIR}/${e.name}`, `${dir}/${e.name}`, {
          oldPathBaseDir: BaseDirectory.AppData,
          newPathBaseDir: BaseDirectory.AppData,
        });
      } catch {
        /* skip this file; retried on the next boot */
      }
    }
  } catch {
    /* no fs (browser preview) or nothing to migrate */
  }
}

export const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_PER_MOVEMENT = 5;

/** Canonical extension per allowed mime type. */
const ALLOWED_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
};
/** Allowed filename extensions (fallback when the browser sends a vague mime). */
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic", ".pdf"]);

function extensionFor(mimeType: string, filename: string): string {
  const mapped = ALLOWED_MIME[mimeType];
  if (mapped) return mapped;
  // Fall back to the filename's extension (browsers sometimes send
  // application/octet-stream for PDFs/HEIC).
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  return ALLOWED_EXT.has(ext) ? ext : "";
}

function mimeForExt(ext: string): string {
  for (const [m, e] of Object.entries(ALLOWED_MIME)) {
    if (e === ext) return m;
  }
  return "application/octet-stream";
}

export interface AttachmentInput {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface ValidatedAttachment {
  /** Whitelisted extension, e.g. ".png". */
  ext: string;
  /** Canonical mime to persist. */
  mime: string;
  size: number;
}

/**
 * Pure validation of an upload candidate. Throws DomainError on rejection.
 * `existingCount` is the number of attachments already on the target movement.
 */
export function validateAttachment(file: AttachmentInput, existingCount: number): ValidatedAttachment {
  if (existingCount >= MAX_PER_MOVEMENT) throw new DomainError("attachment_limit_reached");
  const size = file.bytes.length;
  if (size === 0) throw new DomainError("attachment_empty");
  if (size > MAX_SIZE_BYTES) throw new DomainError("attachment_too_large");
  const ext = extensionFor((file.type || "").toLowerCase(), file.name || "");
  if (!ext) throw new DomainError("attachment_unsupported");
  const lowerType = (file.type || "").toLowerCase();
  // Normalize: keep a sent mime only if it's in the allowed set, else derive it.
  const mime = lowerType in ALLOWED_MIME ? lowerType : mimeForExt(ext);
  return { ext, mime, size };
}

export interface AttachmentRow {
  id: number;
  movement_id: number;
  filename: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export async function listAttachments(db: SqlExecutor, movementId: number): Promise<AttachmentRow[]> {
  return db.select<AttachmentRow>(
    `SELECT id,movement_id,filename,stored_name,mime_type,size_bytes,created_at
     FROM movement_attachments WHERE movement_id = ? ORDER BY id`,
    [movementId],
  );
}

/** Writer seam so the validation/DB path can be exercised in tests with no fs. */
export type FileWriter = (storedName: string, bytes: Uint8Array) => Promise<void>;

const tauriWriter: FileWriter = async (storedName, bytes) => {
  const dir = await attachmentsDir();
  await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeFile(`${dir}/${storedName}`, bytes, { baseDir: BaseDirectory.AppData });
};

export async function addAttachment(
  db: SqlExecutor,
  movementId: number,
  file: AttachmentInput,
  writer: FileWriter = tauriWriter,
): Promise<number> {
  // The movement must exist (the cascade leaves no orphan rows behind).
  const exists = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements WHERE id = ?`, [movementId]);
  if ((exists[0]?.c ?? 0) === 0) throw new DomainError("not_found");

  const count = await db.select<{ c: number }>(
    `SELECT COUNT(*) c FROM movement_attachments WHERE movement_id = ?`,
    [movementId],
  );
  const v = validateAttachment(file, count[0]?.c ?? 0);

  // stored_name is a generated, whitelisted-extension name — never trust the
  // original filename for the disk path.
  const stored = `${movementId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${v.ext}`;
  await writer(stored, file.bytes);
  let rows: { id: number }[];
  try {
    rows = await db.select<{ id: number }>(
      `INSERT INTO movement_attachments (movement_id,filename,stored_name,mime_type,size_bytes,created_at)
       VALUES (?,?,?,?,?,?) RETURNING id`,
      [movementId, (file.name || stored).slice(0, 255), stored, v.mime, v.size, now()],
    );
  } catch (e) {
    // Don't leave the just-written file orphaned if the metadata INSERT fails.
    await removeStoredFile(stored).catch(() => {});
    throw e;
  }
  return rows[0].id;
}

/** Read an attachment's bytes back from disk (for preview/download). */
export async function readAttachment(storedName: string): Promise<Uint8Array> {
  return readFile(`${await attachmentsDir()}/${storedName}`, { baseDir: BaseDirectory.AppData });
}

export async function deleteAttachment(db: SqlExecutor, att: Pick<AttachmentRow, "id" | "stored_name">): Promise<void> {
  await db.execute(`DELETE FROM movement_attachments WHERE id = ?`, [att.id]);
  await removeStoredFile(att.stored_name);
}

/** Count of attachments per movement id (for list badges). */
export async function attachmentCounts(db: SqlExecutor): Promise<Map<number, number>> {
  const rows = await db.select<{ movement_id: number; c: number }>(
    `SELECT movement_id, COUNT(*) c FROM movement_attachments GROUP BY movement_id`,
  );
  return new Map(rows.map((r) => [r.movement_id, r.c]));
}

/** Best-effort removal of one stored file (swallows fs errors). */
async function removeStoredFile(storedName: string): Promise<void> {
  try {
    await remove(`${await attachmentsDir()}/${storedName}`, { baseDir: BaseDirectory.AppData });
  } catch {
    /* file already gone / no fs (browser) — the DB row is what matters */
  }
}

/**
 * Deferred file cleanup. The delete cascades (movements/sources/csv-undo) run
 * INSIDE withTx: if a later statement fails, the rows roll back — so the files
 * must NOT be unlinked mid-transaction or a rollback would leave live rows
 * pointing at deleted files. Invariant: repos only STAGE stored_names into the
 * frame the mutation layer (db/queries.ts) opens INSIDE the tx body — bodies
 * are serialized by the withTx mutex, so exactly one frame is ever active and
 * an overlapping queued transaction can never see or clobber another tx's
 * staged names. queries.ts captures the frame before the mutex releases and
 * unlinks only after COMMIT; on rollback the captured names are simply
 * dropped. The unlink pass is best-effort and never throws.
 */
let stagingFrame: string[] | null = null;

/** Open the staging frame for the current tx body (queries.ts only). */
export function beginUnlinkStaging(): void {
  // Nested withTx joins the outer transaction — keep the outer frame.
  if (stagingFrame == null) stagingFrame = [];
}

/** Close the frame and return its names (queries.ts only, inside the tx body). */
export function endUnlinkStaging(): string[] {
  const names = stagingFrame ?? [];
  stagingFrame = null;
  return names;
}

/**
 * Stage the on-disk files of a set of movement ids for post-commit removal
 * (called BEFORE the cascade DELETEs the rows, while the stored_names are
 * still selectable). Mirrors delete_attachments_for_movement so no file is
 * orphaned when a movement — or its source — is removed. Outside a staging
 * frame (a future caller not routed through queries.ts) it falls back to
 * immediate best-effort unlinks rather than silently orphaning files.
 */
export async function stageAttachmentUnlinks(db: SqlExecutor, movementIds: number[]): Promise<void> {
  if (!movementIds.length) return;
  const ph = movementIds.map(() => "?").join(",");
  const rows = await db.select<{ stored_name: string }>(
    `SELECT stored_name FROM movement_attachments WHERE movement_id IN (${ph})`,
    movementIds,
  );
  if (stagingFrame != null) {
    for (const r of rows) stagingFrame.push(r.stored_name);
  } else {
    for (const r of rows) await removeStoredFile(r.stored_name);
  }
}

/** Best-effort unlink of captured names. Call only after the tx committed. */
export async function unlinkStoredFiles(names: string[]): Promise<void> {
  for (const name of names) await removeStoredFile(name);
}
