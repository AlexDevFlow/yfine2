import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import type { SqlExecutor } from "../types";
import { createSource, getBalance } from "./sources";
import * as mv from "./movements";
import { groupMovementsHierarchically } from "@/domain/grouping";

async function addTag(db: SqlExecutor, name: string): Promise<number> {
  const r = await db.select<{ id: number }>(
    `INSERT INTO tags (name,created_at,updated_at) VALUES (?,?,?) RETURNING id`,
    [name, "t", "t"],
  );
  return r[0].id;
}

describe("movements repo — plain", () => {
  it("creates with validation and replace-set tags", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "A", currency: "EUR", starting_balance: 0 });
    const t1 = await addTag(db, "Food");
    const id = await mv.createMovement(db, {
      source_id: s.id,
      amount: 12.5,
      direction: "out",
      date: "2026-05-01",
      note: "  lunch  ",
      tagIds: [t1],
    });
    const row = (await mv.getMovement(db, id))!;
    expect(row.note).toBe("lunch"); // trimmed
    expect(await getBalance(db, s.id)).toBe(-12.5);

    await expect(
      mv.createMovement(db, { amount: 0, direction: "in", date: "2026-05-01" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      mv.createMovement(db, { source_id: 9999, amount: 5, direction: "in", date: "2026-05-01" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects editing a transfer leg via the plain path (BUG-2 fix)", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const pair = await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 30, date: "2026-05-01" });
    await expect(
      mv.updateMovement(db, pair.outId, { amount: 999 }),
    ).rejects.toMatchObject({ code: "is_transfer_leg" });
  });
});

describe("movements repo — transfers", () => {
  it("requires distinct sources on create (and edit) — BUG-1 fix", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    await expect(
      mv.createTransfer(db, { fromSourceId: a.id, toSourceId: a.id, amount: 10, date: "2026-05-01" }),
    ).rejects.toMatchObject({ code: "same_source" });

    const pair = await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 10, date: "2026-05-01" });
    await expect(
      mv.updateTransfer(db, pair.outId, { toSourceId: a.id }),
    ).rejects.toMatchObject({ code: "same_source" });
  });

  it("same-currency edit mirrors amount to both legs; conserves", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const pair = await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 30, date: "2026-05-01" });
    expect(await getBalance(db, a.id)).toBe(70);
    expect(await getBalance(db, b.id)).toBe(30);

    await mv.updateTransfer(db, pair.outId, { amount: 50, date: "2026-06-01", note: "moved" });
    expect(await getBalance(db, a.id)).toBe(50);
    expect(await getBalance(db, b.id)).toBe(50);
    const inLeg = (await mv.getMovement(db, pair.inId))!;
    expect(inLeg.date).toBe("2026-06-01");
    expect(inLeg.note).toBe("moved");
    expect(inLeg.amount).toBe(50);
  });

  it("cross-currency edit does NOT clobber the converted IN amount", async () => {
    const { db } = await makeMemDb();
    const eur = await createSource(db, { name: "EUR", currency: "EUR", starting_balance: 100 });
    const usd = await createSource(db, { name: "USD", currency: "USD", starting_balance: 0 });
    const pair = await mv.createTransfer(db, {
      fromSourceId: eur.id,
      toSourceId: usd.id,
      amount: 10,
      toAmount: 11,
      date: "2026-05-01",
    });
    expect((await mv.getMovement(db, pair.inId))!.amount).toBe(11);

    // change only the OUT amount → IN must stay at its explicit converted value
    await mv.updateTransfer(db, pair.outId, { amount: 20 });
    expect((await mv.getMovement(db, pair.outId))!.amount).toBe(20);
    expect((await mv.getMovement(db, pair.inId))!.amount).toBe(11);

    // explicit toAmount updates the IN leg
    await mv.updateTransfer(db, pair.outId, { toAmount: 22 });
    expect((await mv.getMovement(db, pair.inId))!.amount).toBe(22);
  });

  it("rejects editing a non-transfer as a transfer", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "A", currency: "EUR" });
    const id = await mv.createMovement(db, { source_id: s.id, amount: 5, direction: "out", date: "2026-05-01" });
    await expect(mv.updateTransfer(db, id, { amount: 9 })).rejects.toMatchObject({ code: "not_a_transfer" });
  });
});

describe("movements repo — bulk", () => {
  it("bulk delete dedups transfer partners and reports skipped", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const pair = await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 30, date: "2026-05-01" });
    const plain = await mv.createMovement(db, { source_id: a.id, amount: 5, direction: "out", date: "2026-05-02" });

    const res = await mv.bulkDelete(db, [pair.outId, pair.inId, plain, 9999]);
    expect(res.affected).toBe(2); // transfer (one delete) + plain
    expect(res.skipped).toEqual([9999]);
    const left = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements`);
    expect(left[0].c).toBe(0);
  });

  it("bulk set-source skips transfer legs; bulk tags expand to partners", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    const c = await createSource(db, { name: "C", currency: "EUR" });
    const pair = await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 30, date: "2026-05-01" });
    const plain = await mv.createMovement(db, { source_id: a.id, amount: 5, direction: "out", date: "2026-05-02" });
    const tag = await addTag(db, "Bills");

    const setRes = await mv.bulkSetSource(db, [pair.outId, plain], c.id);
    expect(setRes.affected).toBe(1); // only the plain one moved
    expect(setRes.skipped).toContain(pair.outId);

    const tagRes = await mv.bulkSetTags(db, [pair.outId], [tag], "add");
    expect(tagRes.affected).toBe(1);
    // both legs got the tag (expanded to partner)
    const tagged = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movement_tag WHERE tag_id = ?`, [tag]);
    expect(tagged[0].c).toBe(2);

    await expect(mv.bulkSetTags(db, [plain], [9999], "add")).rejects.toMatchObject({ code: "unknown_tag" });
  });

  it("bulk set-exclude expands to transfer partners and reports skipped", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 100 });
    const b = await createSource(db, { name: "B", currency: "EUR" });
    const pair = await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 30, date: "2026-05-01" });
    const plain = await mv.createMovement(db, { source_id: a.id, amount: 5, direction: "out", date: "2026-05-02" });

    const res = await mv.bulkSetExclude(db, [pair.outId, plain, 9999], true);
    expect(res.affected).toBe(2);
    expect(res.skipped).toEqual([9999]);
    // both legs of the transfer + the plain row are now excluded
    expect((await mv.getMovement(db, pair.outId))!.exclude_from_stats).toBe(1);
    expect((await mv.getMovement(db, pair.inId))!.exclude_from_stats).toBe(1);
    expect((await mv.getMovement(db, plain))!.exclude_from_stats).toBe(1);

    // toggling individually flips back
    await mv.toggleExclude(db, plain);
    expect((await mv.getMovement(db, plain))!.exclude_from_stats).toBe(0);

    // include the lot again
    await mv.bulkSetExclude(db, [pair.outId], false);
    expect((await mv.getMovement(db, pair.inId))!.exclude_from_stats).toBe(0);
  });
});

describe("movements repo — listing & filters", () => {
  it("hides the IN leg of transfers, escapes note search, paginates", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const b = await createSource(db, { name: "B", currency: "EUR" });
    await mv.createMovement(db, { source_id: a.id, amount: 10, direction: "out", date: "2026-05-01", note: "100% cotton" });
    await mv.createMovement(db, { source_id: a.id, amount: 20, direction: "in", date: "2026-05-02", note: "salary" });
    await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 30, date: "2026-05-03" });

    const all = await mv.listMovements(db, { excludeTransferIn: true });
    // 2 plain + 1 transfer OUT leg = 3 (IN leg hidden)
    expect(all.length).toBe(3);
    expect(all.every((m) => !(m.transfer_pair_id != null && m.direction === "in"))).toBe(true);
    // ordering: date DESC
    expect(all[0].date >= all[1].date).toBe(true);
    // transfer OUT row carries the partner source name
    const transferRow = all.find((m) => m.transfer_pair_id != null)!;
    expect(transferRow.partner_source_name).toBe("B");

    // note search treats % literally (escaped)
    const cotton = await mv.listMovements(db, { q: "100%" });
    expect(cotton.length).toBe(1);
    expect(cotton[0].note).toBe("100% cotton");

    expect(await mv.countMovements(db, { excludeTransferIn: true })).toBe(3);
  });

  it("grouped period rollups equal the aggregate sums over the same set (cards ↔ list invariant)", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const b = await createSource(db, { name: "B", currency: "EUR" });
    await mv.createMovement(db, { source_id: a.id, amount: 100, direction: "in", date: "2026-05-01" });
    await mv.createMovement(db, { source_id: a.id, amount: 30, direction: "out", date: "2026-05-02" });
    await mv.createMovement(db, { source_id: a.id, amount: 70, direction: "in", date: "2026-04-15" });
    // a transfer must not count toward either side, in the rollups or the sums
    await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 50, date: "2026-05-03" });

    const filters = { excludeTransferIn: true } as const;
    const all = await mv.listMovements(db, filters, { limit: 10_000, offset: 0 });
    const groups = groupMovementsHierarchically(all);
    const rollupIn = groups.reduce((s, y) => s + y.totalIn, 0);
    const rollupOut = groups.reduce((s, y) => s + y.totalOut, 0);

    const sums = await mv.sumMovements(db, filters);
    // The summary cards (sumMovements) and the per-period headers (grouping) must
    // agree when the whole filtered set is loaded — the property the movements
    // page relies on now that it loads everything instead of paginating.
    expect(rollupIn).toBeCloseTo(sums.totalIn, 2);
    expect(rollupOut).toBeCloseTo(sums.totalOut, 2);
    expect(sums.totalIn).toBe(170);
    expect(sums.totalOut).toBe(30);
  });

  it("free-text search matches tag names, not just the note", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR" });
    const food = await addTag(db, "Groceries");
    // note has nothing to do with the query; only the tag matches
    const tagged = await mv.createMovement(db, { source_id: a.id, amount: 5, direction: "out", date: "2026-05-01", note: "Lidl run", tagIds: [food] });
    await mv.createMovement(db, { source_id: a.id, amount: 9, direction: "out", date: "2026-05-02", note: "Fuel" });

    const hit = await mv.listMovements(db, { q: "grocer" });
    expect(hit.map((m) => m.id)).toContain(tagged);
    expect(hit.length).toBe(1);
    expect(await mv.countMovements(db, { q: "grocer" })).toBe(1);
  });

  it("sums in/out across all rows, excluding both transfer legs", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const b = await createSource(db, { name: "B", currency: "EUR" });
    await mv.createMovement(db, { source_id: a.id, amount: 100, direction: "in", date: "2026-05-01" });
    await mv.createMovement(db, { source_id: a.id, amount: 40, direction: "out", date: "2026-05-02" });
    await mv.createMovement(db, { source_id: a.id, amount: 10, direction: "out", date: "2026-05-03" });
    // transfer legs must NOT count toward either total
    await mv.createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 30, date: "2026-05-04" });

    const sums = await mv.sumMovements(db, { excludeTransferIn: true });
    expect(sums.totalIn).toBe(100);
    expect(sums.totalOut).toBe(50);

    // a direction filter narrows the aggregate too
    const outOnly = await mv.sumMovements(db, { direction: "out" });
    expect(outOnly.totalIn).toBe(0);
    expect(outOnly.totalOut).toBe(50);
  });

  it("tag match or vs and, and rejects an invalid date range", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR" });
    const food = await addTag(db, "Food");
    const work = await addTag(db, "Work");
    const m1 = await mv.createMovement(db, { source_id: a.id, amount: 1, direction: "out", date: "2026-05-01", tagIds: [food] });
    await mv.createMovement(db, { source_id: a.id, amount: 2, direction: "out", date: "2026-05-02", tagIds: [food, work] });
    void m1;

    expect((await mv.listMovements(db, { tagIds: [food, work], tagMatch: "or" })).length).toBe(2);
    expect((await mv.listMovements(db, { tagIds: [food, work], tagMatch: "and" })).length).toBe(1);

    await expect(
      mv.listMovements(db, { dateFrom: "2026-06-01", dateTo: "2026-05-01" }),
    ).rejects.toMatchObject({ code: "invalid_range" });
  });

  it("paginates with limit + offset so older rows are reachable", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 100000 });
    // 120 movements on distinct, valid, ascending dates (m1 oldest … m120 newest)
    for (let i = 1; i <= 120; i++) {
      const month = String(Math.floor((i - 1) / 28) + 1).padStart(2, "0");
      const day = String(((i - 1) % 28) + 1).padStart(2, "0");
      await mv.createMovement(db, { source_id: a.id, amount: i, direction: "out", date: `2026-${month}-${day}`, note: `m${i}` });
    }
    expect(await mv.countMovements(db, {})).toBe(120);

    const page1 = await mv.listMovements(db, {}, { limit: 50, offset: 0 });
    const page2 = await mv.listMovements(db, {}, { limit: 50, offset: 50 });
    const page3 = await mv.listMovements(db, {}, { limit: 50, offset: 100 });
    expect(page1).toHaveLength(50);
    expect(page2).toHaveLength(50);
    expect(page3).toHaveLength(20); // last page (older rows are still reachable)

    // newest first; no overlap across pages
    expect(page1[0].note).toBe("m120");
    const ids = new Set([...page1, ...page2, ...page3].map((m) => m.id));
    expect(ids.size).toBe(120);
    // the very oldest movement is reachable on the last page — past the 200-row
    // legacy cap would NOT matter here, but offset paging surfaces it.
    expect(page3[page3.length - 1].note).toBe("m1");
  });
});
