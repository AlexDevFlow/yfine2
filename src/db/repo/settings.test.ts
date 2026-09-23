import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { getSettings, hasUserData, parseNetWorthExcluded, updateSettings } from "./settings";

describe("settings repo", () => {
  it("lazily creates the singleton row with defaults", async () => {
    const { db } = await makeMemDb();
    const s = await getSettings(db);
    expect(s.id).toBe(1);
    expect(s.locale).toBe("en");
    expect(s.theme).toBe("system"); // a fresh profile follows the OS, like the theme provider's default
    expect(s.ui_scale).toBe("normal");
    // idempotent
    await getSettings(db);
    const c = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM settings`);
    expect(c[0].c).toBe(1);
  });

  it("updates preferences and coerces booleans", async () => {
    const { db } = await makeMemDb();
    const s = await updateSettings(db, { theme: "dark", hide_net_worth: true, portfolio_prices_enabled: true, ui_scale: "large" });
    expect(s.theme).toBe("dark");
    expect(s.hide_net_worth).toBe(1);
    expect(s.portfolio_prices_enabled).toBe(1);
    expect(s.ui_scale).toBe("large");
  });

  it("defaults privacy settings and round-trips hover-reveal + unlock code", async () => {
    const { db } = await makeMemDb();
    const def = await getSettings(db);
    expect(def.privacy_hover_reveal).toBe(1); // hover reveals by default
    expect(def.privacy_unlock_code).toBeNull();
    const s = await updateSettings(db, { privacy_hover_reveal: false, privacy_unlock_code: "1234" });
    expect(s.privacy_hover_reveal).toBe(0);
    expect(s.privacy_unlock_code).toBe("1234");
    // empty string clears the code back to NULL
    expect((await updateSettings(db, { privacy_unlock_code: "" })).privacy_unlock_code).toBeNull();
  });

  it("defaults auto_update_check to OFF and round-trips the toggle", async () => {
    const { db } = await makeMemDb();
    expect((await getSettings(db)).auto_update_check).toBe(0); // off by default (offline-first)
    expect((await updateSettings(db, { auto_update_check: true })).auto_update_check).toBe(1);
    expect((await updateSettings(db, { auto_update_check: false })).auto_update_check).toBe(0);
  });

  it("rejects invalid value domains", async () => {
    const { db } = await makeMemDb();
    await expect(updateSettings(db, { theme: "neon" })).rejects.toBeTruthy();
    await expect(updateSettings(db, { ui_scale: "huge" })).rejects.toBeTruthy();
  });

  it("defaults bottom_nav_size to md, persists a valid size, and rejects bad ones", async () => {
    const { db } = await makeMemDb();
    expect((await getSettings(db)).bottom_nav_size).toBe("md");
    expect((await updateSettings(db, { bottom_nav_size: "sm" })).bottom_nav_size).toBe("sm");
    expect((await updateSettings(db, { bottom_nav_size: "lg" })).bottom_nav_size).toBe("lg");
    await expect(updateSettings(db, { bottom_nav_size: "xl" })).rejects.toBeTruthy();
  });

  it("defaults date_format to dd/mm/yyyy and persists a valid choice", async () => {
    const { db } = await makeMemDb();
    expect((await getSettings(db)).date_format).toBe("dd/mm/yyyy");
    const s = await updateSettings(db, { date_format: "yyyy-mm-dd" });
    expect(s.date_format).toBe("yyyy-mm-dd");
    await expect(updateSettings(db, { date_format: "DD-MM-YY" })).rejects.toBeTruthy();
  });

  it("persists base_currency, accepting a known code", async () => {
    const { db } = await makeMemDb();
    expect((await getSettings(db)).base_currency).toBeNull();
    const s = await updateSettings(db, { base_currency: "GBP" });
    expect(s.base_currency).toBe("GBP");
    expect((await updateSettings(db, { base_currency: "BTC" })).base_currency).toBe("BTC");
  });

  it("clears base_currency to NULL on empty string or null", async () => {
    const { db } = await makeMemDb();
    await updateSettings(db, { base_currency: "USD" });
    expect((await updateSettings(db, { base_currency: "" })).base_currency).toBeNull();
    await updateSettings(db, { base_currency: "USD" });
    expect((await updateSettings(db, { base_currency: null })).base_currency).toBeNull();
  });

  it("rejects an unknown base_currency code", async () => {
    const { db } = await makeMemDb();
    await expect(updateSettings(db, { base_currency: "ZZZ" })).rejects.toBeTruthy();
    await expect(updateSettings(db, { base_currency: "gbp" })).rejects.toBeTruthy();
  });
});

describe("net-worth account selection + release-notes stamp", () => {
  it("defaults to counting every account and round-trips an exclusion", async () => {
    const { db } = await makeMemDb();
    expect((await getSettings(db)).net_worth_excluded_json).toBe("[]");
    const s = await updateSettings(db, { net_worth_excluded_json: JSON.stringify([2, 5]) });
    expect(parseNetWorthExcluded(s.net_worth_excluded_json)).toEqual([2, 5]);
  });

  it("parses defensively: a corrupt or foreign value means 'exclude nothing'", () => {
    expect(parseNetWorthExcluded(null)).toEqual([]);
    expect(parseNetWorthExcluded("")).toEqual([]);
    expect(parseNetWorthExcluded("not json")).toEqual([]);
    expect(parseNetWorthExcluded('{"a":1}')).toEqual([]);
    // Mixed junk keeps only the usable ids rather than throwing the lot away.
    expect(parseNetWorthExcluded('[1,"2",null,3]')).toEqual([1, 3]);
  });

  it("starts with no seen version so a fresh install is stamped, not popped up at", async () => {
    const { db } = await makeMemDb();
    expect((await getSettings(db)).last_seen_version).toBeNull();
    expect((await updateSettings(db, { last_seen_version: "0.2.0" })).last_seen_version).toBe("0.2.0");
  });
});

describe("hasUserData (fresh install vs upgrade)", () => {
  it("is false on an empty profile and true once an account exists", async () => {
    const { db } = await makeMemDb();
    expect(await hasUserData(db)).toBe(false);
    await db.execute(
      `INSERT INTO sources (name,currency,starting_balance,exclude_from_stats,is_savings_fund,hidden_from_sources,yield_rate,yield_period_months,created_at,updated_at)
       VALUES ('A','EUR',0,0,0,0,0,12,'t','t')`,
    );
    expect(await hasUserData(db)).toBe(true);
  });
});

describe("new-profile language inheritance", () => {
  it("seeds a fresh profile with the language the user is working in", async () => {
    const { db } = await makeMemDb();
    expect((await getSettings(db, { locale: "it" })).locale).toBe("it");
  });

  it("accepts a regional tag through its base language", async () => {
    const { db } = await makeMemDb();
    expect((await getSettings(db, { locale: "es-MX" })).locale).toBe("es");
  });

  it("falls back to English for an unknown or missing language", async () => {
    const { db: a } = await makeMemDb();
    expect((await getSettings(a, { locale: "klingon" })).locale).toBe("en");
    const { db: b } = await makeMemDb();
    expect((await getSettings(b)).locale).toBe("en");
  });

  it("never overwrites the language of a profile that already has one", async () => {
    const { db } = await makeMemDb();
    await getSettings(db, { locale: "it" });
    // A later read in another language must not flip the stored preference.
    expect((await getSettings(db, { locale: "uk" })).locale).toBe("it");
  });
});
