import { describe, it, expect } from "vitest";
import {
  DEFAULT_NAV_ITEMS,
  footerFromLayout,
  mobileNavFromLayout,
  navGroupsFromLayout,
  resolveNavLayout,
} from "./nav";

describe("nav layout — resolveNavLayout", () => {
  it("returns all defaults visible when the layout is empty", () => {
    const r = resolveNavLayout("[]");
    expect(r.map((i) => i.id)).toEqual(DEFAULT_NAV_ITEMS.map((i) => i.id));
    expect(r.every((i) => i.visible)).toBe(true);
  });

  it("tolerates malformed JSON (falls back to defaults)", () => {
    const r = resolveNavLayout("{not json");
    expect(r.map((i) => i.id)).toEqual(DEFAULT_NAV_ITEMS.map((i) => i.id));
  });

  it("tolerates null/undefined", () => {
    expect(resolveNavLayout(null).length).toBe(DEFAULT_NAV_ITEMS.length);
    expect(resolveNavLayout(undefined).length).toBe(DEFAULT_NAV_ITEMS.length);
  });

  it("applies the saved order and visibility", () => {
    const layout = JSON.stringify([
      { id: "settings", visible: true },
      { id: "dashboard", visible: false },
      { id: "sources", visible: true },
    ]);
    const r = resolveNavLayout(layout);
    // saved items come first, in saved order…
    expect(r.slice(0, 3).map((i) => i.id)).toEqual(["settings", "dashboard", "sources"]);
    expect(r.find((i) => i.id === "dashboard")!.visible).toBe(false);
    expect(r.find((i) => i.id === "sources")!.visible).toBe(true);
    // …and every default still appears exactly once
    expect(new Set(r.map((i) => i.id)).size).toBe(DEFAULT_NAV_ITEMS.length);
    expect(r.length).toBe(DEFAULT_NAV_ITEMS.length);
  });

  it("anchors a default not mentioned in the layout next to its predecessor (upgrade-safe)", () => {
    // Saved layout omits "movements" (a default). It sits after "sources" in the
    // defaults, so it must re-appear right after sources, not at the very end.
    const saved = DEFAULT_NAV_ITEMS.filter((d) => d.id !== "movements").map((d) => ({
      id: d.id,
      visible: true,
    }));
    const r = resolveNavLayout(JSON.stringify(saved));
    const ids = r.map((i) => i.id);
    expect(ids).toContain("movements");
    expect(ids.indexOf("movements")).toBe(ids.indexOf("sources") + 1);
  });

  it("ignores unknown and duplicate ids in the saved layout", () => {
    const layout = JSON.stringify([
      { id: "dashboard", visible: true },
      { id: "dashboard", visible: false }, // dup ignored
      { id: "ghost", visible: true }, // unknown ignored
    ]);
    const r = resolveNavLayout(layout);
    expect(r.filter((i) => i.id === "dashboard")).toHaveLength(1);
    expect(r.find((i) => i.id === "dashboard")!.visible).toBe(true);
    expect(r.find((i) => i.id === "ghost")).toBeUndefined();
    expect(r.length).toBe(DEFAULT_NAV_ITEMS.length);
  });

  it("treats a missing `visible` flag as visible", () => {
    const r = resolveNavLayout(JSON.stringify([{ id: "dashboard" }]));
    expect(r.find((i) => i.id === "dashboard")!.visible).toBe(true);
  });
});

describe("nav layout — derived views", () => {
  it("navGroupsFromLayout drops hidden items and footer-pinned items, grouped by section", () => {
    const resolved = resolveNavLayout(
      JSON.stringify([
        { id: "dashboard", visible: false },
        { id: "sources", visible: true },
      ]),
    );
    const groups = navGroupsFromLayout(resolved);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).not.toContain("dashboard"); // hidden
    expect(ids).not.toContain("settings"); // footer-pinned
    expect(ids).not.toContain("notifications"); // footer-pinned
    expect(ids).toContain("sources");
    // overview group with only a hidden dashboard disappears entirely
    expect(groups.find((g) => g.key === "overview")).toBeUndefined();
  });

  it("footerFromLayout returns the visible footer items in resolved order", () => {
    const resolved = resolveNavLayout(JSON.stringify([{ id: "notifications", visible: false }]));
    const footer = footerFromLayout(resolved);
    expect(footer.map((i) => i.id)).toEqual(["settings"]); // notifications hidden
  });

  it("mobileNavFromLayout caps to the limit and respects visibility/order", () => {
    const resolved = resolveNavLayout("[]");
    const mobile = mobileNavFromLayout(resolved, 5);
    expect(mobile).toHaveLength(5);
    expect(mobile[0].id).toBe("dashboard");
  });
});
