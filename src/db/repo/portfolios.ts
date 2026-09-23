/**
 * Portfolios, holdings, daily price snapshots, valuation + history.
 * Faithful port of services/portfolios.py (refactor-analysis/portfolios-prices.md §3).
 * Key invariants: PnL is null (not 0) when cost basis is 0; total_value falls back
 * to cost_basis for unpriced holdings; one snapshot per (holding,date).
 * BUG-1 fixed: per-holding values are FX-converted to the portfolio base currency
 * before summing (mixed-currency totals were meaningless before).
 * BUG-2 fixed: history window starts at the first snapshot, not range start.
 */
import type { SqlExecutor } from "../types";
import { DomainError } from "../errors";
import { round2, round6 } from "@/domain/money";
import { addDaysISO, todayISO } from "@/lib/date";
import { getSource } from "./sources";
import { convert, getRate } from "./exchange-rates";

const now = () => new Date().toISOString();

export interface PortfolioRow {
  id: number;
  name: string;
  kind: "crypto" | "stocks" | "mixed";
  base_currency: string;
  source_id: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface HoldingRow {
  id: number;
  portfolio_id: number;
  asset_class: "crypto" | "stock";
  symbol: string;
  display_name: string | null;
  quantity: number;
  avg_cost: number;
  currency: string;
  last_price: number | null;
  last_price_at: string | null;
  manual_price: number;
  note: string | null;
  /** Blockchain to read the balance from (e.g. "btc" | "eth" | "sol"); null = not tracked. */
  chain: string | null;
  /** Watched public address; when set, refresh syncs `quantity` from the on-chain balance. */
  address: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnrichedHolding extends HoldingRow {
  cost_basis: number;
  market_value: number | null;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
}

export function enrichHolding(h: HoldingRow): EnrichedHolding {
  const cost_basis = round2(h.quantity * h.avg_cost);
  const market_value = h.last_price != null ? round2(h.quantity * h.last_price) : null;
  let unrealized_pnl: number | null = null;
  let unrealized_pnl_pct: number | null = null;
  // PnL is meaningful only when we know the cost AND have a market price.
  if (cost_basis > 0 && market_value != null) {
    unrealized_pnl = round2(market_value - cost_basis);
    unrealized_pnl_pct = round2((unrealized_pnl / cost_basis) * 100);
  }
  return { ...h, cost_basis, market_value, unrealized_pnl, unrealized_pnl_pct };
}

// ---- portfolio CRUD ----

export async function listPortfolios(db: SqlExecutor): Promise<PortfolioRow[]> {
  return db.select<PortfolioRow>(`SELECT * FROM portfolios ORDER BY name COLLATE NOCASE`);
}
export async function getPortfolio(db: SqlExecutor, id: number): Promise<PortfolioRow | null> {
  return (await db.select<PortfolioRow>(`SELECT * FROM portfolios WHERE id = ?`, [id]))[0] ?? null;
}

export interface NewPortfolio {
  name: string;
  kind?: "crypto" | "stocks" | "mixed";
  base_currency?: string;
  source_id: number;
  note?: string | null;
}

export async function createPortfolio(db: SqlExecutor, data: NewPortfolio): Promise<number> {
  if (!(await getSource(db, data.source_id))) throw new DomainError("not_found");
  const ts = now();
  const rows = await db.select<{ id: number }>(
    `INSERT INTO portfolios (name,kind,base_currency,source_id,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
    [data.name, data.kind ?? "mixed", (data.base_currency ?? "EUR").trim().toUpperCase(), data.source_id, data.note ?? null, ts, ts],
  );
  return rows[0].id;
}

export async function updatePortfolio(db: SqlExecutor, id: number, patch: Partial<NewPortfolio>): Promise<void> {
  if (!(await getPortfolio(db, id))) throw new DomainError("not_found");
  if (patch.source_id != null && !(await getSource(db, patch.source_id))) throw new DomainError("not_found");
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (c: string, v: unknown) => (sets.push(`${c} = ?`), params.push(v));
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.kind !== undefined) set("kind", patch.kind);
  if (patch.base_currency !== undefined) set("base_currency", patch.base_currency.trim().toUpperCase());
  if (patch.source_id !== undefined) set("source_id", patch.source_id);
  if (patch.note !== undefined) set("note", patch.note);
  set("updated_at", now());
  await db.execute(`UPDATE portfolios SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
}

export async function deletePortfolio(db: SqlExecutor, id: number): Promise<void> {
  const holdings = await db.select<{ id: number }>(`SELECT id FROM holdings WHERE portfolio_id = ?`, [id]);
  for (const h of holdings) await db.execute(`DELETE FROM holding_price_snapshots WHERE holding_id = ?`, [h.id]);
  await db.execute(`DELETE FROM holdings WHERE portfolio_id = ?`, [id]);
  await db.execute(`DELETE FROM portfolios WHERE id = ?`, [id]);
}

// ---- snapshots ----

export async function upsertSnapshot(db: SqlExecutor, holding: HoldingRow, date = todayISO()): Promise<void> {
  if (holding.last_price == null) return;
  const existing = await db.select<{ id: number; price: number }>(
    `SELECT id, price FROM holding_price_snapshots WHERE holding_id = ? AND date = ?`,
    [holding.id, date],
  );
  if (existing[0]) {
    if (existing[0].price !== holding.last_price) {
      await db.execute(`UPDATE holding_price_snapshots SET price = ? WHERE id = ?`, [holding.last_price, existing[0].id]);
    }
    return;
  }
  await db.execute(
    `INSERT INTO holding_price_snapshots (holding_id,date,price,created_at) VALUES (?,?,?,?)`,
    [holding.id, date, holding.last_price, now()],
  );
}

// ---- holding CRUD ----

export async function getHolding(db: SqlExecutor, id: number): Promise<HoldingRow | null> {
  return (await db.select<HoldingRow>(`SELECT * FROM holdings WHERE id = ?`, [id]))[0] ?? null;
}

export interface NewHolding {
  portfolio_id: number;
  asset_class: "crypto" | "stock";
  symbol: string;
  display_name?: string | null;
  quantity?: number;
  avg_cost?: number;
  currency?: string;
  last_price?: number | null;
  manual_price?: boolean;
  note?: string | null;
  chain?: string | null;
  address?: string | null;
}

/**
 * A quantity, cost or price must be a real non-negative number. The form sends
 * `Number(text) || 0`, so "-5" arrives as -5 and would silently produce a
 * negative cost basis and a negative market value that net worth then counts.
 */
function checkNonNegative(v: number | null | undefined): void {
  if (v == null) return;
  if (!Number.isFinite(v) || v < 0) throw new DomainError("invalid_amount");
}

export async function createHolding(db: SqlExecutor, data: NewHolding): Promise<number> {
  const symbol = data.symbol.trim().toUpperCase();
  if (!symbol || symbol.length > 32) throw new DomainError("invalid_amount"); // reuse: bad input
  checkNonNegative(data.quantity);
  checkNonNegative(data.avg_cost);
  checkNonNegative(data.last_price);
  if (!(await getPortfolio(db, data.portfolio_id))) throw new DomainError("not_found");
  const ts = now();
  const manual = data.manual_price ? 1 : 0;
  const lastPrice = data.last_price ?? null;
  const chain = data.chain?.trim() || null;
  const address = data.address?.trim() || null;
  const rows = await db.select<{ id: number }>(
    `INSERT INTO holdings (portfolio_id,asset_class,symbol,display_name,quantity,avg_cost,currency,last_price,last_price_at,manual_price,note,chain,address,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [data.portfolio_id, data.asset_class, symbol, data.display_name ?? null, data.quantity ?? 0, data.avg_cost ?? 0, (data.currency ?? "EUR").trim().toUpperCase(), lastPrice, lastPrice != null ? ts : null, manual, data.note ?? null, chain, address, ts, ts],
  );
  const id = rows[0].id;
  if (manual && lastPrice != null) {
    await upsertSnapshot(db, (await getHolding(db, id))!);
  }
  return id;
}

export interface HoldingPatch {
  asset_class?: "crypto" | "stock";
  symbol?: string;
  display_name?: string | null;
  quantity?: number;
  avg_cost?: number;
  currency?: string;
  last_price?: number | null;
  manual_price?: boolean;
  note?: string | null;
  chain?: string | null;
  address?: string | null;
}

export async function updateHolding(db: SqlExecutor, id: number, patch: HoldingPatch): Promise<void> {
  const h = await getHolding(db, id);
  if (!h) throw new DomainError("not_found");
  checkNonNegative(patch.quantity);
  checkNonNegative(patch.avg_cost);
  checkNonNegative(patch.last_price);
  if (patch.symbol !== undefined) {
    const symbol = patch.symbol.trim().toUpperCase();
    if (!symbol || symbol.length > 32) throw new DomainError("invalid_amount");
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (c: string, v: unknown) => (sets.push(`${c} = ?`), params.push(v));
  if (patch.asset_class !== undefined) {
    if (patch.asset_class !== "crypto" && patch.asset_class !== "stock") throw new DomainError("invalid_amount");
    set("asset_class", patch.asset_class);
  }
  if (patch.symbol !== undefined) set("symbol", patch.symbol.trim().toUpperCase());
  if (patch.display_name !== undefined) set("display_name", patch.display_name);
  if (patch.quantity !== undefined) set("quantity", patch.quantity);
  if (patch.avg_cost !== undefined) set("avg_cost", patch.avg_cost);
  if (patch.currency !== undefined) set("currency", patch.currency.trim().toUpperCase());
  if (patch.note !== undefined) set("note", patch.note);
  if (patch.chain !== undefined) set("chain", patch.chain?.trim() || null);
  if (patch.address !== undefined) set("address", patch.address?.trim() || null);

  const turningManualOff = patch.manual_price === false && h.manual_price === 1;
  if (patch.manual_price !== undefined) set("manual_price", patch.manual_price ? 1 : 0);
  if (turningManualOff) {
    // clear the manual price so the next auto-refresh takes over
    set("last_price", null);
    set("last_price_at", null);
  } else if (patch.last_price !== undefined) {
    set("last_price", patch.last_price);
    set("last_price_at", patch.last_price != null ? now() : null);
  }
  set("updated_at", now());
  await db.execute(`UPDATE holdings SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);

  // snapshot only when manual + a price is set + last_price was in the payload
  const after = (await getHolding(db, id))!;
  if (after.manual_price === 1 && after.last_price != null && patch.last_price !== undefined) {
    await upsertSnapshot(db, after);
  }
}

export async function deleteHolding(db: SqlExecutor, id: number): Promise<void> {
  await db.execute(`DELETE FROM holding_price_snapshots WHERE holding_id = ?`, [id]);
  await db.execute(`DELETE FROM holdings WHERE id = ?`, [id]);
}

// ---- valuation (FX-correct) ----

async function convOr(db: SqlExecutor, amount: number, from: string, to: string): Promise<number | null> {
  if (from.toUpperCase() === to.toUpperCase()) return amount;
  // null when no rate exists → callers EXCLUDE the holding from the base-currency
  // total and set has_unconverted, rather than adding a raw foreign figure into the
  // total (which would be a meaningless mixed-currency sum). Mirrors consolidate.ts.
  return await convert(db, amount, from, to);
}

/** A holding enriched with its values converted to the portfolio base currency,
 *  its weight within the portfolio, and (optionally) its recent price change. */
export interface PortfolioHolding extends EnrichedHolding {
  /** Market value (cost-basis fallback) in the portfolio base currency; null if no FX rate. */
  base_value: number | null;
  /** Cost basis in the portfolio base currency; null if no FX rate. */
  base_cost: number | null;
  /** Unrealized P/L in the portfolio base currency; null if no rate / no price. */
  base_pnl: number | null;
  /** Share of the portfolio's total value (%); null when the total is 0 / unconverted. */
  weight_pct: number | null;
  /** % change vs the previous price snapshot; null when fewer than 2 snapshots (withChange only). */
  change_pct: number | null;
}

export interface PortfolioSummary {
  portfolio: PortfolioRow;
  source_name: string | null;
  holdings: PortfolioHolding[];
  holdings_count: number;
  total_cost: number;
  total_value: number;
  total_pnl: number | null;
  total_pnl_pct: number | null;
  /** True when a holding currency couldn't be converted to base (rate missing). */
  has_unconverted: boolean;
}

export async function summarizePortfolio(
  db: SqlExecutor,
  id: number,
  opts: { withChange?: boolean } = {},
): Promise<PortfolioSummary> {
  const p = await getPortfolio(db, id);
  if (!p) throw new DomainError("not_found");
  const holdingRows = await db.select<HoldingRow>(
    `SELECT * FROM holdings WHERE portfolio_id = ? ORDER BY asset_class, symbol COLLATE NOCASE`,
    [id],
  );
  const base = p.base_currency;
  const src = await getSource(db, p.source_id);

  let totalCost = 0;
  let totalValue = 0;
  let totalPnl = 0;
  let pnlSeen = false;
  let hasUnconverted = false;
  const holdings: PortfolioHolding[] = [];

  for (const row of holdingRows) {
    const h = enrichHolding(row);
    // Resolve the holding→base FX rate ONCE and reuse it for the has_unconverted
    // probe AND cost/value/pnl, instead of re-querying getRate for the same pair.
    // Mirrors convOr exactly: same currency → pass the amount through unchanged
    // (no round2); else round2(amount × rate), or null when no rate exists.
    const sameCcy = h.currency.toUpperCase() === base.toUpperCase();
    const rate = sameCcy ? 1 : await getRate(db, h.currency, base);
    if (!sameCcy && rate == null) hasUnconverted = true;
    const conv = (amount: number): number | null =>
      sameCcy ? amount : rate == null ? null : round2(amount * rate);

    const base_cost = conv(h.cost_basis);
    if (base_cost != null) totalCost = round2(totalCost + base_cost);
    const valNative = h.market_value ?? h.cost_basis;
    const base_value = conv(valNative);
    if (base_value != null) totalValue = round2(totalValue + base_value);
    let base_pnl: number | null = null;
    if (h.unrealized_pnl != null) {
      base_pnl = conv(h.unrealized_pnl);
      if (base_pnl != null) {
        totalPnl = round2(totalPnl + base_pnl);
        pnlSeen = true;
      }
    }
    // Recent change vs the previous snapshot (opt-in: it costs a query per holding).
    let change_pct: number | null = null;
    if (opts.withChange && h.last_price != null) {
      const snaps = await db.select<{ price: number }>(
        `SELECT price FROM holding_price_snapshots WHERE holding_id = ? ORDER BY date DESC LIMIT 2`,
        [h.id],
      );
      if (snaps.length === 2 && snaps[1].price > 0) {
        change_pct = round2(((snaps[0].price - snaps[1].price) / snaps[1].price) * 100);
      }
    }
    holdings.push({ ...h, base_cost, base_value, base_pnl, weight_pct: null, change_pct });
  }
  // Weights are known only once the portfolio total is summed.
  for (const h of holdings) {
    h.weight_pct = totalValue > 0 && h.base_value != null ? round2((h.base_value / totalValue) * 100) : null;
  }

  const total_pnl = totalCost > 0 && pnlSeen ? totalPnl : null;
  const total_pnl_pct = total_pnl != null && totalCost > 0 ? round2((total_pnl / totalCost) * 100) : null;

  return {
    portfolio: p,
    source_name: src?.name ?? null,
    holdings,
    holdings_count: holdings.length,
    total_cost: totalCost,
    total_value: totalValue,
    total_pnl,
    total_pnl_pct,
    has_unconverted: hasUnconverted,
  };
}

// ---- cross-portfolio overview (aggregate + asset-class allocation) ----

export interface AllocationSlice {
  /** asset_class key ("stock" | "crypto"). */
  key: string;
  /** Value in the overview's display currency. */
  value: number;
  /** Share of the total allocation (%). */
  pct: number;
}

export interface PortfoliosOverview {
  /** Currency every aggregate figure is expressed in. */
  displayCurrency: string;
  total_value: number;
  total_cost: number;
  total_pnl: number | null;
  total_pnl_pct: number | null;
  /** Some value couldn't be FX-converted into the display currency → totals approximate. */
  has_unconverted: boolean;
  /** Asset-class breakdown of total value, in the display currency, largest first. */
  allocation: AllocationSlice[];
  portfolio_count: number;
  holding_count: number;
}

export interface PortfoliosView {
  portfolios: PortfolioSummary[];
  overview: PortfoliosOverview | null;
}

/**
 * Per-portfolio detailed summaries (with per-holding weight + recent change) PLUS a
 * cross-portfolio overview that converts every portfolio's base-currency totals and
 * each holding's value into a single display currency (defaulting to the most common
 * portfolio base currency). Currencies with no FX rate are excluded and flagged via
 * `has_unconverted`, never summed raw (mirrors consolidate.ts).
 */
export async function portfoliosView(db: SqlExecutor, displayCurrency?: string): Promise<PortfoliosView> {
  const ports = await listPortfolios(db);
  const summaries = await Promise.all(ports.map((p) => summarizePortfolio(db, p.id, { withChange: true })));
  if (summaries.length === 0) return { portfolios: [], overview: null };

  // Display currency: explicit override > most common base currency > first.
  const counts = new Map<string, number>();
  for (const s of summaries) counts.set(s.portfolio.base_currency, (counts.get(s.portfolio.base_currency) ?? 0) + 1);
  const display = (displayCurrency || [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]).toUpperCase();

  let totalValue = 0;
  let totalCost = 0;
  let totalPnl = 0;
  let pnlSeen = false;
  let hasUnconverted = false;
  let holdingCount = 0;
  const alloc = new Map<string, number>();

  for (const s of summaries) {
    holdingCount += s.holdings_count;
    if (s.has_unconverted) hasUnconverted = true;
    const baseCcy = s.portfolio.base_currency;
    const vC = await convOr(db, s.total_value, baseCcy, display);
    if (vC != null) totalValue = round2(totalValue + vC);
    else if (s.total_value) hasUnconverted = true;
    const cC = await convOr(db, s.total_cost, baseCcy, display);
    if (cC != null) totalCost = round2(totalCost + cC);
    else if (s.total_cost) hasUnconverted = true;
    if (s.total_pnl != null) {
      const pC = await convOr(db, s.total_pnl, baseCcy, display);
      if (pC != null) {
        totalPnl = round2(totalPnl + pC);
        pnlSeen = true;
      } else hasUnconverted = true;
    }
    for (const h of s.holdings) {
      if (h.base_value == null) {
        hasUnconverted = true;
        continue;
      }
      const dv = await convOr(db, h.base_value, baseCcy, display);
      if (dv == null) {
        hasUnconverted = true;
        continue;
      }
      alloc.set(h.asset_class, round2((alloc.get(h.asset_class) ?? 0) + dv));
    }
  }

  const total_pnl = pnlSeen ? totalPnl : null;
  const total_pnl_pct = total_pnl != null && totalCost > 0 ? round2((total_pnl / totalCost) * 100) : null;
  const allocTotal = [...alloc.values()].reduce((a, b) => a + b, 0);
  const allocation: AllocationSlice[] = [...alloc.entries()]
    .map(([key, value]) => ({ key, value, pct: allocTotal > 0 ? round2((value / allocTotal) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);

  return {
    portfolios: summaries,
    overview: {
      displayCurrency: display,
      total_value: totalValue,
      total_cost: totalCost,
      total_pnl,
      total_pnl_pct,
      has_unconverted: hasUnconverted,
      allocation,
      portfolio_count: summaries.length,
      holding_count: holdingCount,
    },
  };
}

export interface SourcePortfolioValue {
  /** Portfolio market value attributable to this source, in the SOURCE's currency. */
  value: number;
  /** True when a portfolio linked here couldn't be converted (no FX rate). */
  unconverted: boolean;
}

/**
 * Portfolio market value per linked source, converted into that source's own
 * currency. An account whose money sits in a portfolio used to read as 0 on the
 * sources page even though net worth counted it — this is what the sources views
 * add on top of the cash balance so the two agree.
 */
export async function valueBySource(db: SqlExecutor): Promise<Map<number, SourcePortfolioValue>> {
  const list = await listPortfolios(db);
  const out = new Map<number, SourcePortfolioValue>();
  for (const p of list) {
    const src = await getSource(db, p.source_id);
    if (!src) continue;
    const summary = await summarizePortfolio(db, p.id);
    const entry = out.get(p.source_id) ?? { value: 0, unconverted: false };
    const converted = await convOr(db, summary.total_value, p.base_currency, src.currency);
    if (converted == null) entry.unconverted = true;
    else entry.value = round2(entry.value + converted);
    if (summary.has_unconverted) entry.unconverted = true;
    out.set(p.source_id, entry);
  }
  return out;
}

/** Net portfolio market value per base currency (for dashboard net worth).
 *  Portfolios linked to an excluded source are skipped along with it. */
export async function totalValueByCurrency(
  db: SqlExecutor,
  excludedSourceIds: Set<number> = new Set(),
): Promise<Record<string, number>> {
  const portfolios = await listPortfolios(db);
  const out: Record<string, number> = {};
  for (const p of portfolios) {
    if (excludedSourceIds.has(p.source_id)) continue;
    const s = await summarizePortfolio(db, p.id);
    if (s.total_value) out[p.base_currency] = round2((out[p.base_currency] ?? 0) + s.total_value);
  }
  return out;
}

// ---- history (consolidated walk; BUG-2 window fixed) ----

export interface ValuePoint {
  date: string;
  value: number;
}

export async function portfolioValueHistory(db: SqlExecutor, id: number, rangeDays = 30): Promise<ValuePoint[]> {
  const holdingRows = await db.select<HoldingRow>(`SELECT * FROM holdings WHERE portfolio_id = ?`, [id]);
  const p = await getPortfolio(db, id);
  if (!p || holdingRows.length === 0) return [];
  const base = p.base_currency;
  const today = todayISO();
  const rangeStart = addDaysISO(today, -rangeDays);

  // snapshots per holding, sorted ascending
  const snaps = new Map<number, { date: string; price: number }[]>();
  let firstSnapshot = today;
  for (const h of holdingRows) {
    const rows = await db.select<{ date: string; price: number }>(
      `SELECT date, price FROM holding_price_snapshots WHERE holding_id = ? ORDER BY date ASC`,
      [h.id],
    );
    snaps.set(h.id, rows);
    if (rows[0] && rows[0].date < firstSnapshot) firstSnapshot = rows[0].date;
  }
  // BUG-2 fix: window starts at the first real snapshot, not the full range start.
  const windowStart = rangeStart > firstSnapshot ? rangeStart : firstSnapshot;

  // The holding→base FX rate is date-independent (getRate reads exchange_rates only),
  // so resolve it ONCE per holding instead of per (holding, day). Mirrors convOr:
  // same currency → pass through (no round2); else round2(amount × rate) or null.
  // `cursor` advances monotonically with the (ascending) day loop, replacing the
  // per-day full rescan of the sorted snapshot series with an O(days+snaps) walk;
  // it always selects the same latest snapshot ≤ d as the original inner loop.
  const walkers = holdingRows.map((h) => {
    const sameCcy = h.currency.toUpperCase() === base.toUpperCase();
    return { h, sameCcy, rate: sameCcy ? 1 : null as number | null, rateResolved: sameCcy, series: snaps.get(h.id)!, cursor: 0 };
  });

  const points: ValuePoint[] = [];
  for (let d = windowStart; d <= today; d = addDaysISO(d, 1)) {
    let value = 0;
    for (const w of walkers) {
      let price = w.cursor === 0 ? w.h.avg_cost : w.series[w.cursor - 1].price; // fallback / last carried
      while (w.cursor < w.series.length && w.series[w.cursor].date <= d) {
        price = w.series[w.cursor].price;
        w.cursor++;
      }
      const native = round2(w.h.quantity * price);
      let c: number | null;
      if (w.sameCcy) {
        c = native;
      } else {
        if (!w.rateResolved) {
          w.rate = await getRate(db, w.h.currency, base);
          w.rateResolved = true;
        }
        c = w.rate == null ? null : round2(native * w.rate);
      }
      if (c != null) value = round2(value + c);
    }
    points.push({ date: d, value });
  }
  return points;
}

export interface HoldingPricePoint {
  date: string;
  price: number;
  value: number;
}

/**
 * [{date, price, value}] for a single holding over the range. Same fallback as
 * the portfolio chart: latest snapshot ≤ d, else avg_cost. Returns [] when the
 * holding has no snapshots at all; otherwise one point per day from
 * max(rangeStart, firstSnapshot)..today (price round6, value round2).
 * Faithful port of services/portfolios.py holding_price_history (contract §35).
 */
export async function holdingPriceHistory(db: SqlExecutor, id: number, rangeDays = 30): Promise<HoldingPricePoint[]> {
  const h = await getHolding(db, id);
  if (!h) return [];
  const series = await db.select<{ date: string; price: number }>(
    `SELECT date, price FROM holding_price_snapshots WHERE holding_id = ? ORDER BY date ASC`,
    [id],
  );
  if (series.length === 0) return [];
  const today = todayISO();
  const rangeStart = addDaysISO(today, -rangeDays);
  const firstSnapshot = series[0].date;
  const windowStart = rangeStart > firstSnapshot ? rangeStart : firstSnapshot;

  // Monotone cursor over the (ascending) day loop: each snapshot is visited once
  // total instead of rescanning the series from index 0 every day. Selects the
  // same "latest snapshot ≤ d, else avg_cost" price as the original inner loop.
  const points: HoldingPricePoint[] = [];
  let cursor = 0;
  for (let d = windowStart; d <= today; d = addDaysISO(d, 1)) {
    let price = cursor === 0 ? h.avg_cost : series[cursor - 1].price;
    while (cursor < series.length && series[cursor].date <= d) {
      price = series[cursor].price;
      cursor++;
    }
    points.push({ date: d, price: round6(price), value: round2(h.quantity * price) });
  }
  return points;
}

interface SourceHoldingRow {
  id: number;
  quantity: number;
  avg_cost: number;
  currency: string;
}

/**
 * Holdings of every portfolio linked to `sourceId`, each paired with the rate
 * that turns its own currency into the SOURCE currency (1 when they match).
 * Holdings with no usable rate are dropped: the per-source series must never
 * add a raw USD figure to a EUR balance, exactly like valueBySource — which
 * is also why this is not limited to portfolios whose base currency matches
 * the source. The sources page counts a converted USD portfolio in the EUR
 * account's total today; its history has to be the same money.
 */
async function convertibleHoldingsForSource(
  db: SqlExecutor,
  sourceId: number,
): Promise<{ h: SourceHoldingRow; rate: number }[]> {
  const src = await getSource(db, sourceId);
  if (!src) return [];
  const rows = await db.select<SourceHoldingRow>(
    `SELECT h.id, h.quantity, h.avg_cost, h.currency FROM holdings h
     JOIN portfolios p ON h.portfolio_id = p.id WHERE p.source_id = ?`,
    [sourceId],
  );
  const out: { h: SourceHoldingRow; rate: number }[] = [];
  const rateByCcy = new Map<string, number | null>();
  for (const h of rows) {
    const ccy = h.currency.toUpperCase();
    let rate: number | null;
    if (ccy === src.currency.toUpperCase()) rate = 1;
    else if (rateByCcy.has(ccy)) rate = rateByCcy.get(ccy)!;
    else {
      rate = await getRate(db, ccy, src.currency);
      rateByCcy.set(ccy, rate);
    }
    if (rate != null) out.push({ h, rate });
  }
  return out;
}

/**
 * Distinct sorted snapshot dates for holdings whose portfolio is linked to
 * `sourceId` and whose value can be expressed in the source currency (same
 * currency, or an FX rate exists), optionally within [start, end].
 * Port of services/portfolios.py snapshot_dates_for_source (contract §31).
 */
export async function snapshotDatesForSource(
  db: SqlExecutor,
  sourceId: number,
  start?: string,
  end?: string,
): Promise<string[]> {
  const ids = await convertibleHoldingsForSource(db, sourceId);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const params: unknown[] = ids.map((r) => r.h.id);
  let sql = `SELECT DISTINCT date FROM holding_price_snapshots WHERE holding_id IN (${placeholders})`;
  if (start != null) { sql += ` AND date >= ?`; params.push(start); }
  if (end != null) { sql += ` AND date <= ?`; params.push(end); }
  sql += ` ORDER BY date ASC`;
  const rows = await db.select<{ date: string }>(sql, params);
  return rows.map((r) => r.date);
}

/**
 * Market value of the source's linked portfolios at each date, in the SOURCE
 * currency. For each (holding, date): latest snapshot ≤ date, else avg_cost
 * fallback (so the line stays continuous), converted with the holding's own
 * FX rate; holdings with no rate are left out rather than summed raw.
 * Missing source → 0 for every date.
 * Port of services/portfolios.py portfolio_value_by_source_over_time (§32).
 */
export async function portfolioValueBySourceOverTime(
  db: SqlExecutor,
  sourceId: number,
  dates: string[],
): Promise<Record<string, number>> {
  if (dates.length === 0) return {};
  const zeros = (): Record<string, number> => Object.fromEntries(dates.map((d) => [d, 0]));
  const holdings = await convertibleHoldingsForSource(db, sourceId);
  if (holdings.length === 0) return zeros();

  const snaps = new Map<number, { date: string; price: number }[]>();
  for (const { h } of holdings) {
    snaps.set(
      h.id,
      await db.select<{ date: string; price: number }>(
        `SELECT date, price FROM holding_price_snapshots WHERE holding_id = ? ORDER BY date ASC`,
        [h.id],
      ),
    );
  }
  // Advance one cursor per holding over the dates in ascending order so each
  // snapshot series is scanned once total (O(dates+snaps)) instead of fully
  // rescanned per (date,holding). The output is a date→value map, so processing
  // dates sorted (and writing back by their original key) yields byte-identical
  // values for every date regardless of the input array's order. The selected
  // price at each date is still "latest snapshot ≤ date, else avg_cost".
  const cursors = holdings.map(({ h, rate }) => ({ h, rate, series: snaps.get(h.id)!, cursor: 0 }));
  const ordered = [...dates].sort();
  const out: Record<string, number> = {};
  for (const d of ordered) {
    let total = 0;
    for (const c of cursors) {
      let price = c.cursor === 0 ? c.h.avg_cost : c.series[c.cursor - 1].price;
      while (c.cursor < c.series.length && c.series[c.cursor].date <= d) {
        price = c.series[c.cursor].price;
        c.cursor++;
      }
      // Same rounding as valueBySource: native value first, then converted.
      total += c.rate === 1 ? round2(c.h.quantity * price) : round2(round2(c.h.quantity * price) * c.rate);
    }
    out[d] = round2(total);
  }
  return out;
}

// ---- prices (opt-in) ----
// The user's preference gate. The live fetch/refresh functions
// (CoinGecko + Yahoo, TTL cache, snapshots) live in ./prices.ts.

export async function arePricesEnabled(db: SqlExecutor): Promise<boolean> {
  const r = await db.select<{ portfolio_prices_enabled: number }>(`SELECT portfolio_prices_enabled FROM settings WHERE id = 1`);
  return (r[0]?.portfolio_prices_enabled ?? 0) === 1;
}
