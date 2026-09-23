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
import { getRate, upsertRate } from "./repo/exchange-rates";
import * as portfolios from "./repo/portfolios";
import { sourceBalanceHistory } from "./repo/history";
import { clearPriceCache, fetchCryptoPrice, fetchStockPrice, setPriceTransport, type PriceTransport } from "./repo/prices";
import { refreshRates } from "./repo/fx";
import { resetAllData, type AttachmentFs } from "./backup";
import { addAttachment } from "./repo/attachments";
import { getSettings } from "./repo/settings";
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
    // A rule still inside its end date but whose next occurrence would land past
    // it can never fire again either — the scheduler skips it, so the summary
    // must not project it.
    const rid = await recurring.createRecurring(db, { name: "Course", amount: 50, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-05-20", end_date: "2026-06-10", source_id: acct.id });
    await recurring.applyRecurringById(db, rid, {}, "2026-05-20"); // next_due → 2026-06-20 > end
    const sum = await recurring.monthlySummary(db, "2026-06-01");
    expect(sum.byCurrency.EUR.outflow).toBe(700);
    expect(sum.byCurrency.EUR.countOut).toBe(1);
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

describe("budget alerts with no warning threshold", () => {
  it("still fires the overspend alert when alert_threshold_pct is 0", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const food = await tags.createTag(db, { name: "Food" });
    const today = "2026-05-15";
    await budgets.createBudget(db, { tag_id: food, amount: 100, currency: "EUR", period: "monthly", alert_threshold_pct: 0, start_date: "2026-05-01" });
    await movements.createMovement(db, { source_id: eur.id, amount: 90, direction: "out", date: today, tagIds: [food] });
    expect(await budgets.checkBudgetAlerts(db, today)).toBe(0); // 90% but no warning band
    await movements.createMovement(db, { source_id: eur.id, amount: 20, direction: "out", date: today, tagIds: [food] });
    expect(await budgets.checkBudgetAlerts(db, today)).toBe(1); // over → alert
    expect(await budgets.checkBudgetAlerts(db, today)).toBe(0); // idempotent
  });

  it("does not alert on a budget that hasn't started yet", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const food = await tags.createTag(db, { name: "Food" });
    await budgets.createBudget(db, { tag_id: food, amount: 10, currency: "EUR", period: "monthly", alert_threshold_pct: 50, start_date: "2026-06-01" });
    await movements.createMovement(db, { source_id: eur.id, amount: 500, direction: "out", date: "2026-05-15", tagIds: [food] });
    expect(await budgets.checkBudgetAlerts(db, "2026-05-15")).toBe(0);
  });
});

describe("forecast places already-booked future movements on the timeline", () => {
  it("starts from today's balance and applies a future-dated movement on its date", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "Checking", currency: "EUR", starting_balance: 100 });
    await movements.createMovement(db, { source_id: s.id, amount: 80, direction: "out", date: "2026-06-20", note: "Rent (booked ahead)" });
    const fc = await forecastCashflow(db, 30, "2026-06-02");
    const eur = fc.find((f) => f.currency === "EUR")!;
    expect(eur.start).toBe(100); // not 20: the rent hasn't left yet
    expect(eur.end).toBe(20);
    expect(eur.negativeFrom).toBeNull();
    expect(eur.points.map((p) => p.date)).toEqual(["2026-06-02", "2026-06-20"]);
    // A future movement beyond the horizon is simply outside the window.
    await movements.createMovement(db, { source_id: s.id, amount: 500, direction: "out", date: "2026-12-01" });
    const fc2 = await forecastCashflow(db, 30, "2026-06-02");
    expect(fc2.find((f) => f.currency === "EUR")!.end).toBe(20);
  });

  it("same-currency transfer legs booked for a future date cancel out", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    await movements.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 40, date: "2026-06-10" });
    const fc = await forecastCashflow(db, 30, "2026-06-02");
    const eur = fc.find((f) => f.currency === "EUR")!;
    expect(eur.start).toBe(100);
    expect(eur.end).toBe(100);
    expect(eur.points).toHaveLength(1);
  });
});

describe("scheduler ignores rules that can never fire again", () => {
  it("posts no reminder or confirm prompt once the next occurrence is past the end date", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const rid = await recurring.createRecurring(db, { name: "Course", amount: 50, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-05-20", end_date: "2026-06-10", source_id: acct.id, alert_days_before: 30 });
    await recurring.applyRecurringById(db, rid, {}, "2026-05-20"); // next_due → 2026-06-20 > end
    await db.execute(`DELETE FROM notifications`);
    const res = await recurring.processDueRecurring(db, "2026-06-01");
    expect(res).toEqual({ applied: 0, errors: 0 });
    const n = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM notifications`);
    expect(n[0].c).toBe(0);
  });
});

describe("per-source history values foreign-currency holdings in the source currency", () => {
  async function snap(db: SqlExecutor, holdingId: number, date: string, price: number) {
    await db.execute(
      `INSERT INTO holding_price_snapshots (holding_id,date,price,created_at) VALUES (?,?,?,?)`,
      [holdingId, date, price, `${date}T00:00:00`],
    );
  }

  it("converts a USD holding inside a EUR portfolio instead of adding the raw dollars", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "Broker", currency: "EUR", starting_balance: 100 });
    const pid = await portfolios.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await portfolios.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAPL", quantity: 2, avg_cost: 100, currency: "USD", manual_price: true, last_price: 150 });
    await snap(db, hid, "2026-01-10", 150); // 300 USD
    await upsertRate(db, "USD", "EUR", 0.5);

    const values = await portfolios.portfolioValueBySourceOverTime(db, s.id, ["2026-01-05", "2026-01-10"]);
    expect(values["2026-01-05"]).toBe(100); // avg-cost fallback 200 USD → 100 EUR
    expect(values["2026-01-10"]).toBe(150); // 300 USD → 150 EUR, never 300

    // The last history point agrees with what the sources page shows today.
    const hist = await sourceBalanceHistory(db, s.id);
    const bySource = await portfolios.valueBySource(db);
    expect(hist[hist.length - 1].portfolios).toBe(bySource.get(s.id)!.value);
  });

  it("leaves a holding out entirely when its currency has no rate", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "Broker", currency: "EUR", starting_balance: 0 });
    const pid = await portfolios.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await portfolios.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAPL", quantity: 2, avg_cost: 100, currency: "USD" });
    await snap(db, hid, "2026-01-10", 150);
    expect(await portfolios.snapshotDatesForSource(db, s.id)).toEqual([]);
    expect(await portfolios.portfolioValueBySourceOverTime(db, s.id, ["2026-01-10"])).toEqual({ "2026-01-10": 0 });
  });
});

describe("holding inputs must be real non-negative numbers", () => {
  it("rejects a negative quantity, cost or price on create and update", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "Broker", currency: "EUR" });
    const pid = await portfolios.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const base = { portfolio_id: pid, asset_class: "stock" as const, symbol: "X", currency: "EUR" };
    await expect(portfolios.createHolding(db, { ...base, quantity: -1 })).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(portfolios.createHolding(db, { ...base, avg_cost: -5 })).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(portfolios.createHolding(db, { ...base, manual_price: true, last_price: -2 })).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(portfolios.createHolding(db, { ...base, quantity: Number.NaN })).rejects.toMatchObject({ code: "invalid_amount" });
    const hid = await portfolios.createHolding(db, { ...base, quantity: 1, avg_cost: 10 });
    await expect(portfolios.updateHolding(db, hid, { quantity: -3 })).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(portfolios.updateHolding(db, hid, { symbol: "   " })).rejects.toMatchObject({ code: "invalid_amount" });
    expect((await portfolios.getHolding(db, hid))!.quantity).toBe(1);
  });
});

describe("price providers answering 0 never overwrite a known price", () => {
  function mock(routes: { match: string; body: unknown }[]): PriceTransport {
    const t: PriceTransport = async (url) => {
      const r = routes.find((x) => url.includes(x.match));
      return { ok: r != null, status: r ? 200 : 500, json: async () => r?.body } as Response;
    };
    setPriceTransport(t);
    return t;
  }

  it("treats a zero quote as no quote", async () => {
    clearPriceCache();
    mock([
      { match: "simple/price", body: { bitcoin: { usd: 0 } } },
      { match: "finance/chart", body: { chart: { result: [{ meta: { regularMarketPrice: 0 } }] } } },
    ]);
    try {
      expect(await fetchCryptoPrice("BTC", "usd")).toBeNull();
      expect(await fetchStockPrice("AAPL")).toBeNull();
    } finally {
      setPriceTransport(null);
      clearPriceCache();
    }
  });
});

describe("rate refresh re-quotes hand-entered crypto pairs that bypass the pivot", () => {
  it("updates a stale BTC→USD row when the pivot is EUR", async () => {
    const { db } = await makeMemDb();
    await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await db.execute(`UPDATE settings SET base_currency = 'EUR'`);
    await upsertRate(db, "BTC", "USD", 1); // stale, and preferred by getRate over any chain
    await upsertRate(db, "USD", "BTC", 1); // stored the other way round by the user too
    const calls: string[] = [];
    setPriceTransport(async (url) => {
      calls.push(url);
      const body = url.includes("vs_currencies=usd")
        ? { bitcoin: { usd: 50000 } }
        : url.includes("vs_currencies=eur")
          ? { bitcoin: { eur: 40000 } }
          : { rates: { USD: 1.25 } };
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    try {
      const res = await refreshRates(db);
      expect(res.offline).toBe(false);
      expect(await getRate(db, "BTC", "USD")).toBe(50000);
      expect(await getRate(db, "USD", "BTC")).toBeCloseTo(1 / 50000, 12);
      expect(await getRate(db, "BTC", "EUR")).toBe(40000);
    } finally {
      setPriceTransport(null);
      clearPriceCache();
    }
  });
});

describe("reset keeps attachment files until the wipe has committed", () => {
  it("removes files only after the transaction succeeds", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "A", currency: "EUR" });
    const mid = await movements.createMovement(db, { source_id: s.id, amount: 1, direction: "out", date: "2026-05-01" });
    const store = new Map<string, Uint8Array>();
    await addAttachment(db, mid, { name: "r.png", type: "image/png", bytes: new Uint8Array([1]) }, async (n, b) => { store.set(n, b); });
    const order: string[] = [];
    const fs: AttachmentFs = {
      async read() { throw new Error("no"); },
      async write() {},
      async list() { return [...store.keys()]; },
      async remove(n) { order.push(`remove:${n}`); store.delete(n); },
    };
    const origExecute = db.execute.bind(db);
    db.execute = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("DELETE FROM movement_attachments")) order.push("wipe");
      return origExecute(sql, params);
    };
    await resetAllData(db, fs);
    expect(order[0]).toBe("wipe");
    expect(order[order.length - 1]).toMatch(/^remove:/);
    expect(store.size).toBe(0);
  });
});

describe("recurring rule edits and lifecycle", () => {
  it("an amount-only edit keeps the rolled-forward schedule of a rule made from a movement", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const mid = await movements.createMovement(db, { source_id: acct.id, amount: 50, direction: "out", date: "2026-01-15", note: "Gym" });
    const rid = await recurring.makeRecurringFromMovement(db, mid, "monthly", "auto", "2026-09-23");
    const before = (await recurring.getRecurring(db, rid))!;
    expect(before.next_due_date).toBe("2026-10-15");

    // The edit form always sends start_date; unchanged, it must not re-anchor.
    await recurring.updateRecurring(db, rid, { amount: 60, start_date: before.start_date });
    const after = (await recurring.getRecurring(db, rid))!;
    expect(after.amount).toBe(60);
    expect(after.next_due_date).toBe("2026-10-15");
    // Nothing to back-fill on the next tick.
    expect(await recurring.processDueRecurring(db, "2026-09-23")).toEqual({ applied: 0, errors: 0 });

    // A deliberately changed start date still re-anchors the schedule.
    await recurring.updateRecurring(db, rid, { start_date: "2026-11-01" });
    expect((await recurring.getRecurring(db, rid))!.next_due_date).toBe("2026-11-01");
  });

  it("a rule cannot book plain movements on a savings fund", async () => {
    const { db } = await makeMemDb();
    const fund = await sources.ensureFundForCurrency(db, "EUR");
    await expect(
      recurring.createRecurring(db, { name: "Drip", amount: 10, direction: "in", currency: "EUR", frequency: "monthly", start_date: "2026-05-01", source_id: fund.id }),
    ).rejects.toMatchObject({ code: "fund_transfer_not_allowed" });
  });

  it("lists a rule whose next occurrence is past its end date as ended, not overdue", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const rid = await recurring.createRecurring(db, { name: "Course", amount: 50, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-05-20", end_date: "2026-06-10", source_id: acct.id });
    await recurring.applyRecurringById(db, rid, {}, "2026-05-20"); // next_due → 2026-06-20 > end
    const [row] = await recurring.listRecurring(db, "2026-06-01");
    expect(row.ended).toBe(true);
    expect(recurring.isRuleActive(row, "2026-06-01")).toBe(false);
    const summary = await recurring.monthlySummary(db, "2026-06-01");
    expect(summary.totalCount).toBe(0);
  });
});

describe("tag colour tint", () => {
  it("expands short hex and drops an existing alpha before adding its own", () => {
    expect(tags.tintOf("#abc")).toBe("#aabbcc22");
    expect(tags.tintOf("#112233")).toBe("#11223322");
    expect(tags.tintOf("#11223344")).toBe("#11223322");
  });
});

describe("amounts are stored to the cent on every write path", () => {
  it("rounds movement, transfer and split amounts", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const mid = await movements.createMovement(db, { source_id: a.id, amount: 10 / 3, direction: "out", date: "2026-05-01" });
    expect((await movements.getMovement(db, mid))!.amount).toBe(3.33);
    await movements.updateMovement(db, mid, { amount: 19.999 });
    expect((await movements.getMovement(db, mid))!.amount).toBe(20);
    const pair = await movements.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 1.005, date: "2026-05-01" });
    expect((await movements.getMovement(db, pair.outId))!.amount).toBe(1.01);
    expect((await inLeg(db, pair.outId)).amount).toBe(1.01);
    expect(await sources.getBalance(db, b.id)).toBe(1.01);
  });
});

describe("transfer edits never move a leg that sits on a savings fund", () => {
  it("rejects a note-only edit of a goal-close refund pair", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const dest = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const gid = await goals.createGoal(db, { name: "Trip", target_amount: 500, currency: "EUR" });
    await goals.allocate(db, gid, { fromSourceId: acct.id, amount: 100, date: "2026-05-01" });
    await goals.closeGoal(db, gid, dest.id, "2026-05-02");
    const refund = (await db.select<{ id: number }>(`SELECT id FROM movements WHERE note LIKE '↩%' AND direction = 'out'`))[0];
    await expect(movements.updateTransfer(db, refund.id, { note: "renamed" })).rejects.toMatchObject({ code: "fund_transfer_not_allowed" });
    await expect(movements.updateTransfer(db, refund.id, { fromSourceId: acct.id })).rejects.toMatchObject({ code: "fund_transfer_not_allowed" });
  });
});

describe("breakdown tag shares add up to the movement", () => {
  it("gives the rounding remainder to the first tag", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const t1 = await tags.createTag(db, { name: "x" });
    const t2 = await tags.createTag(db, { name: "y" });
    const t3 = await tags.createTag(db, { name: "z" });
    await movements.createMovement(db, { source_id: a.id, amount: 10, direction: "out", date: "2026-05-01", tagIds: [t1, t2, t3] });
    const { spendingBreakdown } = await import("./repo/breakdown");
    const bd = await spendingBreakdown(db, { direction: "out" });
    const sum = bd.byTag.reduce((s, x) => s + x.total, 0);
    expect(Math.round(sum * 100) / 100).toBe(10);
    expect(bd.byTag.map((x) => x.total).sort()).toEqual([3.33, 3.33, 3.34]);
  });
});

describe("CSV amounts with both separators", () => {
  it("treats the rightmost separator as the decimal whatever the preset says", async () => {
    const { parseAmount } = await import("./importers/csv");
    expect(parseAmount("-1.234,56", ".")).toBe(-1234.56);
    expect(parseAmount("1,234.56", ".")).toBe(1234.56);
    expect(parseAmount("1,234.56", ",")).toBe(1234.56);
  });
});

describe("settings that name rows by id forget deleted or wiped rows", () => {
  it("deleteSource drops the id from the net-worth exclusions and the last-used slot", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR" });
    const b = await sources.createSource(db, { name: "B", currency: "EUR" });
    await getSettings(db); // the singleton row is created lazily
    await db.execute(`UPDATE settings SET net_worth_excluded_json = ?, last_source_id = ?`, [JSON.stringify([a.id, b.id]), a.id]);
    await sources.deleteSource(db, a.id, { kind: "delete_all" });
    const s = (await db.select<{ net_worth_excluded_json: string; last_source_id: number | null }>(`SELECT net_worth_excluded_json, last_source_id FROM settings`))[0];
    expect(JSON.parse(s.net_worth_excluded_json)).toEqual([b.id]);
    expect(s.last_source_id).toBeNull();
  });

  it("resetAllData clears id-bearing preferences so re-used ids inherit nothing", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR" });
    await getSettings(db);
    await db.execute(`UPDATE settings SET net_worth_excluded_json = ?, last_source_id = ?, movement_templates_json = '[{"name":"x"}]', saved_views_json = '[{"name":"v","params":{}}]', theme = 'dark'`, [JSON.stringify([a.id]), a.id]);
    await resetAllData(db, { async read() { throw new Error("no"); }, async write() {}, async list() { return []; }, async remove() {} });
    const s = (await db.select<{ net_worth_excluded_json: string; last_source_id: number | null; movement_templates_json: string; saved_views_json: string; theme: string }>(`SELECT * FROM settings`))[0];
    expect(s.net_worth_excluded_json).toBe("[]");
    expect(s.last_source_id).toBeNull();
    expect(s.movement_templates_json).toBe("[]");
    expect(s.saved_views_json).toBe("[]");
    expect(s.theme).toBe("dark"); // other preferences still survive
  });
});

describe("holdings and stock quotes", () => {
  it("a holding's asset class can be corrected after creation", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "Broker", currency: "EUR" });
    const pid = await portfolios.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id, kind: "mixed" });
    const hid = await portfolios.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "BTC", currency: "EUR" });
    await portfolios.updateHolding(db, hid, { asset_class: "crypto" });
    expect((await portfolios.getHolding(db, hid))!.asset_class).toBe("crypto");
  });

  it("a London quote in pence is stored in pounds, and the holding follows the listing currency", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "Broker", currency: "EUR" });
    const pid = await portfolios.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const vod = await portfolios.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "VOD.L", quantity: 10, avg_cost: 0.7, currency: "GBP" });
    const aapl = await portfolios.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAPL", quantity: 1, avg_cost: 100, currency: "EUR" });
    clearPriceCache();
    setPriceTransport(async (url) => {
      const body = url.includes("VOD.L")
        ? { chart: { result: [{ meta: { regularMarketPrice: 7250, currency: "GBp" } }] } }
        : { chart: { result: [{ meta: { regularMarketPrice: 150, currency: "USD" } }] } };
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    try {
      const { refreshHolding } = await import("./repo/prices");
      expect(await refreshHolding(db, vod)).toBe(true);
      expect(await refreshHolding(db, aapl)).toBe(true);
    } finally {
      setPriceTransport(null);
      clearPriceCache();
    }
    const v = (await portfolios.getHolding(db, vod))!;
    expect(v.last_price).toBe(72.5);
    expect(v.currency).toBe("GBP");
    const a = (await portfolios.getHolding(db, aapl))!;
    expect(a.last_price).toBe(150);
    expect(a.currency).toBe("USD"); // a USD price never sits under a EUR label
  });
});

describe("whim price edits follow through to the linked goal", () => {
  it("updates the active goal's target amount", async () => {
    const { db } = await makeMemDb();
    const wid = await whims.createWhim(db, { name: "Camera", amount: 500, currency: "EUR" });
    const gid = await whims.startSavingForWhim(db, wid);
    await whims.updateWhim(db, wid, { amount: 800 });
    expect((await goals.getGoal(db, gid))!.target_amount).toBe(800);
  });
});

describe("income budgets are targets, not ceilings", () => {
  it("never reads as over, never fires an exceeded alert, and a direction change resets the alert band", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    const tid = await tags.createTag(db, { name: "Salary" });
    const bid = await budgets.createBudget(db, { tag_id: tid, amount: 1000, currency: "EUR", direction: "in", period: "monthly", start_date: "2026-05-01" });
    await movements.createMovement(db, { source_id: acct.id, amount: 2000, direction: "in", date: "2026-05-10", tagIds: [tid] });
    const [st] = await budgets.listBudgetStatuses(db, 0, "2026-05-15");
    expect(st.actual).toBe(2000);
    expect(st.status).toBe("ok");
    expect(await budgets.checkBudgetAlerts(db, "2026-05-15")).toBe(0);

    await db.execute(`UPDATE budgets SET last_alert_period = '2026-05', last_alert_level = 100 WHERE id = ?`, [bid]);
    await budgets.updateBudget(db, bid, { direction: "out" });
    const row = (await budgets.getBudget(db, bid))!;
    expect(row.last_alert_period).toBeNull();
    expect(row.last_alert_level).toBe(0);
  });
});

describe("applying a recurring rule answers its prompts", () => {
  it("marks the confirm prompt and reminder read so the next period can prompt again", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const rid = await recurring.createRecurring(db, { name: "Gym", amount: 10, direction: "out", currency: "EUR", frequency: "monthly", start_date: "2026-05-01", source_id: acct.id, apply_mode: "confirm" });
    await recurring.processDueRecurring(db, "2026-05-01"); // posts the "is due" prompt
    const before = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM notifications WHERE related_entity = ? AND is_read = 0`, [`recurring:${rid}#confirm`]);
    expect(before[0].c).toBe(1);
    await recurring.applyRecurringById(db, rid, {}, "2026-05-01");
    const after = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM notifications WHERE related_entity = ? AND is_read = 0`, [`recurring:${rid}#confirm`]);
    expect(after[0].c).toBe(0);
  });
});

describe("month-to-date comparison", () => {
  it("compares a month in progress against the same days of the previous month", async () => {
    const { previousRange } = await import("./repo/breakdown");
    expect(previousRange("2026-09-01", "2026-09-30", "2026-09-23")).toEqual({ from: "2026-08-01", to: "2026-08-23" });
    // Day 31 of a 30-day previous month clamps to its end.
    expect(previousRange("2026-05-01", "2026-05-31", "2026-05-31")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
    // A finished month still compares whole against whole.
    expect(previousRange("2026-05-01", "2026-05-31", "2026-09-23")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
    expect(previousRange("2026-05-01", "2026-05-31")).toEqual({ from: "2026-04-01", to: "2026-04-30" });
  });
});

describe("manual holding prices", () => {
  it("a note-only edit keeps the old 'priced at' stamp and writes no snapshot", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "Broker", currency: "EUR" });
    const pid = await portfolios.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await portfolios.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "X", quantity: 1, avg_cost: 1, currency: "EUR", manual_price: true, last_price: 5 });
    await db.execute(`UPDATE holdings SET last_price_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, [hid]);
    await db.execute(`DELETE FROM holding_price_snapshots`);
    await portfolios.updateHolding(db, hid, { note: "hello", last_price: 5, manual_price: true });
    expect((await portfolios.getHolding(db, hid))!.last_price_at).toBe("2020-01-01T00:00:00.000Z");
    expect((await db.select<{ c: number }>(`SELECT COUNT(*) c FROM holding_price_snapshots`))[0].c).toBe(0);
    await portfolios.updateHolding(db, hid, { last_price: 6, manual_price: true });
    expect((await portfolios.getHolding(db, hid))!.last_price_at).not.toBe("2020-01-01T00:00:00.000Z");
    expect((await db.select<{ c: number }>(`SELECT COUNT(*) c FROM holding_price_snapshots`))[0].c).toBe(1);
  });
});
