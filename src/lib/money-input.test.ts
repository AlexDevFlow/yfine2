import { describe, it, expect } from "vitest";
import { evalMoneyExpr, parseMoneyInput } from "@/components/ui/money-input";

describe("evalMoneyExpr (math-aware amount input)", () => {
  it("evaluates whitelisted arithmetic", () => {
    expect(evalMoneyExpr("100+25*1.22")).toBe(130.5);
    expect(evalMoneyExpr("(10+5)*2")).toBe(30);
    expect(evalMoneyExpr("42")).toBe(42); // plain number passes through
  });

  it("normalizes decimal commas (IT/ES locales)", () => {
    expect(evalMoneyExpr("1,5+2")).toBe(3.5);
    expect(evalMoneyExpr("2,25")).toBe(2.25);
  });

  it("treats grouping separators as thousands, not decimals (no ×1000 error)", () => {
    // Previously "1,000" → 1 (silent ×1000 error) and "1,000.50" → null.
    expect(evalMoneyExpr("1,000")).toBe(1000);
    expect(evalMoneyExpr("1,000.50")).toBe(1000.5);
    expect(evalMoneyExpr("1,000,000")).toBe(1000000);
    expect(evalMoneyExpr("1.234,56")).toBe(1234.56); // IT full format
    expect(evalMoneyExpr("1,000+250")).toBe(1250); // per-operand normalization
    expect(evalMoneyExpr("1,5+2,5")).toBe(4); // decimal commas still work
  });

  it("handles leading-zero / 0,NNN inputs without the octal-literal silent 0", () => {
    // "0,125" → "0125" would be an octal literal (strict-mode throw) → silent 0.
    expect(evalMoneyExpr("0,125")).toBe(0.125); // 0,NNN is a decimal, not grouping
    expect(evalMoneyExpr("0,5")).toBe(0.5);
    expect(evalMoneyExpr("0123")).toBe(123); // leading zeros stripped, not octal
    expect(parseMoneyInput("0,125")).toBe(0.125);
    expect(evalMoneyExpr("10.05")).toBe(10.05); // fraction zeros untouched
  });

  it("parseMoneyInput parses grouped/locale numbers safely (no silent 0 from Number())", () => {
    // Number("1.234,56") is NaN → the old `Number(raw) || 0` silently saved 0.
    expect(parseMoneyInput("1.234,56")).toBe(1234.56);
    expect(parseMoneyInput("1,5")).toBe(1.5);
    expect(parseMoneyInput("1,000")).toBe(1000);
    expect(parseMoneyInput("100+25")).toBe(125);
    expect(parseMoneyInput("42")).toBe(42);
    expect(parseMoneyInput("")).toBe(0);
    expect(parseMoneyInput("garbage")).toBe(0);
  });

  it("rejects non-whitelisted input and non-finite results", () => {
    expect(evalMoneyExpr("alert(1)")).toBeNull();
    expect(evalMoneyExpr("1+")).toBeNull(); // syntax error
    expect(evalMoneyExpr("1/0")).toBeNull(); // Infinity → null
    expect(evalMoneyExpr("")).toBeNull();
    expect(evalMoneyExpr("Math.PI")).toBeNull(); // letters blocked by whitelist
  });
});
