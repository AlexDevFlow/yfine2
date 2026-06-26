/**
 * Per-page contextual help resolver.
 *
 * Faithful port of base.html's Jinja include-cascade:
 *   {% include ['help/PAGE.LOCALE.html', 'help/PAGE.html', 'help/default.html'] %}
 *
 * The bundled help HTML lives under src/help-content/ as `<page>.<locale>.html`
 * (English has no locale suffix: `<page>.html`). Files are app-authored and
 * trusted, so the drawer renders them via dangerouslySetInnerHTML.
 *
 * The resolution chain for an (page, locale) pair is, in order:
 *   1. PAGE.LOCALE.html   (e.g. dashboard.it.html)
 *   2. PAGE.html          (English default for that page)
 *   3. default.LOCALE.html (welcome/overview in the active locale)
 *   4. default.html        (English welcome/overview)
 *
 * The (page, locale) → file-key resolution is split out as a pure function so
 * it can be unit-tested without the Vite glob bundle.
 */

/** Locales that ship a localized help variant. English is the keyless base. */
export const HELP_LOCALES = ["it", "es", "uk"] as const;
export type HelpLocale = (typeof HELP_LOCALES)[number];

/**
 * Map a yfine2 route pathname → help page key. The original keys its help on
 * Flask's `active_page`; here we derive it from the TanStack route. Pages with
 * no dedicated help file (e.g. /goals, or a /sources/$id detail) cascade to the
 * shared `default` page.
 */
export function pageKeyForPath(pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return "dashboard";
  // first path segment, e.g. "/sources/12" → "sources", "/movements" → "movements"
  const seg = p.split("/")[1] ?? "";
  // Only these pages ship help content; everything else falls back to `default`
  // via the resolution chain below (an unknown key resolves to default).
  return seg || "default";
}

/**
 * Build the ordered list of candidate file keys for a (page, locale) pair.
 * Keys are bare basenames like "dashboard.it.html" / "dashboard.html". The
 * caller looks each up in the bundled content map and renders the first hit.
 */
export function helpCandidates(page: string, locale: string): string[] {
  const lc = (locale || "en").toLowerCase().split("-")[0];
  const candidates: string[] = [];
  const isLocalized = (HELP_LOCALES as readonly string[]).includes(lc);
  // 1) page in active locale
  if (isLocalized) candidates.push(`${page}.${lc}.html`);
  // 2) page in English (no suffix)
  candidates.push(`${page}.html`);
  // 3) default in active locale
  if (isLocalized) candidates.push(`default.${lc}.html`);
  // 4) default in English
  candidates.push(`default.html`);
  return candidates;
}

/**
 * Resolve the first available help content for (page, locale) from a content
 * map keyed by bare basename. Returns the matched key + html, or null if even
 * `default.html` is missing (shouldn't happen — it's always bundled).
 */
export function resolveHelp(
  content: Record<string, string>,
  page: string,
  locale: string,
): { key: string; html: string } | null {
  for (const key of helpCandidates(page, locale)) {
    const html = content[key];
    if (typeof html === "string" && html.length > 0) return { key, html };
  }
  return null;
}
