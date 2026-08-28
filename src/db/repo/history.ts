/**
 * Time-series helpers for the dashboard net-worth chart and the per-source
 * sparklines.
 *
 * Net worth (and the per-currency aggregate) stays cash-only:
 * balance(date) = starting_balance + running sum of signed movements up to date.
 * Same-currency transfer legs cancel (out −amt, in +amt), so they don't move
 * net worth — exactly like getBalancesBatch.
 *
 * The per-SOURCE series additionally folds in the market value of portfolios
 * linked to that source (currency-matched), mirroring services/sources.py
 * get_balance_history: balance(date) = cash(date) + portfolio_value(date), with
 * an avg_cost fallback so the line stays continuous before any snapshot exists.
 */
import type { SqlExecutor } from "../types";
import { round2 } from "@/domain/money";
import { todayISO } from "@/lib/date";
import { snapshotDatesForSource, portfolioValueBySourceOverTime } from "./portfolios";

export interface HistoryPoint {
  date: string; // YYYY-MM-DD
  value: number;
  /** Cash component (per-source series only). */
  cash?: number;
  /** Linked-portfolio market value component (per-source series only). */
  portfolios?: number;
}

function cumulative(start: number, deltas: { date: string; delta: number }[]): HistoryPoint[] {
  let acc = round2(start);
  const out: HistoryPoint[] = [];
  for (const d of deltas) {
    acc = round2(acc + d.delta);
    out.push({ date: d.date, value: acc });
  }
  return out;
}

/** Net-worth-over-time for one currency (all that currency's sources combined). */
export async function netWorthHistory(
  db: SqlExecutor,
  currency: string,
  excludedSourceIds: number[] = [],
): Promise<HistoryPoint[]> {
  // Accounts the user left out of net worth must drop out of its history too,
  // or the chart contradicts the number printed above it. Ids come from settings
  // (never user text), so inlining them keeps one bound-parameter shape per call.
  const skip = excludedSourceIds.filter((n) => Number.isInteger(n));
  const notExcluded = skip.length > 0 ? ` AND s.id NOT IN (${skip.join(",")})` : "";
  const startRow = await db.select<{ s: number }>(
    `SELECT COALESCE(SUM(starting_balance),0) s FROM sources s WHERE s.currency = ?${notExcluded}`,
    [currency],
  );
  const start = startRow[0]?.s ?? 0;
  const deltas = await db.select<{ date: string; delta: number }>(
    `SELECT m.date AS date,
        SUM(CASE WHEN m.direction='in' THEN m.amount ELSE -m.amount END) AS delta
     FROM movements m JOIN sources s ON m.source_id = s.id
     WHERE s.currency = ?${notExcluded}
     GROUP BY m.date ORDER BY m.date ASC`,
    [currency],
  );
  const series = cumulative(start, deltas);
  // Lead with the opening balance so a flat start is visible.
  if (series.length && start !== series[0].value) {
    series.unshift({ date: series[0].date, value: round2(start) });
  }
  return series;
}

export interface CurrencySeries {
  currency: string;
  points: HistoryPoint[];
}

/**
 * Net-worth-over-time for EVERY currency (gap 2 / invariants 15, 20). One series
 * per currency (cash only), forward-filled across the union of all currencies'
 * movement dates so the lines stay aligned on a shared x-axis. Mirrors the
 * original dashboard.html per-currency Chart.js datasets.
 */
export async function netWorthHistoryAll(
  db: SqlExecutor,
  excludedSourceIds: number[] = [],
): Promise<CurrencySeries[]> {
  const skip = excludedSourceIds.filter((n) => Number.isInteger(n));
  const currencyRows = await db.select<{ currency: string }>(
    `SELECT DISTINCT currency FROM sources s${skip.length > 0 ? ` WHERE s.id NOT IN (${skip.join(",")})` : ""} ORDER BY currency`,
  );
  const raw: CurrencySeries[] = [];
  for (const { currency } of currencyRows) {
    raw.push({ currency, points: await netWorthHistory(db, currency, excludedSourceIds) });
  }
  if (raw.length === 0) return [];

  // Union of all dates, sorted, then forward-fill each currency's last value.
  const dateSet = new Set<string>();
  for (const s of raw) for (const p of s.points) dateSet.add(p.date);
  const dates = [...dateSet].sort();
  if (dates.length === 0) return raw;

  return raw.map((s) => {
    const byDate = new Map(s.points.map((p) => [p.date, p.value]));
    let last: number | null = s.points[0]?.value ?? null;
    const points: HistoryPoint[] = dates.map((d) => {
      if (byDate.has(d)) last = byDate.get(d)!;
      return { date: d, value: round2(last ?? 0) };
    });
    return { currency: s.currency, points };
  });
}

/**
 * Per-source value over time: cash balance + linked-portfolio market value.
 *
 * Cash is reconstructed from movements (running sum on the starting balance).
 * The portfolio contribution comes from holding-price snapshots of portfolios
 * linked to this source whose base_currency matches the source currency (with
 * an avg_cost fallback), so a source backed mostly by investments shows its real
 * value evolution instead of flatlining on cash. Mirrors get_balance_history.
 */
export async function sourceBalanceHistory(db: SqlExecutor, sourceId: number): Promise<HistoryPoint[]> {
  const startRow = await db.select<{ s: number }>(
    `SELECT COALESCE(starting_balance,0) s FROM sources WHERE id = ?`,
    [sourceId],
  );
  const start = startRow[0]?.s ?? 0;
  const deltas = await db.select<{ date: string; delta: number }>(
    `SELECT date,
        SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) AS delta
     FROM movements WHERE source_id = ?
     GROUP BY date ORDER BY date ASC`,
    [sourceId],
  );

  // Cash balance after each movement date (end-of-day).
  let running = round2(start);
  const cashByMovementDate = new Map<string, number>();
  for (const d of deltas) {
    running = round2(running + d.delta);
    cashByMovementDate.set(d.date, running);
  }

  // Pull holding-price-snapshot dates so the line reflects market-value
  // evolution even when the source itself has no cash movements.
  const snapDates = await snapshotDatesForSource(db, sourceId);

  const today = todayISO();
  const movDates = [...cashByMovementDate.keys()];
  const allDates = [...new Set([...movDates, ...snapDates, today])].sort();

  // If there is neither cash movement history nor any portfolio snapshot, fall
  // back to the plain cumulative cash series (preserves the empty-chart UX).
  if (snapDates.length === 0 && movDates.length === 0) return cumulative(start, deltas);

  // movDates is already ascending (deltas are queried ORDER BY date ASC and
  // Map preserves insertion order with unique GROUP BY date keys), and allDates
  // is sorted ascending, so a single advancing pointer over movDates replaces
  // the per-date rescan. For each date d, `c` holds the cash value at the
  // largest movement date <= d (or round2(start) before any movement).
  let movIdx = 0;
  let c = round2(start);
  const cashOn = (d: string): number => {
    while (movIdx < movDates.length && movDates[movIdx] <= d) {
      c = cashByMovementDate.get(movDates[movIdx])!;
      movIdx++;
    }
    return round2(c);
  };

  const pfValues = await portfolioValueBySourceOverTime(db, sourceId, allDates);

  return allDates.map((d) => {
    const cash = cashOn(d);
    const portfolios = round2(pfValues[d] ?? 0);
    return { date: d, value: round2(cash + portfolios), cash, portfolios };
  });
}

/** Movement count per source id (both transfer legs counted). */
export async function movementCounts(db: SqlExecutor): Promise<Map<number, number>> {
  const rows = await db.select<{ source_id: number | null; c: number }>(
    `SELECT source_id, COUNT(*) c FROM movements WHERE source_id IS NOT NULL GROUP BY source_id`,
  );
  return new Map(rows.map((r) => [r.source_id as number, r.c]));
}
