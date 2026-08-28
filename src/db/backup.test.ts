import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "./repo/sources";
import { createMovement, createTransfer } from "./repo/movements";
import { addAttachment, type FileWriter } from "./repo/attachments";
import { getSettings } from "./repo/settings";
import {
  exportAll, importAll, exportArchive, exportJson, importFile,
  resetAllData, previewBackup, type AttachmentFs,
} from "./backup";
import type { SqlExecutor } from "./types";

/** In-memory attachment fs so the blob bundle/restore/prune path is testable. */
function memFs(initial: Record<string, Uint8Array> = {}): AttachmentFs & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>(Object.entries(initial));
  return {
    store,
    async read(name) {
      const b = store.get(name);
      if (!b) throw new Error(`missing ${name}`);
      return b;
    },
    async write(name, bytes) { store.set(name, bytes); },
    async list() { return [...store.keys()]; },
    async remove(name) { store.delete(name); },
  };
}

async function seed(db: SqlExecutor) {
  const a = await createSource(db, { name: "Checking", currency: "EUR", starting_balance: 1000 });
  const b = await createSource(db, { name: "Savings", currency: "EUR", starting_balance: 0 });
  await db.execute(`INSERT INTO tags (name,color,created_at,updated_at) VALUES ('Food','#fff','t','t')`);
  await createMovement(db, { source_id: a.id, amount: 42, direction: "out", date: "2026-05-01", note: "x", tagIds: [1] });
  await createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 100, date: "2026-05-02" }); // self-cyclic FK
  return { a, b };
}
const count = async (db: SqlExecutor, t: string) =>
  (await db.select<{ c: number }>(`SELECT COUNT(*) c FROM ${t}`))[0].c;

describe("backup round-trip", () => {
  it("exports all core tables and re-imports into a fresh DB (transfers included)", async () => {
    const src = await makeMemDb();
    await seed(src.db);
    const data = await exportAll(src.db);

    const dst = await makeMemDb();
    await importAll(dst.db, data);

    expect(await count(dst.db, "sources")).toBe(2); // Checking + Savings
    expect(await count(dst.db, "movements")).toBe(3); // 1 plain + 2 transfer legs
    expect(await count(dst.db, "movement_tag")).toBe(1);
    // transfer pair links survive (defer_foreign_keys made the cyclic insert possible)
    const paired = await dst.db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements WHERE transfer_pair_id IS NOT NULL`);
    expect(paired[0].c).toBe(2);
  });

  it("imports a LEGACY backup whose rows lack newer NOT NULL columns (heal_default fill)", async () => {
    // An older app's export: settings without the newer JSON blobs, movements
    // without is_savings_contribution — all NOT NULL without a DDL default.
    // Pre-fix this failed wholesale with "NOT NULL constraint failed".
    const legacy = {
      _export_mode: "all" as const,
      sources: [{ id: 1, name: "Old", currency: "EUR", starting_balance: 10, exclude_from_stats: 0, is_savings_fund: 0, hidden_from_sources: 0, yield_rate: 0, yield_period_months: 12, created_at: "2020-01-01 00:00:00", updated_at: "2020-01-01 00:00:00" }],
      movements: [{ id: 1, source_id: 1, amount: 5, direction: "out", date: "2020-06-01", exclude_from_stats: 0, created_at: "2020-06-01 00:00:00", updated_at: "2020-06-01 00:00:00" }],
      settings: [{ id: 1, locale: "en", date_format: "DD/MM/YYYY", theme: "dark", hide_net_worth: 0, hotkeys_enabled: 1, created_at: "2020-01-01 00:00:00", updated_at: "2020-01-01 00:00:00" }],
    };
    const dst = await makeMemDb();
    await importAll(dst.db, legacy as never);
    expect(await count(dst.db, "sources")).toBe(1);
    expect(await count(dst.db, "movements")).toBe(1);
    // healed to the curated defaults instead of failing
    const m = await dst.db.select<{ is_savings_contribution: number }>(`SELECT is_savings_contribution FROM movements`);
    expect(m[0].is_savings_contribution).toBe(0);
    const st = await dst.db.select<{ hotkeys_json: string; ui_scale: string }>(`SELECT hotkeys_json, ui_scale FROM settings`);
    expect(typeof st[0].hotkeys_json).toBe("string");
    expect(typeof st[0].ui_scale).toBe("string");
  });

  it(".yfine archive round-trips through importFile", async () => {
    const src = await makeMemDb();
    await seed(src.db);
    const zip = await exportArchive(src.db, "2026-05-29T00:00:00Z");
    expect(zip[0]).toBe(0x50); // 'P' — it's a real ZIP

    const dst = await makeMemDb();
    await importFile(dst.db, zip);
    expect(await count(dst.db, "movements")).toBe(3);
    expect(await count(dst.db, "sources")).toBe(2);
  });

  it("legacy JSON backup imports via importFile", async () => {
    const src = await makeMemDb();
    await seed(src.db);
    const json = await exportJson(src.db);
    const dst = await makeMemDb();
    await importFile(dst.db, new TextEncoder().encode(json));
    expect(await count(dst.db, "movements")).toBe(3);
  });

  it("rejects a zip without the yfine format marker", async () => {
    const dst = await makeMemDb();
    // a zip-looking byte sequence that isn't a real archive
    const fake = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(importFile(dst.db, fake)).rejects.toBeTruthy();
  });

  it("preserves unknown/plugin tables when present in both DBs", async () => {
    const src = await makeMemDb();
    await seed(src.db);
    await src.db.execute(`CREATE TABLE seller_items (id INTEGER PRIMARY KEY, name TEXT)`);
    await src.db.execute(`INSERT INTO seller_items (name) VALUES ('widget')`);
    const data = await exportAll(src.db);
    expect((data._plugin_tables as Record<string, unknown[]>).seller_items.length).toBe(1);

    const dst = await makeMemDb();
    await dst.db.execute(`CREATE TABLE seller_items (id INTEGER PRIMARY KEY, name TEXT)`);
    await importAll(dst.db, data);
    expect(await count(dst.db, "seller_items")).toBe(1);
  });
});

/** Add one attachment row with a known stored_name + bytes via the writer seam. */
async function seedAttachment(db: SqlExecutor, fs: ReturnType<typeof memFs>, movementId: number, label: string) {
  const writer: FileWriter = async (stored, bytes) => { await fs.write(stored, bytes); };
  await addAttachment(db, movementId, { name: `${label}.png`, type: "image/png", bytes: new TextEncoder().encode(label) }, writer);
}

describe("backup — attachment bundling / restore / prune", () => {
  it("bundles attachment blobs into the .yfine archive and restores them on import", async () => {
    const src = await makeMemDb();
    const a = await createSource(src.db, { name: "A", currency: "EUR" });
    const mid = await createMovement(src.db, { source_id: a.id, amount: 1, direction: "out", date: "2026-05-01" });
    const srcFs = memFs();
    await seedAttachment(src.db, srcFs, mid, "receipt");
    const stored = (await src.db.select<{ stored_name: string }>(`SELECT stored_name FROM movement_attachments`))[0].stored_name;

    const zip = await exportArchive(src.db, "2026-05-29T00:00:00Z", srcFs);

    // The archive carries the blob under attachments/<stored_name>.
    const preview = previewBackup(zip);
    expect(preview.attachmentCount).toBe(1);

    const dst = await makeMemDb();
    const dstFs = memFs();
    await importFile(dst.db, zip, dstFs);
    // DB row restored…
    expect(await count(dst.db, "movement_attachments")).toBe(1);
    // …and the blob landed on the destination fs under its stored_name.
    expect(new TextDecoder().decode(dstFs.store.get(stored))).toBe("receipt");
  });

  it("prunes on-disk files whose stored_name has no restored row", async () => {
    const src = await makeMemDb();
    const a = await createSource(src.db, { name: "A", currency: "EUR" });
    const mid = await createMovement(src.db, { source_id: a.id, amount: 1, direction: "out", date: "2026-05-01" });
    const srcFs = memFs();
    await seedAttachment(src.db, srcFs, mid, "kept");
    const zip = await exportArchive(src.db, "2026-05-29T00:00:00Z", srcFs);

    // Destination starts with a dangling orphan from the previous install.
    const dst = await makeMemDb();
    const dstFs = memFs({ "orphan_old.png": new Uint8Array([1, 2, 3]) });
    await importFile(dst.db, zip, dstFs);

    expect(dstFs.store.has("orphan_old.png")).toBe(false); // pruned
    expect(dstFs.store.size).toBe(1); // only the restored blob remains
  });

  it("skips file IO gracefully with the no-op (browser) fs", async () => {
    const src = await makeMemDb();
    await seed(src.db); // no attachments, no fs passed → default no-op in node
    const zip = await exportArchive(src.db, "2026-05-29T00:00:00Z");
    const dst = await makeMemDb();
    await expect(importFile(dst.db, zip)).resolves.toBeUndefined();
  });
});

describe("resetAllData", () => {
  it("wipes all data, preserves settings, and re-seeds the default tags", async () => {
    const { db } = await makeMemDb();
    await seed(db); // sources + 1 tag + movements + transfer
    await getSettings(db); // ensures the singleton settings row exists

    const fs = memFs();
    const a = (await db.select<{ id: number }>(`SELECT id FROM movements LIMIT 1`))[0].id;
    await seedAttachment(db, fs, a, "blob");
    expect(fs.store.size).toBe(1);

    await resetAllData(db, fs);

    expect(await count(db, "sources")).toBe(0);
    expect(await count(db, "movements")).toBe(0);
    expect(await count(db, "movement_attachments")).toBe(0);
    // settings (user preferences) survive a reset
    expect(await count(db, "settings")).toBe(1);
    // default tags re-seeded (11 in DEFAULT_TAGS) — old 'Food' tag is gone
    expect(await count(db, "tags")).toBe(11);
    const named = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM tags WHERE name = 'Food'`);
    expect(named[0].c).toBe(0);
    // attachment files unlinked from disk first
    expect(fs.store.size).toBe(0);
  });
});

describe("previewBackup (no mutation)", () => {
  it("reports per-table record counts for a .yfine archive", async () => {
    const src = await makeMemDb();
    await seed(src.db); // 2 sources, 1 tag, 3 movements (1 plain + 2 transfer), 1 movement_tag
    const zip = await exportArchive(src.db, "2026-05-29T00:00:00Z");
    const preview = previewBackup(zip);

    expect(preview.format).toBe("yfine-archive");
    expect(preview.created_at).toBe("2026-05-29T00:00:00Z");
    const byTable = Object.fromEntries(preview.coreTables.map((c) => [c.table, c.count]));
    expect(byTable.sources).toBe(2);
    expect(byTable.movements).toBe(3);
    expect(byTable.tags).toBe(1);
    expect(byTable.movement_tag).toBe(1);
  });

  it("reports counts for a legacy JSON backup", async () => {
    const src = await makeMemDb();
    await seed(src.db);
    const json = await exportJson(src.db);
    const preview = previewBackup(new TextEncoder().encode(json));
    expect(preview.format).toBe("json");
    expect(Object.fromEntries(preview.coreTables.map((c) => [c.table, c.count])).movements).toBe(3);
  });
});

describe("backup — legacy drift heal on import", () => {
  it("fills NOT NULL no-default columns missing from an older app's backup", async () => {
    const src = await makeMemDb();
    await seed(src.db);
    await getSettings(src.db); // materialize the settings row so it's exported
    const data = await exportAll(src.db);

    // Simulate a backup exported by an OLDER legacy app: rows lack columns that
    // are NOT NULL without a DDL default in the current schema (the exact drift
    // migrate.ts heals in live DBs).
    const rows = data.movements as Record<string, unknown>[];
    for (const r of rows) delete r.is_savings_contribution;
    const settingsRows = data.settings as Record<string, unknown>[];
    for (const r of settingsRows) {
      delete r.bottom_nav_json;
      delete r.ui_scale;
    }

    const dst = await makeMemDb();
    await importAll(dst.db, data); // must not throw NOT NULL constraint failed

    const movs = await dst.db.select<{ c: number }>(
      `SELECT COUNT(*) c FROM movements WHERE is_savings_contribution = 0`,
    );
    const total = await dst.db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements`);
    expect(total[0].c).toBeGreaterThan(0);
    expect(movs[0].c).toBe(total[0].c); // healed to the default 0
    const st = await dst.db.select<{ ui_scale: string }>(`SELECT ui_scale FROM settings LIMIT 1`);
    expect(typeof st[0].ui_scale).toBe("string"); // healed, not NULL
  });
});
