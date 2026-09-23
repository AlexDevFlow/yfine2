/**
 * NEW FEATURE — cashflow forecast. Projects each currency's cash balance forward
 * by replaying scheduled recurring items from their next due date, so you can see
 * when an account is heading negative BEFORE it happens. Pure computation over
 * sources + recurring_items; no schema change.
 */
import type { SqlExecutor } from "../types";
import { round2 } from "@/domain/money";
import { addDaysISO } from "@/lib/date";
import { anchorDayOf, computeNextDueDate } from "./recurring";
import { getBalancesAsOfBatch, listSources } from "./sources";

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
  start_date: string;
  end_date: string | null;
  source_id: number | null;
}

export async function forecastCashflow(
  db: SqlExecutor,
  horizonDays: number,
  today: string,
): Promise<CurrencyForecast[]> {
  const sources = await listSources(db, { includeHidden: true });
  // Opening balances as of TODAY: a movement the user already booked with a
  // future date (next month's rent, a scheduled deposit) is not money that has
  // moved yet. It belongs on the timeline at its date — below — not silently
  // pre-applied to the starting figure, where it would double-dip with the
  // recurring rule that produced it or hide WHEN the balance actually dips.
  const balances = await getBalancesAsOfBatch(db, today);
  const startByCcy = new Map<string, number>();
  const sourceCcy = new Map<number, string>();
  for (const s of sources) {
    sourceCcy.set(s.id, s.currency);
    startByCcy.set(s.currency, round2((startByCcy.get(s.currency) ?? 0) + (balances.get(s.id) ?? round2(s.starting_balance))));
  }

  const horizonEnd = addDaysISO(today, horizonDays);
  const items = await db.select<RecRow>(`SELECT id,name,amount,direction,frequency,next_due_date,start_date,end_date,source_id FROM recurring_items WHERE source_id IS NOT NULL`);

  const events: { date: string; currency: string; delta: number; label: string }[] = [];

  // Already-booked future movements inside the window, netted per (date, currency).
  // Same-currency transfer legs cancel here exactly as they do in a balance.
  const scheduled = await db.select<{ date: string; currency: string; delta: number }>(
    `SELECT m.date AS date, s.currency AS currency,
            SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END) AS delta
     FROM movements m JOIN sources s ON m.source_id = s.id
     WHERE m.date > ? AND m.date <= ?
     GROUP BY m.date, s.currency`,
    [today, horizonEnd],
  );
  for (const r of scheduled) {
    const delta = round2(r.delta);
    if (delta !== 0) events.push({ date: r.date, currency: r.currency, delta, label: "scheduled" });
  }
  for (const it of items) {
    const ccy = it.source_id != null ? sourceCcy.get(it.source_id) : undefined;
    if (!ccy) continue;
    let d = it.next_due_date;
    // Fast-forward to the first occurrence >= today BEFORE the bounded projection.
    // A confirm-mode daily item the user never applies keeps next_due_date frozen in
    // the past; without this, the projection guard exhausts replaying old dates and the
    // item contributes zero future events (silently dropped from the forecast).
    // Same anchoring as the scheduler, so the projected dates are the ones the
    // rule will actually fire on (a bill on the 31st stays on the 31st).
    const anchor = anchorDayOf(it);
    // An occurrence still sitting in the past is an unpaid, overdue bill (auto
    // rules are advanced by the scheduler, so only confirm-mode ones get here).
    // The dashboard lists it as overdue; the projection places it today rather
    // than pretending it will never be paid.
    if (d < today && !(it.end_date && d > it.end_date)) {
      events.push({ date: today, currency: ccy, delta: it.direction === "in" ? it.amount : -it.amount, label: it.name });
    }
    let ff = 0;
    while (d < today && ff < 100_000) {
      if (it.end_date && d > it.end_date) break;
      const next = computeNextDueDate(d, it.frequency, anchor);
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
      const next = computeNextDueDate(d, it.frequency, anchor);
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
    const evs = events.filter((ev) => ev.currency === currency);
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      running = round2(running + ev.delta);
      points.push({ date: ev.date, balance: running, label: ev.label });
      // Judge the balance at the END of each day: rent and salary due on the
      // same 1st must not flag "goes negative" just because rent happened to
      // be stored first.
      const dayDone = i === evs.length - 1 || evs[i + 1].date !== ev.date;
      if (!dayDone) continue;
      if (running < lowest) lowest = running;
      if (running < 0 && !negativeFrom) negativeFrom = ev.date;
    }
    out.push({ currency, start, end: round2(running), lowest, negativeFrom, points });
  }
  return out.sort((a, b) => Math.abs(b.start) - Math.abs(a.start));
}
