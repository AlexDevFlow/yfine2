import { describe, it, expect } from "vitest";
import { makeMemDb, addMovement } from "@/test/sqlite";
import { addDaysISO, todayISO } from "@/lib/date";
import { createSource } from "./sources";
import * as pf from "./portfolios";
import { netWorthHistoryAll, sourceBalanceHistory } from "./history";

async function snap(db: import("../types").SqlExecutor, holdingId: number, date: string, price: number) {
  await db.execute(
    `INSERT INTO holding_price_snapshots (holding_id,date,price,created_at) VALUES (?,?,?,?)`,
    [holdingId, date, price, `${date}T00:00:00`],
  );
}

describe("sourceBalanceHistory", () => {
  it("stays cash-only when the source has no linked portfolio snapshots", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Cash", currency: "EUR", starting_balance: 100 });
    await addMovement(db, s.id, "in", 50, "2026-01-10");
    const hist = await sourceBalanceHistory(db, s.id);
    expect(hist[hist.length - 1]?.value).toBe(150);
  });

  it("folds linked-portfolio market value into the source balance over time", async () => {
    const { db } = await makeMemDb();
    const today = todayISO();
    const d0 = addDaysISO(today, -3);
    const s = await createSource(db, { name: "Brokerage", currency: "EUR", starting_balance: 100 });
    // cash movement: +20 on d0 → cash 120 from d0 onward
    await addMovement(db, s.id, "in", 20, d0);
    // EUR portfolio linked to the source with a snapshot worth 50 on d0
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 10, avg_cost: 4, currency: "EUR" });
    await snap(db, hid, d0, 5); // value 10*5 = 50

    const hist = await sourceBalanceHistory(db, s.id);
    const last = hist[hist.length - 1];
    expect(last.date).toBe(today);
    expect(last.cash).toBe(120);
    expect(last.portfolios).toBe(50);
    expect(last.value).toBe(170); // cash 120 + portfolio MTM 50
  });

  it("uses the avg_cost fallback for portfolio value before any snapshot exists", async () => {
    const { db } = await makeMemDb();
    const today = todayISO();
    const future = today; // snapshot only today; earlier dates fall back to avg_cost
    const earlier = addDaysISO(today, -2);
    const s = await createSource(db, { name: "Brokerage", currency: "EUR", starting_balance: 0 });
    // a movement at `earlier` to force that date into the series
    await addMovement(db, s.id, "in", 0, earlier);
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 2, avg_cost: 7, currency: "EUR" });
    await snap(db, hid, future, 10); // value 20 today

    const hist = await sourceBalanceHistory(db, s.id);
    const earlyPoint = hist.find((p) => p.date === earlier)!;
    expect(earlyPoint.portfolios).toBe(14); // avg_cost fallback 2*7
    expect(hist[hist.length - 1]?.portfolios).toBe(20); // today: real snapshot 2*10
  });
});

describe("netWorthHistoryAll (multi-currency, gap 2)", () => {
  it("returns one series per currency forward-filled over the union of dates", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    const usd = await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    await addMovement(db, eur.id, "in", 100, "2026-01-10");
    await addMovement(db, usd.id, "in", 50, "2026-02-10");

    const series = await netWorthHistoryAll(db);
    expect(series.map((s) => s.currency).sort()).toEqual(["EUR", "USD"]);
    // All series share the same aligned x-axis (union of dates).
    const lens = new Set(series.map((s) => s.points.length));
    expect(lens.size).toBe(1);
    const dates = series.map((s) => s.points.map((p) => p.date));
    expect(dates[0]).toEqual(dates[1]);
    // Forward-fill: EUR holds 100 at and after the USD-only date.
    const eurSeries = series.find((s) => s.currency === "EUR")!;
    expect(eurSeries.points[eurSeries.points.length - 1].value).toBe(100);
    const usdSeries = series.find((s) => s.currency === "USD")!;
    expect(usdSeries.points[usdSeries.points.length - 1].value).toBe(50);
    // Before its first movement, USD forward-fills its opening value (0).
    expect(usdSeries.points[0].value).toBe(0);
  });
});
