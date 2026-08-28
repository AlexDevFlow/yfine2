/**
 * NEW FEATURE — consolidated (single base-currency) net worth. Opt-in: the app's
 * default stays strictly per-currency (no FX). When the user picks a base currency
 * this converts every currency's net worth via the exchange_rates table and sums.
 * Flags currencies with no rate so the total is honestly marked approximate.
 */
import type { SqlExecutor } from "../types";
import { round2 } from "@/domain/money";
import { netWorth } from "./dashboard";
import { convert } from "./exchange-rates";

export interface Consolidated {
  base: string;
  total: number;
  missing: string[]; // currencies with no rate to base (excluded from total)
}

export async function consolidatedNetWorth(
  db: SqlExecutor,
  base: string,
  excludedSourceIds: number[] = [],
): Promise<Consolidated> {
  const b = base.trim().toUpperCase();
  // Same exclusion as the per-currency figures above it — a total that silently
  // counted an account the user opted out of would contradict them.
  const byCcy = await netWorth(db, excludedSourceIds);
  let total = 0;
  const missing: string[] = [];
  for (const [ccy, amt] of Object.entries(byCcy)) {
    if (ccy.toUpperCase() === b) {
      total = round2(total + amt);
      continue;
    }
    const converted = await convert(db, amt, ccy, b);
    if (converted == null) missing.push(ccy);
    else total = round2(total + converted);
  }
  return { base: b, total, missing };
}
