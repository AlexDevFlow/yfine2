import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "./sources";
import { createMovement } from "./movements";
import { createSaving } from "./savings";
import { searchAll } from "./search";

describe("global search", () => {
  it("matches names, notes, and exact amounts across types", async () => {
    const { db } = await makeMemDb();
    const checking = await createSource(db, { name: "Checking account", currency: "EUR" });
    await createSource(db, { name: "Savings stash", currency: "EUR" });
    await db.execute(`INSERT INTO tags (name,created_at,updated_at) VALUES ('Groceries','t','t')`);
    await db.execute(`INSERT INTO goals (name,target_amount,currency,source_id,status,created_at,updated_at) VALUES ('New car',5000,'EUR',?, 'active','t','t')`, [checking.id]);
    await createMovement(db, { source_id: checking.id, amount: 42.5, direction: "out", date: "2026-05-01", note: "Weekly groceries" });

    const byName = await searchAll(db, "account");
    expect(byName.some((r) => r.type === "source" && r.label === "Checking account")).toBe(true);

    const byNote = await searchAll(db, "groceries");
    expect(byNote.some((r) => r.type === "movement")).toBe(true);
    expect(byNote.some((r) => r.type === "tag" && r.label === "Groceries")).toBe(true);

    const byAmount = await searchAll(db, "42.5");
    expect(byAmount.some((r) => r.type === "movement")).toBe(true);

    const goal = await searchAll(db, "car");
    expect(goal.some((r) => r.type === "goal" && r.label === "New car")).toBe(true);
  });

  it("finds budgets by tag name and portfolios by name", async () => {
    const { db } = await makeMemDb();
    const acct = await createSource(db, { name: "Main", currency: "EUR" });
    await db.execute(`INSERT INTO tags (id,name,created_at,updated_at) VALUES (1,'Groceries','t','t')`);
    await db.execute(
      `INSERT INTO budgets (tag_id,amount,currency,period,direction,rollover,alert_threshold_pct,active,start_date,last_alert_level,created_at,updated_at)
       VALUES (1,300,'EUR','monthly','out',0,80,1,'2026-05-01',0,'t','t')`,
    );
    await db.execute(
      `INSERT INTO portfolios (name,kind,base_currency,source_id,created_at,updated_at) VALUES ('Crypto stack','crypto','EUR',?, 't','t')`,
      [acct.id],
    );

    const budget = await searchAll(db, "groceries");
    expect(budget.some((r) => r.type === "budget" && r.label === "Groceries" && r.period === "monthly")).toBe(true);

    const pf = await searchAll(db, "crypto stack");
    expect(pf.some((r) => r.type === "portfolio" && r.label === "Crypto stack" && r.kind === "crypto")).toBe(true);
  });

  it("ignores queries shorter than 2 chars and escapes wildcards", async () => {
    const { db } = await makeMemDb();
    await createSource(db, { name: "100%_real", currency: "EUR" });
    await createSource(db, { name: "other", currency: "EUR" });
    expect(await searchAll(db, "a")).toEqual([]);
    const res = await searchAll(db, "100%_real");
    expect(res.filter((r) => r.type === "source").length).toBe(1); // % and _ treated literally
  });

  it("finds savings from both contribution movements and legacy rows (gap 6)", async () => {
    const { db } = await makeMemDb();
    const checking = await createSource(db, { name: "Checking", currency: "EUR" });
    // New-style: savings contribution movement (note matched).
    await createSaving(db, { fromSourceId: checking.id, amount: 200, date: "2026-05-01", note: "Vacation fund" });
    // Legacy savings row.
    await db.execute(
      `INSERT INTO savings (amount,currency,date,description,note,created_at,updated_at)
       VALUES (150,'EUR','2026-04-01','Vacation legacy',NULL,'t','t')`,
    );

    const res = await searchAll(db, "vacation");
    const savings = res.filter((r) => r.type === "saving");
    expect(savings.length).toBe(2);
    expect(savings.some((s) => s.label === "Vacation fund" && s.currency === "EUR")).toBe(true);
    expect(savings.some((s) => s.label === "Vacation legacy")).toBe(true);
  });

  it("enriches movements with tags + transfer flag and tags with usage count (gap 3)", async () => {
    const { db } = await makeMemDb();
    const src = await createSource(db, { name: "Wallet", currency: "EUR" });
    await db.execute(`INSERT INTO tags (id,name,color,created_at,updated_at) VALUES (1,'Food','#f00','t','t')`);
    const id = await createMovement(db, { source_id: src.id, amount: 12, direction: "out", date: "2026-05-01", note: "Lunch out", tagIds: [1] });

    const res = await searchAll(db, "Lunch");
    const mov = res.find((r) => r.type === "movement" && r.id === id)!;
    expect(mov.source).toBe("Wallet");
    expect(mov.is_transfer).toBe(false);
    expect(mov.tags?.map((tg) => tg.name)).toEqual(["Food"]);

    const tagRes = await searchAll(db, "Food");
    const tag = tagRes.find((r) => r.type === "tag")!;
    expect(tag.count).toBe(1);
  });
});
