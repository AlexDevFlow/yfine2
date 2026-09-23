import { describe, it, expect } from "vitest";
import {
  evalMoneyExpr,
  formatMoneyInputValue,
  parseMoneyInput,
  sanitizeMoneyInput,
} from "@/components/ui/money-input";

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
    expect(evalMoneyExpr("1.000.000")).toBe(1000000); // several dots can only be grouping
    expect(evalMoneyExpr("1.000")).toBe(1); // a single dot stays the decimal point
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
    expect(evalMoneyExpr("2(3)")).toBeNull(); // implicit multiplication unsupported
    expect(evalMoneyExpr("(1+2")).toBeNull(); // unclosed group
    expect(evalMoneyExpr("1..2")).toBeNull();
    expect(evalMoneyExpr("")).toBeNull();
    expect(evalMoneyExpr("Math.PI")).toBeNull(); // letters blocked by whitelist
  });

  it("works when dynamic code execution is blocked by the desktop CSP", () => {
    const nativeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Function")!;
    Object.defineProperty(globalThis, "Function", {
      configurable: true,
      writable: true,
      value: () => {
        throw new EvalError("Refused by Content Security Policy");
      },
    });
    try {
      expect(evalMoneyExpr("1000")).toBe(1000);
      expect(evalMoneyExpr("100+25*2")).toBe(150);
    } finally {
      Object.defineProperty(globalThis, "Function", nativeDescriptor);
    }
  });
});

describe("evalMoneyExpr — human money typing tolerance (transfer invalid_amount fix)", () => {
  it("strips currency symbols anywhere", () => {
    expect(evalMoneyExpr("€50")).toBe(50);
    expect(evalMoneyExpr("50€")).toBe(50);
    expect(evalMoneyExpr("50 €")).toBe(50);
    expect(evalMoneyExpr("$ 1,000.50")).toBe(1000.5);
  });
  it("treats digit-gap spaces as thousands grouping", () => {
    expect(evalMoneyExpr("1 000")).toBe(1000);
    expect(evalMoneyExpr("1 000 000")).toBe(1000000);
    expect(evalMoneyExpr("1 000,50")).toBe(1000.5);
  });
  it("keeps operator spacing and rejects real garbage", () => {
    expect(evalMoneyExpr("10 + 5")).toBe(15);
    expect(evalMoneyExpr("abc")).toBeNull();
    expect(evalMoneyExpr("50..5")).toBeNull();
  });
});

describe("MoneyInput editing and display constraints", () => {
  it("accepts only characters that can make a supported amount", () => {
    expect(sanitizeMoneyInput("12,50", "12,5")).toBe("12,50");
    expect(sanitizeMoneyInput("10 + 5", "10 + ")).toBe("10 + 5");
    expect(sanitizeMoneyInput("12abc34", "12")).toBe("12");
    expect(sanitizeMoneyInput("Infinity", "10")).toBe("10");
    expect(sanitizeMoneyInput("1".repeat(257), "10")).toBe("10");
  });

  it("cleans pasted currency formatting without merging invalid text", () => {
    expect(sanitizeMoneyInput("€ 1\u00a0234,50")).toBe(" 1 234,50");
    expect(parseMoneyInput(sanitizeMoneyInput("€ 1\u00a0234,50"))).toBe(1234.5);
  });

  it("formats committed amounts for the app locale without ambiguous grouping", () => {
    expect(formatMoneyInputValue(1234.5, "it-IT")).toBe("1234,50");
    expect(formatMoneyInputValue(1234.5, "en-US")).toBe("1234.50");
    expect(formatMoneyInputValue(0.125, "it-IT")).toBe("0,125");
  });
});
