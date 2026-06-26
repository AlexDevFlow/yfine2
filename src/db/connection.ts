/**
 * Single shared database connection. In the packaged app this is native SQLite
 * (plugin-sql) opening the real yfine.db; in a browser dev preview it's an
 * in-memory sql.js DB seeded with sample data. Either way the schema is brought
 * up to date by the drift-tolerant migrate() before first use.
 */
import type { SqlExecutor } from "./types";
import { migrate } from "./migrate";
import { serializeExecutor } from "./tx";
import { runScheduler } from "./repo/scheduler";
import { getSettings } from "./repo/settings";
import { isTauri } from "@/lib/tauri";
import { todayISO } from "@/lib/date";
import i18n from "@/i18n";

let dbPromise: Promise<SqlExecutor> | null = null;

export function getDb(): Promise<SqlExecutor> {
  if (!dbPromise) {
    // Don't cache a rejected init: a transient boot failure (DB lock, migrate
    // hiccup) would otherwise wedge every later getDb() with the same rejection.
    dbPromise = init().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/** True when running on the in-memory preview DB (no persistence). */
export const isPreviewDb = !isTauri();

async function init(): Promise<SqlExecutor> {
  let exec: SqlExecutor;
  if (isTauri()) {
    const { createPluginSqlExecutor } = await import("./executor-pluginsql");
    // plugin-sql runs every statement against a 10-connection SQLx pool. Serialize
    // all access so the pool only ever uses ONE connection — otherwise BEGIN/COMMIT
    // scatter across connections (no atomicity) and parked write locks cause 5s
    // "database is locked" stalls. See serializeExecutor / withTx in tx.ts.
    exec = serializeExecutor((await createPluginSqlExecutor()).exec);
    // Use a rollback journal (not WAL): committed data always lives in yfine.db
    // itself, so the Rust encrypt-on-close reads a complete database (no lost
    // transactions stranded in an uncheckpointed -wal). Also makes BEGIN/COMMIT
    // give real atomicity on the single working connection.
    await exec.execute("PRAGMA journal_mode=DELETE");
    await migrate(exec);
  } else {
    const { createSqlJsExecutor } = await import("./executor-sqljs");
    const { seedPreview } = await import("./seed");
    exec = (await createSqlJsExecutor()).exec;
    await migrate(exec);
    await seedPreview(exec);
  }
  // The persisted DB locale is the source of truth: prime the translator with it
  // on boot so a fresh profile / a DB moved to another machine restores the chosen
  // language (the i18next localStorage detector would otherwise win). Mirrors the
  // legacy main.py _load_settings_into_i18n startup priming.
  try {
    const { locale } = await getSettings(exec);
    if (locale && i18n.resolvedLanguage !== locale) await i18n.changeLanguage(locale);
  } catch {
    /* never block app boot on locale reconciliation */
  }
  // Startup reconciliation: apply due recurring items + accrue yields (idempotent).
  try {
    await runScheduler(exec, todayISO());
  } catch {
    /* never block app boot on the scheduler */
  }
  return exec;
}
