import { describe, it, expect } from "vitest";
import { addMovement, makeMemDb } from "@/test/sqlite";
import { createSource, ensureFundForCurrency } from "./sources";
import { createSaving } from "./savings";
import { createTransfer } from "./movements";
import { createRecurring } from "./recurring";
import * as dash from "./dashboard";

describe("dashboard aggregations", () => {
  it("net worth is per-currency and includes funds + excluded sources", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    await createSource(db, { name: "USD", currency: "USD", starting_balance: 500 });
    const excluded = await createSource(db, { name: "Old", currency: "EUR", starting_balance: 50, exclude_from_stats: true });
    await addMovement(db, eur.id, "out", 200, "2026-05-10");
    await createSaving(db, { fromSourceId: eur.id, amount: 100, date: "2026-05-11" }); // moves to EUR fund
    void excluded;

    const nw = await dash.netWorth(db);
    // EUR: 1000 - 200 - 100(out to fund) + 100(fund) + 50(excluded) = 850; USD: 500
    expect(nw.EUR).toBe(850);
    expect(nw.USD).toBe(500);
  });

  it("monthly flow excludes transfers + excluded, buckets external", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    const b = await createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    await addMovement(db, a.id, "in", 2000, "2026-05-01");
    await addMovement(db, a.id, "out", 300, "2026-05-02");
    await createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 100, date: "2026-05-03" }); // excluded
    await addMovement(db, null, "out", 40, "2026-05-04"); // external
    // excluded-from-stats movement
    await db.execute(
      `INSERT INTO movements (source_id,amount,direction,date,exclude_from_stats,is_savings_contribution,created_at,updated_at)
       VALUES (?,?,?,?,1,0,'t','t')`,
      [a.id, 999, "out", "2026-05-05"],
    );

    const flow = await dash.monthlyFlow(db, "2026-05-01", "2026-05-31");
    expect(flow.byCurrency.EUR).toEqual({ income: 2000, expense: 300 }); // transfer + excluded omitted
    expect(flow.externalExpense).toBe(40);
  });

  it("monthly savings counts contribution in-legs by fund currency", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    await ensureFundForCurrency(db, "EUR");
    await createSaving(db, { fromSourceId: a.id, amount: 250, date: "2026-05-10" });
    const s = await dash.monthlySavings(db, "2026-05-01", "2026-05-31");
    expect(s.EUR).toBe(250);
  });

  it("monthly comparison is zero-filled across the range (BUG-2 fix)", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    await addMovement(db, a.id, "in", 100, "2026-05-10");
    await addMovement(db, a.id, "out", 40, "2026-03-10");
    const cmp = await dash.monthlyComparison(db, "EUR", 4, "2026-05-15");
    expect(cmp.map((c) => c.month)).toEqual(["2026-02", "2026-03", "2026-04", "2026-05"]);
    expect(cmp.find((c) => c.month === "2026-04")).toEqual({ month: "2026-04", income: 0, expense: 0 });
    expect(cmp.find((c) => c.month === "2026-05")!.income).toBe(100);
    expect(cmp.find((c) => c.month === "2026-03")!.expense).toBe(40);
  });

  it("monthly comparison honours the months range param (6m vs 2y)", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    await addMovement(db, a.id, "in", 100, "2026-05-10");
    const six = await dash.monthlyComparison(db, "EUR", 6, "2026-05-15");
    const twoY = await dash.monthlyComparison(db, "EUR", 24, "2026-05-15");
    expect(six.length).toBe(6);
    expect(twoY.length).toBe(24);
    expect(six[0].month).toBe("2025-12");
    expect(twoY[0].month).toBe("2024-06");
    // The same data appears in the most recent bucket regardless of window.
    expect(six[six.length - 1].income).toBe(100);
    expect(twoY[twoY.length - 1].income).toBe(100);
  });

  it("monthly flow surfaces external income + expense subtotals (gap 7)", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    await addMovement(db, a.id, "in", 500, "2026-05-01");
    await addMovement(db, null, "in", 80, "2026-05-02"); // external income
    await addMovement(db, null, "out", 30, "2026-05-03"); // external expense
    const flow = await dash.monthlyFlow(db, "2026-05-01", "2026-05-31");
    expect(flow.byCurrency.EUR).toEqual({ income: 500, expense: 0 });
    expect(flow.externalIncome).toBe(80);
    expect(flow.externalExpense).toBe(30);
  });

  it("monthlyMovements returns all non-transfer rows incl. excluded, newest first (gap 1)", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "Cash", currency: "EUR", starting_balance: 0 });
    const b = await createSource(db, { name: "Bank", currency: "EUR", starting_balance: 0 });
    await addMovement(db, a.id, "out", 10, "2026-05-02");
    await addMovement(db, a.id, "out", 20, "2026-05-05");
    await createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 100, date: "2026-05-06" }); // transfer excluded
    // an excluded-from-stats out movement (still listed, flagged)
    await db.execute(
      `INSERT INTO movements (source_id,amount,direction,date,exclude_from_stats,is_savings_contribution,created_at,updated_at)
       VALUES (?,?,?,?,1,0,'t','t')`,
      [a.id, 7, "out", "2026-05-04"],
    );

    const rows = await dash.monthlyMovements(db, "out", "2026-05-01", "2026-05-31");
    // transfer leg omitted; the other three included
    expect(rows.map((r) => r.amount)).toEqual([20, 7, 10]); // date DESC: 05 > 04 > 02
    expect(rows.find((r) => r.amount === 7)!.exclude_from_stats).toBe(true);
    expect(rows.every((r) => r.source_name === "Cash")).toBe(true);
  });

  it("counts returns aggregate movement + source totals (gap 10)", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "B", currency: "USD", starting_balance: 0 });
    await addMovement(db, a.id, "in", 1, "2026-05-01");
    await addMovement(db, a.id, "out", 2, "2026-05-02");
    const c = await dash.counts(db);
    expect(c.sourceCount).toBe(2);
    expect(c.movementCount).toBe(2);
  });

  it("upcomingRecurring carries days_left and includes overdue items (gap 8)", async () => {
    const { db } = await makeMemDb();
    await createRecurring(db, { name: "Rent", amount: 900, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-05-20" });
    await createRecurring(db, { name: "Phone", amount: 30, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-05-10" });
    const up = await dash.upcomingRecurring(db, "2026-05-15", 5);
    const rent = up.find((r) => r.name === "Rent")!;
    const phone = up.find((r) => r.name === "Phone")!;
    expect(rent.days_left).toBe(5);
    expect(phone.days_left).toBe(-5); // overdue, still listed
  });
});
