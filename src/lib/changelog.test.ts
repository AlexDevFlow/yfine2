/**
 * Release-notes tests. The popup only fires when an entry's `version` matches
 * the app version EXACTLY, and the entry is rendered straight into the UI — so
 * these guard the two ways a release note can silently fail: a version typo
 * (nothing is ever shown) and a missing translation (a blank line in the modal).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CHANGELOG, LATEST_CHANGELOG, changelogFor, pick, releaseNotesAction } from "./changelog";

const SUPPORTED = ["en", "it", "es", "uk"];

describe("pick", () => {
  it("returns the requested language, falling back to English", () => {
    const text = { en: "Hello", it: "Ciao" };
    expect(pick(text, "it")).toBe("Ciao");
    expect(pick(text, "es")).toBe("Hello"); // untranslated → English, never blank
    expect(pick(text, undefined)).toBe("Hello");
  });

  it("resolves a regional tag through its base language", () => {
    expect(pick({ en: "Hello", it: "Ciao" }, "it-CH")).toBe("Ciao");
  });
});

describe("changelogFor", () => {
  it("matches a version exactly and returns nothing for an unknown one", () => {
    expect(changelogFor("0.2.0")?.version).toBe("0.2.0");
    expect(changelogFor("0.2")).toBeUndefined();
    expect(changelogFor("9.9.9")).toBeUndefined();
  });
});

describe("changelog integrity", () => {
  it("is ordered newest-first with unique semver versions", () => {
    const versions = CHANGELOG.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const v of versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    const rank = (v: string) => v.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);
    for (let i = 1; i < versions.length; i++) {
      expect(rank(versions[i - 1])).toBeGreaterThan(rank(versions[i]));
    }
    expect(LATEST_CHANGELOG?.version).toBe(versions[0]);
  });

  it("has an entry for the version the app actually ships", () => {
    // A note whose version doesn't match package.json would never be shown.
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const tauri = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    expect(tauri.version).toBe(pkg.version);
    expect(changelogFor(pkg.version), `no changelog entry for ${pkg.version}`).toBeDefined();
  });

  it("every entry has a valid date and at least one item", () => {
    for (const e of CHANGELOG) {
      expect(e.date, e.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.items.length, e.version).toBeGreaterThan(0);
    }
  });

  it("every string is translated into all supported languages", () => {
    for (const e of CHANGELOG) {
      const texts = [
        ...(e.headline ? [["headline", e.headline] as const] : []),
        ...e.items.flatMap((i, n) => [
          [`item ${n} title`, i.title] as const,
          ...(i.body ? [[`item ${n} body`, i.body] as const] : []),
        ]),
      ];
      for (const [label, text] of texts) {
        for (const lang of SUPPORTED) {
          const value = text[lang];
          expect(value, `${e.version} ${label} missing ${lang}`).toBeTruthy();
          expect(value!.trim().length, `${e.version} ${label} empty ${lang}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("uses only kinds the modal knows how to render", () => {
    for (const e of CHANGELOG) {
      for (const item of e.items) {
        expect(["new", "improved", "fixed"]).toContain(item.kind);
      }
    }
  });
});

describe("releaseNotesAction", () => {
  const base = { version: "0.2.0", hasEntry: true, hasData: true };

  it("shows the notes once after an upgrade, then never again", () => {
    expect(releaseNotesAction({ ...base, seen: "0.1.0" })).toBe("show");
    expect(releaseNotesAction({ ...base, seen: "0.2.0" })).toBe("skip");
  });

  it("stamps a brand-new install instead of popping notes at it", () => {
    expect(releaseNotesAction({ ...base, seen: null, hasData: false })).toBe("stamp");
  });

  it("treats an existing profile with no recorded version as an upgrade", () => {
    // The release that introduces this mechanism would otherwise be the one
    // release whose notes nobody ever sees.
    expect(releaseNotesAction({ ...base, seen: null, hasData: true })).toBe("show");
  });

  it("stamps silently for a version that shipped no notes", () => {
    expect(releaseNotesAction({ ...base, seen: "0.1.0", hasEntry: false })).toBe("stamp");
  });

  it("does nothing outside the desktop app, where there is no version", () => {
    expect(releaseNotesAction({ ...base, version: "", seen: null })).toBe("skip");
  });
});
