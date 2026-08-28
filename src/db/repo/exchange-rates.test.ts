import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { convert, deleteRate, getRate, listRates, upsertRate } from "./exchange-rates";

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

describe("exchange rates — 0-rate means not configured (transfer auto-fill fix)", () => {
  it("getRate ignores a stored 0 direct rate (falls through to inverse/null)", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "USD", 0);
    expect(await getRate(db, "EUR", "USD")).toBeNull();
    // a real inverse still wins over the 0 direct
    await upsertRate(db, "USD", "EUR", 2);
    expect(await getRate(db, "EUR", "USD")).toBe(0.5);
  });

  it("convert never auto-fills 0 for a positive amount", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "JPY", 0.000001);
    expect(await convert(db, 100, "EUR", "JPY")).toBeNull(); // rounds to 0 → null
    await upsertRate(db, "EUR", "USD", 1.1);
    expect(await convert(db, 1000, "EUR", "USD")).toBe(1100);
  });
});

describe("chained rates (a star table values every pair)", () => {
  it("derives a missing pair from two rates that share a currency", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "USD", 1.25);
    await upsertRate(db, "EUR", "GBP", 0.8);
    // USD -> EUR -> GBP, both hops walked in the direction they are stored in.
    expect(await getRate(db, "USD", "GBP")).toBeCloseTo(0.64, 10);
    expect(await getRate(db, "GBP", "USD")).toBeCloseTo(1.5625, 10);
    expect(await convert(db, 100, "USD", "GBP")).toBe(64);
  });

  it("prefers a direct pair over a chain, so a manual rate always wins", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "USD", 1.25);
    await upsertRate(db, "EUR", "GBP", 0.8);
    await upsertRate(db, "USD", "GBP", 0.7);
    expect(await getRate(db, "USD", "GBP")).toBe(0.7);
  });

  it("stays null when the graph doesn't connect the two currencies", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "USD", 1.25);
    await upsertRate(db, "JPY", "KRW", 9.5);
    expect(await getRate(db, "USD", "KRW")).toBeNull();
  });
});

describe("deleteRate", () => {
  it("removes the pair so conversions fall back to null again", async () => {
    const { db } = await makeMemDb();
    await upsertRate(db, "EUR", "USD", 1.1);
    const [row] = await listRates(db);
    await deleteRate(db, row.id);
    expect(await listRates(db)).toHaveLength(0);
    expect(await getRate(db, "EUR", "USD")).toBeNull();
  });
});
