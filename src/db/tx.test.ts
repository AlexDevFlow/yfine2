/**
 * Verifies the serialized-executor + transaction behaviour that pins the
 * plugin-sql pool to a single connection. Uses a fake async executor that would
 * expose concurrency (and thus multiple pool connections) if serialization broke.
 */
import { describe, it, expect } from "vitest";
import type { SqlExecutor } from "./types";
import { serializeExecutor, withTx } from "./tx";

/** Fake raw executor with a real async gap, recording call order + max overlap. */
function makeFake() {
  const log: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const run = async (sql: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick();
    log.push(sql);
    inFlight--;
  };
  const raw: SqlExecutor = {
    async execute(sql) {
      await run(sql);
    },
    async select(sql) {
      await run(sql);
      return [] as never;
    },
  };
  return {
    raw,
    log,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

describe("serializeExecutor", () => {
  it("never runs two statements concurrently (one pool connection)", async () => {
    const fake = makeFake();
    const db = serializeExecutor(fake.raw);
    await Promise.all([
      db.select("A"),
      db.select("B"),
      db.execute("C"),
      db.select("D"),
    ]);
    expect(fake.maxInFlight).toBe(1);
    expect(fake.log).toEqual(["A", "B", "C", "D"]); // FIFO order preserved
  });

  it("keeps serializing after a statement throws", async () => {
    const log: string[] = [];
    const raw: SqlExecutor = {
      async execute(sql) {
        if (sql === "BOOM") throw new Error("boom");
        log.push(sql);
      },
      async select() {
        return [] as never;
      },
    };
    const db = serializeExecutor(raw);
    await expect(db.execute("BOOM")).rejects.toThrow("boom");
    await db.execute("AFTER");
    expect(log).toEqual(["AFTER"]);
  });
});

describe("withTx (serialized backend)", () => {
  it("wraps the body in a single BEGIN/COMMIT", async () => {
    const fake = makeFake();
    const db = serializeExecutor(fake.raw);
    await withTx(db, async (tx) => {
      await tx.execute("INSERT A");
      await tx.execute("INSERT B");
    });
    expect(fake.log).toEqual(["BEGIN", "INSERT A", "INSERT B", "COMMIT"]);
  });

  it("blocks concurrent statements until the transaction commits", async () => {
    const fake = makeFake();
    const db = serializeExecutor(fake.raw);
    const tx = withTx(db, async (t) => {
      await t.execute("INSERT A");
      await t.execute("INSERT B");
    });
    const outside = db.select("SELECT outside"); // fired mid-transaction
    await Promise.all([tx, outside]);
    // The outside read must run AFTER the whole transaction, never interleaved.
    expect(fake.log).toEqual(["BEGIN", "INSERT A", "INSERT B", "COMMIT", "SELECT outside"]);
    expect(fake.maxInFlight).toBe(1);
  });

  it("rolls back and rethrows when the body throws", async () => {
    const fake = makeFake();
    const db = serializeExecutor(fake.raw);
    await expect(
      withTx(db, async (tx) => {
        await tx.execute("INSERT X");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fake.log).toEqual(["BEGIN", "INSERT X", "ROLLBACK"]);
  });

  it("joins a nested transaction instead of re-issuing BEGIN", async () => {
    const fake = makeFake();
    const db = serializeExecutor(fake.raw);
    await withTx(db, async (tx) => {
      await tx.execute("OUTER");
      await withTx(tx, async (inner) => {
        await inner.execute("INNER");
      });
    });
    expect(fake.log).toEqual(["BEGIN", "OUTER", "INNER", "COMMIT"]);
  });
});
