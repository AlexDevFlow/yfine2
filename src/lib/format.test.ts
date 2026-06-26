import { describe, it, expect } from "vitest";
import { formatMoney, formatSigned, currencyFlag, BASE_CURRENCY_CODES } from "./format";

describe("formatMoney", () => {
  it("formats a fiat amount with grouping + 2 decimals", () => {
    const s = formatMoney(1234.5, "USD", "en");
    expect(s).toContain("1,234.50");
  });

  it("keeps up to 8 decimals for crypto (Intl would clamp to 2)", () => {
    const s = formatMoney(0.12345678, "BTC", "en");
    expect(s).toBe("0.12345678 BTC");
  });

  it("crypto still shows at least 2 decimals", () => {
    expect(formatMoney(2, "ETH", "en")).toBe("2.00 ETH");
  });

  it("falls back to a number + suffix for non-ISO codes", () => {
    expect(formatMoney(10, "XYZW", "en")).toBe("10.00 XYZW");
  });

  it("is currency-symbol aware for a real ISO code", () => {
    // Don't hard-code the symbol (ICU varies); just ensure it isn't the plain suffix form.
    const s = formatMoney(5, "EUR", "en");
    expect(s).not.toBe("5.00 EUR");
    expect(s).toContain("5");
  });
});

describe("formatSigned", () => {
  it("prefixes + for positive and the real minus sign for negative", () => {
    expect(formatSigned(10, "USD", "en").startsWith("+")).toBe(true);
    expect(formatSigned(-10, "USD", "en").startsWith("−")).toBe(true); // U+2212 MINUS SIGN
  });

  it("has no sign for zero", () => {
    const s = formatSigned(0, "USD", "en");
    expect(s.startsWith("+")).toBe(false);
    expect(s.startsWith("−")).toBe(false);
  });

  it("uses the absolute value after the sign", () => {
    expect(formatSigned(-7, "XYZW", "en")).toBe("−7.00 XYZW");
  });
});

describe("currencyFlag", () => {
  it("returns a flag for known codes and '' for unknown", () => {
    expect(currencyFlag("EUR")).toBe("🇪🇺");
    expect(currencyFlag("ZZZ")).toBe("");
  });

  it("every base currency code maps to a non-empty flag", () => {
    for (const code of BASE_CURRENCY_CODES) {
      expect(currencyFlag(code), code).not.toBe("");
    }
  });
});
