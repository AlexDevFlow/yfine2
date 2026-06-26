/**
 * Boot/periodic reconciliation: apply due recurring items and accrue source
 * yields. Mirrors the legacy startup-sync + hourly scheduler run, made idempotent
 * by last_fired_date (recurring) and yield_last_date (yield). Each unit is
 * isolated so one failure can't abort the rest.
 */
import type { SqlExecutor } from "../types";
import type { SourceRow } from "../schema-types";
import { withTx } from "../tx";
import { accrueSource } from "@/domain/yield";
import { getBalance } from "./sources";
import { createNotification } from "./notifications";
import { processDueRecurring } from "./recurring";
import { checkBudgetAlerts } from "./budgets";
import { arePricesEnabled } from "./portfolios";
import { refreshAllHoldings } from "./prices";
import { getLastPriceRefreshAt, setLastPriceRefreshAt } from "./settings";

const now = () => new Date().toISOString();

/** Don't re-hit CoinGecko/Yahoo more than once per cache window. */
const PRICE_REFRESH_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Opt-in, throttled auto price refresh. No-op when prices are disabled or the
 * last refresh was < 10 min ago (the cache window). Returns the count updated.
 * Isolated by the caller so a network outage can never abort boot or the tick.
 */
export async function maybeRefreshPrices(db: SqlExecutor): Promise<number> {
  if (!(await arePricesEnabled(db))) return 0;
  const last = await getLastPriceRefreshAt(db);
  if (last) {
    const elapsed = Date.now() - new Date(last).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < PRICE_REFRESH_THROTTLE_MS) return 0;
  }
  const updated = await refreshAllHoldings(db);
  // Stamp even on 0 updates: prevents a tight retry loop when every fetch fails.
  await setLastPriceRefreshAt(db);
  return updated;
}

export async function processSourceYields(db: SqlExecutor, today: string): Promise<number> {
  const sources = await db.select<SourceRow>(
    `SELECT * FROM sources WHERE yield_rate > 0 AND yield_next_date IS NOT NULL`,
  );
  let credited = 0;
  for (const s of sources) {
    try {
      // Accrue (may post several catch-up interest movements + notifications) and
      // advance the yield cursor as one atomic unit. On the boot path the executor
      // is the serialized one, so without this a crash between a posted interest
      // movement and the cursor UPDATE would re-credit the same period next boot.
      credited += await withTx(db, async (tx) => {
        const res = await accrueSource(
          s,
          {
            getBalance: (id) => getBalance(tx, id),
            postInterest: async (id, amount, date, note) => {
              const ts = now();
              await tx.execute(
                `INSERT INTO movements (source_id,amount,direction,date,note,transfer_pair_id,exclude_from_stats,is_savings_contribution,created_at,updated_at)
                 VALUES (?,?,?,?,?,NULL,0,0,?,?)`,
                [id, amount, "in", date, note, ts, ts],
              );
              await createNotification(tx, {
                type: "info",
                title: `Interest: ${s.name}`,
                body: `+${amount} ${s.currency}`,
                related_entity: `source:${id}`,
              });
            },
          },
          today,
          (rate, period) => `Interest ${rate}% · ${period}m`,
        );
        await tx.execute(
          `UPDATE sources SET yield_last_date = ?, yield_next_date = ?, updated_at = ? WHERE id = ?`,
          [res.yield_last_date, res.yield_next_date, now(), s.id],
        );
        return res.created;
      });
    } catch {
      /* isolate per-source failures */
    }
  }
  return credited;
}

export async function runScheduler(
  db: SqlExecutor,
  today: string,
  // The live price refresh is a NETWORK call. On the boot path it is left OFF so
  // the dashboard never waits on CoinGecko/Yahoo to paint — the app-shell's
  // background interval (which runs an immediate tick on mount and invalidates the
  // money views when prices change) handles it instead. Only opt in for callers
  // that genuinely want the refresh inline.
  opts: { refreshPrices?: boolean } = {},
): Promise<{ applied: number; errors: number; credited: number; alerts: number; priced: number }> {
  const rec = await processDueRecurring(db, today);
  const credited = await processSourceYields(db, today);
  // Budget threshold/overspend alerts (idempotent via last_alert_period/level).
  // Isolated so a failure here can never abort boot or the rest of the tick.
  let alerts = 0;
  try {
    alerts = await checkBudgetAlerts(db, today);
  } catch {
    /* isolate budget-alert failures */
  }
  // Opt-in live price refresh (throttled to the 10-min cache window). Isolated so
  // a network outage can never abort the tick. No-op when prices are disabled.
  let priced = 0;
  if (opts.refreshPrices) {
    try {
      priced = await maybeRefreshPrices(db);
    } catch {
      /* isolate price-refresh failures */
    }
  }
  return { ...rec, credited, alerts, priced };
}
