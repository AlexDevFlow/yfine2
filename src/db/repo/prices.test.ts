/**
 * Live price-fetch tests. The HTTP transport is mocked via setPriceTransport so
 * NO test ever touches the network. Covers: CoinGecko id-map + /search fallback,
 * crypto batch parse, Yahoo chart parse (+ close fallback), the 10-min TTL cache
 * (hit + expiry), refreshHolding skipping manual_price, refreshAllHoldings gating
 * (off → 0; on → writes prices + snapshots), and the boot throttle logic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "./sources";
import * as pf from "./portfolios";
import { updateSettings } from "./settings";
import { maybeRefreshPrices } from "./scheduler";
import {
  clearPriceCache,
  coingeckoIdFor,
  fetchCryptoPrice,
  fetchCryptoPricesBatch,
  fetchStockPrice,
  fetchAddressBalance,
  refreshAllHoldings,
  refreshHolding,
  searchAssets,
  setPriceTransport,
  type PriceTransport,
} from "./prices";

/** A fake Response wrapping a JSON body. */
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

/** Install a transport that maps url-substring → response, recording calls. */
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
  vi.useRealTimers();
});

describe("coingeckoIdFor", () => {
  it("uses the built-in id map without any network call for known symbols", async () => {
    const { calls } = mockTransport([]);
    expect(await coingeckoIdFor("BTC")).toBe("bitcoin");
    expect(await coingeckoIdFor("eth")).toBe("ethereum"); // case-insensitive
    expect(calls.length).toBe(0); // map hit → no /search
  });

  it("falls back to /search and matches the coin whose symbol equals the query", async () => {
    const { calls } = mockTransport([
      { match: "/search", body: { coins: [{ id: "wrong-coin", symbol: "XX" }, { id: "pepe", symbol: "PEPE" }] } },
    ]);
    expect(await coingeckoIdFor("PEPE")).toBe("pepe");
    expect(calls.some((u) => u.includes("/search?query=PEPE"))).toBe(true);
  });

  it("returns null when /search has no symbol match", async () => {
    mockTransport([{ match: "/search", body: { coins: [{ id: "other", symbol: "ZZ" }] } }]);
    expect(await coingeckoIdFor("NOPE")).toBeNull();
  });
});

describe("searchAssets (symbol autocomplete)", () => {
  it("returns nothing for a query under 2 chars (no network call)", async () => {
    const { calls } = mockTransport([]);
    expect(await searchAssets("crypto", "b")).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("maps CoinGecko /search coins to {symbol,name} for crypto", async () => {
    mockTransport([
      { match: "/search", body: { coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }, { id: "bitcoin-cash", symbol: "bch", name: "Bitcoin Cash" }] } },
    ]);
    const out = await searchAssets("crypto", "bitcoin");
    expect(out).toEqual([
      { symbol: "BTC", name: "Bitcoin" },
      { symbol: "BCH", name: "Bitcoin Cash" },
    ]);
  });

  it("maps Yahoo search quotes for stocks, filtering non-tradable types and keeping currency", async () => {
    mockTransport([
      {
        match: "/finance/search",
        body: {
          quotes: [
            { symbol: "AAPL", longname: "Apple Inc.", quoteType: "EQUITY", exchange: "NMS", currency: "USD" },
            { symbol: "SOMENEWS", quoteType: "NEWS" }, // dropped
            { symbol: "VWCE.DE", shortname: "Vanguard FTSE All-World", quoteType: "ETF", currency: "EUR" },
          ],
        },
      },
    ]);
    const out = await searchAssets("stock", "apple");
    expect(out).toEqual([
      { symbol: "AAPL", name: "Apple Inc.", currency: "USD", hint: "NMS" },
      { symbol: "VWCE.DE", name: "Vanguard FTSE All-World", currency: "EUR", hint: undefined },
    ]);
  });

  it("fails soft to [] when the endpoint errors", async () => {
    mockTransport([{ match: "/search", body: null, ok: false }]);
    expect(await searchAssets("crypto", "xyz")).toEqual([]);
  });
});

describe("fetchAddressBalance (on-chain native balance)", () => {
  it("BTC: blockstream funded-spent sats → BTC", async () => {
    mockTransport([{ match: "blockstream.info", body: { chain_stats: { funded_txo_sum: 150000000, spent_txo_sum: 50000000 } } }]);
    expect(await fetchAddressBalance("btc", "bc1qexample")).toBe(1); // (1.5 − 0.5) BTC
  });
  it("ETH: eth_getBalance wei (hex) → ETH", async () => {
    mockTransport([{ match: "ethereum-rpc.publicnode", body: { result: "0x1bc16d674ec80000" } }]); // 2e18 wei
    expect(await fetchAddressBalance("eth", "0xabc")).toBe(2);
  });
  it("SOL: getBalance lamports → SOL", async () => {
    mockTransport([{ match: "api.mainnet-beta.solana.com", body: { result: { value: 1500000000 } } }]);
    expect(await fetchAddressBalance("sol", "So1ana")).toBe(1.5);
  });
  it("returns null for an unknown chain or empty address", async () => {
    mockTransport([]);
    expect(await fetchAddressBalance("xrp", "r123")).toBeNull();
    expect(await fetchAddressBalance("btc", "   ")).toBeNull();
  });
});

describe("fetchCryptoPrice", () => {
  it("fetches via simple/price in the holding's vs_currency (lowercased)", async () => {
    const { calls } = mockTransport([{ match: "/simple/price", body: { bitcoin: { eur: 42000 } } }]);
    expect(await fetchCryptoPrice("BTC", "EUR")).toBe(42000);
    expect(calls.some((u) => u.includes("ids=bitcoin") && u.includes("vs_currencies=eur"))).toBe(true);
  });

  it("returns null on a missing price field (fail soft)", async () => {
    mockTransport([{ match: "/simple/price", body: { bitcoin: {} } }]);
    expect(await fetchCryptoPrice("BTC", "usd")).toBeNull();
  });

  it("returns null and never throws when the transport errors", async () => {
    setPriceTransport(async () => {
      throw new Error("network down");
    });
    expect(await fetchCryptoPrice("BTC", "usd")).toBeNull();
  });
});

describe("fetchCryptoPricesBatch", () => {
  it("joins ids into one call and parses each symbol's price", async () => {
    const { calls } = mockTransport([
      { match: "/simple/price", body: { bitcoin: { usd: 100 }, ethereum: { usd: 50 } } },
    ]);
    const out = await fetchCryptoPricesBatch(["BTC", "ETH"], "usd");
    expect(out).toEqual({ BTC: 100, ETH: 50 });
    // exactly one network call (batched), and it carried both ids
    const priceCalls = calls.filter((u) => u.includes("/simple/price"));
    expect(priceCalls.length).toBe(1);
    expect(priceCalls[0]).toContain("ids=bitcoin%2Cethereum");
  });

  it("skips symbols already in the cache", async () => {
    mockTransport([{ match: "/simple/price", body: { bitcoin: { usd: 100 } } }]);
    await fetchCryptoPrice("BTC", "usd"); // primes the cache
    const { calls } = mockTransport([{ match: "/simple/price", body: { ethereum: { usd: 50 } } }]);
    const out = await fetchCryptoPricesBatch(["BTC", "ETH"], "usd");
    expect(out).toEqual({ BTC: 100, ETH: 50 }); // BTC from cache
    expect(calls[0]).toContain("ids=ethereum"); // only the uncached id requested
    expect(calls[0]).not.toContain("bitcoin");
  });
});

describe("fetchStockPrice (Yahoo chart)", () => {
  it("reads chart.result[0].meta.regularMarketPrice", async () => {
    mockTransport([{ match: "finance/chart/AAPL", body: { chart: { result: [{ meta: { regularMarketPrice: 187.5 } }] } } }]);
    expect(await fetchStockPrice("AAPL")).toBe(187.5);
  });

  it("falls back to the last non-null close in indicators.quote[0].close", async () => {
    mockTransport([
      {
        match: "finance/chart/MSFT",
        body: { chart: { result: [{ meta: {}, indicators: { quote: [{ close: [10, 11, null, 12, null] }] } }] } },
      },
    ]);
    expect(await fetchStockPrice("MSFT")).toBe(12);
  });

  it("returns null when there is no usable price", async () => {
    mockTransport([{ match: "finance/chart/ZZZ", body: { chart: { result: [{ meta: {}, indicators: { quote: [{ close: [] }] } }] } } }]);
    expect(await fetchStockPrice("ZZZ")).toBeNull();
  });
});

describe("TTL cache", () => {
  it("serves a cache hit without a second network call", async () => {
    const { calls } = mockTransport([{ match: "/simple/price", body: { bitcoin: { usd: 100 } } }]);
    expect(await fetchCryptoPrice("BTC", "usd")).toBe(100);
    expect(await fetchCryptoPrice("BTC", "usd")).toBe(100);
    expect(calls.filter((u) => u.includes("/simple/price")).length).toBe(1); // cached the 2nd time
  });

  it("re-fetches once the 10-minute TTL has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { calls } = mockTransport([{ match: "/simple/price", body: { bitcoin: { usd: 100 } } }]);
    expect(await fetchCryptoPrice("BTC", "usd")).toBe(100);
    vi.setSystemTime(new Date("2026-01-01T00:11:00Z")); // +11 min > 10 min TTL
    expect(await fetchCryptoPrice("BTC", "usd")).toBe(100);
    expect(calls.filter((u) => u.includes("/simple/price")).length).toBe(2); // cache expired → refetched
  });
});

describe("refreshHolding", () => {
  it("skips manual-price holdings (returns false, no network)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "BTC", quantity: 1, avg_cost: 1, currency: "EUR", manual_price: true, last_price: 5 });
    const { calls } = mockTransport([{ match: "/simple/price", body: { bitcoin: { eur: 999 } } }]);
    expect(await refreshHolding(db, hid)).toBe(false);
    expect(calls.length).toBe(0);
    const h = await pf.getHolding(db, hid);
    expect(h?.last_price).toBe(5); // unchanged
  });

  it("fetches by asset_class, persists price + timestamp, and snapshots (crypto)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "BTC", quantity: 2, avg_cost: 1, currency: "EUR" });
    mockTransport([{ match: "/simple/price", body: { bitcoin: { eur: 30000 } } }]);
    expect(await refreshHolding(db, hid)).toBe(true);
    const h = await pf.getHolding(db, hid);
    expect(h?.last_price).toBe(30000);
    expect(h?.last_price_at).not.toBeNull();
    const snaps = await db.select<{ price: number }>(`SELECT price FROM holding_price_snapshots WHERE holding_id = ?`, [hid]);
    expect(snaps[0]?.price).toBe(30000);
  });

  it("syncs quantity from a watched address (and still fetches price)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const hid = await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "BTC", quantity: 0, avg_cost: 0, currency: "EUR", chain: "btc", address: "bc1qexample" });
    mockTransport([
      { match: "blockstream.info", body: { chain_stats: { funded_txo_sum: 200000000, spent_txo_sum: 0 } } }, // 2 BTC
      { match: "/simple/price", body: { bitcoin: { eur: 50000 } } },
    ]);
    expect(await refreshHolding(db, hid)).toBe(true);
    const h = await pf.getHolding(db, hid);
    expect(h?.quantity).toBe(2); // synced from the address
    expect(h?.last_price).toBe(50000);
  });
});

describe("refreshAllHoldings", () => {
  it("returns 0 and does nothing when prices are disabled", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "BTC", quantity: 1, avg_cost: 1, currency: "EUR" });
    const { calls } = mockTransport([{ match: "/simple/price", body: { bitcoin: { eur: 1 } } }]);
    // default portfolio_prices_enabled = 0
    expect(await refreshAllHoldings(db)).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("when enabled, batches crypto by currency, skips manual, writes prices + snapshots", async () => {
    const { db } = await makeMemDb();
    await updateSettings(db, { portfolio_prices_enabled: true });
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    const btc = await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "BTC", quantity: 1, avg_cost: 1, currency: "USD" });
    const eth = await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "ETH", quantity: 1, avg_cost: 1, currency: "USD" });
    const aapl = await pf.createHolding(db, { portfolio_id: pid, asset_class: "stock", symbol: "AAPL", quantity: 1, avg_cost: 1, currency: "USD" });
    const manual = await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "SOL", quantity: 1, avg_cost: 1, currency: "USD", manual_price: true, last_price: 7 });

    const { calls } = mockTransport([
      { match: "/simple/price", body: { bitcoin: { usd: 100 }, ethereum: { usd: 50 } } },
      { match: "finance/chart/AAPL", body: { chart: { result: [{ meta: { regularMarketPrice: 200 } }] } } },
    ]);

    expect(await refreshAllHoldings(db)).toBe(3); // BTC + ETH + AAPL; SOL skipped (manual)
    // one batched crypto call (both ids) + one stock call
    expect(calls.filter((u) => u.includes("/simple/price")).length).toBe(1);
    expect((await pf.getHolding(db, btc))?.last_price).toBe(100);
    expect((await pf.getHolding(db, eth))?.last_price).toBe(50);
    expect((await pf.getHolding(db, aapl))?.last_price).toBe(200);
    expect((await pf.getHolding(db, manual))?.last_price).toBe(7); // untouched
    const snaps = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM holding_price_snapshots WHERE holding_id IN (?,?,?)`, [btc, eth, aapl]);
    expect(snaps[0].c).toBe(3);
  });
});

describe("maybeRefreshPrices throttle", () => {
  it("no-ops when disabled", async () => {
    const { db } = await makeMemDb();
    mockTransport([]);
    expect(await maybeRefreshPrices(db)).toBe(0);
  });

  it("skips a refresh that happened < 10 min ago, then runs once the window passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { db } = await makeMemDb();
    await updateSettings(db, { portfolio_prices_enabled: true });
    const s = await createSource(db, { name: "Inv", currency: "EUR" });
    const pid = await pf.createPortfolio(db, { name: "P", base_currency: "EUR", source_id: s.id });
    await pf.createHolding(db, { portfolio_id: pid, asset_class: "crypto", symbol: "BTC", quantity: 1, avg_cost: 1, currency: "USD" });
    mockTransport([{ match: "/simple/price", body: { bitcoin: { usd: 100 } } }]);

    expect(await maybeRefreshPrices(db)).toBe(1); // first run stamps last_price_refresh_at
    clearPriceCache(); // isolate the throttle from the price TTL cache
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z")); // +5 min < 10 min
    expect(await maybeRefreshPrices(db)).toBe(0); // throttled

    clearPriceCache();
    vi.setSystemTime(new Date("2026-01-01T00:11:00Z")); // +11 min > 10 min
    mockTransport([{ match: "/simple/price", body: { bitcoin: { usd: 110 } } }]);
    expect(await maybeRefreshPrices(db)).toBe(1); // window passed → runs again
  });
});
