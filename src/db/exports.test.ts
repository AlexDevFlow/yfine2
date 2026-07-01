import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "./repo/sources";
import { createMovement, createTransfer } from "./repo/movements";
import { exportExcel, EXPORT_SECTIONS } from "./exports";
import type { SqlExecutor } from "./types";

async function seed(db: SqlExecutor) {
  const eur = await createSource(db, { name: "Checking", currency: "EUR", starting_balance: 1000 });
  const usd = await createSource(db, { name: "USD acc", currency: "USD", starting_balance: 500 });
  await db.execute(`INSERT INTO tags (name,color,created_at,updated_at) VALUES ('Food','#fff','t','t')`);
  await createMovement(db, { source_id: eur.id, amount: 200, direction: "in", date: "2026-05-01" });
  await createMovement(db, { source_id: eur.id, amount: 50, direction: "out", date: "2026-05-02" });
  await createMovement(db, { source_id: usd.id, amount: 100, direction: "out", date: "2026-05-03" });
  return { eur, usd };
}

/** Read a workbook's sheet back as a 2D array of cell values. */
function sheetAoa(bytes: Uint8Array, name: string): unknown[][] {
  const wb = XLSX.read(bytes, { type: "array" });
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }) as unknown[][];
}

describe("excel export — overview & data contract", () => {
  it("leads with an Overview sheet carrying net-worth-by-currency KPIs + counts", async () => {
    const { db } = await makeMemDb();
    await seed(db);
    const bytes = await exportExcel(db, EXPORT_SECTIONS.map((s) => s.key));
    const wb = XLSX.read(bytes, { type: "array" });

    // Overview is the FIRST sheet.
    expect(wb.SheetNames[0]).toBe("Overview");

    const aoa = sheetAoa(bytes, "Overview");
    const flat = aoa.map((r) => r.map((c) => String(c ?? "")));
    const find = (label: string) => flat.find((r) => r[0] === label);

    // Net worth by currency: EUR = 1000 + 200 - 50 = 1150; USD = 500 - 100 = 400.
    expect(find("Net Worth (EUR)")?.[1]).toBe("1150");
    expect(find("Net Worth (USD)")?.[1]).toBe("400");
    expect(find("Total Sources")?.[1]).toBe("2");
    expect(find("Movements")?.[1]).toBe("3");
    expect(find("Tags")?.[1]).toBe("1");
  });

  it("reports movement income/expense/net PER CURRENCY (never cross-summed)", async () => {
    const { db } = await makeMemDb();
    await seed(db);
    const bytes = await exportExcel(db, ["movements"]);
    const flat = sheetAoa(bytes, "Movements").map((r) => r.map((c) => String(c ?? "")));
    const find = (label: string) => flat.find((r) => r[0] === label);
    // EUR: +200 in, -50 out. USD: -100 out. The €/$ totals must NOT be mixed
    // (the old export reported "Expense 150" = 50 EUR + 100 USD — meaningless).
    expect(find("Income (EUR)")?.[1]).toBe("200");
    expect(find("Expense (EUR)")?.[1]).toBe("50");
    expect(find("Net (EUR)")?.[1]).toBe("150");
    expect(find("Expense (USD)")?.[1]).toBe("100");
    expect(find("Net (USD)")?.[1]).toBe("-100");
  });

  it("excludes transfer legs from the movements summary (a transfer isn't income/expense)", async () => {
    const { db } = await makeMemDb();
    const a = await createSource(db, { name: "A", currency: "EUR", starting_balance: 1000 });
    const b = await createSource(db, { name: "B", currency: "EUR", starting_balance: 0 });
    await createMovement(db, { source_id: a.id, amount: 200, direction: "in", date: "2026-05-01" });
    await createTransfer(db, { fromSourceId: a.id, toSourceId: b.id, amount: 300, date: "2026-05-02" });
    const bytes = await exportExcel(db, ["movements"]);
    const flat = sheetAoa(bytes, "Movements").map((r) => r.map((c) => String(c ?? "")));
    const find = (label: string) => flat.find((r) => r[0] === label);
    // The €300 transfer must NOT inflate income or expense — only the +200 counts.
    expect(find("Income (EUR)")?.[1]).toBe("200");
    expect(find("Expense (EUR)")?.[1]).toBe("0");
    expect(find("Net (EUR)")?.[1]).toBe("200");
  });

  it("number-formats monetary Excel cells (#,##0.00) but leaves counts plain", async () => {
    const { db } = await makeMemDb();
    await seed(db);
    const bytes = await exportExcel(db, EXPORT_SECTIONS.map((s) => s.key));
    const wb = XLSX.read(bytes, { type: "array", cellNF: true });
    const ws = wb.Sheets["Overview"];
    const range = XLSX.utils.decode_range(ws["!ref"]!);
    const valueCell = (label: string) => {
      for (let r = range.s.r; r <= range.e.r; r++) {
        const a = ws[XLSX.utils.encode_cell({ r, c: 0 })];
        if (a && String(a.v) === label) return ws[XLSX.utils.encode_cell({ r, c: 1 })];
      }
      return undefined;
    };
    expect(valueCell("Net Worth (EUR)")?.z).toBe("#,##0.00"); // money → formatted
    expect(valueCell("Total Sources")?.z ?? "General").not.toBe("#,##0.00"); // count → plain
  });

  it("empty section selection exports ALL sections (fallback, not an empty file)", async () => {
    const { db } = await makeMemDb();
    await seed(db);
    const bytes = await exportExcel(db, []);
    const wb = XLSX.read(bytes, { type: "array" });
    // Overview + the 6 canonical sections.
    expect(wb.SheetNames).toEqual(["Overview", "Sources", "Movements", "Tags", "Recurring", "Savings", "Whims"]);
  });

  it("emits sections in canonical order regardless of selection order", async () => {
    const { db } = await makeMemDb();
    await seed(db);
    const bytes = await exportExcel(db, ["whims", "sources", "movements"]);
    const wb = XLSX.read(bytes, { type: "array" });
    expect(wb.SheetNames).toEqual(["Overview", "Sources", "Movements", "Whims"]);
  });
});
