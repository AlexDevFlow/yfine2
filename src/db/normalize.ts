/**
 * Undo tauri-plugin-sql's decltype-based decode mangling.
 *
 * The plugin decodes each SELECT column by its *declared* type (sqlx attaches
 * `sqlite3_column_decltype` to every row value — see sqlx-sqlite row.rs), so
 * against the real app DB:
 *
 *   - BOOLEAN columns arrive as JSON true/false instead of the stored 0/1.
 *     Every strict `=== 0/1` check in the app silently fails (e.g. the
 *     movements page filtered `is_savings_fund === 0` to an empty list, which
 *     kept the Transfer button permanently disabled).
 *   - DATETIME columns are parsed into a `time::PrimitiveDateTime` and
 *     re-stringified by its Display impl: "2026-08-01 9:05:07.12" — space
 *     separator, UNPADDED hour, trailing-zero-trimmed subseconds, no "Z" —
 *     instead of the stored `new Date().toISOString()`. That breaks
 *     `new Date(created_at)` (parsed as local time), `localeCompare` sorts,
 *     and backup round-trips.
 *
 * The sql.js preview and better-sqlite3 test executors return raw storage
 * values (0/1 ints, ISO strings), which is why tests never see this. This
 * module restores raw shape at the executor boundary so the whole app keeps a
 * single value contract (schema-types.ts: booleans as 0|1, datetimes as ISO).
 *
 * DATE columns round-trip unchanged ("YYYY-MM-DD" in, same out) and SQL
 * expressions/aliases have no decltype (raw storage passthrough), so neither
 * needs handling.
 */

/**
 * Space separator + mandatory subseconds is exactly the `time` crate's
 * PrimitiveDateTime Display shape and (unlike bare "YYYY-MM-DD HH:MM:SS")
 * can't realistically collide with user-typed text, so it's safe to apply by
 * value to any string column.
 */
const MANGLED_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2})\.(\d+)$/;

export function normalizeValue(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const m = MANGLED_DATETIME.exec(v);
    if (m) {
      // Millisecond precision, zero-padded: ".7" → ".700", ".789012" → ".789".
      const ms = (m[5] + "00").slice(0, 3);
      return `${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:${m[4]}.${ms}Z`;
    }
  }
  return v;
}

/** Normalize plugin-sql rows in place (they're fresh from IPC deserialization). */
export function normalizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  for (const row of rows) {
    for (const k in row) {
      const v = row[k];
      if (typeof v === "boolean" || typeof v === "string") {
        (row as Record<string, unknown>)[k] = normalizeValue(v);
      }
    }
  }
  return rows;
}
