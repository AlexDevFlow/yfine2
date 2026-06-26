import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "../repo/sources";
import { parseOfx, parseOfxDate, sniffOfx } from "./ofx";
import { previewImport } from "./format";

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<SIGNONMSGSRSV1><SONRS><FI><ORG>My Bank</ORG></FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD</CURDEF>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240115120000<TRNAMT>-42.10<FITID>A1<NAME>Coffee Shop<MEMO>Latte</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240116<TRNAMT>2000.00<FITID>A2<NAME>Salary</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240117<TRNAMT>0.00<FITID>A3<NAME>Zero</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe("ofx parser", () => {
  it("sniffs OFX content", () => {
    expect(sniffOfx(OFX)).toBe(true);
    expect(sniffOfx("Date,Amount\n1,2")).toBe(false);
  });

  it("parses OFX dates (compact + dashed)", () => {
    expect(parseOfxDate("20240115120000")).toBe("2024-01-15");
    expect(parseOfxDate("20240116")).toBe("2024-01-16");
    expect(parseOfxDate("2024-01-17")).toBe("2024-01-17");
    expect(parseOfxDate(null)).toBeNull();
  });

  it("extracts STMTTRN blocks, signs amounts, builds notes, detects currency/org", () => {
    const r = parseOfx(OFX);
    expect(r.detectedCurrency).toBe("USD");
    expect(r.detectedSourceHint).toBe("My Bank");
    // the 0.00 row is dropped (zero amount)
    expect(r.movements.length).toBe(2);
    expect(r.movements[0]).toMatchObject({ date: "2024-01-15", amount: 42.1, direction: "out", note: "Coffee Shop - Latte", currency: "USD" });
    expect(r.movements[1]).toMatchObject({ date: "2024-01-16", amount: 2000, direction: "in", note: "Salary" });
  });

  it("warns when multiple statements are merged", () => {
    const multi = OFX.replace("</OFX>", "<BANKMSGSRSV1><STMTTRNRS><STMTRS></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>");
    expect(parseOfx(multi).warnings).toContain("multiple_accounts_merged");
  });

  it("routes through previewImport via .ofx extension and the same dedupe pipeline", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Bank", currency: "USD" });
    const bytes = new TextEncoder().encode(OFX);
    const preview = await previewImport(db, { name: "stmt.ofx", bytes, text: OFX }, { sourceId: s.id });
    expect(preview.format).toBe("ofx");
    expect(preview.rows.length).toBe(2);
    expect(preview.totalOut).toBe(42.1);
    expect(preview.totalIn).toBe(2000);
  });
});
