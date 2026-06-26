import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * i18n integrity guard. These bugs all shipped at least once this project and
 * are invisible to typecheck/runtime — they only surface as a missing word or a
 * literal "{{count}}" in the UI. The checks below make them CI failures instead:
 *
 *  1. every locale is valid JSON with no duplicate keys
 *  2. all locales expose exactly the same key set (no missing/orphan translation)
 *  3. a given key uses the SAME {{placeholders}} in every locale
 *  4. each `t("key", { defaultValue })` in the source uses placeholders that match
 *     the locale value for that key (the n_items / days_left / over_by class)
 */
const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "locales");
const srcDir = join(here, "..");
const LOCALES = ["en", "it", "es", "uk"] as const;

function rawLocale(loc: string): string {
  return readFileSync(join(localesDir, `${loc}.json`), "utf8");
}
function keyList(raw: string): string[] {
  return [...raw.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
}
function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
}
function eqSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

const parsed = Object.fromEntries(
  LOCALES.map((loc) => [loc, JSON.parse(rawLocale(loc)) as Record<string, string>]),
) as Record<string, Record<string, string>>;

describe("i18n locale files", () => {
  it.each(LOCALES)("%s is valid JSON with no duplicate keys", (loc) => {
    const keys = keyList(rawLocale(loc));
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dups, `duplicate keys in ${loc}.json`).toEqual([]);
  });

  it("all locales have exactly the same key set as English", () => {
    const en = new Set(Object.keys(parsed.en));
    for (const loc of LOCALES) {
      if (loc === "en") continue;
      const cur = new Set(Object.keys(parsed[loc]));
      const missing = [...en].filter((k) => !cur.has(k));
      const extra = [...cur].filter((k) => !en.has(k));
      expect(missing, `${loc}.json is MISSING keys`).toEqual([]);
      expect(extra, `${loc}.json has EXTRA keys not in en.json`).toEqual([]);
    }
  });

  it("a key uses the same {{placeholders}} across every locale", () => {
    const problems: string[] = [];
    for (const key of Object.keys(parsed.en)) {
      const ref = placeholders(parsed.en[key]);
      for (const loc of LOCALES) {
        if (loc === "en") continue;
        const val = parsed[loc][key];
        if (val == null) continue; // covered by the parity test
        if (!eqSet(ref, placeholders(val))) {
          problems.push(`${loc}.${key}: en[${[...ref]}] vs ${loc}[${[...placeholders(val)]}]`);
        }
      }
    }
    expect(problems, "placeholder mismatch between locales").toEqual([]);
  });
});

/** Recursively collect every .ts/.tsx source file (excluding tests + the locales). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "locales" || entry === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("i18n usage in source", () => {
  it("every t() defaultValue uses placeholders matching its locale value", () => {
    // Capture: t("key", { defaultValue: "....", ... })
    const re = /\bt\(\s*"([a-z0-9_]+)"\s*,\s*\{\s*defaultValue:\s*"((?:[^"\\]|\\.)*)"/g;
    const problems: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const [, key, def] = m;
        const localeVal = parsed.en[key];
        if (localeVal == null) continue; // default-only key, fine
        if (!eqSet(placeholders(def), placeholders(localeVal))) {
          problems.push(
            `${file.replace(srcDir, "")} → t("${key}"): default[${[...placeholders(def)]}] vs en.json[${[...placeholders(localeVal)]}]`,
          );
        }
      }
    }
    expect(problems, "code defaultValue placeholders disagree with en.json").toEqual([]);
  });
});
