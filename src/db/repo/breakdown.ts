/**
 * Spending breakdown: "where did the money actually go?".
 *
 * Aggregates the SAME rows the movements list and the KPI band already agree on
 * — `buildFilter` is shared with movements.ts, and transfers plus
 * `exclude_from_stats` rows are dropped exactly like sumMovements /
 * dashboard.monthlyFlow do. No FX conversion ever happens here: amounts are
 * grouped BY CURRENCY and the caller picks one, mirroring the net-worth rule
 * that currencies are never silently summed together.
 *
 * Tag attribution: a movement can carry several tags, so charging its full
 * amount to each one would make the slices add up to more than the total and
 * the donut meaningless. Each slice therefore carries two figures:
 *  - `total` — the amount split EVENLY across the movement's tags, so every
 *    slice is disjoint and the shares sum to exactly 100 %;
 *  - `gross` — the full amount of every movement carrying the tag, which is the
 *    number you want when you ask "how much did anything tagged Food cost me?".
 * Untagged movements form their own slice (`key: "untagged"`).
 */
import type { SqlExecutor } from "../types";
import { round2 } from "@/domain/money";
import { addDaysISO, addMonthsISO, daysBetween, monthEnd, monthStart } from "@/lib/date";
import { buildFilter, type MovementFilters } from "./movements";

export interface BreakdownSlice {
  /** Stable identity: `tag:<id>`, `source:<id>`, `untagged` or `external`. */
  key: string;
  /** Tag/account name; null for the untagged and external buckets. */
  label: string | null;
  /** Tag colour when the user set one — otherwise the UI assigns a palette colour. */
  color: string | null;
  /** Disjoint share of the period total (multi-tag rows split evenly). */
  total: number;
  /** Full amount of every movement in this bucket (tag overlaps double-count). */
  gross: number;
  count: number;
}

export interface BreakdownItem {
  id: number;
  date: string;
  amount: number;
  note: string | null;
  source_name: string | null;
  tags: string[];
}

export interface Breakdown {
  /** The currency these figures are in (the busiest one unless the caller picks). */
  currency: string;
  /** Every currency present in the range, biggest first — drives the switcher. */
  currencies: { currency: string; total: number }[];
  total: number;
  count: number;
  /** Mean movement size, 0 when there are none. */
  avg: number;
  /** Middle movement size — says more than the mean when one bill dwarfs the rest. */
  median: number;
  byTag: BreakdownSlice[];
  bySource: BreakdownSlice[];
  /** Chronological, only the months that actually have rows. */
  byMonth: { month: string; total: number }[];
  /** Monday-first totals, always 7 entries. */
  byWeekday: number[];
  /** Biggest single movements, largest first. */
  top: BreakdownItem[];
  /** Notes seen more than once — the subscriptions and habits hiding in the list. */
  repeats: { label: string; total: number; count: number }[];
}

interface Row {
  id: number;
  date: string;
  amount: number;
  note: string | null;
  source_id: number | null;
  source_name: string | null;
  currency: string | null;
}

/** Transfers and stat-excluded rows never count — same rule as sumMovements. */
const STATS_ONLY = "m.transfer_pair_id IS NULL AND m.exclude_from_stats = 0";

function scoped(f: MovementFilters): { where: string; params: unknown[] } {
  const { where, params } = buildFilter(f);
  return { where: where ? `${where} AND ${STATS_ONLY}` : `WHERE ${STATS_ONLY}`, params };
}

/** Period total per currency — used for the "vs previous period" delta. */
export async function totalByCurrency(
  db: SqlExecutor,
  f: MovementFilters,
): Promise<Record<string, number>> {
  const { where, params } = scoped(f);
  const rows = await db.select<{ currency: string | null; total: number }>(
    `SELECT s.currency AS currency, COALESCE(SUM(m.amount), 0) AS total
     FROM movements m LEFT JOIN sources s ON m.source_id = s.id
     ${where} GROUP BY s.currency`,
    params,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.currency ?? ""] = round2(r.total);
  return out;
}

function weekdayIndex(iso: string): number {
  // Monday-first (0..6). Parsed as UTC so a local timezone can't shift the day.
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return (d + 6) % 7;
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

export async function spendingBreakdown(
  db: SqlExecutor,
  filters: MovementFilters,
  opts: { currency?: string; topLimit?: number; repeatLimit?: number } = {},
): Promise<Breakdown> {
  const { where, params } = scoped(filters);
  const rows = await db.select<Row>(
    `SELECT m.id, m.date, m.amount, m.note, m.source_id,
            s.name AS source_name, s.currency AS currency
     FROM movements m LEFT JOIN sources s ON m.source_id = s.id
     ${where}`,
    params,
  );

  // Tags for exactly the same row set. Re-running the filter as a subquery
  // (rather than an IN list of ids) keeps this to one round-trip and can't hit
  // SQLite's bound-parameter ceiling on a wide range.
  const tagRows = rows.length
    ? await db.select<{ movement_id: number; id: number; name: string; color: string | null }>(
        `SELECT mt.movement_id, t.id, t.name, t.color
         FROM movement_tag mt JOIN tags t ON t.id = mt.tag_id
         WHERE mt.movement_id IN (
           SELECT m.id FROM movements m LEFT JOIN sources s ON m.source_id = s.id ${where}
         )`,
        params,
      )
    : [];
  const tagsOf = new Map<number, { id: number; name: string; color: string | null }[]>();
  for (const tr of tagRows) {
    const list = tagsOf.get(tr.movement_id);
    if (list) list.push(tr);
    else tagsOf.set(tr.movement_id, [tr]);
  }

  // Pick the currency to report on: the caller's choice when it has rows, else
  // the one carrying the most money. Rows on a deleted/external source have no
  // currency and land in the "" bucket, which the UI labels plainly.
  const perCurrency = new Map<string, number>();
  for (const r of rows) perCurrency.set(r.currency ?? "", round2((perCurrency.get(r.currency ?? "") ?? 0) + r.amount));
  const currencies = [...perCurrency.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => b.total - a.total);
  const currency =
    opts.currency != null && perCurrency.has(opts.currency) ? opts.currency : currencies[0]?.currency ?? "";
  const scopedRows = rows.filter((r) => (r.currency ?? "") === currency);

  const tagAgg = new Map<string, BreakdownSlice>();
  const srcAgg = new Map<string, BreakdownSlice>();
  const monthAgg = new Map<string, number>();
  const noteAgg = new Map<string, { label: string; total: number; count: number }>();
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;

  const bump = (
    map: Map<string, BreakdownSlice>,
    key: string,
    label: string | null,
    color: string | null,
    share: number,
    amount: number,
  ) => {
    const cur = map.get(key) ?? { key, label, color, total: 0, gross: 0, count: 0 };
    cur.total = round2(cur.total + share);
    cur.gross = round2(cur.gross + amount);
    cur.count += 1;
    map.set(key, cur);
  };

  for (const r of scopedRows) {
    total = round2(total + r.amount);
    const tags = tagsOf.get(r.id) ?? [];
    if (tags.length === 0) {
      bump(tagAgg, "untagged", null, null, r.amount, r.amount);
    } else {
      // Cent-exact split: every tag but the first gets the rounded share and the
      // first absorbs the remainder, so the slices add up to the movement (10.00
      // over three tags is 3.34 + 3.33 + 3.33, not three 3.33s that sum to 9.99).
      const share = round2(r.amount / tags.length);
      const first = round2(r.amount - share * (tags.length - 1));
      tags.forEach((tg, i) => bump(tagAgg, `tag:${tg.id}`, tg.name, tg.color, i === 0 ? first : share, r.amount));
    }
    const sKey = r.source_id == null ? "external" : `source:${r.source_id}`;
    bump(srcAgg, sKey, r.source_name, null, r.amount, r.amount);

    const ym = r.date.slice(0, 7);
    monthAgg.set(ym, round2((monthAgg.get(ym) ?? 0) + r.amount));
    byWeekday[weekdayIndex(r.date)] = round2(byWeekday[weekdayIndex(r.date)] + r.amount);

    const note = (r.note ?? "").trim();
    if (note) {
      const k = note.toLowerCase();
      const cur = noteAgg.get(k) ?? { label: note, total: 0, count: 0 };
      cur.total = round2(cur.total + r.amount);
      cur.count += 1;
      noteAgg.set(k, cur);
    }
  }

  const bySize = scopedRows.map((r) => r.amount).sort((a, b) => a - b);
  const byAmountDesc = [...scopedRows].sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date));

  return {
    currency,
    currencies,
    total,
    count: scopedRows.length,
    avg: scopedRows.length ? round2(total / scopedRows.length) : 0,
    median: median(bySize),
    byTag: [...tagAgg.values()].sort((a, b) => b.total - a.total),
    bySource: [...srcAgg.values()].sort((a, b) => b.total - a.total),
    byMonth: [...monthAgg.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, t]) => ({ month, total: t })),
    byWeekday,
    top: byAmountDesc.slice(0, opts.topLimit ?? 8).map((r) => ({
      id: r.id,
      date: r.date,
      amount: r.amount,
      note: r.note,
      source_name: r.source_name,
      tags: (tagsOf.get(r.id) ?? []).map((tg) => tg.name),
    })),
    repeats: [...noteAgg.values()]
      .filter((n) => n.count > 1)
      .sort((a, b) => b.total - a.total)
      .slice(0, opts.repeatLimit ?? 6),
  };
}

/**
 * The comparable window immediately before `[from, to]`.
 *
 * Whole-calendar-month ranges shift by whole months (August compares against
 * July, not "the 31 days before August"), which is what "vs previous period"
 * means to anyone reading a monthly figure. Anything else — a custom filter, a
 * fortnight — shifts back by its own length in days.
 */
export function previousRange(from: string, to: string): { from: string; to: string } {
  if (from === monthStart(from) && to === monthEnd(to)) {
    const months =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
      1;
    return { from: addMonthsISO(from, -months), to: monthEnd(addMonthsISO(monthStart(to), -months)) };
  }
  const days = daysBetween(from, to) + 1;
  const prevTo = addDaysISO(from, -1);
  return { from: addDaysISO(prevTo, -(days - 1)), to: prevTo };
}
