/**
 * Backup / restore. Reproduces the legacy formats so existing backups stay
 * importable (refactor-analysis/exports-data.md §3):
 *  - JSON: { "<table>": [rows...], "_export_mode": "all", "_plugin_tables": {...} }
 *  - .yfine: a ZIP with manifest.json (format marker) + data.json + the movement
 *    attachment blobs under attachments/<stored_name> so the archive is
 *    self-contained (invariant #8 — attachments survive a backup/restore).
 * Import is all-or-nothing inside one transaction with PRAGMA defer_foreign_keys=ON
 * (needed for the self-referential movements.transfer_pair_id cycle).
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import type { SqlExecutor } from "./types";
import { withTx } from "./tx";
import { isTauri } from "@/lib/tauri";
import expectedSchema from "../../db/expected-schema.json";

const EXPECTED = expectedSchema as {
  tables: Record<
    string,
    { columns: { name: string; notnull: boolean; heal_default: string | null }[] }
  >;
};

// Parents-first insert order; delete is the reverse (children-first).
const CORE_TABLES = [
  "sources", "tags", "exchange_rates", "movements", "movement_tag",
  "movement_attachments", "recurring_items", "notifications", "settings",
  "whims", "budgets", "portfolios", "holdings", "holding_price_snapshots",
  "goals", "goal_allocations", "savings", "saving_tag",
];

/** Default tag set re-seeded after a reset (mirrors database.py DEFAULT_TAGS). */
const DEFAULT_TAGS = [
  "🛒 Groceries 🛒",
  "⛽ Fuel ⛽",
  "🚌 Transport 🚌",
  "🎉 Entertainment 🎉",
  "🛍️ Shopping 🛍️",
  "✈️ Travel ✈️",
  "📋 Subscription 📋",
  "💰 Salary 💰",
  "📈 Investment 📈",
  "🎁 Gift 🎁",
  "💼 Freelance 💼",
];

/**
 * Filesystem seam for attachment blobs so the archive can bundle/restore the
 * real files on Tauri while staying inert (and testable) in the browser preview
 * and in node tests. Files live under the ACTIVE profile's subdir —
 * $APPDATA/attachments/<profileId>/ (see repo/attachments.ts attachmentsDir) —
 * addressed by their `stored_name`; list()/remove() are therefore scoped to
 * that one profile, so a restore's orphan-prune can never touch another
 * profile's files. (Archive members keep the flat attachments/<stored_name>
 * layout for format compatibility.)
 */
export interface AttachmentFs {
  read(storedName: string): Promise<Uint8Array>;
  write(storedName: string, bytes: Uint8Array): Promise<void>;
  /** Existing on-disk file names (for orphan pruning). */
  list(): Promise<string[]>;
  remove(storedName: string): Promise<void>;
}

/** No-op fs used in the browser preview / tests (no real filesystem). */
const noopAttachmentFs: AttachmentFs = {
  async read() { throw new Error("no filesystem"); },
  async write() { /* nothing */ },
  async list() { return []; },
  async remove() { /* nothing */ },
};

/** Archive member prefix (fixed format marker, NOT the on-disk layout). */
const ATTACH_DIR = "attachments";

/** The active profile's on-disk attachment dir (also runs the legacy-flat migration). */
async function activeAttachmentsDir(): Promise<string> {
  const { attachmentsDir } = await import("./repo/attachments");
  return attachmentsDir();
}

/** Tauri-backed attachment fs (lazy-imports the fs plugin so tests stay clean). */
function tauriAttachmentFs(): AttachmentFs {
  return {
    async read(storedName) {
      const { BaseDirectory, readFile } = await import("@tauri-apps/plugin-fs");
      return readFile(`${await activeAttachmentsDir()}/${storedName}`, { baseDir: BaseDirectory.AppData });
    },
    async write(storedName, bytes) {
      const { BaseDirectory, mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
      const dir = await activeAttachmentsDir();
      await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true });
      await writeFile(`${dir}/${storedName}`, bytes, { baseDir: BaseDirectory.AppData });
    },
    async list() {
      const { BaseDirectory, exists, readDir } = await import("@tauri-apps/plugin-fs");
      const dir = await activeAttachmentsDir();
      if (!(await exists(dir, { baseDir: BaseDirectory.AppData }))) return [];
      const entries = await readDir(dir, { baseDir: BaseDirectory.AppData });
      return entries.filter((e) => e.isFile).map((e) => e.name);
    },
    async remove(storedName) {
      const { BaseDirectory, remove } = await import("@tauri-apps/plugin-fs");
      try {
        await remove(`${await activeAttachmentsDir()}/${storedName}`, { baseDir: BaseDirectory.AppData });
      } catch {
        /* already gone */
      }
    },
  };
}

/** Resolve the active attachment fs (Tauri when available, no-op otherwise). */
function resolveAttachmentFs(fs?: AttachmentFs): AttachmentFs {
  if (fs) return fs;
  return isTauri() ? tauriAttachmentFs() : noopAttachmentFs;
}

/** Strip any path components from an archive member name (basename only). */
function basename(name: string): string {
  const i = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return i >= 0 ? name.slice(i + 1) : name;
}

type Row = Record<string, unknown>;
export interface BackupData {
  _export_mode: "all";
  _plugin_tables?: Record<string, Row[]>;
  [table: string]: unknown;
}

async function tableColumns(db: SqlExecutor, table: string): Promise<Set<string>> {
  const info = await db.select<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(info.map((r) => r.name));
}

async function allTableNames(db: SqlExecutor): Promise<string[]> {
  const rows = await db.select<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  );
  return rows.map((r) => r.name);
}

export async function exportAll(db: SqlExecutor): Promise<BackupData> {
  const out: BackupData = { _export_mode: "all" };
  for (const t of CORE_TABLES) {
    out[t] = await db.select<Row>(`SELECT * FROM ${t}`);
  }
  // plugin / unknown tables (everything not core, not alembic_version)
  const known = new Set([...CORE_TABLES, "alembic_version"]);
  const extra = (await allTableNames(db)).filter((t) => !known.has(t));
  if (extra.length) {
    const plugins: Record<string, Row[]> = {};
    for (const t of extra) plugins[t] = await db.select<Row>(`SELECT * FROM ${t}`);
    out._plugin_tables = plugins;
  }
  return out;
}

function normalizeVal(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

/**
 * Backups exported by OLDER app versions can lack columns that are NOT NULL
 * without a DDL default in the current schema (the same drift migrate.ts heals
 * in live DBs via expected-schema.json's heal_default). Without filling those,
 * a legacy backup import dies wholesale on "NOT NULL constraint failed".
 * Returns [column, value] pairs to append for keys the row is missing.
 */
const HEAL_COLUMNS: Map<string, [string, unknown][]> = (() => {
  const m = new Map<string, [string, unknown][]>();
  for (const [table, def] of Object.entries(EXPECTED.tables)) {
    const cols: [string, unknown][] = [];
    for (const c of def.columns) {
      if (!c.notnull || c.heal_default == null) continue;
      // heal_default is a SQL literal: 'text' (quoted, '' escapes ') or a bare number.
      const lit = c.heal_default;
      const value = lit.startsWith("'") ? lit.slice(1, -1).replace(/''/g, "'") : Number(lit);
      cols.push([c.name, value]);
    }
    if (cols.length) m.set(table, cols);
  }
  return m;
})();

/**
 * Fill healable columns that are missing from the row OR explicitly null (a
 * null in a NOT NULL column would abort the whole import; the heal default is
 * strictly better than failing a legacy restore). Mutates the row in place and
 * returns the insertable key list.
 */
function healRowKeys(table: string, row: Row, cols: Set<string>): string[] {
  const healable = HEAL_COLUMNS.get(table);
  if (healable) {
    for (const [name, value] of healable) {
      if (cols.has(name) && (!(name in row) || row[name] == null)) row[name] = value;
    }
  }
  return Object.keys(row).filter((k) => cols.has(k));
}

async function clearAndInsert(db: SqlExecutor, table: string, rows: Row[]): Promise<void> {
  await db.execute(`DELETE FROM ${table}`);
  if (!rows.length) return;
  const cols = await tableColumns(db, table);
  for (const row of rows) {
    // Skip rows with no recognizable columns BEFORE healing, so a stray empty
    // object can't materialize a phantom all-defaults row.
    if (!Object.keys(row).some((k) => cols.has(k))) continue;
    const keys = healRowKeys(table, row, cols);
    const ph = keys.map(() => "?").join(",");
    await db.execute(
      `INSERT INTO ${table} (${keys.join(",")}) VALUES (${ph})`,
      keys.map((k) => normalizeVal(row[k])),
    );
  }
}

/**
 * Insert movements with transfer_pair_id deferred to a second pass, so the
 * self-referential transfer cycle never trips an FK error during insert — no
 * reliance on `defer_foreign_keys` (which is per-connection and unreliable on a
 * pooled backend). Both legs exist before any transfer_pair_id is set.
 */
async function insertMovementsDeferred(db: SqlExecutor, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const cols = await tableColumns(db, "movements");
  const links: { id: unknown; pair: unknown }[] = [];
  for (const row of rows) {
    if (!Object.keys(row).some((k) => cols.has(k))) continue;
    const keys = healRowKeys("movements", row, cols);
    const ph = keys.map(() => "?").join(",");
    const vals = keys.map((k) => (k === "transfer_pair_id" ? null : normalizeVal(row[k])));
    await db.execute(`INSERT INTO movements (${keys.join(",")}) VALUES (${ph})`, vals);
    if (row.transfer_pair_id != null && row.id != null) links.push({ id: row.id, pair: row.transfer_pair_id });
  }
  for (const l of links) {
    await db.execute(`UPDATE movements SET transfer_pair_id = ? WHERE id = ?`, [l.pair, l.id]);
  }
}

async function applyImport(db: SqlExecutor, data: BackupData): Promise<void> {
  for (const t of [...CORE_TABLES].reverse()) await db.execute(`DELETE FROM ${t}`); // children-first
  for (const t of CORE_TABLES) {
    const rows = (data[t] as Row[] | undefined) ?? [];
    if (t === "movements") await insertMovementsDeferred(db, rows);
    else await clearAndInsert(db, t, rows);
  }
  if (data._plugin_tables) {
    const existing = new Set(await allTableNames(db));
    for (const [t, rows] of Object.entries(data._plugin_tables)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) || !existing.has(t)) continue;
      await clearAndInsert(db, t, rows);
    }
  }
}

/**
 * All-or-nothing restore. Wraps the wipe+reload in a transaction AND keeps a
 * pre-import snapshot: if anything fails, the snapshot is reloaded so a failed
 * restore can't leave the database half-wiped (defends against backends where a
 * transaction may not roll back cleanly, e.g. a pooled connection).
 */
export async function importAll(db: SqlExecutor, data: BackupData): Promise<void> {
  const snapshot = await exportAll(db);
  try {
    // withTx serializes the whole wipe+reload onto one connection so it is truly
    // atomic and rolls back cleanly on failure (the pool would scatter it otherwise).
    await withTx(db, (tx) => applyImport(tx, data));
  } catch (e) {
    // Best-effort recovery to the pre-import state.
    try {
      await withTx(db, (tx) => applyImport(tx, snapshot));
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Reset all user data to a fresh-install state (mirrors data.py:reset_all_data).
 * Wipes every core table EXCEPT settings (user preferences survive), children
 * first, deletes attachment files from disk first, then re-seeds the default
 * tags. Plugin tables are left untouched. Atomic via withTx.
 */
export async function resetAllData(db: SqlExecutor, fs?: AttachmentFs): Promise<void> {
  const afs = resolveAttachmentFs(fs);
  // Unlink attachment files first; their rows are dropped in the wipe below.
  const att = await db.select<{ stored_name: string }>(`SELECT stored_name FROM movement_attachments`);
  for (const a of att) await afs.remove(a.stored_name);

  await withTx(db, async (tx) => {
    // children-first, skip settings (user preferences survive a reset)
    for (const t of [...CORE_TABLES].reverse()) {
      if (t === "settings") continue;
      await tx.execute(`DELETE FROM ${t}`);
    }
    // Re-seed default tags so the app looks like a fresh install.
    const ts = new Date().toISOString();
    for (const name of DEFAULT_TAGS) {
      await tx.execute(`INSERT INTO tags (name,created_at,updated_at) VALUES (?,?,?)`, [name, ts, ts]);
    }
  });
}

// ---- .yfine archive ----

export interface ArchiveManifest {
  format: "yfine-archive";
  version: number;
  created_at: string;
  plugins: { id: string; name: string; version: string }[];
}

export async function exportArchive(db: SqlExecutor, createdAt: string, fs?: AttachmentFs): Promise<Uint8Array> {
  const afs = resolveAttachmentFs(fs);
  const manifest: ArchiveManifest = { format: "yfine-archive", version: 1, created_at: createdAt, plugins: [] };
  const data = await exportAll(db);
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "data.json": strToU8(JSON.stringify(data, null, 2)),
  };
  // Bundle the attachment blobs so the archive is self-contained (invariant #8).
  const att = await db.select<{ stored_name: string }>(`SELECT stored_name FROM movement_attachments`);
  for (const a of att) {
    try {
      files[`${ATTACH_DIR}/${a.stored_name}`] = await afs.read(a.stored_name);
    } catch {
      /* missing blob / no fs — skip; the row still restores, just without its file */
    }
  }
  return zipSync(files);
}

/**
 * Restore the attachment blobs carried by a .yfine archive to disk and prune
 * on-disk files whose stored_name has no restored DB row (orphans from the
 * previous install). Mirrors data.py:494-523. The DB rows must already be
 * loaded (importAll) so we know which names are "known". Best-effort and inert
 * without a real filesystem.
 */
async function restoreAttachments(
  db: SqlExecutor,
  files: Record<string, Uint8Array>,
  afs: AttachmentFs,
): Promise<void> {
  const rows = await db.select<{ stored_name: string }>(`SELECT stored_name FROM movement_attachments`);
  const known = new Set(rows.map((r) => r.stored_name));

  // Prune orphans: on-disk files with no restored row.
  for (const name of await afs.list()) {
    if (!known.has(name)) await afs.remove(name);
  }

  // Write each archive member whose basename matches a restored row.
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith(`${ATTACH_DIR}/`) || name === `${ATTACH_DIR}/`) continue;
    const stored = basename(name);
    if (!stored || !known.has(stored)) continue; // no DB row for it — skip
    await afs.write(stored, bytes);
  }
}

export async function exportJson(db: SqlExecutor): Promise<string> {
  return JSON.stringify(await exportAll(db), null, 2);
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Import either a .yfine ZIP or a legacy JSON backup (detected by content). */
export async function importFile(db: SqlExecutor, bytes: Uint8Array, fs?: AttachmentFs): Promise<void> {
  if (isZip(bytes)) {
    const files = unzipSync(bytes);
    const manifestRaw = files["manifest.json"];
    if (!manifestRaw) throw new Error("not a yfine archive (no manifest.json)");
    const manifest = JSON.parse(strFromU8(manifestRaw)) as Partial<ArchiveManifest>;
    if (manifest.format !== "yfine-archive") throw new Error("not a yfine archive (bad format marker)");
    const dataRaw = files["data.json"];
    if (!dataRaw) throw new Error("archive missing data.json");
    await importAll(db, JSON.parse(strFromU8(dataRaw)) as BackupData);
    // After the DB is loaded, restore the bundled blobs and prune orphans.
    await restoreAttachments(db, files, resolveAttachmentFs(fs));
    return;
  }
  // legacy JSON
  const data = JSON.parse(strFromU8(bytes)) as BackupData;
  await importAll(db, data);
}

export interface BackupPreview {
  /** "yfine-archive" ZIP or legacy "json". */
  format: "yfine-archive" | "json";
  created_at?: string;
  /** Record count per core table, in canonical order. */
  coreTables: { table: string; count: number }[];
  /** Record count per plugin table (if any). */
  pluginTables: { table: string; count: number }[];
  /** Number of bundled attachment blobs (Tauri archives). */
  attachmentCount: number;
}

/**
 * Parse a .yfine ZIP or JSON backup WITHOUT mutating anything and report what an
 * import would load (record counts per table + bundled attachment count), so the
 * UI can confirm before the destructive replace. Mirrors data.py:preview_archive
 * / preview_json (minus the plugin install/scan analysis, which yfine2 lacks).
 */
export function previewBackup(bytes: Uint8Array): BackupPreview {
  let data: BackupData;
  let format: BackupPreview["format"];
  let createdAt: string | undefined;
  let attachmentCount = 0;

  if (isZip(bytes)) {
    const files = unzipSync(bytes);
    const manifestRaw = files["manifest.json"];
    if (!manifestRaw) throw new Error("not a yfine archive (no manifest.json)");
    const manifest = JSON.parse(strFromU8(manifestRaw)) as Partial<ArchiveManifest>;
    if (manifest.format !== "yfine-archive") throw new Error("not a yfine archive (bad format marker)");
    const dataRaw = files["data.json"];
    if (!dataRaw) throw new Error("archive missing data.json");
    data = JSON.parse(strFromU8(dataRaw)) as BackupData;
    format = "yfine-archive";
    createdAt = manifest.created_at;
    attachmentCount = Object.keys(files).filter(
      (n) => n.startsWith(`${ATTACH_DIR}/`) && n !== `${ATTACH_DIR}/`,
    ).length;
  } else {
    data = JSON.parse(strFromU8(bytes)) as BackupData;
    format = "json";
  }

  const coreTables = CORE_TABLES.map((t) => ({ table: t, count: ((data[t] as unknown[] | undefined) ?? []).length }));
  const pluginTables = Object.entries(data._plugin_tables ?? {}).map(([t, rows]) => ({ table: t, count: rows.length }));
  return { format, created_at: createdAt, coreTables, pluginTables, attachmentCount };
}

/** Plain-CSV export of movements (lowest-common-denominator, a gap the old app lacked). */
export async function exportMovementsCsv(db: SqlExecutor): Promise<string> {
  const rows = await db.select<{ date: string; amount: number; direction: string; note: string | null; source_name: string | null; currency: string | null }>(
    `SELECT m.date, m.amount, m.direction, m.note, s.name AS source_name, s.currency
     FROM movements m LEFT JOIN sources s ON m.source_id = s.id
     WHERE m.transfer_pair_id IS NULL ORDER BY m.date DESC, m.id DESC`,
  );
  const esc = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // CSV formula-injection guard: a leading =,+,-,@ (or a tab/CR before one) turns
    // a note like "=HYPERLINK(...)" into a live formula when opened in a spreadsheet.
    // Neutralize by prefixing a single quote so the cell renders as plain text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = "date,amount,direction,note,account,currency";
  const lines = rows.map((r) => [r.date, r.amount, r.direction, r.note, r.source_name, r.currency].map(esc).join(","));
  return [header, ...lines].join("\n");
}
