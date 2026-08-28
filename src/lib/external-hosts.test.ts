/**
 * Guards the two allow-lists that silently break external content when they
 * fall out of sync with the code:
 *
 *  1. `src-tauri/capabilities/default.json` — the Tauri http plugin refuses any
 *     URL it doesn't list. A refused fetch lands in the same `catch` as an
 *     outage, so a missing host looks exactly like "the provider is down".
 *  2. the CSP in `src-tauri/tauri.conf.json` — `frame-src` has no default of its
 *     own, so it falls back to `default-src 'self'` and every external iframe is
 *     blocked with nothing but a console message. That is how the TradingView
 *     chart shipped broken.
 *
 * Both files are outside TypeScript's reach, so nothing else catches this.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

/** Origins a source file talks to, taken from its https:// literals. */
function originsIn(rel: string): string[] {
  const found = [...read(rel).matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((m) => m[0].toLowerCase());
  return [...new Set(found)];
}

function allowedHttpOrigins(): string[] {
  const caps = JSON.parse(read("src-tauri/capabilities/default.json")) as {
    permissions: (string | { identifier: string; allow?: { url: string }[] })[];
  };
  const http = caps.permissions.find(
    (p): p is { identifier: string; allow?: { url: string }[] } =>
      typeof p === "object" && p.identifier === "http:default",
  );
  return (http?.allow ?? []).map((a) => a.url.replace(/\/\*$/, "").toLowerCase());
}

function cspDirective(name: string): string[] {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as { app: { security: { csp: string } } };
  const directive = conf.app.security.csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
  return directive ? directive.split(/\s+/).slice(1) : [];
}

describe("Tauri http allow-list", () => {
  it("covers every host the price and FX fetchers call", () => {
    const used = [...new Set([...originsIn("src/db/repo/prices.ts"), ...originsIn("src/db/repo/fx.ts")])];
    expect(used.length).toBeGreaterThan(0); // the scan itself must not silently find nothing
    const allowed = allowedHttpOrigins();
    for (const origin of used) {
      expect(allowed, `${origin} is fetched but not allow-listed`).toContain(origin);
    }
  });

  it("still allows the providers those modules depend on", () => {
    const allowed = allowedHttpOrigins();
    expect(allowed).toContain("https://api.coingecko.com");
    expect(allowed).toContain("https://api.frankfurter.dev");
  });
});

describe("CSP", () => {
  it("allows the TradingView chart to be framed", () => {
    const embedded = originsIn("src/pages/portfolios.tsx").filter((o) => o.includes("tradingview"));
    expect(embedded.length, "no TradingView embed found — update this test").toBeGreaterThan(0);
    const frameSrc = cspDirective("frame-src");
    for (const origin of embedded) {
      expect(frameSrc, `${origin} is framed but frame-src doesn't allow it`).toContain(origin);
    }
  });

  it("keeps the app itself locked down", () => {
    // frame-src widening must not have loosened what the app can load or run.
    expect(cspDirective("default-src")).toEqual(["'self'"]);
    expect(cspDirective("script-src")).toEqual(["'self'"]);
    expect(cspDirective("object-src")).toEqual(["blob:"]);
  });
});
