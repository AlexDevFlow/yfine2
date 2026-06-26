import { describe, it, expect } from "vitest";
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
