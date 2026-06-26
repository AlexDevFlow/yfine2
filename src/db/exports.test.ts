import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "./repo/sources";
import { createMovement } from "./repo/movements";
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

  it("each section carries its summary KPIs above the table (movements income/expense/net)", async () => {
    const { db } = await makeMemDb();
    await seed(db);
    const bytes = await exportExcel(db, ["movements"]);
    const flat = sheetAoa(bytes, "Movements").map((r) => r.map((c) => String(c ?? "")));
    const find = (label: string) => flat.find((r) => r[0] === label);
    expect(find("Income")?.[1]).toBe("200");
    expect(find("Expense")?.[1]).toBe("150"); // 50 + 100
    expect(find("Net")?.[1]).toBe("50");
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
