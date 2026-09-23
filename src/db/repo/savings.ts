/**
 * Savings deposits. A "saving" is the IN leg of a transfer into the currency's
 * savings fund (refactor-analysis/sources-savings.md §B). Conservation: net
 * worth in that currency is unchanged — money leaves the from-source and enters
 * the fund. The exposed "saving id" is the IN-leg movement id.
 */
import type { SqlExecutor } from "../types";
import type { MovementRow } from "../schema-types";
import { DomainError } from "../errors";
import { round2 } from "@/domain/money";
import { validateDate } from "@/domain/validators";
import { lastNMonths, todayISO } from "@/lib/date";
import { ensureFundForCurrency, getSource } from "./sources";
import { createTransferPair, deleteMovementCascade } from "./transfers";

export interface NewSaving {
  fromSourceId: number;
  amount: number;
  date: string;
  note?: string | null;
  tagIds?: number[];
  /** Optional explicit currency; must match the from-source's currency. */
  currency?: string;
}

/** Create a savings deposit. Returns the IN-leg movement id (the "saving id"). */
export async function createSaving(
  db: SqlExecutor,
  input: NewSaving,
  fundLabel = "Savings Fund",
): Promise<number> {
  if (!(input.amount > 0)) throw new DomainError("invalid_amount");
  validateDate(input.date);
  const from = await getSource(db, input.fromSourceId);
  if (!from) throw new DomainError("not_found");
  if (from.is_savings_fund === 1) throw new DomainError("fund_save_rejected");

  let currency = from.currency;
  if (input.currency) {
    const requested = input.currency.trim().toUpperCase();
    if (requested !== from.currency) throw new DomainError("currency_mismatch");
    currency = requested;
  }

  const fund = await ensureFundForCurrency(db, currency, fundLabel);
  const { inId } = await createTransferPair(db, {
    fromSourceId: from.id,
    toSourceId: fund.id,
    amount: input.amount,
    date: input.date,
    note: input.note ?? null,
    tagIds: input.tagIds ?? [],
    isSavingsContribution: true,
  });
  return inId;
}

/** Delete a saving — reverses BOTH legs (refund to the from-source + fund debit). */
export async function deleteSaving(db: SqlExecutor, savingInLegId: number): Promise<void> {
  await deleteMovementCascade(db, savingInLegId);
}

export interface EnrichedSaving {
  /** The IN-leg movement id (the "saving id"). */
  id: number;
  amount: number;
  /** Currency of the savings fund the money landed in. */
  currency: string;
  date: string;
  note: string | null;
  /** Where the money came from (the OUT-leg's source). */
  from_source_id: number | null;
  from_source_name: string | null;
  fund_source_id: number | null;
  tags: { id: number; name: string; color: string | null }[];
}

export interface SavingsFilters {
  /** Currency of the fund the money landed in. */
  currency?: string | null;
  /** Tag id present on the IN-leg. */
  tagId?: number | null;
  /** Inclusive date lower bound (YYYY-MM-DD). */
  dateFrom?: string | null;
  /** Inclusive date upper bound (YYYY-MM-DD). */
  dateTo?: string | null;
}

/**
 * Build the WHERE/JOIN fragment shared by listSavings + countSavings. The
 * currency filter joins the fund source; the tag filter joins movement_tag on
 * the IN-leg (mirrors services/savings.py `_build_list_query`).
 */
function buildFilter(f: SavingsFilters): { join: string; where: string; params: unknown[] } {
  const where: string[] = ["m.is_savings_contribution = 1"];
  const params: unknown[] = [];
  let join = "LEFT JOIN sources f ON m.source_id = f.id";
  if (f.tagId != null) {
    join += " JOIN movement_tag mtf ON mtf.movement_id = m.id AND mtf.tag_id = ?";
    params.push(f.tagId);
  }
  if (f.currency) {
    where.push("f.currency = ?");
    params.push(f.currency.trim().toUpperCase());
  }
  if (f.dateFrom) {
    where.push("m.date >= ?");
    params.push(f.dateFrom);
  }
  if (f.dateTo) {
    where.push("m.date <= ?");
    params.push(f.dateTo);
  }
  return { join, where: where.join(" AND "), params };
}

/** Count savings matching the filters (for pagination). */
export async function countSavings(db: SqlExecutor, filters: SavingsFilters = {}): Promise<number> {
  const { join, where, params } = buildFilter(filters);
  const rows = await db.select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM movements m ${join} WHERE ${where}`,
    params,
  );
  return rows[0]?.c ?? 0;
}

/**
 * List savings deposits — the IN-legs flagged `is_savings_contribution`, newest
 * first. Mirrors the legacy `list_savings` contract (currency comes from the
 * fund; "from" comes from the partner OUT-leg's source). Supports
 * currency/tag/date filters + offset pagination.
 */
export async function listSavings(
  db: SqlExecutor,
  opts: SavingsFilters & { limit?: number; offset?: number } = {},
): Promise<EnrichedSaving[]> {
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  const { join, where, params } = buildFilter(opts);
  const rows = await db.select<{
    id: number;
    amount: number;
    date: string;
    note: string | null;
    fund_source_id: number | null;
    currency: string | null;
    from_source_id: number | null;
    from_source_name: string | null;
  }>(
    `SELECT m.id, m.amount, m.date, m.note,
       m.source_id AS fund_source_id, f.currency AS currency,
       (SELECT pm.source_id FROM movements pm WHERE pm.id = m.transfer_pair_id) AS from_source_id,
       (SELECT ps.name FROM movements pm LEFT JOIN sources ps ON pm.source_id = ps.id WHERE pm.id = m.transfer_pair_id) AS from_source_name
     FROM movements m ${join}
     WHERE ${where}
     ORDER BY m.date DESC, m.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const out: EnrichedSaving[] = rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    currency: r.currency ?? "",
    date: r.date,
    note: r.note,
    from_source_id: r.from_source_id,
    from_source_name: r.from_source_name,
    fund_source_id: r.fund_source_id,
    tags: [],
  }));

  if (rows.length) {
    const byId = new Map(out.map((s) => [s.id, s]));
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");
    const tagRows = await db.select<{ movement_id: number; id: number; name: string; color: string | null }>(
      `SELECT mt.movement_id, t.id, t.name, t.color
       FROM movement_tag mt JOIN tags t ON t.id = mt.tag_id
       WHERE mt.movement_id IN (${ph}) ORDER BY t.name COLLATE NOCASE`,
      ids,
    );
    for (const tr of tagRows) byId.get(tr.movement_id)?.tags.push({ id: tr.id, name: tr.name, color: tr.color });
  }

  return out;
}

export interface SavingPatch {
  amount?: number;
  date?: string;
  note?: string | null;
  tagIds?: number[];
  /** Move the saving to a different currency's fund (re-points the IN leg). */
  currency?: string;
  /** Re-point the OUT leg to a different from-source. */
  fromSourceId?: number;
}

/**
 * Edit a saving by its IN-leg id, keeping BOTH legs in lockstep (amount, date,
 * note, tags) and preserving the is_savings_contribution flag + transfer pair
 * (refactor-analysis §B-8). Changing currency moves the IN leg to the new
 * currency's fund; if the partner OUT-leg's source currency no longer matches
 * and no compatible fromSourceId is supplied, rejects (422-equivalent). Faithful
 * port of services/savings.py `update_saving` (with BUG-2's redundant guard
 * dropped).
 */
export async function updateSaving(
  db: SqlExecutor,
  savingInLegId: number,
  patch: SavingPatch,
  fundLabel = "Savings Fund",
): Promise<void> {
  const inLeg = (await db.select<MovementRow>(
    `SELECT id,source_id,amount,direction,date,note,transfer_pair_id,exclude_from_stats,is_savings_contribution,created_at,updated_at
     FROM movements WHERE id = ?`,
    [savingInLegId],
  ))[0];
  if (!inLeg || inLeg.is_savings_contribution !== 1) throw new DomainError("not_found");
  const partner =
    inLeg.transfer_pair_id != null
      ? (await db.select<MovementRow>(
          `SELECT id,source_id,amount,direction,date,note,transfer_pair_id,exclude_from_stats,is_savings_contribution,created_at,updated_at
           FROM movements WHERE id = ?`,
          [inLeg.transfer_pair_id],
        ))[0] ?? null
      : null;

  const inSets: string[] = [];
  const inParams: unknown[] = [];
  const outSets: string[] = [];
  const outParams: unknown[] = [];
  const iset = (c: string, v: unknown) => (inSets.push(`${c} = ?`), inParams.push(v));
  const oset = (c: string, v: unknown) => (outSets.push(`${c} = ?`), outParams.push(v));

  if (patch.note !== undefined) {
    // Same normalisation as createSaving → transfers (blank → NULL, trimmed).
    const note = patch.note?.trim() || null;
    iset("note", note);
    if (partner) oset("note", note);
  }
  if (patch.amount !== undefined) {
    if (!(patch.amount > 0)) throw new DomainError("invalid_amount");
    iset("amount", patch.amount);
    if (partner) oset("amount", patch.amount);
  }
  if (patch.date !== undefined) {
    validateDate(patch.date);
    iset("date", patch.date);
    if (partner) oset("date", patch.date);
  }

  // Currency change → move the IN leg to the new currency's fund.
  const newCurrency = patch.currency ? patch.currency.trim().toUpperCase() : null;
  let inFundId = inLeg.source_id;
  if (newCurrency) {
    const fundNow = inLeg.source_id != null ? await getSource(db, inLeg.source_id) : null;
    if (fundNow && fundNow.currency !== newCurrency) {
      const newFund = await ensureFundForCurrency(db, newCurrency, fundLabel);
      inFundId = newFund.id;
      iset("source_id", newFund.id);
      // A partner with a different-currency source no longer makes sense; if no
      // compatible from-source was supplied, surface the conflict.
      if (partner && patch.fromSourceId === undefined) {
        const partnerSrc = partner.source_id != null ? await getSource(db, partner.source_id) : null;
        if (partnerSrc && partnerSrc.currency !== newCurrency) {
          throw new DomainError("currency_mismatch");
        }
      }
    }
  }

  // Re-point the OUT leg to a new from-source (currency-matched, non-fund).
  if (patch.fromSourceId !== undefined && partner) {
    const newSrc = await getSource(db, patch.fromSourceId);
    if (!newSrc) throw new DomainError("not_found");
    const fundNow = inFundId != null ? await getSource(db, inFundId) : null;
    if (fundNow && newSrc.currency !== fundNow.currency) throw new DomainError("currency_mismatch");
    if (newSrc.is_savings_fund === 1) throw new DomainError("fund_save_rejected");
    oset("source_id", newSrc.id);
  }

  const ts = new Date().toISOString();
  iset("updated_at", ts);
  await db.execute(`UPDATE movements SET ${inSets.join(", ")} WHERE id = ?`, [...inParams, inLeg.id]);
  if (partner) {
    oset("updated_at", ts);
    await db.execute(`UPDATE movements SET ${outSets.join(", ")} WHERE id = ?`, [...outParams, partner.id]);
  }

  // Reset tags on BOTH legs symmetrically.
  if (patch.tagIds !== undefined) {
    const ids = partner ? [inLeg.id, partner.id] : [inLeg.id];
    const ph = ids.map(() => "?").join(",");
    await db.execute(`DELETE FROM movement_tag WHERE movement_id IN (${ph})`, ids);
    for (const tid of patch.tagIds) {
      for (const mid of ids) {
        await db.execute(`INSERT OR IGNORE INTO movement_tag (movement_id, tag_id) VALUES (?, ?)`, [mid, tid]);
      }
    }
  }
}

// --- Aggregates (refactor-analysis §G) ---

/**
 * Total saved per currency — sums ONLY is_savings_contribution movements,
 * grouped by the fund's currency. Goal allocations into a fund are deliberately
 * NOT counted (§G-27). Optionally scoped to one currency.
 */
export async function totalSaved(
  db: SqlExecutor,
  currency?: string | null,
): Promise<Record<string, number>> {
  const params: unknown[] = [];
  let extra = "";
  if (currency) {
    extra = " AND f.currency = ?";
    params.push(currency.trim().toUpperCase());
  }
  const rows = await db.select<{ currency: string; total: number }>(
    `SELECT f.currency AS currency, SUM(m.amount) AS total
     FROM movements m JOIN sources f ON m.source_id = f.id
     WHERE m.is_savings_contribution = 1${extra}
     GROUP BY f.currency`,
    params,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.currency] = round2(r.total ?? 0);
  return out;
}

/** Total saved per currency within an inclusive date range (contributions only). */
export async function totalSavedPeriod(
  db: SqlExecutor,
  dateFrom: string,
  dateTo: string,
): Promise<Record<string, number>> {
  const rows = await db.select<{ currency: string; total: number }>(
    `SELECT f.currency AS currency, SUM(m.amount) AS total
     FROM movements m JOIN sources f ON m.source_id = f.id
     WHERE m.is_savings_contribution = 1 AND m.date >= ? AND m.date <= ?
     GROUP BY f.currency`,
    [dateFrom, dateTo],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.currency] = round2(r.total ?? 0);
  return out;
}

export interface TrendPoint {
  month: string; // YYYY-MM
  currency: string;
  value: number;
}

/**
 * Tab 1 — monthly contributions per currency (deposits only,
 * is_savings_contribution). Faithful port of services/savings.py monthly_trend.
 */
export async function monthlyTrend(
  db: SqlExecutor,
  months = 12,
  today: string = todayISO(),
): Promise<TrendPoint[]> {
  const cutoff = lastNMonths(today, months)[0] + "-01";
  const rows = await db.select<{ month: string; currency: string; total: number }>(
    `SELECT strftime('%Y-%m', m.date) AS month, f.currency AS currency, SUM(m.amount) AS total
     FROM movements m JOIN sources f ON m.source_id = f.id
     WHERE m.is_savings_contribution = 1 AND m.date >= ?
     GROUP BY month, f.currency
     ORDER BY month`,
    [cutoff],
  );
  return rows.map((r) => ({ month: r.month, currency: r.currency, value: round2(r.total ?? 0) }));
}

/**
 * Tab 2 — running end-of-month balance of each savings fund. Counts ALL
 * movements on is_savings_fund sources (so it includes goal allocations + yield
 * credits, unlike tab 1 — the §G-28 asymmetry). Faithful port of
 * services/savings.py fund_balance_trend.
 */
export async function fundBalanceTrend(
  db: SqlExecutor,
  months = 12,
  today: string = todayISO(),
): Promise<TrendPoint[]> {
  const cutoff = lastNMonths(today, months)[0]; // YYYY-MM
  const rows = await db.select<{ month: string; currency: string; direction: "in" | "out"; total: number }>(
    `SELECT strftime('%Y-%m', m.date) AS month, f.currency AS currency, m.direction AS direction, SUM(m.amount) AS total
     FROM movements m JOIN sources f ON m.source_id = f.id
     WHERE f.is_savings_fund = 1
     GROUP BY month, f.currency, m.direction
     ORDER BY month`,
    [],
  );
  // Net per (month, currency).
  const net = new Map<string, number>();
  const monthSet = new Set<string>();
  const ccySet = new Set<string>();
  for (const r of rows) {
    const key = `${r.month}|${r.currency}`;
    const signed = r.direction === "in" ? (r.total ?? 0) : -(r.total ?? 0);
    net.set(key, (net.get(key) ?? 0) + signed);
    monthSet.add(r.month);
    ccySet.add(r.currency);
  }
  // Walk every month from the earliest movement (or the cutoff, whichever is
  // first) through today, not just the months that had movements: a balance is
  // a LEVEL, so a fund untouched for a year still has its balance in every one
  // of those months — dropping them left gaps in the chart and made a dormant
  // fund vanish from it entirely.
  const window = lastNMonths(today, months);
  const firstMonth = [...monthSet].sort()[0];
  const walkFrom = firstMonth != null && firstMonth < cutoff ? firstMonth : cutoff;
  const allMonths = monthsBetween(walkFrom, window[window.length - 1]);
  const out: TrendPoint[] = [];
  for (const cur of [...ccySet].sort()) {
    let running = 0;
    for (const month of allMonths) {
      running += net.get(`${month}|${cur}`) ?? 0;
      if (month < cutoff) continue; // accumulate history but only emit from cutoff
      out.push({ month, currency: cur, value: round2(running) });
    }
  }
  return out;
}

/** Every "YYYY-MM" from `from` to `to` inclusive (both YYYY-MM), chronological. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  for (let i = fy * 12 + (fm - 1); i <= ty * 12 + (tm - 1); i++) {
    out.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** All savings in a given month (YYYY-MM) — the calendar drill-down list. */
export async function savingsByMonth(
  db: SqlExecutor,
  yearMonth: string,
): Promise<EnrichedSaving[]> {
  const [y, m] = yearMonth.split("-").map(Number);
  const first = `${yearMonth}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
  return listSavings(db, { dateFrom: first, dateTo: last, limit: 500 });
}
