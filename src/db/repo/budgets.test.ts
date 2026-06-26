import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import type { SqlExecutor } from "../types";
import { createSource } from "./sources";
import { createMovement, createTransfer } from "./movements";
import { addMonthsISO, monthStart, todayISO } from "@/lib/date";
import { runScheduler } from "./scheduler";
import { listNotifications } from "./notifications";
import * as bud from "./budgets";

async function tag(db: SqlExecutor, name: string) {
  return (await db.select<{ id: number }>(`INSERT INTO tags (name,created_at,updated_at) VALUES (?,?,?) RETURNING id`, [name, "t", "t"]))[0].id;
}

describe("budget actuals", () => {
  it("sums tagged, same-currency, in-period, non-transfer, non-excluded movements", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    const usd = await createSource(db, { name: "USD", currency: "USD", starting_balance: 1000 });
    const food = await tag(db, "Food");
    const today = todayISO();
    const inMonth = monthStart(today);

    await createMovement(db, { source_id: eur.id, amount: 30, direction: "out", date: inMonth, tagIds: [food] });
    await createMovement(db, { source_id: eur.id, amount: 12, direction: "out", date: today, tagIds: [food] });
    await createMovement(db, { source_id: usd.id, amount: 99, direction: "out", date: today, tagIds: [food] }); // wrong currency
    await createMovement(db, { source_id: eur.id, amount: 5, direction: "in", date: today, tagIds: [food] }); // wrong direction
    await createMovement(db, { source_id: null, amount: 7, direction: "out", date: today, tagIds: [food] }); // external
    await createTransfer(db, { fromSourceId: eur.id, toSourceId: usd.id, amount: 50, date: today }); // transfer

    const id = await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR", period: "monthly" });
    const st = await bud.budgetStatus(db, (await bud.getBudget(db, id))!, today);
    expect(st.actual).toBe(42); // 30 + 12 only
    expect(st.available).toBe(100);
    expect(st.remaining).toBe(58);
    expect(st.status).toBe("ok");
  });

  it("carries signed rollover across periods", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 10000 });
    const food = await tag(db, "Food");
    const today = todayISO();
    const m2 = addMonthsISO(monthStart(today), -2);
    const m1 = addMonthsISO(monthStart(today), -1);
    await createMovement(db, { source_id: eur.id, amount: 30, direction: "out", date: m2, tagIds: [food] });
    await createMovement(db, { source_id: eur.id, amount: 150, direction: "out", date: m1, tagIds: [food] });

    const id = await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR", period: "monthly", rollover: true, start_date: m2 });
    const st = await bud.budgetStatus(db, (await bud.getBudget(db, id))!, today);
    // m2: 100-30=+70 ; m1: 100+70-150=-... = 20 ; current available = 100 + 20 = 120
    expect(st.rolloverIn).toBe(20);
    expect(st.available).toBe(120);
  });

  it("reports 'over' even when rollover makes available negative (BUG-1 fix)", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 10000 });
    const food = await tag(db, "Food");
    const today = todayISO();
    const m1 = addMonthsISO(monthStart(today), -1);
    await createMovement(db, { source_id: eur.id, amount: 500, direction: "out", date: m1, tagIds: [food] }); // huge overspend
    await createMovement(db, { source_id: eur.id, amount: 50, direction: "out", date: today, tagIds: [food] });

    const id = await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR", period: "monthly", rollover: true, start_date: m1 });
    const st = await bud.budgetStatus(db, (await bud.getBudget(db, id))!, today);
    expect(st.available).toBeLessThanOrEqual(0);
    expect(st.status).toBe("over"); // would have been "ok"/"warning" before the fix
  });

  it("fires the overspend alert even when rollover makes available <= 0 (BUG-1 alert half)", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 10000 });
    const food = await tag(db, "Food");
    const today = todayISO();
    const m1 = addMonthsISO(monthStart(today), -1);
    await createMovement(db, { source_id: eur.id, amount: 500, direction: "out", date: m1, tagIds: [food] }); // drives rollover negative
    await createMovement(db, { source_id: eur.id, amount: 50, direction: "out", date: today, tagIds: [food] });
    await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR", period: "monthly", rollover: true, start_date: m1, alert_threshold_pct: 80 });
    // Before the fix the alert path gated on available > 0 and returned 0 here.
    expect(await bud.checkBudgetAlerts(db, today)).toBe(1);
    expect(await bud.checkBudgetAlerts(db, today)).toBe(0); // idempotent
  });

  it("rejects a duplicate active (tag,currency); allows inactive + other currency", async () => {
    const { db } = await makeMemDb();
    const food = await tag(db, "Food");
    await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR" });
    await expect(bud.createBudget(db, { tag_id: food, amount: 50, currency: "EUR" })).rejects.toMatchObject({ code: "duplicate_budget" });
    await bud.createBudget(db, { tag_id: food, amount: 50, currency: "EUR", active: false }); // inactive ok
    await bud.createBudget(db, { tag_id: food, amount: 50, currency: "USD" }); // other currency ok
  });

  it("fires threshold then overspend alerts once each (idempotent bands)", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 10000 });
    const food = await tag(db, "Food");
    const today = todayISO();
    await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR", period: "monthly", alert_threshold_pct: 80 });

    await createMovement(db, { source_id: eur.id, amount: 85, direction: "out", date: today, tagIds: [food] });
    expect(await bud.checkBudgetAlerts(db, today)).toBe(1); // threshold band
    expect(await bud.checkBudgetAlerts(db, today)).toBe(0); // idempotent

    await createMovement(db, { source_id: eur.id, amount: 30, direction: "out", date: today, tagIds: [food] });
    expect(await bud.checkBudgetAlerts(db, today)).toBe(1); // overspend band
    expect(await bud.checkBudgetAlerts(db, today)).toBe(0);
  });

  it("deletes budgets for a tag", async () => {
    const { db } = await makeMemDb();
    const food = await tag(db, "Food");
    await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR" });
    await bud.deleteBudgetsForTag(db, food);
    expect((await bud.listBudgetStatuses(db)).length).toBe(0);
  });

  it("anchors pace to the real today, not the viewed period (gap #3)", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 10000 });
    const food = await tag(db, "Food");
    const today = todayISO();
    const last = addMonthsISO(monthStart(today), -1);
    const next = addMonthsISO(monthStart(today), 1);
    await createMovement(db, { source_id: eur.id, amount: 40, direction: "out", date: last, tagIds: [food] });
    await createMovement(db, { source_id: eur.id, amount: 60, direction: "out", date: next, tagIds: [food] });
    const b = (await bud.getBudget(db, await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR", period: "monthly" })))!;

    // Past period: today is after its end → fully elapsed (no days remaining),
    // and projected equals the actual (whole period already elapsed).
    const past = await bud.budgetStatus(db, b, last, today);
    expect(past.daysRemaining).toBe(0);
    expect(past.elapsedPct).toBe(100);
    expect(past.projected).toBe(past.actual);
    expect(past.actual).toBe(40);

    // Future period: today is before its start → nothing elapsed, full period remaining, no projection.
    const future = await bud.budgetStatus(db, b, next, today);
    expect(future.projected).toBe(0);
    expect(future.elapsedPct).toBe(0);
    const [fs, fe] = [future.periodStart, future.periodEnd];
    const totalDays = Math.round((Date.parse(fe) - Date.parse(fs)) / 86400000) + 1;
    expect(future.daysRemaining).toBe(totalDays);
  });

  it("computes daily_remaining = remaining/daysRemaining within the period (gap #7)", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 10000 });
    const food = await tag(db, "Food");
    const today = todayISO();
    const b = (await bud.getBudget(db, await bud.createBudget(db, { tag_id: food, amount: 70, currency: "EUR", period: "weekly" })))!;
    await createMovement(db, { source_id: eur.id, amount: 14, direction: "out", date: today, tagIds: [food] });
    const st = await bud.budgetStatus(db, b, today, today);
    if (st.daysRemaining > 0) {
      expect(st.dailyRemaining).toBe(Math.round((st.remaining / st.daysRemaining) * 100) / 100);
    } else {
      // Period's last day: no days remain → no per-day allowance.
      expect(st.dailyRemaining).toBe(0);
    }
  });

  it("hides inactive budgets by default; updateBudget can deactivate (gap #2)", async () => {
    const { db } = await makeMemDb();
    const food = await tag(db, "Food");
    const id = await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR" });
    expect((await bud.listBudgetStatuses(db)).length).toBe(1);

    await bud.updateBudget(db, id, { active: false });
    expect((await bud.listBudgetStatuses(db)).length).toBe(0); // hidden by default
    expect((await bud.listBudgetStatuses(db, 0, todayISO(), false)).length).toBe(1); // shown when asked

    // Deactivating frees the (tag,currency) slot so a new active one is allowed.
    await bud.createBudget(db, { tag_id: food, amount: 50, currency: "EUR" });
    expect((await bud.listBudgetStatuses(db)).length).toBe(1);
  });

  it("rejects an unknown currency code on create and update (gap #9)", async () => {
    const { db } = await makeMemDb();
    const food = await tag(db, "Food");
    await expect(bud.createBudget(db, { tag_id: food, amount: 10, currency: "XYZ" })).rejects.toMatchObject({ code: "invalid_currency" });
    await expect(bud.createBudget(db, { tag_id: food, amount: 10, currency: "E" })).rejects.toMatchObject({ code: "invalid_currency" });
    const id = await bud.createBudget(db, { tag_id: food, amount: 10, currency: "eur" }); // normalized
    expect((await bud.getBudget(db, id))!.currency).toBe("EUR");
    await expect(bud.updateBudget(db, id, { currency: "NOPE" })).rejects.toMatchObject({ code: "invalid_currency" });
  });

  it("runScheduler fires budget alerts at boot (gap #1 wiring)", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 10000 });
    const food = await tag(db, "Food");
    const today = todayISO();
    await bud.createBudget(db, { tag_id: food, amount: 100, currency: "EUR", period: "monthly", alert_threshold_pct: 80 });
    await createMovement(db, { source_id: eur.id, amount: 130, direction: "out", date: today, tagIds: [food] }); // overspent

    const res = await runScheduler(db, today);
    expect(res.alerts).toBe(1);
    const notes = await listNotifications(db, { limit: 50 });
    expect(notes.some((n) => n.related_entity === `budget:1` && /exceeded/i.test(n.body))).toBe(true);

    // Idempotent: a second tick fires nothing new.
    expect((await runScheduler(db, today)).alerts).toBe(0);
  });
});
