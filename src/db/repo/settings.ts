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
  /** JSON array of source ids left OUT of the net-worth total (and their portfolios). */
  net_worth_excluded_json: string;
  /** App version whose release notes were last shown (null = never shown). */
  last_seen_version: string | null;
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

/** Languages a fresh profile may be seeded with (mirrors i18n's SUPPORTED_LANGS;
 *  duplicated here so the repo layer doesn't import the initialized translator). */
const SEEDABLE_LOCALES = ["en", "it", "es", "uk"];

export interface SettingsDefaults {
  /** UI language to seed a BRAND-NEW settings row with. Ignored once the row exists. */
  locale?: string | null;
}

/**
 * The singleton preferences row, created on first read.
 *
 * `defaults.locale` matters for a new profile: each profile has its own database
 * and therefore its own settings row, and boot primes the translator FROM that
 * row — so seeding 'en' would silently flip a user who works in Italian back to
 * English the moment they create a profile. The caller that knows the current UI
 * language (the connection bootstrap) passes it in.
 */
export async function getSettings(db: SqlExecutor, defaults: SettingsDefaults = {}): Promise<SettingsRow> {
  const ts = now();
  const seedLocale = (() => {
    const raw = (defaults.locale ?? "").trim().toLowerCase();
    const base = raw.split("-")[0];
    return SEEDABLE_LOCALES.includes(raw) ? raw : SEEDABLE_LOCALES.includes(base) ? base : "en";
  })();
  await db.execute(
    `INSERT OR IGNORE INTO settings
      (id,locale,date_format,base_currency,theme,hide_net_worth,last_source_id,mobile_nav_mode,bottom_nav_size,ui_scale,hotkeys_enabled,hotkeys_json,nav_layout_json,bottom_nav_json,lan_access,portfolio_prices_enabled,portfolio_prices_prompted,portfolio_charts_enabled,privacy_hover_reveal,privacy_unlock_code,auto_update_check,saved_views_json,movement_templates_json,net_worth_excluded_json,last_seen_version,created_at,updated_at)
     VALUES (1,?,'dd/mm/yyyy',NULL,'light',0,NULL,'sidebar','md','normal',1,'{}','[]','[]',0,0,0,0,1,NULL,0,'[]','[]','[]',NULL,?,?)`,
    [seedLocale, ts, ts],
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
  net_worth_excluded_json?: string;
  last_seen_version?: string | null;
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

/** Source ids the user left out of the net-worth total. Tolerates a corrupt value. */
export function parseNetWorthExcluded(json: string | null | undefined): number[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/** True when this profile already holds data — i.e. it's an upgrade rather than
 *  a fresh install. Used to decide whether release notes are worth showing. */
export async function hasUserData(db: SqlExecutor): Promise<boolean> {
  const rows = await db.select<{ c: number }>(
    `SELECT (SELECT COUNT(*) FROM sources) + (SELECT COUNT(*) FROM movements) AS c`,
  );
  return (rows[0]?.c ?? 0) > 0;
}
