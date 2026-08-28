import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { helpCandidates, pageKeyForPath, resolveHelp } from "./help-resolver";

describe("help resolver — page key mapping", () => {
  it("maps the index route to dashboard", () => {
    expect(pageKeyForPath("/")).toBe("dashboard");
    expect(pageKeyForPath("")).toBe("dashboard");
  });
  it("uses the first path segment as the page key", () => {
    expect(pageKeyForPath("/sources")).toBe("sources");
    expect(pageKeyForPath("/movements")).toBe("movements");
    expect(pageKeyForPath("/settings")).toBe("settings");
  });
  it("collapses detail routes to their section key", () => {
    expect(pageKeyForPath("/sources/12")).toBe("sources");
    expect(pageKeyForPath("/portfolios/7/holdings")).toBe("portfolios");
  });
  it("strips trailing slashes", () => {
    expect(pageKeyForPath("/tags/")).toBe("tags");
  });
  it("maps routes without dedicated help (goals) to their own key (cascades to default)", () => {
    // /goals has no help file → key is "goals"; the content cascade falls to default.
    expect(pageKeyForPath("/goals")).toBe("goals");
  });
});

describe("help resolver — candidate cascade", () => {
  it("English: page then default, no locale variants", () => {
    expect(helpCandidates("dashboard", "en")).toEqual([
      "dashboard.html",
      "default.html",
    ]);
  });
  it("localized: page.locale → page → default.locale → default", () => {
    expect(helpCandidates("dashboard", "it")).toEqual([
      "dashboard.it.html",
      "dashboard.html",
      "default.it.html",
      "default.html",
    ]);
  });
  it("normalizes region/case (it-IT → it)", () => {
    expect(helpCandidates("sources", "IT-it")).toEqual([
      "sources.it.html",
      "sources.html",
      "default.it.html",
      "default.html",
    ]);
  });
  it("unknown locale falls back to English-only chain", () => {
    expect(helpCandidates("sources", "de")).toEqual([
      "sources.html",
      "default.html",
    ]);
  });
});

describe("help resolver — content resolution", () => {
  const content = {
    "dashboard.html": "<h5>EN dashboard</h5>",
    "dashboard.it.html": "<h5>IT dashboard</h5>",
    "sources.html": "<h5>EN sources</h5>",
    "default.html": "<h5>EN default</h5>",
    "default.it.html": "<h5>IT default</h5>",
  };

  it("prefers the localized page file", () => {
    expect(resolveHelp(content, "dashboard", "it")).toEqual({
      key: "dashboard.it.html",
      html: "<h5>IT dashboard</h5>",
    });
  });
  it("falls back to the English page file when the locale variant is missing", () => {
    // sources has no .it.html → English page file
    expect(resolveHelp(content, "sources", "it")).toEqual({
      key: "sources.html",
      html: "<h5>EN sources</h5>",
    });
  });
  it("falls back to localized default for a page with no help at all", () => {
    expect(resolveHelp(content, "goals", "it")).toEqual({
      key: "default.it.html",
      html: "<h5>IT default</h5>",
    });
  });
  it("falls back to English default as the last resort", () => {
    expect(resolveHelp(content, "goals", "de")).toEqual({
      key: "default.html",
      html: "<h5>EN default</h5>",
    });
  });
  it("returns null only when even default.html is absent", () => {
    expect(resolveHelp({}, "anything", "en")).toBeNull();
  });
  it("skips empty-string entries in the cascade", () => {
    const withEmpty = { "dashboard.html": "", "default.html": "<h5>def</h5>" };
    expect(resolveHelp(withEmpty, "dashboard", "en")).toEqual({
      key: "default.html",
      html: "<h5>def</h5>",
    });
  });
});

/**
 * Help-content integrity. The drawer is written as product documentation, so
 * stale help is worse than none — and nothing else in the toolchain reads these
 * files. Two failure modes are cheap to catch: a locale left behind when a page
 * is updated, and text describing a feature that no longer exists.
 */
describe("bundled help content", () => {
  const dir = new URL("../../help-content/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".html"));
  const pageOf = (f: string) => f.replace(/\.(it|es|uk)\.html$/, "").replace(/\.html$/, "");
  const pages = [...new Set(files.map(pageOf))];
  const read = (f: string) => readFileSync(new URL(f, dir), "utf8");

  it("ships every page in all four languages", () => {
    for (const page of pages) {
      for (const suffix of ["", ".it", ".es", ".uk"]) {
        expect(files, `${page}${suffix}.html missing`).toContain(`${page}${suffix}.html`);
      }
    }
  });

  it("keeps the localized versions structurally in step with English", () => {
    // A section added to one language and forgotten in the others shows up here
    // as a differing <h6> count.
    for (const page of pages) {
      const base = (read(`${page}.html`).match(/<h6>/g) ?? []).length;
      for (const suffix of [".it", ".es", ".uk"]) {
        const n = (read(`${page}${suffix}.html`).match(/<h6>/g) ?? []).length;
        expect(n, `${page}${suffix}.html has ${n} sections vs ${base} in English`).toBe(base);
      }
    }
  });

  it("does not document features this app doesn't have", () => {
    // Inherited from the Flask original: plugin uploads and LAN serving don't
    // exist in the desktop build.
    for (const f of files) {
      const html = read(f);
      for (const gone of ["yn-help-action-label\">Plugins", "LAN access", "server port"]) {
        expect(html.includes(gone), `${f} still mentions "${gone}"`).toBe(false);
      }
    }
  });
});
