/**
 * Sources repository. Faithful port of services/sources.py invariants
 * (refactor-analysis/sources-savings.md §A, §C, §D, §E):
 *  - balance is DERIVED (starting + Σin − Σout), never stored.
 *  - currency uppercased at the boundary.
 *  - yield schedule resynced on create, and on update ONLY when rate/period change.
 *  - exactly one savings fund per currency; funds never merge.
 *  - delete is blocked by an active goal; move/external/delete_all reject
 *    cross-currency and cascade manually (FK is also ON as a backstop).
 */
import type { SqlExecutor } from "../types";
import type { SourceRow } from "../schema-types";
import { DomainError } from "../errors";
import { round2 } from "@/domain/money";
import { resyncYieldSchedule } from "@/domain/yield";
import { todayISO } from "@/lib/date";
import { stageAttachmentUnlinks } from "./attachments";

const COLS =
  "id,name,currency,starting_balance,exclude_from_stats,is_savings_fund,hidden_from_sources,yield_rate,yield_period_months,yield_next_date,yield_last_date,created_at,updated_at";

const now = () => new Date().toISOString();

export async function listSources(
  db: SqlExecutor,
  opts: { includeHidden?: boolean } = {},
): Promise<SourceRow[]> {
  const where = opts.includeHidden === false ? "WHERE hidden_from_sources = 0" : "";
  return db.select<SourceRow>(
    `SELECT ${COLS} FROM sources ${where} ORDER BY is_savings_fund ASC, name COLLATE NOCASE ASC`,
  );
}

export async function getSource(
  db: SqlExecutor,
  id: number,
): Promise<SourceRow | null> {
  const rows = await db.select<SourceRow>(`SELECT ${COLS} FROM sources WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

const BALANCE_EXPR = `s.starting_balance + COALESCE((
    SELECT SUM(CASE m.direction WHEN 'in' THEN m.amount ELSE -m.amount END)
    FROM movements m WHERE m.source_id = s.id), 0)`;

export async function getBalance(db: SqlExecutor, id: number): Promise<number> {
  const rows = await db.select<{ bal: number }>(
    `SELECT ${BALANCE_EXPR} AS bal FROM sources s WHERE s.id = ?`,
    [id],
  );
  if (!rows[0]) throw new DomainError("not_found");
  return round2(rows[0].bal);
}

/**
 * Balance as of a given date (inclusive) — what the source actually held then.
 * Used by yield catch-up so a missed period accrues on the balance of THAT
 * period, not on money deposited afterwards.
 */
export async function getBalanceAsOf(db: SqlExecutor, id: number, dateISO: string): Promise<number> {
  const rows = await db.select<{ bal: number }>(
    `SELECT s.starting_balance + COALESCE((
        SELECT SUM(CASE m.direction WHEN 'in' THEN m.amount ELSE -m.amount END)
        FROM movements m WHERE m.source_id = s.id AND m.date <= ?), 0) AS bal
     FROM sources s WHERE s.id = ?`,
    [dateISO, id],
  );
  if (!rows[0]) throw new DomainError("not_found");
  return round2(rows[0].bal);
}

export async function getBalancesBatch(
  db: SqlExecutor,
): Promise<Map<number, number>> {
  const rows = await db.select<{ id: number; bal: number }>(
    `SELECT s.id AS id, ${BALANCE_EXPR} AS bal FROM sources s`,
  );
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.id, round2(r.bal));
  return map;
}

export interface NewSource {
  name: string;
  currency: string;
  starting_balance?: number;
  exclude_from_stats?: boolean;
  yield_rate?: number;
  yield_period_months?: number;
}

export async function createSource(
  db: SqlExecutor,
  data: NewSource,
  today: string = todayISO(),
): Promise<SourceRow> {
  const currency = data.currency.trim().toUpperCase();
  const rate = data.yield_rate ?? 0;
  const period = data.yield_period_months ?? 12;
  const nextDate = resyncYieldSchedule(rate, period, null, today);
  const ts = now();
  const rows = await db.select<{ id: number }>(
    `INSERT INTO sources
      (name,currency,starting_balance,exclude_from_stats,is_savings_fund,hidden_from_sources,yield_rate,yield_period_months,yield_next_date,yield_last_date,created_at,updated_at)
     VALUES (?,?,?,?,0,0,?,?,?,NULL,?,?) RETURNING id`,
    [data.name, currency, data.starting_balance ?? 0, data.exclude_from_stats ? 1 : 0, rate, period, nextDate, ts, ts],
  );
  return (await getSource(db, rows[0].id))!;
}

export interface SourcePatch {
  name?: string;
  currency?: string;
  starting_balance?: number;
  exclude_from_stats?: boolean;
  yield_rate?: number;
  yield_period_months?: number;
}

export async function updateSource(
  db: SqlExecutor,
  id: number,
  patch: SourcePatch,
  today: string = todayISO(),
): Promise<SourceRow> {
  const cur = await getSource(db, id);
  if (!cur) throw new DomainError("not_found");

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };

  if (patch.name !== undefined) set("name", patch.name);
  const newCurrency = patch.currency !== undefined ? patch.currency.trim().toUpperCase() : cur.currency;
  const currencyChanged = newCurrency !== cur.currency;
  if (currencyChanged) {
    // A fund IS its currency: "one fund per currency" and every savings/goal
    // total group by it, so re-labelling one would collide with (or orphan)
    // the fund the contributions were actually made into.
    if (cur.is_savings_fund === 1) throw new DomainError("fund_currency_locked");
    // Goals are created currency-matched to their source and their allocations
    // were transferred in that currency; an active one would silently hold
    // money in a currency it no longer reports.
    const activeGoals = await db.select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM goals WHERE source_id = ? AND status = 'active'`,
      [id],
    );
    if ((activeGoals[0]?.c ?? 0) > 0) throw new DomainError("active_goal_blocks_currency_change");
    set("currency", newCurrency);
  } else if (patch.currency !== undefined) {
    set("currency", newCurrency);
  }
  if (patch.starting_balance !== undefined) set("starting_balance", patch.starting_balance);
  if (patch.exclude_from_stats !== undefined)
    set("exclude_from_stats", patch.exclude_from_stats ? 1 : 0);
  if (patch.yield_rate !== undefined) set("yield_rate", patch.yield_rate);
  if (patch.yield_period_months !== undefined)
    set("yield_period_months", patch.yield_period_months);

  // §17: re-anchor the countdown ONLY when rate/period are in the payload.
  if (patch.yield_rate !== undefined || patch.yield_period_months !== undefined) {
    const rate = patch.yield_rate ?? cur.yield_rate;
    const period = patch.yield_period_months ?? cur.yield_period_months;
    // Interest that was OFF (rate 0 / no schedule) and is being switched back
    // on starts counting from today. Anchoring on the old last-credit date
    // would make the scheduler back-fill every period the account spent with
    // interest disabled, crediting money that was never earned.
    const wasActive = cur.yield_rate > 0 && cur.yield_next_date != null;
    set("yield_next_date", resyncYieldSchedule(rate, period, wasActive ? cur.yield_last_date : null, today));
  }

  set("updated_at", now());
  await db.execute(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  if (currencyChanged) {
    // Recurring rules are validated to share their source's currency (their
    // amounts book straight into it); keep that invariant when the source moves.
    await db.execute(`UPDATE recurring_items SET currency = ?, updated_at = ? WHERE source_id = ?`, [
      newCurrency,
      now(),
      id,
    ]);
  }
  return (await getSource(db, id))!;
}

/** The savings fund for a currency, or null if none exists yet. */
export async function getFundForCurrency(
  db: SqlExecutor,
  currency: string,
): Promise<SourceRow | null> {
  const rows = await db.select<SourceRow>(
    `SELECT ${COLS} FROM sources WHERE is_savings_fund = 1 AND currency = ? LIMIT 1`,
    [currency.trim().toUpperCase()],
  );
  return rows[0] ?? null;
}

/** Find-or-create the single savings fund for a currency (§C-11). */
export async function ensureFundForCurrency(
  db: SqlExecutor,
  currency: string,
  fundLabel = "Savings Fund",
): Promise<SourceRow> {
  const cc = currency.trim().toUpperCase();
  const existing = await db.select<SourceRow>(
    `SELECT ${COLS} FROM sources WHERE is_savings_fund = 1 AND currency = ? LIMIT 1`,
    [cc],
  );
  if (existing[0]) return existing[0];
  const ts = now();
  const rows = await db.select<{ id: number }>(
    `INSERT INTO sources
      (name,currency,starting_balance,exclude_from_stats,is_savings_fund,hidden_from_sources,yield_rate,yield_period_months,yield_next_date,yield_last_date,created_at,updated_at)
     VALUES (?,?,0,0,1,0,0,12,NULL,NULL,?,?) RETURNING id`,
    [`${fundLabel} (${cc})`, cc, ts, ts],
  );
  return (await getSource(db, rows[0].id))!;
}

export async function setFundVisibility(
  db: SqlExecutor,
  id: number,
  hidden: boolean,
): Promise<void> {
  const s = await getSource(db, id);
  if (!s || s.is_savings_fund === 0) throw new DomainError("not_a_fund");
  await db.execute(`UPDATE sources SET hidden_from_sources = ?, updated_at = ? WHERE id = ?`, [
    hidden ? 1 : 0,
    now(),
    id,
  ]);
}

/**
 * After repointing movements onto `targetId`, transfer pairs whose two legs
 * BOTH landed on the target collapse into self-transfers ("B → B") that the
 * same_source invariant makes uneditable — and, both legs being equal amounts
 * in the same currency, they're a balance no-op. Drop both legs plus their
 * tag/attachment/allocation rows.
 */
async function dropSelfTransferPairs(db: SqlExecutor, targetId: number): Promise<void> {
  const rows = await db.select<{ id: number; transfer_pair_id: number }>(
    `SELECT m.id, m.transfer_pair_id FROM movements m
       JOIN movements p ON p.id = m.transfer_pair_id
      WHERE m.source_id = ? AND p.source_id = ?`,
    [targetId, targetId],
  );
  if (rows.length === 0) return;
  const ids = new Set<number>();
  for (const r of rows) {
    ids.add(r.id);
    ids.add(r.transfer_pair_id);
  }
  const list = [...ids];
  const ph = list.map(() => "?").join(",");
  await stageAttachmentUnlinks(db, list);
  await db.execute(`DELETE FROM goal_allocations WHERE movement_id IN (${ph})`, list);
  await db.execute(`DELETE FROM movement_tag WHERE movement_id IN (${ph})`, list);
  await db.execute(`DELETE FROM movement_attachments WHERE movement_id IN (${ph})`, list);
  await db.execute(`DELETE FROM movements WHERE id IN (${ph})`, list);
}

export async function mergeSources(
  db: SqlExecutor,
  fromId: number,
  toId: number,
): Promise<void> {
  const from = await getSource(db, fromId);
  const to = await getSource(db, toId);
  if (!from || !to) throw new DomainError("not_found");
  if (from.is_savings_fund || to.is_savings_fund) throw new DomainError("fund_not_mergeable");
  if (from.currency !== to.currency) throw new DomainError("cross_currency");

  await db.execute(`UPDATE movements SET source_id = ? WHERE source_id = ?`, [toId, fromId]);
  await dropSelfTransferPairs(db, toId);
  await db.execute(`UPDATE recurring_items SET source_id = ? WHERE source_id = ?`, [toId, fromId]);
  await db.execute(`UPDATE portfolios SET source_id = ? WHERE source_id = ?`, [toId, fromId]);
  // goals.source_id (ON DELETE RESTRICT) and whims.source_id (no ON DELETE) also
  // reference the source — repoint them too or the final DELETE FK-fails. Same
  // currency is guaranteed by the cross_currency guard above.
  await db.execute(`UPDATE goals SET source_id = ? WHERE source_id = ?`, [toId, fromId]);
  await db.execute(`UPDATE whims SET source_id = ? WHERE source_id = ?`, [toId, fromId]);
  await db.execute(`UPDATE sources SET starting_balance = ?, updated_at = ? WHERE id = ?`, [
    round2(to.starting_balance + from.starting_balance),
    now(),
    toId,
  ]);
  await db.execute(
    `INSERT INTO notifications (type,title,body,related_entity,is_read,created_at) VALUES ('info',?,?,?,0,?)`,
    ["Sources merged", `${from.name} merged into ${to.name}`, `source:${toId}`, now()],
  );
  await db.execute(`DELETE FROM sources WHERE id = ?`, [fromId]);
}

export interface SourceDependencies {
  movements: number;
  recurring: number;
  portfolios: number;
}

/**
 * Counts of rows that a delete will affect, so the UI can warn the user and
 * proactively disable "make external" when a portfolio is attached (the legacy
 * GET /api/sources/{id}/dependencies + the portfolio guard).
 */
export async function getSourceDependencies(
  db: SqlExecutor,
  id: number,
): Promise<SourceDependencies> {
  const one = async (sql: string) => (await db.select<{ c: number }>(sql, [id]))[0]?.c ?? 0;
  return {
    movements: await one(`SELECT COUNT(*) AS c FROM movements WHERE source_id = ?`),
    recurring: await one(`SELECT COUNT(*) AS c FROM recurring_items WHERE source_id = ?`),
    portfolios: await one(`SELECT COUNT(*) AS c FROM portfolios WHERE source_id = ?`),
  };
}

export type DeleteAction =
  | { kind: "delete_all" }
  | { kind: "move_to"; targetId: number }
  | { kind: "make_external" };

export async function deleteSource(
  db: SqlExecutor,
  id: number,
  action: DeleteAction,
): Promise<void> {
  const s = await getSource(db, id);
  if (!s) throw new DomainError("not_found");
  // Funds hold savings contributions and goal money; deleting one would orphan
  // is_savings_contribution legs (or erase them and their partner refunds),
  // desyncing every savings/goal total. Mirrors fund_not_mergeable above.
  if (s.is_savings_fund === 1) throw new DomainError("fund_not_deletable");

  const activeGoals = await db.select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM goals WHERE source_id = ? AND status = 'active'`,
    [id],
  );
  if ((activeGoals[0]?.c ?? 0) > 0) throw new DomainError("active_goal_blocks_delete");

  if (action.kind === "move_to") {
    // Moving onto itself would repoint nothing and then delete the source the
    // movements still reference (FK failure at best, orphans at worst).
    if (action.targetId === id) throw new DomainError("same_source");
    const target = await getSource(db, action.targetId);
    if (!target) throw new DomainError("not_found");
    if (target.currency !== s.currency) throw new DomainError("cross_currency");
    // A fund's balance must only move through the savings/goals flows: pouring
    // a regular account's history into it would inflate it with no contribution
    // records behind the money (mirrors mergeSources' fund_not_mergeable).
    if (target.is_savings_fund === 1) throw new DomainError("fund_not_mergeable");
    await db.execute(`UPDATE movements SET source_id = ? WHERE source_id = ?`, [action.targetId, id]);
    await dropSelfTransferPairs(db, action.targetId);
    await db.execute(`UPDATE recurring_items SET source_id = ? WHERE source_id = ?`, [action.targetId, id]);
    await db.execute(`UPDATE portfolios SET source_id = ? WHERE source_id = ?`, [action.targetId, id]);
    // Non-active goals still reference this source (goals.source_id is NOT NULL with
    // ON DELETE RESTRICT) — repoint them too, else the final DELETE FK-fails. Active
    // goals are already blocked above.
    await db.execute(`UPDATE goals SET source_id = ? WHERE source_id = ?`, [action.targetId, id]);
    // whims.source_id also FK-references sources (no ON DELETE) — repoint it too.
    await db.execute(`UPDATE whims SET source_id = ? WHERE source_id = ?`, [action.targetId, id]);
    await db.execute(`UPDATE sources SET starting_balance = ?, updated_at = ? WHERE id = ?`, [
      round2(target.starting_balance + s.starting_balance),
      now(),
      action.targetId,
    ]);
    await db.execute(`DELETE FROM sources WHERE id = ?`, [id]);
    return;
  }

  if (action.kind === "make_external") {
    const ports = await db.select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM portfolios WHERE source_id = ?`,
      [id],
    );
    if ((ports[0]?.c ?? 0) > 0) throw new DomainError("has_portfolios");
    await db.execute(`UPDATE movements SET source_id = NULL WHERE source_id = ?`, [id]);
    await db.execute(`DELETE FROM recurring_items WHERE source_id = ?`, [id]);
    // Drop the source's (non-active) goals so the DELETE doesn't FK-fail; allocations
    // cascade, and any whim still linked to them is unlinked first.
    await db.execute(`UPDATE whims SET linked_goal_id = NULL WHERE linked_goal_id IN (SELECT id FROM goals WHERE source_id = ?)`, [id]);
    await db.execute(`DELETE FROM goals WHERE source_id = ?`, [id]);
    // whims.source_id FK-references sources (no ON DELETE) — clear it before the delete.
    await db.execute(`UPDATE whims SET source_id = NULL WHERE source_id = ?`, [id]);
    await db.execute(`DELETE FROM sources WHERE id = ?`, [id]);
    return;
  }

  // delete_all — purge this source's movements AND their transfer partners.
  const movs = await db.select<{ id: number; transfer_pair_id: number | null }>(
    `SELECT id, transfer_pair_id FROM movements WHERE source_id = ?`,
    [id],
  );
  const ids = new Set<number>();
  for (const m of movs) {
    ids.add(m.id);
    if (m.transfer_pair_id != null) ids.add(m.transfer_pair_id);
  }
  if (ids.size) {
    const list = [...ids];
    const ph = list.map(() => "?").join(",");
    // Stage on-disk attachment files for post-commit unlink so nothing is orphaned.
    await stageAttachmentUnlinks(db, list);
    await db.execute(`DELETE FROM goal_allocations WHERE movement_id IN (${ph})`, list);
    await db.execute(`DELETE FROM movement_tag WHERE movement_id IN (${ph})`, list);
    await db.execute(`DELETE FROM movement_attachments WHERE movement_id IN (${ph})`, list);
    await db.execute(`DELETE FROM movements WHERE id IN (${ph})`, list);
  }

  const ports = await db.select<{ id: number }>(`SELECT id FROM portfolios WHERE source_id = ?`, [id]);
  for (const p of ports) {
    const holds = await db.select<{ id: number }>(`SELECT id FROM holdings WHERE portfolio_id = ?`, [p.id]);
    for (const h of holds) {
      await db.execute(`DELETE FROM holding_price_snapshots WHERE holding_id = ?`, [h.id]);
    }
    await db.execute(`DELETE FROM holdings WHERE portfolio_id = ?`, [p.id]);
  }
  await db.execute(`DELETE FROM portfolios WHERE source_id = ?`, [id]);
  await db.execute(`DELETE FROM recurring_items WHERE source_id = ?`, [id]);
  // Drop the source's (non-active) goals so the DELETE doesn't FK-fail; goal_allocations
  // cascade (ON DELETE CASCADE), and any whim still linked to them is unlinked first.
  await db.execute(`UPDATE whims SET linked_goal_id = NULL WHERE linked_goal_id IN (SELECT id FROM goals WHERE source_id = ?)`, [id]);
  await db.execute(`DELETE FROM goals WHERE source_id = ?`, [id]);
  // whims.source_id FK-references sources (no ON DELETE) — clear it before the delete.
  await db.execute(`UPDATE whims SET source_id = NULL WHERE source_id = ?`, [id]);
  await db.execute(`DELETE FROM sources WHERE id = ?`, [id]);
}
