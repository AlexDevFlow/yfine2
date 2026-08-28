/**
 * Minimal async SQL executor abstraction so the same migration / query code runs
 * against both `@tauri-apps/plugin-sql` (in the app) and `better-sqlite3` (in
 * tests) without leaking either driver into the domain layer.
 */
export interface SqlExecutor {
  /** Run a statement that returns no rows (DDL, INSERT/UPDATE/DELETE, PRAGMA set). */
  execute(sql: string, params?: unknown[]): Promise<void>;
  /** Run a query and return all rows. */
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Recreate the backend's connection pool if it's old enough that sqlx's
   * default 30-min `max_lifetime` could recycle the working connection soon
   * (which, mid-transaction, tears the transaction — see tx.ts). Called by
   * withTx at a safe point (mutex held, no open transaction). Optional: the
   * single-connection preview/test executors don't need it.
   */
  rotateIfStale?(): Promise<void>;
}
