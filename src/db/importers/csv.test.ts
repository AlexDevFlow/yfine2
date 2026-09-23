import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { createSource, getBalance } from "../repo/sources";
import { parseAmount, tryParseDate, parseCsv, detectPreset, extractHeaders, previewCsv, commitCsv, undoImport, type ParsedMovement } from "./csv";

describe("csv heuristics", () => {
  it("parses amounts with separators and currency tokens", () => {
    expect(parseAmount("1,234.56", ".")).toBe(1234.56);
    expect(parseAmount("1.234,56", ",")).toBe(1234.56);
    expect(parseAmount("€ 42,10", ",")).toBe(42.1);
    // comma-decimal preset, but a dot-locale value (e.g. US PayPal): the lone dot is
    // the decimal, not a thousands separator → must NOT become 350.
    expect(parseAmount("-3.50", ",")).toBe(-3.5);
    expect(parseAmount("1.234", ",")).toBe(1234); // 3-digit group still treated as grouping
    expect(parseAmount("-9.99", ".")).toBe(-9.99);
    // dot-decimal locale: comma is the THOUSANDS separator, not a decimal.
    expect(parseAmount("1,234", ".")).toBe(1234);
    expect(parseAmount("1,234,567", ".")).toBe(1234567);
    expect(parseAmount("1.234.567", ".")).toBe(1234567); // several dot groups can only be grouping
    expect(parseAmount("1.234", ".")).toBe(1.234); // a single dot stays the decimal
    expect(parseAmount("1,5", ".")).toBe(1.5); // stray non-group comma → decimal fallback
    expect(parseAmount("", ".")).toBeNull();
  });
  it("parses dates with formats and day-first fallback", () => {
    expect(tryParseDate("2026-05-10")).toBe("2026-05-10");
    expect(tryParseDate("10/05/2026")).toBe("2026-05-10"); // d/m/y fallback
    expect(tryParseDate("05/10/2026", "%m/%d/%Y")).toBe("2026-05-10");
    expect(tryParseDate("2026-05-10 14:30:00", "%Y-%m-%d %H:%M:%S")).toBe("2026-05-10");
    expect(tryParseDate("nonsense")).toBeNull();
  });

  it("recovers day-first / ambiguous dates that the narrow fallback dropped (gap 4)", () => {
    // 2-digit year, day-first (pivot <70 → 2000s)
    expect(tryParseDate("12.03.21")).toBe("2021-03-12");
    expect(tryParseDate("15/01/24")).toBe("2024-01-15");
    // month-name dates
    expect(tryParseDate("15 Jan 2024")).toBe("2024-01-15");
    expect(tryParseDate("Jan 15, 2024")).toBe("2024-01-15");
    expect(tryParseDate("15 January 24")).toBe("2024-01-15");
    // ISO datetime with trailing Z / offset
    expect(tryParseDate("2024-01-15T10:30:00Z")).toBe("2024-01-15");
    expect(tryParseDate("2024-01-15T10:30:00+02:00")).toBe("2024-01-15");
  });

  it("imports rows whose only date is day-first 2-digit-year (no longer silently dropped)", () => {
    const csv = "Date,Amount,Description\n12.03.21,-5.00,Coffee\n";
    const r = parseCsv(csv, { decimal_separator: "." });
    expect(r.movements.length).toBe(1);
    expect(r.movements[0]).toMatchObject({ date: "2021-03-12", amount: 5, direction: "out" });
  });
});

describe("csv parse + presets", () => {
  it("auto-guesses columns and signs amounts", () => {
    const csv = "Date,Amount,Description\n2026-05-01,-42.10,Groceries\n2026-05-02,2000,Salary\n";
    const r = parseCsv(csv);
    expect(r.movements.length).toBe(2);
    expect(r.movements[0]).toMatchObject({ date: "2026-05-01", amount: 42.1, direction: "out", note: "Groceries" });
    expect(r.movements[1]).toMatchObject({ amount: 2000, direction: "in" });
  });

  it("detects the Revolut preset and applies its mapping", () => {
    const csv = "Type,Started Date,Completed Date,Description,Amount,Currency,State\nCARD,2026-05-01 10:00:00,2026-05-01 12:00:00,Coffee,-3.50,EUR,COMPLETED\n";
    const headers = extractHeaders(csv);
    const preset = detectPreset(csv, headers);
    expect(preset?.id).toBe("revolut");
    const r = parseCsv(csv, preset!.options);
    expect(r.movements[0]).toMatchObject({ date: "2026-05-01", amount: 3.5, direction: "out", note: "Coffee", currency: "EUR" });
  });

  it("returns needs_mapping when columns can't be guessed", () => {
    const r = parseCsv("foo,bar\n1,2\n");
    expect(r.needsMapping).toBe(true);
  });
});

describe("csv preview + commit", () => {
  const movements: ParsedMovement[] = [
    { date: "2026-05-01", amount: 42.1, direction: "out", note: "Groceries", currency: "EUR" },
    { date: "2026-05-02", amount: 2000, direction: "in", note: "Salary", currency: "EUR" },
  ];

  it("commits rows, then re-dedupes on a second import (BUG-1 fix)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Bank", currency: "EUR", starting_balance: 0 });
    const r1 = await commitCsv(db, { movements, sourceId: s.id });
    expect(r1.imported).toBe(2);
    expect(await getBalance(db, s.id)).toBe(1957.9); // 2000 - 42.10
    // importing the same file again imports nothing (dedupe at commit)
    const r2 = await commitCsv(db, { movements, sourceId: s.id });
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(2);
  });

  it("warns on a currency mismatch with the target account (BUG-2 fix)", async () => {
    const { db } = await makeMemDb();
    const usd = await createSource(db, { name: "USD acct", currency: "USD", starting_balance: 0 });
    const r = await commitCsv(db, { movements, sourceId: usd.id });
    expect(r.currencyWarning).toContain("EUR");
    expect(r.imported).toBe(2); // still imported verbatim
  });

  it("preview flags duplicates against an existing source", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Bank", currency: "EUR" });
    await commitCsv(db, { movements: [movements[0]], sourceId: s.id });
    const csv = "Date,Amount,Description\n2026-05-01,-42.10,Groceries\n2026-05-02,2000,Salary\n";
    const preview = await previewCsv(db, csv, { sourceId: s.id });
    expect(preview.duplicateCount).toBe(1); // the groceries row already exists
    expect(preview.rows.find((r) => r.note === "Groceries")?.isDuplicate).toBe(true);
  });

  it("honors an explicit include-set, overriding the duplicate filter (gap 3)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Bank", currency: "EUR" });
    await commitCsv(db, { movements: [movements[0]], sourceId: s.id }); // seed the groceries dup
    // Force-import BOTH rows (index 0 is the flagged duplicate) via includeIndices.
    const r = await commitCsv(db, { movements, sourceId: s.id, includeIndices: [0, 1] });
    expect(r.imported).toBe(2); // duplicate imported anyway because the user chose it
    // ...and excluding a non-duplicate row via the set skips it.
    const r2 = await commitCsv(db, { movements, sourceId: s.id, includeIndices: [1] });
    expect(r2.imported).toBe(1);
    expect(r2.skipped).toBe(1);
  });

  it("undoes a committed import by deleting exactly the created movements (gap 6)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Bank", currency: "EUR", starting_balance: 100 });
    const r = await commitCsv(db, { movements, sourceId: s.id });
    expect(r.createdIds.length).toBe(2);
    expect(await getBalance(db, s.id)).toBe(2057.9); // 100 + 2000 - 42.10
    const deleted = await undoImport(db, r.createdIds);
    expect(deleted).toBe(2);
    expect(await getBalance(db, s.id)).toBe(100); // back to starting balance
    // idempotent: undoing again deletes nothing
    expect(await undoImport(db, r.createdIds)).toBe(0);
  });
});
