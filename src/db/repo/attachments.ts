/**
 * Movement attachments — files stored on disk under $APPDATA/attachments via the
 * Tauri fs plugin (the DB keeps only metadata: filename, stored_name, mime,
 * size). Tauri-only; the browser preview has no filesystem. Schema unchanged
 * from the legacy app (movement_attachments).
 *
 * Upload validation mirrors services/attachments.py: max 5 per movement, max
 * 10 MB each, no empty files, and only PNG/JPEG/WebP/HEIC/PDF (resolved by mime
 * with a filename-extension fallback). The stored mime is normalized to the
 * canonical mime for the resolved extension.
 */
import { BaseDirectory, mkdir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import type { SqlExecutor } from "../types";
import { DomainError } from "../errors";

const DIR = "attachments";
const now = () => new Date().toISOString();

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
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true });
  await writeFile(`${DIR}/${storedName}`, bytes, { baseDir: BaseDirectory.AppData });
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
  return readFile(`${DIR}/${storedName}`, { baseDir: BaseDirectory.AppData });
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
    await remove(`${DIR}/${storedName}`, { baseDir: BaseDirectory.AppData });
  } catch {
    /* file already gone / no fs (browser) — the DB row is what matters */
  }
}

/**
 * Delete the on-disk files for a set of movement ids (called BEFORE the cascade
 * DELETEs the rows). Mirrors delete_attachments_for_movement so no file is
 * orphaned when a movement — or its source — is removed. Best-effort: a missing
 * file or a browser environment without fs never blocks the delete.
 */
export async function purgeAttachmentFiles(db: SqlExecutor, movementIds: number[]): Promise<void> {
  if (!movementIds.length) return;
  const ph = movementIds.map(() => "?").join(",");
  const rows = await db.select<{ stored_name: string }>(
    `SELECT stored_name FROM movement_attachments WHERE movement_id IN (${ph})`,
    movementIds,
  );
  for (const r of rows) await removeStoredFile(r.stored_name);
}
