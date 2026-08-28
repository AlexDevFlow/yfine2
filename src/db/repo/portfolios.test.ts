import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { addDaysISO, todayISO } from "@/lib/date";
import { createSource } from "./sources";
import { upsertRate } from "./exchange-rates";
import * as pf from "./portfolios";

describe("holding valuation", () => {
  it("PnL is null (not 0) when cost basis is 0; computed otherwise", () => {
    const base = {
      id: 1, portfolio_id: 1, asset_class: "stock" as const, symbol: "X", display_name: null,
      currency: "EUR", last_price_at: null, manual_price: 1, note: null, chain: null, address: null, created_at: "t", updated_at: "t",
    };
    const free = pf.enrichHolding({ ...base, quantity: 10, avg_cost: 0, last_price: 5 });
    expect(free.cost_basis).toBe(0);
    expect(free.market_value).toBe(50);
    expect(free.unrealized_pnl).toBeNull(); // cost unknown ≠ no profit

    const priced = pf.enrichHolding({ ...base, quantity: 10, avg_cost: 4, last_price: 5 });
    expect(priced.cost_basis).toBe(40);
    expect(priced.unrealized_pnl).toBe(10);
    expect(priced.unrealized_pnl_pct).toBe(25);

    const unpriced = pf.enrichHolding({ ...base, quantity: 10, avg_cost: 4, last_price: null });
    expect(unpriced.market_value).toBeNull();
    expect(unpriced.unrealized_pnl).toBeNull();
  });

  it("exposes the absolute PnL money amount alongside the percentage", () => {
    const base = {
      id: 1, portfolio_id: 1, asset_class: "stock" as const, symbol: "X", display_name: null,
      currency: "EUR", last_price_at: null, manual_price: 1, note: null, chain: null, address: null, created_at: "t", updated_at: "t",
    };
    // gain: 100 qty @ avg 1.50 (cost 150) now 1.60 (value 160) → +10.00 (+6.67%)
    const gain = pf.enrichHolding({ ...base, quantity: 100, avg_cost: 1.5, last_price: 1.6 });
    expect(gain.unrealized_pnl).toBe(10);
    expect(gain.unrealized_pnl_pct).toBe(6.67);
    // loss is negative money, not just a negative pct
    const loss = pf.enrichHolding({ ...base, quantity: 100, avg_cost: 2, last_price: 1.5 });
    expect(loss.unrealized_pnl).toBe(-50);
    // no cost basis → money figure is null (not 0), so the UI can show "—"
    const noCost = pf.enrichHolding({ ...base, quantity: 5, avg_cost: 0, last_price: 3 });
    expect(noCost.unrealized_pnl).toBeNull();
    expect(noCost.unrealized_pnl_pct).toBeNull();
  });
});

describe("portfolio summary", () => {
  it("falls back to cost basis for unpriced holdings", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 10, avg_cost: 3, currency: "EUR", manual_price: true, last_price: 5 });
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "BBB", quantity: 2, avg_cost: 20, currency: "EUR" }); // unpriced
    const sum = await pf.summarizePortfolio(db, pid);
    // AAA: value 50, cost 30 ; BBB unpriced → contributes cost 40
    expect(sum.total_value).toBe(90);
    expect(sum.total_cost).toBe(70);
    expect(sum.total_pnl).toBe(20); // only AAA has pnl
  });

  it("preserves last_price when the patch omits it (benign-edit regression)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 10, avg_cost: 3, currency: "EUR", manual_price: true, last_price: 5 });
    // A benign edit (note/quantity) that doesn't include last_price must NOT wipe it.
    await pf.updateHolding(db, hid, { note: "rebalanced", quantity: 12 });
    const h = await pf.getHolding(db, hid);
    expect(h!.last_price).toBe(5);
    // Turning manual OFF still clears it so the next auto-refresh takes over.
    await pf.updateHolding(db, hid, { manual_price: false });
    expect((await pf.getHolding(db, hid))!.last_price).toBeNull();
  });

  it("portfoliosView aggregates totals, per-holding weights, and asset-class allocation", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 10, avg_cost: 3, currency: "EUR", manual_price: true, last_price: 5 }); // value 50, cost 30
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "BBB", quantity: 2, avg_cost: 20, currency: "EUR", manual_price: true, last_price: 30 }); // value 60, cost 40

    const view = await pf.portfoliosView(db);
    const o = view.overview!;
    expect(o.displayCurrency).toBe("EUR");
    expect(o.total_value).toBe(110);
    expect(o.total_cost).toBe(70);
    expect(o.total_pnl).toBe(40);
    expect(o.holding_count).toBe(2);
    // Allocation is largest-first: crypto 60 then stock 50.
    expect(o.allocation.map((a) => a.key)).toEqual(["crypto", "stock"]);
    expect(o.allocation[0].value).toBe(60);
    expect(o.allocation[0].pct).toBe(54.55);

    const holds = view.portfolios[0].holdings;
    const aaa = holds.find((h) => h.symbol === "AAA")!;
    expect(aaa.base_value).toBe(50);
    expect(aaa.weight_pct).toBe(45.45);
  });

  it("converts mixed-currency holdings to the base currency (BUG-1 fix)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    await upsertRate(db, "USD", "EUR", 0.9);
    // a USD-priced holding worth $100 → should count as €90 in an EUR portfolio
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "USX", quantity: 10, avg_cost: 8, currency: "USD", manual_price: true, last_price: 10 });
    const sum = await pf.summarizePortfolio(db, pid);
    expect(sum.total_value).toBe(90); // $100 × 0.9, NOT 100
    expect(sum.total_cost).toBe(72); // $80 × 0.9
    expect(sum.has_unconverted).toBe(false);
  });

  it("flags unconverted when a rate is missing", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "BTC", quantity: 1, avg_cost: 100, currency: "GBP", manual_price: true, last_price: 200 });
    const sum = await pf.summarizePortfolio(db, pid);
    expect(sum.has_unconverted).toBe(true); // no GBP→EUR rate
  });
});

describe("snapshots", () => {
  it("writes one per (holding,date) and replaces only on price change", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 1, avg_cost: 1, currency: "EUR", manual_price: true, last_price: 5 });
    // create-time snapshot
    let snaps = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM holding_price_snapshots WHERE holding_id = ?`, [hid]);
    expect(snaps[0].c).toBe(1);
    // update price same day → replaces in place (still 1)
    await pf.updateHolding(db, hid, { manual_price: true, last_price: 7 });
    snaps = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM holding_price_snapshots WHERE holding_id = ?`, [hid]);
    expect(snaps[0].c).toBe(1);
    const price = await db.select<{ price: number }>(`SELECT price FROM holding_price_snapshots WHERE holding_id = ?`, [hid]);
    expect(price[0].price).toBe(7);
  });

  it("turning manual price off clears the price", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 1, avg_cost: 1, currency: "EUR", manual_price: true, last_price: 5 });
    await pf.updateHolding(db, hid, { manual_price: false });
    const h = (await pf.getHolding(db, hid))!;
    expect(h.last_price).toBeNull();
    expect(h.manual_price).toBe(0);
  });
});

describe("invested total", () => {
  it("sums cost basis across holdings; unknown-cost holdings contribute 0", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    // 3 @ 10 = 30 invested
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 3, avg_cost: 10, currency: "EUR", manual_price: true, last_price: 12 });
    // 2 @ 25 = 50 invested
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "BBB", quantity: 2, avg_cost: 25, currency: "EUR" });
    // free/unknown cost → contributes 0 to invested
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "FREE", quantity: 100, avg_cost: 0, currency: "EUR", manual_price: true, last_price: 1 });
    const sum = await pf.summarizePortfolio(db, pid);
    expect(sum.total_cost).toBe(80); // 30 + 50 + 0
  });
});

// Helper: insert a snapshot at an explicit date (the repo upsert only writes "today").
async function snap(db: import("../types").SqlExecutor, holdingId: number, date: string, price: number) {
  await db.execute(
    `INSERT INTO holding_price_snapshots (holding_id,date,price,created_at) VALUES (?,?,?,?)`,
    [holdingId, date, price, `${date}T00:00:00`],
  );
}

describe("holdingPriceHistory", () => {
  it("returns [] when the holding has no snapshots", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 2, avg_cost: 3, currency: "EUR" });
    expect(await pf.holdingPriceHistory(db, hid, 30)).toEqual([]);
  });

  it("emits {date, price, value} per day from the first snapshot, carrying the last price forward", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", source_id: s.id });
    const today = todayISO();
    const d0 = addDaysISO(today, -2);
    const d1 = addDaysISO(today, -1);
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAA", quantity: 2, avg_cost: 3, currency: "EUR" });
    await snap(db, hid, d0, 5);
    await snap(db, hid, d1, 6);
    const hist = await pf.holdingPriceHistory(db, hid, 365);
    expect(hist[0]).toEqual({ date: d0, price: 5, value: 10 });
    expect(hist[1]).toEqual({ date: d1, price: 6, value: 12 });
    // today: carries d1's price forward (6) → value 12
    expect(hist[hist.length - 1]).toEqual({ date: today, price: 6, value: 12 });
  });
});

describe("portfolioValueBySourceOverTime", () => {
  it("uses latest snapshot ≤ date, falls back to avg_cost, currency-matched only", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const today = todayISO();
    const d0 = addDaysISO(today, -2);
    // EUR portfolio (matches source) — counted
    const pidE = await pf.createPortfolio(db, { name: "PE", base_currency: "EUR", source_id: s.id });
    const hE = await pf.createHolding(db, { portfolio_id: pidE, asset_class: "stock", symbol: "EU", quantity: 2, avg_cost: 4, currency: "EUR" });
    await snap(db, hE, d0, 5); // value 10 from d0 on
    // USD portfolio on the same source — excluded (base_currency != source.currency)
    const pidU = await pf.createPortfolio(db, { name: "PU", base_currency: "USD", source_id: s.id });
    await pf.createHolding(db, { portfolio_id: pidU, asset_class: "stock", symbol: "US", quantity: 10, avg_cost: 100, currency: "USD", manual_price: true, last_price: 100 });

    const before = addDaysISO(today, -5);
    const out = await pf.portfolioValueBySourceOverTime(db, s.id, [before, d0, today]);
    expect(out[before]).toBe(8); // no snapshot yet → avg_cost fallback 2*4
    expect(out[d0]).toBe(10); // snapshot price 5
    expect(out[today]).toBe(10); // carried forward; USD portfolio NOT added
  });

  it("returns zeros for every date when the source has no matching holdings", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Empty", currency: "EUR" });
    const today = todayISO();
    const out = await pf.portfolioValueBySourceOverTime(db, s.id, [today]);
    expect(out).toEqual({ [today]: 0 });
  });
});

describe("valueBySource (sources page shows portfolio money too)", () => {
  it("attributes portfolio value to its source, converted into that source's currency", async () => {
    const { db } = await makeMemDb();
    const src = await createSource(db, { name: "Kraken", currency: "EUR", starting_balance: 0 });
    const portfolioId = await pf.createPortfolio(db, { name: "Crypto", kind: "crypto", base_currency: "USD", source_id: src.id });
    await pf.createHolding(db, {
      portfolio_id: portfolioId, asset_class: "crypto", symbol: "BTC", quantity: 2,
      avg_cost: 100, currency: "USD", manual_price: true, last_price: 200,
    });
    await upsertRate(db, "EUR", "USD", 1.25); // 400 USD -> 320 EUR

    const map = await pf.valueBySource(db);
    expect(map.get(src.id)).toEqual({ value: 320, unconverted: false });
  });

  it("flags a source whose portfolio currency has no rate rather than mixing currencies", async () => {
    const { db } = await makeMemDb();
    const src = await createSource(db, { name: "Bank", currency: "EUR", starting_balance: 0 });
    const portfolioId = await pf.createPortfolio(db, { name: "US stocks", kind: "stocks", base_currency: "USD", source_id: src.id });
    await pf.createHolding(db, {
      portfolio_id: portfolioId, asset_class: "stock", symbol: "AAPL", quantity: 1,
      avg_cost: 100, currency: "USD", manual_price: true, last_price: 150,
    });

    expect(await pf.valueBySource(db)).toEqual(new Map([[src.id, { value: 0, unconverted: true }]]));
  });
});
