/**
 * NEW FEATURE — cashflow forecast. Projects each currency's cash balance forward
 * by replaying scheduled recurring items from their next due date, so you can see
 * when an account is heading negative BEFORE it happens. Pure computation over
 * sources + recurring_items; no schema change.
 */
import type { SqlExecutor } from "../types";
import { round2 } from "@/domain/money";
import { addDaysISO } from "@/lib/date";
import { computeNextDueDate } from "./recurring";
import { getBalancesBatch, listSources } from "./sources";

export interface ForecastPoint {
  date: string;
  balance: number;
  label?: string; // the recurring item that moved the balance on this date
}
export interface CurrencyForecast {
  currency: string;
  start: number;
  end: number;
  lowest: number;
  negativeFrom: string | null;
  points: ForecastPoint[];
}

interface RecRow {
  id: number;
  name: string;
  amount: number;
  direction: "in" | "out";
  frequency: string;
  next_due_date: string;
  end_date: string | null;
  source_id: number | null;
}

export async function forecastCashflow(
  db: SqlExecutor,
  horizonDays: number,
  today: string,
): Promise<CurrencyForecast[]> {
  const sources = await listSources(db, { includeHidden: true });
  const balances = await getBalancesBatch(db);
  const startByCcy = new Map<string, number>();
  const sourceCcy = new Map<number, string>();
  for (const s of sources) {
    sourceCcy.set(s.id, s.currency);
    startByCcy.set(s.currency, round2((startByCcy.get(s.currency) ?? 0) + (balances.get(s.id) ?? 0)));
  }

  const horizonEnd = addDaysISO(today, horizonDays);
  const items = await db.select<RecRow>(`SELECT id,name,amount,direction,frequency,next_due_date,end_date,source_id FROM recurring_items WHERE source_id IS NOT NULL`);

  const events: { date: string; currency: string; delta: number; label: string }[] = [];
  for (const it of items) {
    const ccy = it.source_id != null ? sourceCcy.get(it.source_id) : undefined;
    if (!ccy) continue;
    let d = it.next_due_date;
    // Fast-forward to the first occurrence >= today BEFORE the bounded projection.
    // A confirm-mode daily item the user never applies keeps next_due_date frozen in
    // the past; without this, the projection guard exhausts replaying old dates and the
    // item contributes zero future events (silently dropped from the forecast).
    let ff = 0;
    while (d < today && ff < 100_000) {
      if (it.end_date && d > it.end_date) break;
      const next = computeNextDueDate(d, it.frequency);
      if (next <= d) break;
      d = next;
      ff += 1;
    }
    let guard = 0;
    while (d <= horizonEnd && guard < 2000) {
      guard += 1;
      if (it.end_date && d > it.end_date) break;
      if (d >= today) {
        events.push({ date: d, currency: ccy, delta: it.direction === "in" ? it.amount : -it.amount, label: it.name });
      }
      const next = computeNextDueDate(d, it.frequency);
      if (next <= d) break;
      d = next;
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const out: CurrencyForecast[] = [];
  for (const [currency, start] of startByCcy) {
    let running = start;
    let lowest = start;
    // Seed from the opening balance: an account already in the red today must be
    // flagged even if no future event ever pushes it negative.
    let negativeFrom: string | null = start < 0 ? today : null;
    const points: ForecastPoint[] = [{ date: today, balance: round2(running) }];
    for (const ev of events) {
      if (ev.currency !== currency) continue;
      running = round2(running + ev.delta);
      points.push({ date: ev.date, balance: running, label: ev.label });
      if (running < lowest) lowest = running;
      if (running < 0 && !negativeFrom) negativeFrom = ev.date;
    }
    out.push({ currency, start, end: round2(running), lowest, negativeFrom, points });
  }
  return out.sort((a, b) => Math.abs(b.start) - Math.abs(a.start));
}
