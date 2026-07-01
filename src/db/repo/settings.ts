/**
 * Settings: the singleton preferences row (id=1), lazily created. Matches the
 * legacy `settings` table exactly (refactor-analysis/settings-i18n.md). Server-side
 * value-domain validation (a gap the old app lacked) keeps bad values out.
 */
import type { SqlExecutor } from "../types";
import { BASE_CURRENCY_CODES } from "@/lib/format";

export type Theme = "light" | "dark" | "system";
export type UiScale = "small" | "normal" | "large" | "xlarge";

export interface SettingsRow {
  id: number;
  locale: string;
  date_format: string;
  base_currency: string | null;
  theme: string;
  hide_net_worth: number;
  last_source_id: number | null;
  mobile_nav_mode: string;
  bottom_nav_size: string;
  ui_scale: string;
  hotkeys_enabled: number;
  hotkeys_json: string;
  nav_layout_json: string;
  /** Ordered ids of the pages shown directly on the bottom bar; the rest go to "More". */
  bottom_nav_json: string;
  lan_access: number;
  portfolio_prices_enabled: number;
  portfolio_prices_prompted: number;
  /** Opt-in (default OFF): show embedded TradingView charts for holdings (loads external content). */
  portfolio_charts_enabled: number;
  /** Privacy mode: when 1, hovering a blurred amount reveals it; when 0, hover never reveals. */
  privacy_hover_reveal: number;
  /** Optional code required to turn privacy mode OFF (reveal). null/empty = no code. */
  privacy_unlock_code: string | null;
  /** Opt-in (default OFF): on launch, check GitHub releases for a newer version. Manual check always available. */
  auto_update_check: number;
  saved_views_json: string;
  movement_templates_json: string;
  /** UTC ISO timestamp of the last successful auto/manual price refresh (null = never). */
  last_price_refresh_at: string | null;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

const VALID = {
  theme: ["light", "dark", "system"],
  date_format: ["dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd"],
  ui_scale: ["small", "normal", "large", "xlarge"],
  mobile_nav_mode: ["sidebar", "bottom"],
  bottom_nav_size: ["sm", "md", "lg"],
};

export async function getSettings(db: SqlExecutor): Promise<SettingsRow> {
  const ts = now();
  await db.execute(
    `INSERT OR IGNORE INTO settings
      (id,locale,date_format,base_currency,theme,hide_net_worth,last_source_id,mobile_nav_mode,bottom_nav_size,ui_scale,hotkeys_enabled,hotkeys_json,nav_layout_json,bottom_nav_json,lan_access,portfolio_prices_enabled,portfolio_prices_prompted,portfolio_charts_enabled,privacy_hover_reveal,privacy_unlock_code,auto_update_check,saved_views_json,movement_templates_json,created_at,updated_at)
     VALUES (1,'en','dd/mm/yyyy',NULL,'light',0,NULL,'sidebar','md','normal',1,'{}','[]','[]',0,0,0,0,1,NULL,0,'[]','[]',?,?)`,
    [ts, ts],
  );
  return (await db.select<SettingsRow>(`SELECT * FROM settings WHERE id = 1`))[0];
}

export interface SettingsPatch {
  locale?: string;
  date_format?: string;
  base_currency?: string | null;
  theme?: string;
  hide_net_worth?: boolean;
  last_source_id?: number | null;
  mobile_nav_mode?: string;
  bottom_nav_size?: string;
  ui_scale?: string;
  hotkeys_enabled?: boolean;
  lan_access?: boolean;
  portfolio_prices_enabled?: boolean;
  portfolio_prices_prompted?: boolean;
  portfolio_charts_enabled?: boolean;
  privacy_hover_reveal?: boolean;
  privacy_unlock_code?: string | null;
  auto_update_check?: boolean;
  saved_views_json?: string;
  movement_templates_json?: string;
  nav_layout_json?: string;
  bottom_nav_json?: string;
  hotkeys_json?: string;
}

function validate(patch: SettingsPatch): void {
  for (const [k, allowed] of Object.entries(VALID)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v !== undefined && !allowed.includes(v as string)) {
      throw new Error(`invalid ${k}: ${String(v)}`);
    }
  }
  // base_currency is nullable: "" / null clears it; any value must be a known code.
  if (patch.base_currency !== undefined && patch.base_currency !== null && patch.base_currency !== "") {
    if (!BASE_CURRENCY_CODES.includes(patch.base_currency)) {
      throw new Error(`invalid base_currency: ${patch.base_currency}`);
    }
  }
}

export async function updateSettings(db: SqlExecutor, patch: SettingsPatch): Promise<SettingsRow> {
  validate(patch);
  await getSettings(db); // ensure the row exists
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (c: string, v: unknown) => (sets.push(`${c} = ?`), params.push(v));
  const bools = new Set(["hide_net_worth", "hotkeys_enabled", "lan_access", "portfolio_prices_enabled", "portfolio_prices_prompted", "portfolio_charts_enabled", "privacy_hover_reveal", "auto_update_check"]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // Empty base_currency means "no default" → store NULL (matches the original's empty <option>).
    if (k === "base_currency" && v === "") { set(k, null); continue; }
    // Empty unlock code clears it (no code required to reveal).
    if (k === "privacy_unlock_code" && v === "") { set(k, null); continue; }
    set(k, bools.has(k) ? (v ? 1 : 0) : v);
  }
  if (sets.length) {
    set("updated_at", now());
    await db.execute(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`, params);
  }
  return (await db.select<SettingsRow>(`SELECT * FROM settings WHERE id = 1`))[0];
}

/**
 * Last successful price-refresh timestamp (UTC ISO), or null if never refreshed.
 * Used to throttle the boot/interval auto-refresh so we never hit CoinGecko/Yahoo
 * more than once per cache window. Kept separate from updateSettings so a refresh
 * bookkeeping write never bumps `updated_at` or invalidates user-pref views.
 */
export async function getLastPriceRefreshAt(db: SqlExecutor): Promise<string | null> {
  await getSettings(db); // ensure the row exists
  const r = await db.select<{ last_price_refresh_at: string | null }>(
    `SELECT last_price_refresh_at FROM settings WHERE id = 1`,
  );
  return r[0]?.last_price_refresh_at ?? null;
}

export async function setLastPriceRefreshAt(db: SqlExecutor, when: string = now()): Promise<void> {
  await getSettings(db); // ensure the row exists
  await db.execute(`UPDATE settings SET last_price_refresh_at = ? WHERE id = 1`, [when]);
}
