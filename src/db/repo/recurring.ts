/**
 * Recurring items + the scheduler "tick". Faithful port of services/recurring.py
 * and scheduler.py (refactor-analysis/recurring-scheduler.md). The FOUR confirmed
 * bugs are designed out:
 *  - BUG-1: insufficient-funds warning only for direction === "out".
 *  - BUG-2: confirm prompt and upcoming reminder use DISTINCT related_entity keys
 *           ("recurring:{id}#confirm" vs "recurring:{id}") so dedup can't collide.
 *  - BUG-3: end_date >= start_date enforced on update (merged state), not just create.
 *  - BUG-4: each item processed in its own try/catch so one bad rule can't poison
 *           the whole tick.
 */
import type { SqlExecutor } from "../types";
import { withTx } from "../tx";
import { DomainError } from "../errors";
import { round2 } from "@/domain/money";
import { validateCurrency, validateDate, validateName } from "@/domain/validators";
import { addDaysISO, addMonthsISO, dayOfMonth, daysBetween, todayISO } from "@/lib/date";
import { getBalance, getSource } from "./sources";
import { createNotification, hasUnread } from "./notifications";

const now = () => new Date().toISOString();

export interface RecurringRow {
  id: number;
  name: string;
  amount: number;
  direction: "in" | "out";
  currency: string;
  frequency: string;
  start_date: string;
  end_date: string | null;
  source_id: number | null;
  apply_mode: "auto" | "confirm";
  next_due_date: string;
  alert_days_before: number;
  alert_if_insufficient: number;
  last_fired_date: string | null;
  last_alert_date: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Advance one period; unknown frequency falls back to monthly (with clamping).
 * `anchorDay` is the day-of-month the rule was set on (its start_date): a bill
 * due on the 31st is clamped to Feb 28 but comes back to Mar 31 instead of
 * drifting to the 28th forever.
 */
export function computeNextDueDate(current: string, frequency: string, anchorDay?: number): string {
  switch (frequency) {
    case "daily":
      return addDaysISO(current, 1);
    case "weekly":
      return addDaysISO(current, 7);
    case "yearly":
      return addMonthsISO(current, 12, anchorDay);
    case "monthly":
    default:
      return addMonthsISO(current, 1, anchorDay);
  }
}

/** The day-of-month a rule's schedule is anchored to (its start date). */
export function anchorDayOf(item: Pick<RecurringRow, "start_date">): number {
  return dayOfMonth(item.start_date);
}

async function validateSourceCurrency(
  db: SqlExecutor,
  sourceId: number | null | undefined,
  currency: string,
): Promise<void> {
  if (sourceId == null) return;
  const s = await getSource(db, sourceId);
  if (!s) throw new DomainError("not_found");
  if (s.currency.toUpperCase() !== currency.trim().toUpperCase())
    throw new DomainError("currency_mismatch");
}

export interface NewRecurring {
  name: string;
  amount: number;
  direction: "in" | "out";
  currency: string;
  frequency: string;
  start_date: string;
  end_date?: string | null;
  source_id?: number | null;
  apply_mode?: "auto" | "confirm";
  alert_days_before?: number;
  alert_if_insufficient?: boolean;
}

export async function createRecurring(db: SqlExecutor, data: NewRecurring): Promise<number> {
  if (!(data.amount > 0)) throw new DomainError("invalid_amount");
  validateDate(data.start_date);
  if (data.end_date) validateDate(data.end_date);
  if (data.end_date && data.end_date < data.start_date) throw new DomainError("invalid_range");
  const name = validateName(data.name);
  const currency = validateCurrency(data.currency);
  await validateSourceCurrency(db, data.source_id, currency);
  const ts = now();
  const rows = await db.select<{ id: number }>(
    `INSERT INTO recurring_items
      (name,amount,direction,currency,frequency,start_date,end_date,source_id,apply_mode,next_due_date,alert_days_before,alert_if_insufficient,last_fired_date,last_alert_date,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?) RETURNING id`,
    [
      name,
      data.amount,
      data.direction,
      currency,
      data.frequency,
      data.start_date,
      data.end_date ?? null,
      data.source_id ?? null,
      data.apply_mode ?? "confirm",
      data.start_date, // next_due_date initialized to start_date
      data.alert_days_before ?? 7,
      data.alert_if_insufficient === false ? 0 : 1,
      ts,
      ts,
    ],
  );
  return rows[0].id;
}

export async function getRecurring(db: SqlExecutor, id: number): Promise<RecurringRow | null> {
  const r = await db.select<RecurringRow>(`SELECT * FROM recurring_items WHERE id = ?`, [id]);
  return r[0] ?? null;
}

/**
 * Create a recurring rule mirroring an existing movement. Faithful port of
 * services/movements.py:make_recurring_from_movement:
 *  - transfers can't be made recurring;
 *  - currency = the movement's source currency, falling back to settings'
 *    base_currency, else `no_currency`;
 *  - the source movement already covers its own (possibly past) date, so the
 *    first next_due_date is rolled forward past today — 'auto' won't back-fill a
 *    burst of duplicates and 'confirm' won't fire a stale prompt.
 */
export async function makeRecurringFromMovement(
  db: SqlExecutor,
  movementId: number,
  frequency: string,
  applyMode: "auto" | "confirm",
  today: string,
): Promise<number> {
  const m = await db.select<{
    id: number;
    source_id: number | null;
    amount: number;
    direction: "in" | "out";
    date: string;
    note: string | null;
    transfer_pair_id: number | null;
  }>(`SELECT id, source_id, amount, direction, date, note, transfer_pair_id FROM movements WHERE id = ?`, [movementId]);
  const mv = m[0];
  if (!mv) throw new DomainError("not_found");
  if (mv.transfer_pair_id != null) throw new DomainError("cannot_make_transfer_recurring");

  let currency: string | null = null;
  if (mv.source_id != null) {
    const src = await getSource(db, mv.source_id);
    currency = src ? src.currency : null;
  }
  if (!currency) {
    const settings = await db.select<{ base_currency: string | null }>(
      `SELECT base_currency FROM settings WHERE id = 1`,
    );
    currency = settings[0]?.base_currency ?? null;
  }
  if (!currency) throw new DomainError("no_currency");

  const name = (mv.note ?? "").trim() || `${mv.amount.toFixed(2)} ${currency}`;
  const id = await createRecurring(db, {
    name,
    amount: mv.amount,
    direction: mv.direction,
    currency,
    frequency,
    start_date: mv.date,
    source_id: mv.source_id,
    apply_mode: applyMode,
    alert_if_insufficient: mv.direction === "out",
  });

  // Roll next_due_date forward past today (createRecurring set it = start_date).
  const item = (await getRecurring(db, id))!;
  if (item.next_due_date <= today) {
    let nd = item.next_due_date;
    let guard = 0;
    while (nd <= today && guard < 36500) {
      nd = computeNextDueDate(nd, item.frequency, anchorDayOf(item));
      guard += 1;
    }
    await db.execute(`UPDATE recurring_items SET next_due_date = ?, updated_at = ? WHERE id = ?`, [nd, now(), id]);
  }
  return id;
}

export type RecurringPatch = Partial<NewRecurring>;

export async function updateRecurring(db: SqlExecutor, id: number, patch: RecurringPatch): Promise<void> {
  const cur = await getRecurring(db, id);
  if (!cur) throw new DomainError("not_found");

  // Validate the supplied currency/name (only when present in the patch, mirroring
  // the original RecurringUpdate field validators which skip None values).
  const validatedName = patch.name !== undefined ? validateName(patch.name) : undefined;
  const merged = {
    currency: patch.currency !== undefined ? validateCurrency(patch.currency) : cur.currency,
    source_id: patch.source_id !== undefined ? patch.source_id : cur.source_id,
    start_date: patch.start_date ?? cur.start_date,
    end_date: patch.end_date !== undefined ? patch.end_date : cur.end_date,
    amount: patch.amount ?? cur.amount,
  };
  if (!(merged.amount > 0)) throw new DomainError("invalid_amount");
  if (patch.start_date !== undefined) validateDate(patch.start_date);
  if (patch.end_date) validateDate(patch.end_date);
  // BUG-3 fix: enforce end >= start on the merged state.
  if (merged.end_date && merged.end_date < merged.start_date) throw new DomainError("invalid_range");
  await validateSourceCurrency(db, merged.source_id, merged.currency);

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (c: string, v: unknown) => {
    sets.push(`${c} = ?`);
    params.push(v);
  };
  if (patch.name !== undefined) set("name", validatedName);
  if (patch.amount !== undefined) set("amount", patch.amount);
  if (patch.direction !== undefined) set("direction", patch.direction);
  if (patch.currency !== undefined) set("currency", merged.currency);
  if (patch.frequency !== undefined) set("frequency", patch.frequency);
  if (patch.end_date !== undefined) set("end_date", patch.end_date);
  if (patch.source_id !== undefined) set("source_id", patch.source_id);
  if (patch.apply_mode !== undefined) set("apply_mode", patch.apply_mode);
  if (patch.alert_days_before !== undefined) set("alert_days_before", patch.alert_days_before);
  if (patch.alert_if_insufficient !== undefined)
    set("alert_if_insufficient", patch.alert_if_insufficient ? 1 : 0);

  // start_date + backdate-protected next_due_date re-sync
  if (patch.start_date !== undefined) {
    set("start_date", patch.start_date);
    if (cur.last_fired_date == null || patch.start_date > cur.next_due_date) {
      set("next_due_date", patch.start_date);
    }
  }
  set("updated_at", now());
  await db.execute(`UPDATE recurring_items SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
}

export async function deleteRecurring(db: SqlExecutor, id: number): Promise<void> {
  await db.execute(`DELETE FROM recurring_items WHERE id = ?`, [id]);
}

function applyNote(item: RecurringRow, amount: number, extraNote?: string | null): string {
  let note = `Recurring: ${item.name}`;
  if (extraNote) note += ` — ${extraNote}`;
  if (Math.abs(amount - item.amount) > 0.001) note += ` (base: ${item.amount}, adjusted: ${amount})`;
  return note;
}

/**
 * Apply one period of a rule (books a movement if sourced + an info notification),
 * then advances last_fired_date and next_due_date. Returns the advanced cursor.
 */
export async function applyRecurringItem(
  db: SqlExecutor,
  item: RecurringRow,
  opts: { amount?: number; note?: string | null } = {},
): Promise<{ last_fired_date: string; next_due_date: string }> {
  if (item.end_date && item.next_due_date > item.end_date) throw new DomainError("recurring_ended");
  if (opts.amount != null && !(opts.amount > 0)) throw new DomainError("invalid_amount");
  const amount = opts.amount ?? item.amount;
  const ts = now();
  const lastFired = item.next_due_date;
  const nextDue = computeNextDueDate(item.next_due_date, item.frequency, anchorDayOf(item));
  // Book the movement, post the notification, and advance the cursor as ONE atomic
  // unit. On the boot/scheduler path (connection.ts) the executor is the serialized
  // one, so without this a crash between the INSERT and the cursor UPDATE would
  // leave the movement posted but the rule un-advanced → a duplicate next boot.
  // On the manual path the caller already holds a withTx, which this nests into.
  await withTx(db, async (tx) => {
    if (item.source_id != null) {
      await tx.execute(
        `INSERT INTO movements (source_id,amount,direction,date,note,transfer_pair_id,exclude_from_stats,is_savings_contribution,created_at,updated_at)
         VALUES (?,?,?,?,?,NULL,0,0,?,?)`,
        [item.source_id, amount, item.direction, item.next_due_date, applyNote(item, amount, opts.note), ts, ts],
      );
    }
    await createNotification(tx, {
      type: "info",
      title: `Applied: ${item.name}`,
      body: `${item.direction === "in" ? "+" : "−"}${amount} ${item.currency}`,
      related_entity: `recurring:${item.id}`,
    });
    await tx.execute(
      `UPDATE recurring_items SET last_fired_date = ?, next_due_date = ?, updated_at = ? WHERE id = ?`,
      [lastFired, nextDue, ts, item.id],
    );
  });
  return { last_fired_date: lastFired, next_due_date: nextDue };
}

/** Manual apply: blocks future items, advances exactly one period. */
export async function applyRecurringById(
  db: SqlExecutor,
  id: number,
  opts: { amount?: number; note?: string | null },
  today: string,
): Promise<void> {
  const item = await getRecurring(db, id);
  if (!item) throw new DomainError("not_found");
  if (item.next_due_date > today) throw new DomainError("not_yet_due");
  await applyRecurringItem(db, item, opts);
}

/** Scheduler tick: reminders, insufficient-funds warnings, auto-apply/confirm prompts. */
export async function processDueRecurring(db: SqlExecutor, today: string): Promise<{ applied: number; errors: number }> {
  const items = await db.select<RecurringRow>(`SELECT * FROM recurring_items`);
  let applied = 0;
  let errors = 0;

  for (const item of items) {
    try {
      // Ended rules: skip — both those whose end date has passed and those whose
      // next occurrence already falls past it (nothing will ever fire again, so a
      // reminder or a "confirm" prompt would only lead to recurring_ended).
      if (item.end_date && (item.end_date < today || item.next_due_date > item.end_date)) continue;

      // advance reminder + insufficient-funds (once per due cycle)
      const windowStart = addDaysISO(item.next_due_date, -item.alert_days_before);
      const inWindow = today >= windowStart && today <= item.next_due_date;
      const alreadyAlerted = item.last_alert_date != null && item.last_alert_date >= windowStart;
      if (inWindow && !alreadyAlerted) {
        const dueIn = daysBetween(today, item.next_due_date);
        await createNotification(db, {
          type: "alert",
          title: `📅 ${item.name}`,
          body: `${item.direction === "in" ? "+" : "−"}${item.amount} ${item.currency} · ${dueIn === 0 ? "due today" : `in ${dueIn}d`}`,
          related_entity: `recurring:${item.id}`,
        });
        // BUG-1 fix: only warn about low funds for OUTGOING items.
        if (item.direction === "out" && item.alert_if_insufficient && item.source_id != null) {
          const balance = await getBalance(db, item.source_id);
          if (balance < item.amount) {
            await createNotification(db, {
              type: "warning",
              title: `⚠️ ${item.name}`,
              body: `Balance ${round2(balance)} ${item.currency} is below the ${item.amount} ${item.currency} due.`,
              related_entity: `recurring:${item.id}`,
            });
          }
        }
        await db.execute(`UPDATE recurring_items SET last_alert_date = ? WHERE id = ?`, [today, item.id]);
        item.last_alert_date = today;
      }

      if (item.apply_mode === "auto") {
        let guard = 0;
        const cursor = { ...item };
        while (cursor.next_due_date <= today && guard < 3650) {
          guard += 1;
          if (cursor.end_date && cursor.next_due_date > cursor.end_date) break;
          if (cursor.last_fired_date === cursor.next_due_date) break; // idempotency
          const prev = cursor.next_due_date;
          const res = await applyRecurringItem(db, cursor);
          cursor.last_fired_date = res.last_fired_date;
          cursor.next_due_date = res.next_due_date;
          applied += 1;
          if (cursor.next_due_date <= prev) break; // non-advancing guard
        }
      } else if (item.next_due_date <= today) {
        // confirm mode: post a single actionable prompt (distinct key — BUG-2 fix)
        const confirmKey = `recurring:${item.id}#confirm`;
        if (!(await hasUnread(db, confirmKey))) {
          await createNotification(db, {
            type: "alert",
            title: `✅ Confirm: ${item.name}`,
            body: `${item.direction === "in" ? "+" : "−"}${item.amount} ${item.currency} is due — apply it?`,
            related_entity: confirmKey,
          });
        }
      }
    } catch {
      errors += 1; // BUG-4 fix: isolate per-item failures
    }
  }
  return { applied, errors };
}

// ---- read helpers ----

export interface EnrichedRecurring extends RecurringRow {
  source_name: string | null;
  days_until: number;
}

export async function listRecurring(db: SqlExecutor, today: string): Promise<EnrichedRecurring[]> {
  const rows = await db.select<RecurringRow & { source_name: string | null }>(
    `SELECT r.*, s.name AS source_name FROM recurring_items r LEFT JOIN sources s ON r.source_id = s.id
     ORDER BY r.next_due_date ASC`,
  );
  return rows.map((r) => ({ ...r, days_until: daysBetween(today, r.next_due_date) }));
}

/** Occurrences per month by frequency (365.25-day year), shared with the exports. */
export const MONTHLY_MULTIPLIER: Record<string, number> = {
  daily: 365.25 / 12,
  weekly: 52.1785714 / 12,
  monthly: 1,
  yearly: 1 / 12,
};

export interface MonthlySummary {
  byCurrency: Record<string, { outflow: number; inflow: number; net: number; countOut: number; countIn: number }>;
  totalCount: number;
}

/**
 * Monthly-equivalent inflow/outflow of the rules that are still running. A
 * rule past its end date will never fire again, so it must not keep inflating
 * "Monthly outflow" (nor the export's summary, which shares this filter).
 */
export function isRuleActive(item: Pick<RecurringRow, "end_date">, today: string): boolean {
  return !item.end_date || item.end_date >= today;
}

export async function monthlySummary(db: SqlExecutor, today: string = todayISO()): Promise<MonthlySummary> {
  const rows = (await db.select<RecurringRow>(`SELECT * FROM recurring_items`)).filter((r) => isRuleActive(r, today));
  // Accumulate the RAW (unrounded) monthly-equivalents per currency and round
  // ONCE when reading the bucket out — matching services/recurring.py:79/89.
  // Rounding per item (or per running sum) lets several same-currency rules
  // drift by sub-cents (e.g. three 10/day EUR → 913.12, not 913.14).
  const raw: Record<string, { outflow: number; inflow: number; countOut: number; countIn: number }> = {};
  for (const r of rows) {
    const ccy = r.currency.toUpperCase();
    const monthly = r.amount * (MONTHLY_MULTIPLIER[r.frequency] ?? 1);
    const b = raw[ccy] ?? { outflow: 0, inflow: 0, countOut: 0, countIn: 0 };
    if (r.direction === "out") {
      b.outflow += monthly;
      b.countOut += 1;
    } else {
      b.inflow += monthly;
      b.countIn += 1;
    }
    raw[ccy] = b;
  }
  const out: MonthlySummary = { byCurrency: {}, totalCount: rows.length };
  for (const [ccy, b] of Object.entries(raw)) {
    out.byCurrency[ccy] = {
      outflow: round2(b.outflow),
      inflow: round2(b.inflow),
      net: round2(b.inflow - b.outflow),
      countOut: b.countOut,
      countIn: b.countIn,
    };
  }
  return out;
}
