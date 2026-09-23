/**
 * Regression tests for the logic fixes made in the "logic-fixes" pass. Each
 * `describe` names the invariant that was previously violated.
 */
import { describe, it, expect } from "vitest";
import { makeMemDb, addMovement } from "@/test/sqlite";
import type { SqlExecutor } from "./types";
import * as sources from "./repo/sources";
import * as movements from "./repo/movements";
import * as goals from "./repo/goals";
import * as whims from "./repo/whims";
import * as tags from "./repo/tags";
import * as budgets from "./repo/budgets";
import * as recurring from "./repo/recurring";
import { forecastCashflow } from "./repo/forecast";
import { createSaving, fundBalanceTrend } from "./repo/savings";
import { upsertRate } from "./repo/exchange-rates";
import { tryParseDate, parseCsv, isValidCalendarDate } from "./importers/csv";
import { parseOfxDate } from "./importers/ofx";
import { addMonthsISO } from "@/lib/date";

async function inLeg(db: SqlExecutor, outId: number) {
  const out = (await movements.getMovement(db, outId))!;
  return (await movements.getMovement(db, out.transfer_pair_id!))!;
}

describe("transfer edit keeps same-currency legs equal", () => {
  it("re-pointing a cross-currency pair onto same-currency accounts mirrors the amount", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    const usd = await sources.createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    const eur2 = await sources.createSource(db, { name: "EUR2", currency: "EUR", starting_balance: 0 });
    const pair = await movements.createTransfer(db, { fromSourceId: eur.id, toSourceId: usd.id, amount: 100, toAmount: 108, date: "2026-05-01" });
    expect((await inLeg(db, pair.outId)).amount).toBe(108);

    // Move the receiving leg to a EUR account, no toAmount supplied.
    await movements.updateTransfer(db, pair.outId, { toSourceId: eur2.id });
    expect((await inLeg(db, pair.outId)).amount).toBe(100); // 108 would have minted 8 EUR
    expect(await sources.getBalance(db, eur.id)).toBe(900);
    expect(await sources.getBalance(db, eur2.id)).toBe(100);
  });

  it("a cross-currency pair keeps its converted amount when only the date changes", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    const usd = await sources.createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    const pair = await movements.createTransfer(db, { fromSourceId: eur.id, toSourceId: usd.id, amount: 100, toAmount: 108, date: "2026-05-01" });
    await movements.updateTransfer(db, pair.outId, { date: "2026-05-02" });
    expect((await inLeg(db, pair.outId)).amount).toBe(108);
  });
});

describe("source delete/move guards", () => {
  it("move_to rejects the source itself and a savings fund", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 10 });
    const fund = await sources.ensureFundForCurrency(db, "EUR");
    await addMovement(db, a.id, "in", 5);
    await expect(sources.deleteSource(db, a.id, { kind: "move_to", targetId: a.id })).rejects.toMatchObject({ code: "same_source" });
    await expect(sources.deleteSource(db, a.id, { kind: "move_to", targetId: fund.id })).rejects.toMatchObject({ code: "fund_not_mergeable" });
    expect(await sources.getSource(db, a.id)).not.toBeNull(); // nothing was deleted
  });

  it("a fund's currency is locked; an active goal locks its source's currency", async () => {
    const { db } = await makeMemDb();
    const fund = await sources.ensureFundForCurrency(db, "EUR");
    await expect(sources.updateSource(db, fund.id, { currency: "USD" })).rejects.toMatchObject({ code: "fund_currency_locked" });
    // name edits on a fund still pass (the currency is unchanged)
    await sources.updateSource(db, fund.id, { currency: "eur", name: "Piggy" });
    expect((await sources.getSource(db, fund.id))!.name).toBe("Piggy");

    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const gid = await goals.createGoal(db, { name: "Trip", target_amount: 50, currency: "EUR", source_id: acct.id });
    await expect(sources.updateSource(db, acct.id, { currency: "USD" })).rejects.toMatchObject({ code: "active_goal_blocks_currency_change" });
    await goals.deleteGoal(db, gid);
    await sources.updateSource(db, acct.id, { currency: "USD" });
    expect((await sources.getSource(db, acct.id))!.currency).toBe("USD");
  });

  it("changing a source's currency carries its recurring rules along", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const rid = await recurring.createRecurring(db, { name: "Rent", amount: 10, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-05-01", source_id: acct.id });
    await sources.updateSource(db, acct.id, { currency: "USD" });
    expect((await recurring.getRecurring(db, rid))!.currency).toBe("USD");
    // The invariant the scheduler relies on still holds: a later edit validates cleanly.
    await recurring.updateRecurring(db, rid, { amount: 20 });
  });
});

describe("whims and goals lifecycle", () => {
  it("save-for-this after the linked goal was closed starts a fresh goal", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const dest = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const wid = await whims.createWhim(db, { name: "Camera", amount: 800, currency: "EUR" });
    const g1 = await whims.startSavingForWhim(db, wid);
    await goals.allocate(db, g1, { fromSourceId: acct.id, amount: 100, date: "2026-05-01" });
    await goals.closeGoal(db, g1, dest.id, "2026-05-02");
    expect((await goals.getGoal(db, g1))!.status).toBe("completed");

    const g2 = await whims.startSavingForWhim(db, wid);
    expect(g2).not.toBe(g1);
    expect((await goals.getGoal(db, g2))!.status).toBe("active");
    expect((await whims.getWhim(db, wid))!.linked_goal_id).toBe(g2);
    // ...and money can be put toward it again.
    await goals.allocate(db, g2, { fromSourceId: acct.id, amount: 50, date: "2026-05-03" });
  });

  it("a whim with an active goal can't change currency; other edits pass", async () => {
    const { db } = await makeMemDb();
    const wid = await whims.createWhim(db, { name: "Camera", amount: 800, currency: "EUR" });
    await whims.startSavingForWhim(db, wid);
    await expect(whims.updateWhim(db, wid, { currency: "USD" })).rejects.toMatchObject({ code: "linked_goal_currency_locked" });
    await whims.updateWhim(db, wid, { currency: "eur", amount: 700 });
    expect((await whims.getWhim(db, wid))!.amount).toBe(700);
  });

  it("closing an already-closed goal is rejected instead of silently re-stamped", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const dest = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const gid = await goals.createGoal(db, { name: "Trip", target_amount: 500, currency: "EUR" });
    await goals.allocate(db, gid, { fromSourceId: acct.id, amount: 100, date: "2026-05-01" });
    await goals.closeGoal(db, gid, dest.id, "2026-05-02");
    await expect(goals.closeGoal(db, gid, dest.id, "2026-05-03")).rejects.toMatchObject({ code: "goal_not_active" });
    expect(await sources.getBalance(db, dest.id)).toBe(100); // paid out exactly once
  });
});

describe("recurring schedules anchor to the start day", () => {
  it("addMonthsISO with an anchor comes back to the 31st after a short month", () => {
    expect(addMonthsISO("2026-01-31", 1)).toBe("2026-02-28"); // legacy clamp unchanged
    expect(addMonthsISO("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(addMonthsISO("2026-03-31", 1, 31)).toBe("2026-04-30");
    expect(addMonthsISO("2025-02-28", 12, 29)).toBe("2026-02-28");
    expect(addMonthsISO("2027-02-28", 12, 29)).toBe("2028-02-29");
  });

  it("computeNextDueDate(anchor) does not drift", () => {
    let d = "2026-01-31";
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      d = recurring.computeNextDueDate(d, "monthly", 31);
      seen.push(d);
    }
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("the scheduler and the forecast fire a 31st bill on the 31st again after February", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const rid = await recurring.createRecurring(db, { name: "Rent", amount: 10, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-01-31", source_id: acct.id, apply_mode: "auto" });
    await recurring.processDueRecurring(db, "2026-03-01");
    const item = (await recurring.getRecurring(db, rid))!;
    expect(item.last_fired_date).toBe("2026-02-28");
    expect(item.next_due_date).toBe("2026-03-31");
    const dates = (await db.select<{ date: string }>(`SELECT date FROM movements WHERE source_id = ? ORDER BY date`, [acct.id])).map((r) => r.date);
    expect(dates).toEqual(["2026-01-31", "2026-02-28"]);

    const fc = await forecastCashflow(db, 130, "2026-03-01"); // through 2026-07-09
    const eur = fc.find((f) => f.currency === "EUR")!;
    expect(eur.points.map((p) => p.date).slice(1)).toEqual(["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
  });
});

describe("fund balance trend is a level, not a flow", () => {
  it("emits every month of the window and keeps a dormant fund on the chart", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    await createSaving(db, { fromSourceId: acct.id, amount: 300, date: "2025-01-15" });
    await createSaving(db, { fromSourceId: acct.id, amount: 200, date: "2025-03-10" });
    // Nothing since March 2025; viewing 6 months up to Sept 2026.
    const trend = await fundBalanceTrend(db, 6, "2026-09-15");
    expect(trend.map((p) => p.month)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(trend.every((p) => p.currency === "EUR" && p.value === 500)).toBe(true);
  });

  it("carries the running balance through months with no movements", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    await createSaving(db, { fromSourceId: acct.id, amount: 100, date: "2026-01-05" });
    await createSaving(db, { fromSourceId: acct.id, amount: 50, date: "2026-03-05" });
    const trend = await fundBalanceTrend(db, 4, "2026-04-20");
    expect(trend).toEqual([
      { month: "2026-01", currency: "EUR", value: 100 },
      { month: "2026-02", currency: "EUR", value: 100 },
      { month: "2026-03", currency: "EUR", value: 150 },
      { month: "2026-04", currency: "EUR", value: 150 },
    ]);
  });
});

describe("movement KPI averages", () => {
  it("sumMovements reports how many rows fed the totals (transfers/excluded left out)", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    const b = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    await addMovement(db, a.id, "in", 100);
    await addMovement(db, a.id, "out", 40);
    await movements.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 30, date: "2026-01-01" });
    const excluded = await movements.createMovement(db, { source_id: a.id, amount: 999, direction: "out", date: "2026-01-01", exclude_from_stats: true });
    void excluded;
    const sums = await movements.sumMovements(db, { excludeTransferIn: true });
    expect(sums).toEqual({ totalIn: 100, totalOut: 40, countedRows: 2 });
    // The plain count still includes the transfer OUT leg and the excluded row.
    expect(await movements.countMovements(db, { excludeTransferIn: true })).toBe(4);
  });
});

describe("importers reject impossible calendar dates", () => {
  it("isValidCalendarDate knows month lengths and leap years", () => {
    expect(isValidCalendarDate(2024, 2, 29)).toBe(true);
    expect(isValidCalendarDate(2023, 2, 29)).toBe(false);
    expect(isValidCalendarDate(2024, 4, 31)).toBe(false);
    expect(isValidCalendarDate(2024, 13, 1)).toBe(false);
  });

  it("CSV date parsing drops Feb 30 / Apr 31 in every format path", () => {
    expect(tryParseDate("2024-02-30")).toBeNull();
    expect(tryParseDate("31/04/2024")).toBeNull();
    expect(tryParseDate("30/02/2024", "%d/%m/%Y")).toBeNull();
    expect(tryParseDate("30 Feb 2024")).toBeNull();
    expect(tryParseDate("29/02/2024")).toBe("2024-02-29");
    const text = "date,amount\n2024-02-30,-5\n2024-02-28,-5\n";
    const res = parseCsv(text);
    expect(res.movements.map((m) => m.date)).toEqual(["2024-02-28"]);
    expect(res.warnings).toContain("row_2_bad_date");
  });

  it("OFX dates go through the same check", () => {
    expect(parseOfxDate("20240230120000")).toBeNull();
    expect(parseOfxDate("2024-02-30")).toBeNull();
    expect(parseOfxDate("20240229")).toBe("2024-02-29");
  });
});

describe("tag merge preserves budgets and legacy saving links", () => {
  it("re-points the source tag's budget when the target has none in that currency", async () => {
    const { db } = await makeMemDb();
    const a = await tags.createTag(db, { name: "Groceries" });
    const b = await tags.createTag(db, { name: "Food" });
    const bid = await budgets.createBudget(db, { tag_id: a, amount: 200, currency: "EUR" });
    await db.execute(`INSERT INTO savings (amount,currency,date,created_at,updated_at) VALUES (10,'EUR','2025-01-01','t','t')`);
    await db.execute(`INSERT INTO saving_tag (saving_id,tag_id) VALUES (1,?)`, [a]);

    await tags.mergeTags(db, a, b);
    expect((await budgets.getBudget(db, bid))!.tag_id).toBe(b);
    expect((await db.select<{ tag_id: number }>(`SELECT tag_id FROM saving_tag`)).map((r) => r.tag_id)).toEqual([b]);
  });

  it("drops the source budget only when the target already has an active one in that currency", async () => {
    const { db } = await makeMemDb();
    const a = await tags.createTag(db, { name: "Groceries" });
    const b = await tags.createTag(db, { name: "Food" });
    const fromEur = await budgets.createBudget(db, { tag_id: a, amount: 200, currency: "EUR" });
    const fromUsd = await budgets.createBudget(db, { tag_id: a, amount: 50, currency: "USD" });
    const intoEur = await budgets.createBudget(db, { tag_id: b, amount: 300, currency: "EUR" });
    await tags.mergeTags(db, a, b);
    expect(await budgets.getBudget(db, fromEur)).toBeNull(); // collided with intoEur
    expect((await budgets.getBudget(db, intoEur))!.amount).toBe(300);
    expect((await budgets.getBudget(db, fromUsd))!.tag_id).toBe(b); // carried over
    // No two active budgets for the same tag+currency survived the merge.
    const dup = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM budgets WHERE tag_id = ? AND currency = 'EUR' AND active = 1`, [b]);
    expect(dup[0].c).toBe(1);
  });
});

describe("exchange-rate driven transfer edit sanity", () => {
  it("same-currency amount edit still mirrors (pre-existing behaviour kept)", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "USD", 1.1);
    const a = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const pair = await movements.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 10, date: "2026-01-01" });
    await movements.updateTransfer(db, pair.outId, { amount: 25 });
    expect((await inLeg(db, pair.outId)).amount).toBe(25);
  });
});

describe("date validation at the repository boundary", () => {
  it("rejects malformed or impossible dates on movements, transfers, savings and rules", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    await expect(movements.createMovement(db, { source_id: a.id, amount: 1, direction: "out", date: "2026-02-30" })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(movements.createMovement(db, { source_id: a.id, amount: 1, direction: "out", date: "" })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(movements.createMovement(db, { source_id: a.id, amount: 1, direction: "out", date: "2026-5-1" })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(movements.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 1, date: "not-a-date" })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(createSaving(db, { fromSourceId: a.id, amount: 1, date: "2026-13-01" })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(recurring.createRecurring(db, { name: "X", amount: 1, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-04-31" })).rejects.toMatchObject({ code: "invalid_date" });
    const id = await movements.createMovement(db, { source_id: a.id, amount: 1, direction: "out", date: "2024-02-29" });
    await expect(movements.updateMovement(db, id, { date: "2023-02-29" })).rejects.toMatchObject({ code: "invalid_date" });
    expect((await movements.getMovement(db, id))!.date).toBe("2024-02-29");
  });
});

describe("yield re-enable does not back-fill disabled periods", () => {
  it("anchors the next accrual on today when interest was switched off in between", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "TD", currency: "EUR", starting_balance: 1000, yield_rate: 1, yield_period_months: 1 }, "2026-01-01");
    // First period accrues on schedule, then the user turns interest off.
    const { processSourceYields } = await import("./repo/scheduler");
    expect(await processSourceYields(db, "2026-02-01")).toBe(1);
    expect((await sources.getSource(db, s.id))!.yield_last_date).toBe("2026-02-01");
    await sources.updateSource(db, s.id, { yield_rate: 0 }, "2026-02-05");
    expect((await sources.getSource(db, s.id))!.yield_next_date).toBeNull();
    // Six months later interest is switched back on: nothing is owed for the gap.
    await sources.updateSource(db, s.id, { yield_rate: 1 }, "2026-08-10");
    expect((await sources.getSource(db, s.id))!.yield_next_date).toBe("2026-09-10");
    expect(await processSourceYields(db, "2026-08-10")).toBe(0);
    // A rate change on a RUNNING schedule still re-anchors on the last credit (§17).
    await sources.updateSource(db, s.id, { yield_period_months: 2 }, "2026-08-20");
    expect((await sources.getSource(db, s.id))!.yield_next_date).toBe("2026-04-01"); // last 2026-02-01 + 2mo
  });
});

describe("recurring rules past their end date", () => {
  it("drop out of the monthly summary and of the dashboard's upcoming list", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    await recurring.createRecurring(db, { name: "Old gym", amount: 30, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2025-01-01", end_date: "2025-12-31", source_id: acct.id });
    await recurring.createRecurring(db, { name: "Rent", amount: 700, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-01-01", source_id: acct.id });
    // A rule still inside its end date but whose next occurrence would land past it.
    const rid = await recurring.createRecurring(db, { name: "Course", amount: 50, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-05-20", end_date: "2026-06-10", source_id: acct.id });
    await recurring.applyRecurringById(db, rid, {}, "2026-05-20"); // next_due → 2026-06-20 > end
    const sum = await recurring.monthlySummary(db, "2026-06-01");
    expect(sum.byCurrency.EUR.outflow).toBe(750);
    expect(sum.byCurrency.EUR.countOut).toBe(2);
    const { upcomingRecurring } = await import("./repo/dashboard");
    const up = await upcomingRecurring(db, "2026-06-01", 10);
    expect(up.map((u) => u.name)).toEqual(["Rent"]);
  });

  it("a manual apply with a zero override amount is rejected", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const rid = await recurring.createRecurring(db, { name: "Rent", amount: 10, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-01-01", source_id: acct.id });
    await expect(recurring.applyRecurringById(db, rid, { amount: 0 }, "2026-01-05")).rejects.toMatchObject({ code: "invalid_amount" });
    expect(await sources.getBalance(db, acct.id)).toBe(100);
  });
});

describe("whims preferred source and goal allocations from funds", () => {
  it("a preferred source must exist and share the whim's currency", async () => {
    const { db } = await makeMemDb();
    const usd = await sources.createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    const eur = await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await expect(whims.createWhim(db, { name: "X", amount: 5, currency: "EUR", source_id: usd.id })).rejects.toMatchObject({ code: "currency_mismatch" });
    await expect(whims.createWhim(db, { name: "X", amount: 5, currency: "EUR", source_id: 9999 })).rejects.toMatchObject({ code: "not_found" });
    const wid = await whims.createWhim(db, { name: "X", amount: 5, currency: "EUR", source_id: eur.id });
    await expect(whims.updateWhim(db, wid, { source_id: usd.id })).rejects.toMatchObject({ code: "currency_mismatch" });
    await whims.updateWhim(db, wid, { source_id: null });
    expect((await whims.getWhim(db, wid))!.source_id).toBeNull();
  });

  it("money cannot be allocated to a goal straight out of a savings fund", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const other = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    await createSaving(db, { fromSourceId: acct.id, amount: 300, date: "2026-01-01" });
    const fund = (await sources.listSources(db)).find((s) => s.is_savings_fund === 1)!;
    const gid = await goals.createGoal(db, { name: "Bike", target_amount: 200, currency: "EUR", source_id: other.id });
    await expect(goals.allocate(db, gid, { fromSourceId: fund.id, amount: 100, date: "2026-01-02" })).rejects.toMatchObject({ code: "fund_transfer_not_allowed" });
    expect(await sources.getBalance(db, fund.id)).toBe(300);
  });
});
