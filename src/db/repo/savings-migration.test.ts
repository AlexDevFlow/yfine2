import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { netWorthByCurrency } from "@/domain/money";
import type { SqlExecutor } from "../types";
import * as sources from "./sources";
import { listSavings } from "./savings";
import { needsWizard, previewWizard, runWizard } from "./savings-migration";

const TS = "2026-01-01T00:00:00";

async function addLegacySaving(
  db: SqlExecutor,
  amount: number,
  currency: string,
  date: string,
  description: string | null = null,
  tagIds: number[] = [],
): Promise<number> {
  const rows = await db.select<{ id: number }>(
    `INSERT INTO savings (amount,currency,date,description,note,created_at,updated_at)
     VALUES (?,?,?,?,NULL,?,?) RETURNING id`,
    [amount, currency, date, description, TS, TS],
  );
  const id = rows[0].id;
  for (const tid of tagIds) {
    await db.execute(`INSERT INTO saving_tag (saving_id, tag_id) VALUES (?, ?)`, [id, tid]);
  }
  return id;
}

async function netWorth(db: SqlExecutor): Promise<Record<string, number>> {
  const all = await sources.listSources(db);
  const balances = await sources.getBalancesBatch(db);
  return netWorthByCurrency(all.map((s) => ({ currency: s.currency, balance: balances.get(s.id) ?? 0 })));
}

describe("legacy savings migration wizard", () => {
  it("needsWizard is false on a clean DB, true once a legacy row exists", async () => {
    const { db } = await makeMemDb();
    expect(await needsWizard(db)).toBe(false);
    await addLegacySaving(db, 100, "EUR", "2026-02-01");
    expect(await needsWizard(db)).toBe(true);
  });

  it("preview summarizes count, per-currency totals, and date range", async () => {
    const { db } = await makeMemDb();
    await addLegacySaving(db, 100, "EUR", "2026-02-01");
    await addLegacySaving(db, 50, "EUR", "2026-03-15");
    await addLegacySaving(db, 200, "USD", "2026-01-10");

    const p = await previewWizard(db);
    expect(p.count).toBe(3);
    expect(p.byCurrency).toEqual([
      { currency: "EUR", count: 2, total: 150 },
      { currency: "USD", count: 1, total: 200 },
    ]);
    expect(p.earliestDate).toBe("2026-01-10");
    expect(p.latestDate).toBe("2026-03-15");
  });

  it("movements mode: one transfer per saving from a unified source, tags on both legs, conserving", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "Checking", currency: "EUR", starting_balance: 1000 });
    await db.execute(`INSERT INTO tags (name,created_at,updated_at) VALUES ('Goal','t','t')`);
    await addLegacySaving(db, 100, "EUR", "2026-02-01", "rent", [1]);
    await addLegacySaving(db, 250, "EUR", "2026-03-01", "car");

    const before = await netWorth(db);
    const res = await runWizard(db, "movements", { unifiedSourceId: acct.id });
    expect(res).toEqual({ mode: "movements", count: 2 });

    // Conservation: money moved acct → fund, EUR net worth unchanged.
    expect((await netWorth(db)).EUR).toBe(before.EUR);
    expect(await sources.getBalance(db, acct.id)).toBe(650); // 1000 - 100 - 250

    const fund = (await sources.listSources(db)).find((s) => s.is_savings_fund === 1)!;
    expect(fund.currency).toBe("EUR");
    expect(await sources.getBalance(db, fund.id)).toBe(350);

    // Legacy rows drained.
    expect(await needsWizard(db)).toBe(false);
    const saved = await listSavings(db);
    expect(saved.map((s) => s.amount).sort((a, b) => a - b)).toEqual([100, 250]);
    // is_savings_contribution flagged on every imported in-leg.
    const flagged = (await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements WHERE is_savings_contribution = 1`))[0].c;
    expect(flagged).toBe(2);
    // Tags copied to BOTH legs of the tagged saving.
    const tagged = (await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movement_tag WHERE tag_id = 1`))[0].c;
    expect(tagged).toBe(2);
  });

  it("movements mode: mixed-currency rows fall back to external when the source doesn't match", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "EUR acct", currency: "EUR", starting_balance: 500 });
    await addLegacySaving(db, 100, "EUR", "2026-02-01");
    await addLegacySaving(db, 80, "USD", "2026-02-05");

    await runWizard(db, "movements", { unifiedSourceId: eur.id });

    // EUR saving debits the source; USD saving's out-leg is external (NULL source).
    expect(await sources.getBalance(db, eur.id)).toBe(400);
    const eurFund = await sources.getFundForCurrency(db, "EUR");
    const usdFund = await sources.getFundForCurrency(db, "USD");
    expect(await sources.getBalance(db, eurFund!.id)).toBe(100);
    expect(await sources.getBalance(db, usdFund!.id)).toBe(80);
    const externalOut = (await db.select<{ c: number }>(
      `SELECT COUNT(*) c FROM movements WHERE source_id IS NULL AND direction='out'`,
    ))[0].c;
    expect(externalOut).toBe(1);
  });

  it("movements mode rejects a fund as the unified source", async () => {
    const { db } = await makeMemDb();
    const fund = await sources.ensureFundForCurrency(db, "EUR");
    await addLegacySaving(db, 100, "EUR", "2026-02-01");
    await expect(runWizard(db, "movements", { unifiedSourceId: fund.id })).rejects.toMatchObject({
      code: "fund_save_rejected",
    });
  });

  it("starting_balance mode collapses per-currency totals into each fund and drains rows", async () => {
    const { db } = await makeMemDb();
    await addLegacySaving(db, 100, "EUR", "2026-02-01");
    await addLegacySaving(db, 250, "EUR", "2026-03-01");
    await addLegacySaving(db, 80, "USD", "2026-02-05");

    const res = await runWizard(db, "starting_balance");
    expect(res).toEqual({ mode: "starting_balance", count: 2 }); // 2 funds touched

    const eurFund = await sources.getFundForCurrency(db, "EUR");
    const usdFund = await sources.getFundForCurrency(db, "USD");
    expect(eurFund!.starting_balance).toBe(350);
    expect(usdFund!.starting_balance).toBe(80);
    expect(await sources.getBalance(db, eurFund!.id)).toBe(350);
    expect(await needsWizard(db)).toBe(false);
    // No movements created in this mode.
    expect((await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements`))[0].c).toBe(0);
  });

  it("discard mode deletes everything and creates nothing", async () => {
    const { db } = await makeMemDb();
    await db.execute(`INSERT INTO tags (name,created_at,updated_at) VALUES ('Goal','t','t')`);
    await addLegacySaving(db, 100, "EUR", "2026-02-01", null, [1]);
    await addLegacySaving(db, 80, "USD", "2026-02-05");

    const res = await runWizard(db, "discard");
    expect(res).toEqual({ mode: "discard", count: 2 });
    expect(await needsWizard(db)).toBe(false);
    expect((await db.select<{ c: number }>(`SELECT COUNT(*) c FROM savings`))[0].c).toBe(0);
    expect((await db.select<{ c: number }>(`SELECT COUNT(*) c FROM saving_tag`))[0].c).toBe(0);
    expect((await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements`))[0].c).toBe(0);
    // No fund auto-created by discard.
    expect((await sources.listSources(db)).filter((s) => s.is_savings_fund === 1).length).toBe(0);
  });
});
