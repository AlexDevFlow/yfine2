import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { convert, getRate, upsertRate } from "./exchange-rates";

describe("exchange-rate conversion (transfer auto-fill backend)", () => {
  it("identity, direct, and reverse-rate fallback", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "USD", 1.1);
    expect(await getRate(db, "EUR", "EUR")).toBe(1);
    expect(await getRate(db, "eur", "usd")).toBe(1.1); // case-insensitive
    // reverse pair derived from the direct rate
    expect(await getRate(db, "USD", "EUR")).toBeCloseTo(1 / 1.1, 10);
  });

  it("convert rounds to 2dp and prefills a cross-currency amount", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "USD", 1.1);
    expect(await convert(db, 100, "EUR", "USD")).toBe(110);
    expect(await convert(db, 33.33, "EUR", "USD")).toBe(36.66); // round2
  });

  it("returns null when no rate exists (so the form stays optional / shows the no-rate hint)", async () => {
    const { db } = await makeMemDb();
    expect(await getRate(db, "EUR", "JPY")).toBeNull();
    expect(await convert(db, 100, "EUR", "JPY")).toBeNull();
  });
});
