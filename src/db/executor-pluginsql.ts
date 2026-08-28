/** Native SQLite executor backed by @tauri-apps/plugin-sql (the real app DB). */
import Database from "@tauri-apps/plugin-sql";
import type { SqlExecutor } from "./types";
import { normalizeRows } from "./normalize";

/**
 * Rotate the pool comfortably before sqlx's default 30-min `max_lifetime`
 * closes the working connection. The close happens at the first statement
 * release past the boundary — if that falls inside a BEGIN…COMMIT, the first
 * half of the transaction is rolled back and the rest autocommits (torn
 * write). withTx calls rotateIfStale() before every BEGIN, so entering a
 * transaction the connection is at most ~20 min old and would need a >10-min
 * transaction to be at risk.
 */
const ROTATE_AFTER_MS = 20 * 60 * 1000;

export async function createPluginSqlExecutor(
  path = "sqlite:yfine.db",
): Promise<{ exec: SqlExecutor; db: Database }> {
  let db = await Database.load(path);
  let poolBornAt = Date.now();
  const exec: SqlExecutor = {
    async execute(sql, params = []) {
      await db.execute(sql, params as unknown[]);
    },
    async select(sql, params = []) {
      // plugin-sql decodes by DECLARED column type (BOOLEAN → true/false,
      // DATETIME → re-stringified); restore the raw 0/1 + ISO contract the
      // rest of the app (and the test executors) rely on. See normalize.ts.
      const rows = (await db.select(sql, params as unknown[])) as Record<string, unknown>[];
      return normalizeRows(rows) as never;
    },
    async rotateIfStale() {
      if (Date.now() - poolBornAt < ROTATE_AFTER_MS) return;
      try {
        await db.close();
      } catch {
        /* a closed/unreachable pool is exactly what rotation wants */
      }
      db = await Database.load(path);
      poolBornAt = Date.now();
    },
  };
  return { exec, db };
}
