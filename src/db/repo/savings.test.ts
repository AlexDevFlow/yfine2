import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { netWorthByCurrency } from "@/domain/money";
import * as sources from "./sources";
import {
  countSavings,
  createSaving,
  deleteSaving,
  listSavings,
  totalSaved,
  totalSavedPeriod,
  updateSaving,
} from "./savings";

async function netWorthEUR(db: Parameters<typeof sources.getBalancesBatch>[0]) {
  const all = await sources.listSources(db);
  const balances = await sources.getBalancesBatch(db);
  return netWorthByCurrency(
    all.map((s) => ({ currency: s.currency, balance: balances.get(s.id) ?? 0 })),
  )["EUR"];
}

describe("savings deposit (transfer-backed, conserving)", () => {
  it("moves money source→fund, conserving net worth; flags the in-leg; tags both legs", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "Checking", currency: "EUR", starting_balance: 1000 });
    await db.execute(`INSERT INTO tags (name,created_at,updated_at) VALUES ('Goal','t','t')`);

    const before = await netWorthEUR(db);
    const savingId = await createSaving(db, {
      fromSourceId: acct.id,
      amount: 300,
      date: "2026-05-01",
      note: "monthly",
      tagIds: [1],
    });
    const after = await netWorthEUR(db);

    expect(after).toBe(before); // conservation
    expect(await sources.getBalance(db, acct.id)).toBe(700);

    const fund = (await sources.listSources(db)).find((s) => s.is_savings_fund === 1)!;
    expect(fund.currency).toBe("EUR");
    expect(await sources.getBalance(db, fund.id)).toBe(300);

    // in-leg flagged + both legs linked + tags on both
    const inLeg = (await db.select<{ id: number; is_savings_contribution: number; transfer_pair_id: number }>(
      `SELECT id,is_savings_contribution,transfer_pair_id FROM movements WHERE id = ?`,
      [savingId],
    ))[0];
    expect(inLeg.is_savings_contribution).toBe(1);
    const tagCount = (await db.select<{ c: number }>(
      `SELECT COUNT(*) c FROM movement_tag WHERE tag_id = 1`,
    ))[0].c;
    expect(tagCount).toBe(2); // both legs tagged
  });

  it("lists deposits newest-first with currency, source, and tags", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "Checking", currency: "EUR", starting_balance: 1000 });
    await db.execute(`INSERT INTO tags (name,created_at,updated_at) VALUES ('Goal','t','t')`);
    await createSaving(db, { fromSourceId: acct.id, amount: 100, date: "2026-05-01", note: "first" });
    await createSaving(db, { fromSourceId: acct.id, amount: 200, date: "2026-05-10", note: "second", tagIds: [1] });

    const list = await listSavings(db);
    expect(list.map((s) => s.amount)).toEqual([200, 100]); // newest first
    expect(list[0]).toMatchObject({ currency: "EUR", from_source_name: "Checking", note: "second" });
    expect(list[0].tags).toEqual([{ id: 1, name: "Goal", color: null }]);
    expect(list[1].tags).toEqual([]);
  });

  it("rejects saving FROM a fund", async () => {
    const { db } = await makeMemDb();
    const fund = await sources.ensureFundForCurrency(db, "EUR");
    await expect(
      createSaving(db, { fromSourceId: fund.id, amount: 10, date: "2026-05-01" }),
    ).rejects.toMatchObject({ code: "fund_save_rejected" });
  });

  it("rejects a currency that doesn't match the from-source", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "USD acct", currency: "USD" });
    await expect(
      createSaving(db, { fromSourceId: acct.id, amount: 10, date: "2026-05-01", currency: "EUR" }),
    ).rejects.toMatchObject({ code: "currency_mismatch" });
  });

  it("deleting a saving reverses both legs (full refund)", async () => {
    const { db } = await makeMemDb();
    const acct = await sources.createSource(db, { name: "Checking", currency: "EUR", starting_balance: 1000 });
    const savingId = await createSaving(db, { fromSourceId: acct.id, amount: 250, date: "2026-05-01" });
    expect(await sources.getBalance(db, acct.id)).toBe(750);

    await deleteSaving(db, savingId);
    expect(await sources.getBalance(db, acct.id)).toBe(1000); // refunded
    const fund = (await sources.listSources(db)).find((s) => s.is_savings_fund === 1)!;
    expect(await sources.getBalance(db, fund.id)).toBe(0);
    const movCount = (await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements`))[0].c;
    expect(movCount).toBe(0); // both legs gone
  });
});

describe("savings filters + pagination", () => {
  it("filters by currency, tag, and date range; counts match", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    const usd = await sources.createSource(db, { name: "USD", currency: "USD", starting_balance: 1000 });
    await db.execute(`INSERT INTO tags (name,created_at,updated_at) VALUES ('Goal','t','t')`);
    await createSaving(db, { fromSourceId: eur.id, amount: 100, date: "2026-01-10", tagIds: [1] });
    await createSaving(db, { fromSourceId: eur.id, amount: 200, date: "2026-03-10" });
    await createSaving(db, { fromSourceId: usd.id, amount: 300, date: "2026-03-20" });

    expect(await countSavings(db)).toBe(3);
    expect(await countSavings(db, { currency: "EUR" })).toBe(2);
    expect(await countSavings(db, { tagId: 1 })).toBe(1);
    expect((await listSavings(db, { tagId: 1 }))[0].amount).toBe(100);
    expect(await countSavings(db, { dateFrom: "2026-03-01", dateTo: "2026-03-31" })).toBe(2);
    expect(await countSavings(db, { currency: "USD", dateFrom: "2026-03-01" })).toBe(1);

    // Pagination: 2 per page.
    const p1 = await listSavings(db, { limit: 2, offset: 0 });
    const p2 = await listSavings(db, { limit: 2, offset: 2 });
    expect(p1.length).toBe(2);
    expect(p2.length).toBe(1);
  });
});

describe("savings aggregates (contributions only)", () => {
  it("totalSaved sums contributions per currency", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    const usd = await sources.createSource(db, { name: "USD", currency: "USD", starting_balance: 1000 });
    await createSaving(db, { fromSourceId: eur.id, amount: 100, date: "2026-01-10" });
    await createSaving(db, { fromSourceId: eur.id, amount: 50, date: "2026-02-10" });
    await createSaving(db, { fromSourceId: usd.id, amount: 300, date: "2026-02-20" });

    expect(await totalSaved(db)).toEqual({ EUR: 150, USD: 300 });
    expect(await totalSaved(db, "EUR")).toEqual({ EUR: 150 });
  });

  it("totalSavedPeriod is bounded by date range (contributions only)", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    await createSaving(db, { fromSourceId: eur.id, amount: 100, date: "2026-01-10" });
    await createSaving(db, { fromSourceId: eur.id, amount: 50, date: "2026-02-10" });

    expect(await totalSavedPeriod(db, "2026-02-01", "2026-02-28")).toEqual({ EUR: 50 });
    expect(await totalSavedPeriod(db, "2026-01-01", "2026-02-28")).toEqual({ EUR: 150 });
    expect(await totalSavedPeriod(db, "2026-03-01", "2026-03-31")).toEqual({});
  });

  it("does NOT count a fund's non-contribution in-movements (§G asymmetry)", async () => {
    const { db } = await makeMemDb();
    const fund = await sources.ensureFundForCurrency(db, "EUR");
    // A plain in-movement on the fund (e.g. a yield credit or goal allocation) —
    // not flagged is_savings_contribution, so totalSaved must ignore it.
    await db.execute(
      `INSERT INTO movements (source_id,amount,direction,date,exclude_from_stats,is_savings_contribution,created_at,updated_at)
       VALUES (?,500,'in','2026-01-01',0,0,'t','t')`,
      [fund.id],
    );
    expect(await totalSaved(db)).toEqual({});
  });
});

describe("edit a saving (both legs stay consistent)", () => {
  it("edits amount/date/note/from-source in lockstep, preserving the pair + flag", async () => {
    const { db } = await makeMemDb();
    const a = await sources.createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const b = await sources.createSource(db, { name: "B", currency: "EUR", starting_balance: 1000 });
    await db.execute(`INSERT INTO tags (name,created_at,updated_at) VALUES ('Old','t','t'),('New','t','t')`);
    const savingId = await createSaving(db, { fromSourceId: a.id, amount: 100, date: "2026-01-10", note: "x", tagIds: [1] });

    await updateSaving(db, savingId, { amount: 250, date: "2026-02-01", note: "fixed", fromSourceId: b.id, tagIds: [2] });

    const inLeg = (await db.select<{ amount: number; date: string; note: string; transfer_pair_id: number; is_savings_contribution: number; source_id: number }>(
      `SELECT amount,date,note,transfer_pair_id,is_savings_contribution,source_id FROM movements WHERE id = ?`,
      [savingId],
    ))[0];
    const outLeg = (await db.select<{ amount: number; date: string; note: string; source_id: number }>(
      `SELECT amount,date,note,source_id FROM movements WHERE id = ?`,
      [inLeg.transfer_pair_id],
    ))[0];

    expect(inLeg.is_savings_contribution).toBe(1);
    expect(inLeg.amount).toBe(250);
    expect(outLeg.amount).toBe(250); // mirrored
    expect(inLeg.date).toBe("2026-02-01");
    expect(outLeg.date).toBe("2026-02-01");
    expect(outLeg.note).toBe("fixed");
    expect(outLeg.source_id).toBe(b.id); // from-source moved
    expect(inLeg.source_id).not.toBe(b.id); // in-leg still on the fund

    // Balances reflect the new from-source + amount.
    expect(await sources.getBalance(db, a.id)).toBe(1000); // refunded
    expect(await sources.getBalance(db, b.id)).toBe(750); // -250
    const fund = (await sources.listSources(db)).find((s) => s.is_savings_fund === 1)!;
    expect(await sources.getBalance(db, fund.id)).toBe(250);

    // Tags reset symmetrically on BOTH legs.
    expect((await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movement_tag WHERE tag_id = 1`))[0].c).toBe(0);
    expect((await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movement_tag WHERE tag_id = 2`))[0].c).toBe(2);
  });

  it("changing currency moves the in-leg to the new fund (with a matching from-source)", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    const usd = await sources.createSource(db, { name: "USD", currency: "USD", starting_balance: 1000 });
    const savingId = await createSaving(db, { fromSourceId: eur.id, amount: 100, date: "2026-01-10" });

    await updateSaving(db, savingId, { currency: "USD", fromSourceId: usd.id });

    const usdFund = await sources.getFundForCurrency(db, "USD");
    const inLeg = (await db.select<{ source_id: number }>(`SELECT source_id FROM movements WHERE id = ?`, [savingId]))[0];
    expect(inLeg.source_id).toBe(usdFund!.id);
    expect(await sources.getBalance(db, eur.id)).toBe(1000); // EUR refunded
    expect(await sources.getBalance(db, usd.id)).toBe(900);
    expect(await sources.getBalance(db, usdFund!.id)).toBe(100);
  });

  it("rejects a currency change when the partner source no longer matches and no from-source is supplied", async () => {
    const { db } = await makeMemDb();
    const eur = await sources.createSource(db, { name: "EUR", currency: "EUR", starting_balance: 1000 });
    const savingId = await createSaving(db, { fromSourceId: eur.id, amount: 100, date: "2026-01-10" });
    await expect(updateSaving(db, savingId, { currency: "USD" })).rejects.toMatchObject({
      code: "currency_mismatch",
    });
  });

  it("rejects editing a non-saving movement id", async () => {
    const { db } = await makeMemDb();
    const s = await sources.createSource(db, { name: "A", currency: "EUR" });
    const rows = await db.select<{ id: number }>(
      `INSERT INTO movements (source_id,amount,direction,date,exclude_from_stats,is_savings_contribution,created_at,updated_at)
       VALUES (?,10,'in','2026-01-01',0,0,'t','t') RETURNING id`,
      [s.id],
    );
    await expect(updateSaving(db, rows[0].id, { amount: 5 })).rejects.toMatchObject({ code: "not_found" });
  });
});
