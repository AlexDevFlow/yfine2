import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "../repo/sources";
import { parseXlsx, sniffXlsx } from "./xlsx";
import { previewImport } from "./format";

function buildXlsx(rows: unknown[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

describe("xlsx parser", () => {
  it("sniffs a real xlsx (ZIP) buffer", () => {
    const bytes = buildXlsx([["Date", "Amount"], ["2024-01-15", -10]]);
    expect(sniffXlsx(bytes)).toBe(true);
    expect(sniffXlsx(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("auto-guesses columns, signs amounts and reads notes/currency", () => {
    const bytes = buildXlsx([
      ["Date", "Amount", "Description", "Currency"],
      ["2024-01-15", -42.1, "Groceries", "EUR"],
      ["2024-01-16", 2000, "Salary", "EUR"],
    ]);
    const r = parseXlsx(bytes);
    expect(r.movements.length).toBe(2);
    expect(r.movements[0]).toMatchObject({ date: "2024-01-15", amount: 42.1, direction: "out", note: "Groceries", currency: "EUR" });
    expect(r.movements[1]).toMatchObject({ amount: 2000, direction: "in" });
    expect(r.detectedCurrency).toBe("EUR");
  });

  it("surfaces column_not_found for a bad explicit map (B3 fix)", () => {
    const bytes = buildXlsx([["Date", "Amount"], ["2024-01-15", -10]]);
    const r = parseXlsx(bytes, { column_map: { date: "Nope", amount: "Amount" } });
    expect(r.warnings).toContain("column_not_found:Nope");
    expect(r.movements.length).toBe(0);
  });

  it("honors positive_with_type + a direction column (B4 fix)", () => {
    const bytes = buildXlsx([
      ["date", "amount", "type"],
      ["2024-01-15", 50, "debit"],
      ["2024-01-16", 50, "credit"],
    ]);
    const r = parseXlsx(bytes, { column_map: { date: "date", amount: "amount", direction: "type" }, sign_convention: "positive_with_type" });
    expect(r.movements[0]).toMatchObject({ amount: 50, direction: "out" });
    expect(r.movements[1]).toMatchObject({ amount: 50, direction: "in" });
  });

  it("returns needs_mapping when columns can't be guessed", () => {
    const bytes = buildXlsx([["foo", "bar"], [1, 2]]);
    expect(parseXlsx(bytes).needsMapping).toBe(true);
  });

  it("routes through previewImport via .xlsx extension", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Bank", currency: "EUR" });
    const bytes = buildXlsx([["Date", "Amount", "Description"], ["2024-01-15", -42.1, "Groceries"]]);
    const preview = await previewImport(db, { name: "stmt.xlsx", bytes, text: "" }, { sourceId: s.id });
    expect(preview.format).toBe("xlsx");
    expect(preview.rows.length).toBe(1);
    expect(preview.totalOut).toBe(42.1);
  });
});
