/**
 * Exchange-rate refresh from the network.
 *
 * Fiat rates come from Frankfurter (European Central Bank reference rates, no
 * API key, no tracking); crypto rates reuse the CoinGecko endpoint the holding
 * prices already use. Both go through prices.ts's injectable transport, so in
 * Tauri they are proxied by Rust (no CORS, capability allow-list) and in tests
 * they are mocked — this module never touches the network on its own.
 *
 * Shape of what we store: a STAR, not a mesh. One row per currency pointing at
 * a single pivot (the user's base currency when it is a supported fiat, else
 * EUR). Every other pair is then derived by `getRate`'s chain walk, so N
 * currencies cost one HTTP call instead of N² rows. Pairs the user typed by
 * hand are refreshed too when they're fetchable, and never deleted.
 *
 * Every failure is soft: an unreachable API leaves the existing rates alone.
 */
import type { SqlExecutor } from "../types";
import { COINGECKO_ID_MAP, httpGetJson } from "./prices";
import { listRates, upsertRate, type ExchangeRateRow } from "./exchange-rates";
import { getSettings } from "./settings";

/**
 * Currencies Frankfurter quotes (the ECB reference set). Anything outside this
 * list and outside COINGECKO_ID_MAP can only be maintained by hand — the UI
 * says so rather than silently skipping it.
 */
export const FRANKFURTER_CODES = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR",
  "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

/** True when `refreshRates` can source this currency online (fiat or crypto). */
export function isFetchable(code: string): boolean {
  const c = code.trim().toUpperCase();
  return FRANKFURTER_CODES.has(c) || c in COINGECKO_ID_MAP;
}

// Frankfurter moved to api.frankfurter.dev; the old host still answers. Try the
// current one first and fall back, so neither being retired breaks the feature.
const FRANKFURTER_HOSTS = [
  "https://api.frankfurter.dev/v1/latest",
  "https://api.frankfurter.app/latest",
];

interface FrankfurterResponse {
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

/**
 * Rates for 1 `base` expressed in each of `symbols`. Returns only the entries
 * that came back as finite positive numbers; null when every host failed.
 */
export async function fetchFiatRates(
  base: string,
  symbols: string[],
): Promise<Record<string, number> | null> {
  const b = base.trim().toUpperCase();
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(
    (s) => s !== b && FRANKFURTER_CODES.has(s),
  );
  if (wanted.length === 0) return {};
  if (!FRANKFURTER_CODES.has(b)) return null;
  const query = `?base=${encodeURIComponent(b)}&symbols=${encodeURIComponent(wanted.join(","))}`;
  for (const host of FRANKFURTER_HOSTS) {
    const data = (await httpGetJson(`${host}${query}`)) as FrankfurterResponse | null;
    const rates = data?.rates;
    if (!rates) continue;
    const out: Record<string, number> = {};
    for (const [code, value] of Object.entries(rates)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[code.toUpperCase()] = n;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return null;
}

/** Every currency the user's data actually holds money in. */
export async function usedCurrencies(db: SqlExecutor): Promise<string[]> {
  const rows = await db.select<{ ccy: string | null }>(
    `SELECT DISTINCT currency AS ccy FROM sources
     UNION SELECT DISTINCT currency FROM holdings
     UNION SELECT DISTINCT base_currency FROM portfolios`,
  );
  const set = new Set<string>();
  for (const r of rows) {
    const c = (r.ccy ?? "").trim().toUpperCase();
    if (c) set.add(c);
  }
  const base = (await getSettings(db)).base_currency;
  if (base) set.add(base.trim().toUpperCase());
  return [...set].sort();
}

/**
 * The currency every other one is quoted against. The user's base currency when
 * Frankfurter quotes it (so its rows read naturally: 1 USD = x EUR), else the
 * most common used fiat, else EUR.
 */
export function pickPivot(used: string[], preferred: string | null | undefined): string {
  const p = (preferred ?? "").trim().toUpperCase();
  if (FRANKFURTER_CODES.has(p)) return p;
  const fiat = used.map((c) => c.toUpperCase()).filter((c) => FRANKFURTER_CODES.has(c));
  return fiat[0] ?? "EUR";
}

export interface RefreshResult {
  /** Pairs written. */
  updated: number;
  /** Currency the rates are quoted against. */
  pivot: string;
  /** Currencies in use that no provider quotes — the user must enter these by hand. */
  unsupported: string[];
  /** True when every network call failed (nothing was written and rates are stale). */
  offline: boolean;
}

/**
 * Fetch and store rates for every currency in use, plus refresh any hand-entered
 * pair that is fetchable. Existing rows are updated in place; nothing is deleted.
 */
export async function refreshRates(db: SqlExecutor): Promise<RefreshResult> {
  const settings = await getSettings(db);
  const used = await usedCurrencies(db);
  const existing = await listRates(db);
  // Hand-entered pairs count as currencies to keep current, even if no source or
  // holding uses them any more — the user put them there on purpose.
  const all = new Set(used);
  for (const r of existing) {
    all.add(r.from_currency.toUpperCase());
    all.add(r.to_currency.toUpperCase());
  }
  const pivot = pickPivot([...all], settings.base_currency);
  all.delete(pivot);

  const codes = [...all];
  const unsupported = codes.filter((c) => !isFetchable(c)).sort();
  let updated = 0;
  let attempted = 0;
  let failed = 0;

  // 1) Fiat: one call for the whole star.
  const fiat = codes.filter((c) => FRANKFURTER_CODES.has(c));
  if (fiat.length > 0) {
    attempted += 1;
    const rates = await fetchFiatRates(pivot, fiat);
    if (rates == null) failed += 1;
    else {
      for (const [code, rate] of Object.entries(rates)) {
        await writeRate(db, existing, pivot, code, rate);
        updated += 1;
      }
    }
  }

  // 2) Crypto: quoted directly in the pivot, so 1 BTC = rate PIVOT.
  const crypto = codes.filter((c) => !FRANKFURTER_CODES.has(c) && c in COINGECKO_ID_MAP);
  for (const code of crypto) {
    attempted += 1;
    const price = await fetchCryptoRate(code, pivot);
    if (price == null) failed += 1;
    else {
      await writeRate(db, existing, code, pivot, price);
      updated += 1;
    }
  }

  // 3) Hand-entered pairs that don't touch the pivot (e.g. USD→GBP) would keep
  //    shadowing the fresh star rates with a stale number, since getRate prefers
  //    a direct pair. Re-quote the ones we can.
  for (const r of existing) {
    const from = r.from_currency.toUpperCase();
    const to = r.to_currency.toUpperCase();
    if (from === pivot || to === pivot || from === to) continue;
    if (!FRANKFURTER_CODES.has(from) || !FRANKFURTER_CODES.has(to)) continue;
    attempted += 1;
    const rates = await fetchFiatRates(from, [to]);
    if (rates == null) failed += 1;
    else if (rates[to] != null) {
      await upsertRate(db, from, to, rates[to]);
      updated += 1;
    }
  }

  return {
    updated,
    pivot,
    unsupported,
    offline: attempted > 0 && failed === attempted,
  };
}

/**
 * Store `from`→`to` = rate, but update the row the user already has when it
 * holds the same pair the other way round. Writing the opposite direction
 * instead would leave their stale row in place, and getRate prefers a direct
 * pair — so the refresh would appear to do nothing.
 */
async function writeRate(
  db: SqlExecutor,
  existing: ExchangeRateRow[],
  from: string,
  to: string,
  rate: number,
): Promise<void> {
  const hasInverse = existing.some(
    (r) => r.from_currency.toUpperCase() === to && r.to_currency.toUpperCase() === from,
  );
  const hasDirect = existing.some(
    (r) => r.from_currency.toUpperCase() === from && r.to_currency.toUpperCase() === to,
  );
  if (hasInverse && !hasDirect) await upsertRate(db, to, from, 1 / rate);
  else await upsertRate(db, from, to, rate);
}

/** Price of 1 unit of a crypto in `vsCurrency`, i.e. the crypto→fiat rate. */
async function fetchCryptoRate(symbol: string, vsCurrency: string): Promise<number | null> {
  const id = COINGECKO_ID_MAP[symbol.toUpperCase()];
  if (!id) return null;
  const vs = vsCurrency.toLowerCase();
  const data = (await httpGetJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vs)}`,
  )) as Record<string, Record<string, number>> | null;
  const price = Number(data?.[id]?.[vs]);
  return Number.isFinite(price) && price > 0 ? price : null;
}
