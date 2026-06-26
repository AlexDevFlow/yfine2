import { describe, it, expect } from "vitest";
import { validateCurrency, validateName, MAX_NAME_LENGTH } from "./validators";

describe("validateCurrency", () => {
  it("normalizes case + whitespace for a known code", () => {
    expect(validateCurrency("  eur ")).toBe("EUR");
    expect(validateCurrency("usd")).toBe("USD");
    expect(validateCurrency("btc")).toBe("BTC");
  });

  it("rejects codes outside the allow-list", () => {
    expect(() => validateCurrency("XYZ")).toThrowError(/invalid_currency/);
  });

  it("rejects too-short and too-long codes", () => {
    expect(() => validateCurrency("E")).toThrowError(/invalid_currency/);
    expect(() => validateCurrency("TOOLONG")).toThrowError(/invalid_currency/);
  });

  it("exposes the code on the thrown DomainError", () => {
    try {
      validateCurrency("nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("invalid_currency");
    }
  });
});

describe("validateName", () => {
  it("trims a valid name", () => {
    expect(validateName("  Groceries ")).toBe("Groceries");
  });

  it("rejects an empty / whitespace-only name", () => {
    expect(() => validateName("")).toThrowError(/invalid_name/);
    expect(() => validateName("   ")).toThrowError(/invalid_name/);
  });

  it("accepts a name at the max length but rejects one over it", () => {
    expect(validateName("a".repeat(MAX_NAME_LENGTH))).toHaveLength(MAX_NAME_LENGTH);
    expect(() => validateName("a".repeat(MAX_NAME_LENGTH + 1))).toThrowError(/invalid_name/);
  });
});
