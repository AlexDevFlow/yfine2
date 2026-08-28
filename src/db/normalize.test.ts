/**
 * The plugin-sql executor decodes SELECT columns by DECLARED type: BOOLEAN
 * columns come back as JSON true/false and DATETIME columns as the `time`
 * crate's Display output ("2026-08-01 9:05:07.12" — space separator, unpadded
 * hour, trimmed subseconds, no Z). These tests pin the normalization that
 * restores the raw 0/1 + ISO contract the app relies on. Regression: the
 * movements page filtered `is_savings_fund === 0` against boolean values →
 * empty source list → Transfer button permanently disabled in the real app.
 */
import { describe, expect, it } from "vitest";
import { normalizeRows, normalizeValue } from "./normalize";

describe("normalizeValue", () => {
  it("maps plugin-sql booleans to the stored 0/1 ints", () => {
    expect(normalizeValue(true)).toBe(1);
    expect(normalizeValue(false)).toBe(0);
  });

  it("restores mangled DATETIME strings to ISO with padded hour and ms", () => {
    expect(normalizeValue("2026-08-01 9:05:07.123")).toBe("2026-08-01T09:05:07.123Z");
    expect(normalizeValue("2026-08-01 23:59:59.5")).toBe("2026-08-01T23:59:59.500Z");
    // time trims trailing zeros; ".78" means 780ms
    expect(normalizeValue("2026-08-01 12:00:00.78")).toBe("2026-08-01T12:00:00.780Z");
    // zero subseconds render as ".0"
    expect(normalizeValue("2026-08-01 0:00:00.0")).toBe("2026-08-01T00:00:00.000Z");
    // legacy Python microseconds truncate to ms
    expect(normalizeValue("2026-08-01 12:34:56.789012")).toBe("2026-08-01T12:34:56.789Z");
  });

  it("passes through already-ISO datetimes, plain dates, and other values", () => {
    expect(normalizeValue("2026-08-01T12:34:56.789Z")).toBe("2026-08-01T12:34:56.789Z");
    expect(normalizeValue("2026-08-01")).toBe("2026-08-01");
    expect(normalizeValue(42)).toBe(42);
    expect(normalizeValue(null)).toBe(null);
    expect(normalizeValue(1.5)).toBe(1.5);
  });

  it("leaves user text alone, even datetime-looking notes without subseconds", () => {
    expect(normalizeValue("2026-08-01 12:34:56")).toBe("2026-08-01 12:34:56");
    expect(normalizeValue("meeting 2026-08-01 12:34:56.1")).toBe("meeting 2026-08-01 12:34:56.1");
    expect(normalizeValue("paid rent")).toBe("paid rent");
  });
});

describe("normalizeRows", () => {
  it("normalizes every column of every row (the transfers regression shape)", () => {
    const rows = [
      {
        id: 1,
        name: "Checking",
        is_savings_fund: false as unknown,
        hidden_from_sources: false as unknown,
        created_at: "2026-08-01 9:05:07.1" as unknown,
        starting_balance: 100.5,
        yield_next_date: null,
      },
      {
        id: 2,
        name: "Fund",
        is_savings_fund: true as unknown,
        hidden_from_sources: false as unknown,
        created_at: "2026-08-01T10:00:00.000Z" as unknown,
        starting_balance: 0,
        yield_next_date: "2026-09-01",
      },
    ];
    const out = normalizeRows(rows);
    expect(out[0].is_savings_fund).toBe(0);
    expect(out[1].is_savings_fund).toBe(1);
    expect(out[0].created_at).toBe("2026-08-01T09:05:07.100Z");
    expect(out[1].created_at).toBe("2026-08-01T10:00:00.000Z");
    // the strict filter that gates the Transfer button works again
    expect(out.filter((s) => s.is_savings_fund === 0)).toHaveLength(1);
  });
});
