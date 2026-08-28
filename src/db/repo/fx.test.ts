/**
 * Exchange-rate refresh tests. The HTTP transport is mocked via setPriceTransport
 * so NO test touches the network. Covers: Frankfurter parse + host fallback, the
 * star-shaped write (one row per currency, every other pair derived), crypto
 * quoting, direction preservation for hand-entered pairs, the unsupported-currency
 * report, and the offline path leaving saved rates untouched.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "./sources";
import { getRate, listRates, upsertRate } from "./exchange-rates";
import { updateSettings } from "./settings";
import { clearPriceCache, setPriceTransport, type PriceTransport } from "./prices";
import { fetchFiatRates, pickPivot, refreshRates, usedCurrencies } from "./fx";
import { maybeRefreshRates, resetRateRefreshThrottle } from "./scheduler";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

/** Install a transport mapping url-substring → response, recording every call. */
function mockTransport(routes: { match: string; body: unknown; ok?: boolean }[]): { calls: string[] } {
  const calls: string[] = [];
  const t: PriceTransport = async (url) => {
    calls.push(url);
    for (const r of routes) {
      if (url.includes(r.match)) return jsonResponse(r.body, r.ok ?? true);
    }
    return jsonResponse(null, false);
  };
  setPriceTransport(t);
  return { calls };
}

afterEach(() => {
  setPriceTransport(null);
  clearPriceCache();
});

describe("fetchFiatRates", () => {
  it("parses the Frankfurter payload and drops non-numeric entries", async () => {
    mockTransport([{ match: "frankfurter", body: { base: "EUR", rates: { USD: 1.09, GBP: 0.85, XXX: "n/a" } } }]);
    expect(await fetchFiatRates("EUR", ["USD", "GBP"])).toEqual({ USD: 1.09, GBP: 0.85 });
  });

  it("falls back to the legacy host when the current one is down", async () => {
    const { calls } = mockTransport([
      { match: "frankfurter.dev", body: null, ok: false },
      { match: "frankfurter.app", body: { rates: { USD: 1.09 } } },
    ]);
    expect(await fetchFiatRates("EUR", ["USD"])).toEqual({ USD: 1.09 });
    expect(calls).toHaveLength(2);
  });

  it("returns null when every host fails, and never calls out for an unquoted base", async () => {
    mockTransport([{ match: "frankfurter", body: null, ok: false }]);
    expect(await fetchFiatRates("EUR", ["USD"])).toBeNull();
    const { calls } = mockTransport([]);
    expect(await fetchFiatRates("BTC", ["USD"])).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("usedCurrencies / pickPivot", () => {
  it("collects every currency money actually sits in", async () => {
    const { db } = await makeMemDb();
    await createSource(db, { name: "EUR account", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "USD account", currency: "USD", starting_balance: 0 });
    await updateSettings(db, { base_currency: "GBP" });
    expect(await usedCurrencies(db)).toEqual(["EUR", "GBP", "USD"]);
  });

  it("quotes against the user's base currency, else a used fiat, else EUR", () => {
    expect(pickPivot(["USD", "CHF"], "GBP")).toBe("GBP");
    expect(pickPivot(["USD", "CHF"], "BTC")).toBe("USD"); // base not quoted by the provider
    expect(pickPivot(["BTC"], null)).toBe("EUR");
  });
});

describe("refreshRates", () => {
  it("stores one row per currency and derives every other pair from them", async () => {
    const { db } = await makeMemDb();
    await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    await createSource(db, { name: "GBP", currency: "GBP", starting_balance: 0 });
    await updateSettings(db, { base_currency: "EUR" });
    const { calls } = mockTransport([{ match: "frankfurter", body: { rates: { USD: 1.25, GBP: 0.8 } } }]);

    const res = await refreshRates(db);
    expect(res).toMatchObject({ updated: 2, pivot: "EUR", unsupported: [], offline: false });
    expect(calls).toHaveLength(1); // the whole star in one request

    expect(await getRate(db, "EUR", "USD")).toBe(1.25);
    expect(await getRate(db, "USD", "EUR")).toBeCloseTo(0.8, 10); // inverse
    expect(await getRate(db, "USD", "GBP")).toBeCloseTo(0.64, 10); // chained via EUR
  });

  it("quotes crypto against the pivot so a BTC holding can be valued", async () => {
    const { db } = await makeMemDb();
    await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await db.execute(
      `INSERT INTO portfolios (name,kind,base_currency,source_id,created_at,updated_at) VALUES ('P','crypto','EUR',1,'2026-01-01','2026-01-01')`,
    );
    await db.execute(
      `INSERT INTO holdings (portfolio_id,symbol,asset_class,quantity,avg_cost,currency,manual_price,created_at,updated_at)
       VALUES (1,'BTC','crypto',1,10000,'BTC',0,'2026-01-01','2026-01-01')`,
    );
    mockTransport([{ match: "simple/price", body: { bitcoin: { eur: 61000 } } }]);

    const res = await refreshRates(db);
    expect(res.updated).toBe(1);
    expect(await getRate(db, "BTC", "EUR")).toBe(61000);
  });

  it("updates a hand-entered pair in place instead of writing its mirror", async () => {
    const { db } = await makeMemDb();
    await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    await updateSettings(db, { base_currency: "EUR" });
    await upsertRate(db, "USD", "EUR", 0.5); // stale, wrong way round vs the pivot
    mockTransport([{ match: "frankfurter", body: { rates: { USD: 1.25 } } }]);

    await refreshRates(db);
    const rows = await listRates(db);
    // One row, still USD→EUR — a second EUR→USD row would be shadowed by this one.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_currency: "USD", to_currency: "EUR" });
    expect(rows[0].rate).toBeCloseTo(0.8, 10);
    expect(await getRate(db, "EUR", "USD")).toBeCloseTo(1.25, 10);
  });

  it("reports currencies no provider quotes instead of silently skipping them", async () => {
    const { db } = await makeMemDb();
    await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "Doubloons", currency: "XDB", starting_balance: 0 });
    await updateSettings(db, { base_currency: "EUR" });
    mockTransport([{ match: "frankfurter", body: { rates: {} } }]);

    const res = await refreshRates(db);
    expect(res.unsupported).toEqual(["XDB"]);
  });

  it("leaves saved rates untouched when the provider is unreachable", async () => {
    const { db } = await makeMemDb();
    await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    await updateSettings(db, { base_currency: "EUR" });
    await upsertRate(db, "EUR", "USD", 1.1);
    mockTransport([{ match: "frankfurter", body: null, ok: false }]);

    const res = await refreshRates(db);
    expect(res).toMatchObject({ updated: 0, offline: true });
    expect(await getRate(db, "EUR", "USD")).toBe(1.1);
  });
});

describe("maybeRefreshRates (background schedule)", () => {
  it("does nothing while live prices are off — the network opt-in gates FX too", async () => {
    const { db } = await makeMemDb();
    resetRateRefreshThrottle();
    await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    const { calls } = mockTransport([{ match: "frankfurter", body: { rates: { USD: 1.25 } } }]);

    expect(await maybeRefreshRates(db)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("refreshes once, then throttles until the rates go stale", async () => {
    const { db } = await makeMemDb();
    resetRateRefreshThrottle();
    await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    await updateSettings(db, { portfolio_prices_enabled: true, base_currency: "EUR" });
    mockTransport([{ match: "frankfurter", body: { rates: { USD: 1.25 } } }]);

    expect(await maybeRefreshRates(db)).toBe(1);
    expect(await maybeRefreshRates(db)).toBe(0); // < 12h old
  });

  it("backs off after a failed attempt instead of retrying on every tick", async () => {
    const { db } = await makeMemDb();
    resetRateRefreshThrottle();
    await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 0 });
    await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    await updateSettings(db, { portfolio_prices_enabled: true, base_currency: "EUR" });
    // Nothing gets written, so the DB timestamp can't throttle the next tick —
    // only the in-memory attempt guard can.
    const { calls } = mockTransport([{ match: "frankfurter", body: null, ok: false }]);

    expect(await maybeRefreshRates(db)).toBe(0);
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await maybeRefreshRates(db)).toBe(0);
    expect(calls).toHaveLength(afterFirst); // no second round of requests
  });
});
