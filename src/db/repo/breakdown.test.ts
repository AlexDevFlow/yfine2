import { describe, it, expect } from "vitest";
import { addMovement, makeMemDb } from "@/test/sqlite";
import { createSource } from "./sources";
import { createMovement, createTransfer } from "./movements";
import { createTag } from "./tags";
import { previousRange, spendingBreakdown, totalByCurrency } from "./breakdown";

describe("spending breakdown", () => {
  it("splits a multi-tag movement evenly but keeps the gross figure", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const food = await createTag(db, { name: "Food" });
    const fun = await createTag(db, { name: "Fun" });
    await createMovement(db, { source_id: a.id, amount: 100, direction: "out", date: "2026-05-04", tagIds: [food, fun] });
    await createMovement(db, { source_id: a.id, amount: 60, direction: "out", date: "2026-05-05", tagIds: [food] });
    await createMovement(db, { source_id: a.id, amount: 40, direction: "out", date: "2026-05-06" });

    const b = await spendingBreakdown(db, { direction: "out" });
    expect(b.total).toBe(200);
    // Slices are disjoint: 50 + 110 + 40 = the period total, so shares sum to 100%.
    expect(b.byTag.reduce((s, x) => s + x.total, 0)).toBe(200);
    const byKey = Object.fromEntries(b.byTag.map((s) => [s.label ?? "untagged", s]));
    expect(byKey.Food.total).toBe(110);
    expect(byKey.Fun.total).toBe(50);
    expect(byKey.untagged.total).toBe(40);
    // Gross answers "anything tagged Fun cost me…" — the whole 100, not half.
    expect(byKey.Fun.gross).toBe(100);
    expect(byKey.Food.gross).toBe(160);
  });

  it("ignores transfers and stat-excluded rows, like every other total", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const b = await createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    await addMovement(db, a.id, "out", 100, "2026-05-01");
    await createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 300, date: "2026-05-02" });
    await createMovement(db, { source_id: a.id, amount: 999, direction: "out", date: "2026-05-03", exclude_from_stats: true });

    const out = await spendingBreakdown(db, { direction: "out" });
    expect(out.total).toBe(100);
    expect(out.count).toBe(1);
  });

  it("never mixes currencies: it reports one and lists the rest", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    const usd = await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    await addMovement(db, eur.id, "out", 100, "2026-05-01");
    await addMovement(db, usd.id, "out", 250, "2026-05-02");

    const auto = await spendingBreakdown(db, { direction: "out" });
    expect(auto.currency).toBe("USD"); // busiest wins by default
    expect(auto.total).toBe(250);
    expect(auto.currencies.map((c) => c.currency)).toEqual(["USD", "EUR"]);

    const picked = await spendingBreakdown(db, { direction: "out" }, { currency: "EUR" });
    expect(picked.currency).toBe("EUR");
    expect(picked.total).toBe(100);
  });

  it("surfaces the biggest movements, repeats, months and weekdays", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    await createMovement(db, { source_id: a.id, amount: 30, direction: "out", date: "2026-04-06", note: "Netflix" });
    await createMovement(db, { source_id: a.id, amount: 30, direction: "out", date: "2026-05-04", note: "netflix" });
    await createMovement(db, { source_id: a.id, amount: 500, direction: "out", date: "2026-05-05", note: "Laptop" });

    const b = await spendingBreakdown(db, { direction: "out" });
    expect(b.top[0].note).toBe("Laptop");
    expect(b.median).toBe(30);
    // Case-insensitive: one subscription, seen twice.
    expect(b.repeats).toEqual([{ label: "Netflix", total: 60, count: 2 }]);
    expect(b.byMonth).toEqual([
      { month: "2026-04", total: 30 },
      { month: "2026-05", total: 530 },
    ]);
    // 2026-04-06 and 2026-05-04 are Mondays, 2026-05-05 a Tuesday.
    expect(b.byWeekday[0]).toBe(60);
    expect(b.byWeekday[1]).toBe(500);
  });

  it("totalByCurrency answers the previous-period question", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    await addMovement(db, a.id, "out", 80, "2026-04-10");
    await addMovement(db, a.id, "out", 20, "2026-05-10");
    const prev = previousRange("2026-05-01", "2026-05-31");
    expect(prev).toEqual({ from: "2026-04-01", to: "2026-04-30" });
    const totals = await totalByCurrency(db, { direction: "out", dateFrom: prev.from, dateTo: prev.to });
    expect(totals.EUR).toBe(80);
  });
});

describe("previousRange", () => {
  it("shifts whole-month ranges by whole months", () => {
    expect(previousRange("2026-03-01", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousRange("2026-01-01", "2026-03-31")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
  });

  it("shifts any other range by its own length in days", () => {
    expect(previousRange("2026-05-10", "2026-05-16")).toEqual({ from: "2026-05-03", to: "2026-05-09" });
  });
});
