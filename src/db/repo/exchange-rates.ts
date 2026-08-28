/**
 * Exchange rates: one row per directed pair (unique). Provides the FX-conversion
 * seam the portfolio totals need (fixes the mixed-currency BUG-1). Rate semantics:
 * 1 `from` = rate × `to`.
 *
 * Lookup order is direct pair → inverse pair → shortest chain through the pairs
 * that DO exist (BFS). The chain step is what makes a star-shaped rate table
 * usable: storing EUR→USD and EUR→GBP is enough to value a USD holding in a GBP
 * portfolio, so `refreshRates` only has to fetch one row per currency instead of
 * every ordered pair.
 */
import type { SqlExecutor } from "../types";
import { round2 } from "@/domain/money";

const now = () => new Date().toISOString();

export interface ExchangeRateRow {
  id: number;
  from_currency: string;
  to_currency: string;
  rate: number;
  updated_at: string;
}

export async function listRates(db: SqlExecutor): Promise<ExchangeRateRow[]> {
  return db.select<ExchangeRateRow>(`SELECT * FROM exchange_rates ORDER BY from_currency, to_currency`);
}

/** Longest chain we will walk. 3 hops covers any star/two-pivot table; deeper
 *  chains would multiply enough rounding error to not be worth trusting. */
const MAX_HOPS = 3;

/**
 * Rate to convert `from` → `to` through the stored pairs, or null if unreachable.
 * Direct pair first, then the inverse, then the shortest chain (e.g. USD→EUR→GBP).
 */
export async function getRate(db: SqlExecutor, from: string, to: string): Promise<number | null> {
  const f = from.trim().toUpperCase();
  const t = to.trim().toUpperCase();
  if (f === t) return 1;
  const direct = await db.select<{ rate: number }>(
    `SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?`,
    [f, t],
  );
  // A stored 0 is "not configured", not a real rate — using it would convert
  // every amount to 0 (which then reads as an invalid transfer leg downstream).
  if (direct[0] && direct[0].rate !== 0) return direct[0].rate;
  const inverse = await db.select<{ rate: number }>(
    `SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = ?`,
    [t, f],
  );
  if (inverse[0] && inverse[0].rate !== 0) return 1 / inverse[0].rate;
  return chainRate(await listRates(db), f, t);
}

/**
 * Shortest-path rate through the stored pairs (each row usable in both
 * directions). Pure so it stays cheap to test; BFS keeps the hop count minimal,
 * which keeps the compounded rounding error minimal too.
 */
export function chainRate(rows: ExchangeRateRow[], from: string, to: string): number | null {
  const f = from.trim().toUpperCase();
  const t = to.trim().toUpperCase();
  if (f === t) return 1;
  const edges = new Map<string, { to: string; rate: number }[]>();
  const add = (a: string, b: string, rate: number) => {
    const list = edges.get(a) ?? [];
    list.push({ to: b, rate });
    edges.set(a, list);
  };
  for (const r of rows) {
    if (!r.rate) continue; // 0 = not configured (see getRate)
    const a = r.from_currency.toUpperCase();
    const b = r.to_currency.toUpperCase();
    if (a === b) continue;
    add(a, b, r.rate);
    add(b, a, 1 / r.rate);
  }
  let frontier = [{ ccy: f, rate: 1 }];
  const seen = new Set([f]);
  for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop++) {
    const next: { ccy: string; rate: number }[] = [];
    for (const node of frontier) {
      for (const e of edges.get(node.ccy) ?? []) {
        if (seen.has(e.to)) continue;
        const rate = node.rate * e.rate;
        if (e.to === t) return Number.isFinite(rate) && rate > 0 ? rate : null;
        seen.add(e.to);
        next.push({ ccy: e.to, rate });
      }
    }
    frontier = next;
  }
  return null;
}

/** Convert an amount, or null when no rate is available. */
export async function convert(db: SqlExecutor, amount: number, from: string, to: string): Promise<number | null> {
  const rate = await getRate(db, from, to);
  if (rate == null) return null;
  const v = round2(amount * rate);
  // A positive amount that rounds to nothing is useless as an auto-fill and
  // reads as a 0 leg downstream — treat it like a missing rate.
  return amount > 0 && v <= 0 ? null : v;
}

export async function upsertRate(db: SqlExecutor, from: string, to: string, rate: number): Promise<void> {
  const f = from.trim().toUpperCase();
  const t = to.trim().toUpperCase();
  const existing = await db.select<{ id: number }>(
    `SELECT id FROM exchange_rates WHERE from_currency = ? AND to_currency = ?`,
    [f, t],
  );
  if (existing[0]) {
    await db.execute(`UPDATE exchange_rates SET rate = ?, updated_at = ? WHERE id = ?`, [rate, now(), existing[0].id]);
  } else {
    await db.execute(
      `INSERT INTO exchange_rates (from_currency,to_currency,rate,updated_at) VALUES (?,?,?,?)`,
      [f, t, rate, now()],
    );
  }
}

export async function deleteRate(db: SqlExecutor, id: number): Promise<void> {
  await db.execute(`DELETE FROM exchange_rates WHERE id = ?`, [id]);
}

/** Most recent `updated_at` across all rates, or null when the table is empty. */
export async function lastRateUpdate(db: SqlExecutor): Promise<string | null> {
  const rows = await db.select<{ ts: string | null }>(`SELECT MAX(updated_at) AS ts FROM exchange_rates`);
  return rows[0]?.ts ?? null;
}
