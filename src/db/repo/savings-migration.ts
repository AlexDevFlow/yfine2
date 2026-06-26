/**
 * One-shot legacy-savings migration wizard. Faithful port of
 * services/savings_migration.py (refactor-analysis/sources-savings.md §H).
 *
 * The legacy `savings`/`saving_tag` tables survive in the schema so a not-yet-
 * migrated DB still has its rows, but the new savings model is transfer-backed
 * (a saving = the IN-leg of a transfer into a per-currency fund). This wizard
 * drains the legacy rows into that model. After ANY mode runs, every legacy row
 * + its tag links are deleted so the wizard never re-fires.
 */
import type { SqlExecutor } from "../types";
import { DomainError } from "../errors";
import { round2 } from "@/domain/money";
import { ensureFundForCurrency, getSource } from "./sources";
import { createTransferPair } from "./transfers";

export type WizardMode = "movements" | "starting_balance" | "discard";

/** Do any legacy `savings` rows remain to be migrated? */
export async function needsWizard(db: SqlExecutor): Promise<boolean> {
  const rows = await db.select<{ c: number }>(`SELECT COUNT(*) AS c FROM savings`);
  return (rows[0]?.c ?? 0) > 0;
}

export interface WizardPreview {
  count: number;
  byCurrency: { currency: string; count: number; total: number }[];
  earliestDate: string | null;
  latestDate: string | null;
}

/** Summarize the legacy data: total count, per-currency totals, date range. */
export async function previewWizard(db: SqlExecutor): Promise<WizardPreview> {
  const rows = await db.select<{ currency: string; count: number; total: number }>(
    `SELECT currency, COUNT(id) AS count, SUM(amount) AS total
     FROM savings GROUP BY currency ORDER BY currency`,
  );
  const byCurrency = rows.map((r) => ({
    currency: r.currency,
    count: r.count ?? 0,
    total: round2(r.total ?? 0),
  }));
  const range = await db.select<{ earliest: string | null; latest: string | null }>(
    `SELECT MIN(date) AS earliest, MAX(date) AS latest FROM savings`,
  );
  return {
    count: byCurrency.reduce((s, b) => s + b.count, 0),
    byCurrency,
    earliestDate: range[0]?.earliest ?? null,
    latestDate: range[0]?.latest ?? null,
  };
}

interface LegacySaving {
  id: number;
  amount: number;
  currency: string;
  date: string;
  description: string | null;
  note: string | null;
}

async function tagsForSaving(db: SqlExecutor, savingId: number): Promise<number[]> {
  const rows = await db.select<{ tag_id: number }>(
    `SELECT tag_id FROM saving_tag WHERE saving_id = ?`,
    [savingId],
  );
  return rows.map((r) => r.tag_id);
}

/** Drop every legacy saving + its tag links (so the wizard won't re-fire). */
async function dropLegacyRows(db: SqlExecutor): Promise<void> {
  await db.execute(`DELETE FROM saving_tag`);
  await db.execute(`DELETE FROM savings`);
}

/**
 * Mode `movements`: one transfer per legacy saving. OUT-leg source = the chosen
 * unified source (must exist, must not be a fund) or NULL (external). Mixed-
 * currency fallback: a row whose currency differs from the unified source's
 * currency falls back to external. IN-leg lands in the row's currency fund and
 * is flagged is_savings_contribution; tags copied to both legs.
 */
async function migrateAsMovements(
  db: SqlExecutor,
  unifiedSourceId: number | null,
  fundLabel: string,
): Promise<number> {
  const rows = await db.select<LegacySaving>(
    `SELECT id, amount, currency, date, description, note FROM savings ORDER BY date`,
  );
  if (rows.length === 0) return 0;

  let unified = null as Awaited<ReturnType<typeof getSource>>;
  if (unifiedSourceId != null) {
    unified = await getSource(db, unifiedSourceId);
    if (!unified) throw new DomainError("not_found");
    if (unified.is_savings_fund === 1) throw new DomainError("fund_save_rejected");
  }

  let count = 0;
  for (const s of rows) {
    const currency = (s.currency || "").trim().toUpperCase();
    // Mixed-currency history with a single source: rows that don't match the
    // unified source's currency fall back to external (NULL out-leg source).
    const outSourceId =
      unified != null && unified.currency === currency ? unified.id : null;

    const fund = await ensureFundForCurrency(db, currency, fundLabel);
    const note = s.description ?? s.note ?? null;
    const tagIds = await tagsForSaving(db, s.id);

    await createTransferPair(db, {
      fromSourceId: outSourceId,
      toSourceId: fund.id,
      amount: s.amount,
      date: s.date,
      note,
      tagIds,
      isSavingsContribution: true,
    });
    count += 1;
  }

  await dropLegacyRows(db);
  return count;
}

/**
 * Mode `starting_balance`: collapse per-currency totals into each fund's
 * starting_balance (loses per-saving granularity). Returns funds touched.
 */
async function migrateAsStartingBalance(db: SqlExecutor, fundLabel: string): Promise<number> {
  const rows = await db.select<{ currency: string; total: number }>(
    `SELECT currency, SUM(amount) AS total FROM savings GROUP BY currency`,
  );
  if (rows.length === 0) return 0;
  const ts = new Date().toISOString();
  for (const r of rows) {
    const cc = (r.currency || "").trim().toUpperCase();
    const fund = await ensureFundForCurrency(db, cc, fundLabel);
    await db.execute(
      `UPDATE sources SET starting_balance = ?, updated_at = ? WHERE id = ?`,
      [round2(fund.starting_balance + (r.total ?? 0)), ts, fund.id],
    );
  }
  await dropLegacyRows(db);
  return rows.length;
}

/** Mode `discard`: delete every legacy saving and start fresh. Returns dropped count. */
async function discardAll(db: SqlExecutor): Promise<number> {
  const rows = await db.select<{ c: number }>(`SELECT COUNT(*) AS c FROM savings`);
  const dropped = rows[0]?.c ?? 0;
  await dropLegacyRows(db);
  return dropped;
}

export interface WizardResult {
  mode: WizardMode;
  /** movements: transfers created; starting_balance: funds touched; discard: rows dropped. */
  count: number;
}

/**
 * Run the migration. Caller wraps this in withTx so all the per-saving transfer
 * pairs + the final legacy-row purge commit atomically (conservation: every
 * imported saving is a transfer source→fund with is_savings_contribution=1 on
 * the in-leg, exactly like createSaving).
 */
export async function runWizard(
  db: SqlExecutor,
  mode: WizardMode,
  opts: { unifiedSourceId?: number | null; fundLabel?: string } = {},
): Promise<WizardResult> {
  const fundLabel = opts.fundLabel ?? "Savings Fund";
  if (mode === "movements") {
    return { mode, count: await migrateAsMovements(db, opts.unifiedSourceId ?? null, fundLabel) };
  }
  if (mode === "starting_balance") {
    return { mode, count: await migrateAsStartingBalance(db, fundLabel) };
  }
  if (mode === "discard") {
    return { mode, count: await discardAll(db) };
  }
  throw new DomainError("invalid_range"); // unknown mode (legacy 422)
}
