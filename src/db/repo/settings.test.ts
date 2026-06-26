import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { getSettings, updateSettings } from "./settings";

describe("settings repo", () => {
  it("lazily creates the singleton row with defaults", async () => {
    const { db } = await makeMemDb();
    const s = await getSettings(db);
    expect(s.id).toBe(1);
    expect(s.locale).toBe("en");
    expect(s.theme).toBe("light");
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
