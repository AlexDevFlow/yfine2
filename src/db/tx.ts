/**
 * Serialized DB access + atomic transactions.
 *
 * tauri-plugin-sql runs every execute()/select() against a SQLx *connection
 * pool* (default max_connections=10), acquiring a fresh connection per call.
 * That silently breaks BEGIN/COMMIT: the statements scatter across different
 * connections, so a transaction isn't atomic, a half-finished operation can't
 * be rolled back, and a connection parked mid-transaction holds a write lock
 * that makes every other connection stall on the 5s busy timeout before
 * failing with "database is locked".
 *
 * Fix: funnel every statement through one in-process mutex. With no concurrent
 * acquires the pool only ever materialises a SINGLE connection, so BEGIN…COMMIT
 * land together and there is no cross-connection lock contention. withTx() holds
 * the mutex for the whole transaction and hands the body a transaction-scoped
 * executor whose statements run directly on that one connection (bypassing the
 * mutex it already holds); concurrent queries queue behind the transaction.
 */
import type { SqlExecutor } from "./types";

/** Promise-chain mutex: each run() waits for the previous task to settle. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    // .then(fn, fn) runs the next task whether the previous settled ok or threw,
    // so one failed task never wedges the queue.
    const next = this.tail.then(fn, fn);
    this.tail = next.then(noop, noop);
    return next;
  }
}
const noop = (): void => {};

interface TxState {
  mutex: Mutex;
  raw: SqlExecutor;
}
const STATE = new WeakMap<SqlExecutor, TxState>();
/** Executors handed to a withTx() body — already inside the held transaction. */
const TX_SCOPED = new WeakSet<SqlExecutor>();

/**
 * Wrap a raw executor so every statement is serialized through one mutex,
 * pinning the plugin-sql pool to a single connection. Pass the returned executor
 * to migrate(), the repos, and withTx() — not the raw one.
 */
export function serializeExecutor(raw: SqlExecutor): SqlExecutor {
  const mutex = new Mutex();
  const wrapped: SqlExecutor = {
    execute: (sql, params) => mutex.run(() => raw.execute(sql, params)),
    select: (sql, params) => mutex.run(() => raw.select(sql, params)),
  };
  STATE.set(wrapped, { mutex, raw });
  return wrapped;
}

// Fallback path for non-serialized, single-connection backends (the sql.js
// browser preview and the better-sqlite3 test executor): a depth-guarded
// BEGIN/COMMIT is already atomic there, so no mutex is needed.
const depth = new WeakMap<SqlExecutor, number>();

/**
 * Run `fn` inside a single atomic transaction. `fn` receives the executor it
 * must use for its statements (transaction-scoped on the serialized backend).
 * Nested calls join the outer transaction instead of issuing an illegal nested
 * BEGIN.
 */
export async function withTx<T>(
  db: SqlExecutor,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  // Already inside a held transaction — reuse its connection, don't re-BEGIN.
  if (TX_SCOPED.has(db)) return fn(db);

  const st = STATE.get(db);
  if (st) {
    // Serialized backend: hold the mutex for the whole transaction so no other
    // statement touches the (single) connection until COMMIT/ROLLBACK.
    return st.mutex.run(async () => {
      const tx: SqlExecutor = {
        execute: (sql, params) => st.raw.execute(sql, params),
        select: (sql, params) => st.raw.select(sql, params),
      };
      TX_SCOPED.add(tx);
      await st.raw.execute("BEGIN");
      try {
        const result = await fn(tx);
        await st.raw.execute("COMMIT");
        return result;
      } catch (e) {
        try {
          await st.raw.execute("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw e;
      }
    });
  }

  // Non-serialized single-connection backend: depth-guarded BEGIN/COMMIT.
  if ((depth.get(db) ?? 0) > 0) return fn(db);
  depth.set(db, 1);
  await db.execute("BEGIN");
  try {
    const result = await fn(db);
    await db.execute("COMMIT");
    return result;
  } catch (e) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      /* ignore rollback errors */
    }
    throw e;
  } finally {
    depth.set(db, 0);
  }
}
