import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "../repo/sources";
import { detectFormat, previewImport, type ImportFile } from "./format";

function mk(name: string, text: string): ImportFile {
  return { name, text, bytes: new TextEncoder().encode(text) };
}

describe("format detection", () => {
  it("detects by extension", () => {
    expect(detectFormat(mk("a.csv", "x,y\n1,2"))).toBe("csv");
    expect(detectFormat(mk("a.ofx", "<OFX>"))).toBe("ofx");
    expect(detectFormat(mk("a.qfx", "<OFX>"))).toBe("qfx");
  });
  it("falls back to a content sniff for unknown extensions", () => {
    expect(detectFormat(mk("data.txt", "OFXHEADER:100\n<OFX>"))).toBe("ofx");
    expect(detectFormat(mk("data.txt", "Date,Amount\n2024-01-01,5"))).toBe("csv");
    expect(detectFormat(mk("data.txt", "just one short line"))).toBeNull();
  });
});

describe("column-mapping re-preview (gap 2)", () => {
  it("returns needsMapping for un-guessable headers, then re-previews with a user column_map", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Bank", currency: "EUR" });
    const csv = "Col1,Col2,Col3\n2024-01-15,-42.10,Groceries\n2024-01-16,2000,Salary\n";
    const file = mk("weird.csv", csv);

    const first = await previewImport(db, file, { sourceId: s.id });
    expect(first.needsMapping).toBe(true);
    expect(first.headers).toEqual(["Col1", "Col2", "Col3"]);
    expect(first.rows.length).toBe(0);

    // user maps the columns and re-previews — same pipeline, now it parses
    const second = await previewImport(db, file, {
      sourceId: s.id,
      options: { column_map: { date: "Col1", amount: "Col2", note: "Col3" } },
    });
    expect(second.needsMapping).toBe(false);
    expect(second.rows.length).toBe(2);
    expect(second.rows[0]).toMatchObject({ date: "2024-01-15", amount: 42.1, direction: "out", note: "Groceries" });
  });
});

describe("manual format + preset override (gap 8)", () => {
  it("forces a CSV preset instead of auto-detecting", async () => {
    const { db } = await makeMemDb();
    // YNAB two-column format; force the preset explicitly.
    const csv = "Date,Payee,Inflow,Outflow\n01/15/2024,Coffee,$0.00,$3.50\n";
    const p = await previewImport(db, mk("x.csv", csv), { presetId: "ynab" });
    expect(p.preset?.id).toBe("ynab");
    expect(p.rows[0]).toMatchObject({ date: "2024-01-15", amount: 3.5, direction: "out", note: "Coffee" });
  });

  it("forces a format override", async () => {
    const { db } = await makeMemDb();
    const csv = "Date,Amount,Description\n2024-01-15,-5,Coffee\n";
    const p = await previewImport(db, mk("ambiguous", csv), { format: "csv" });
    expect(p.format).toBe("csv");
    expect(p.rows.length).toBe(1);
  });
});
