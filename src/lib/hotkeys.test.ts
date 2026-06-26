import { describe, it, expect } from "vitest";
import {
  HOTKEY_ACTIONS,
  isPassthroughCombo,
  isTypingTarget,
  matchKey,
  normalizeKey,
  parseOverrides,
  pruneOverrides,
  resolveBindings,
} from "./hotkeys";

describe("hotkeys — action table", () => {
  it("ships the 14 documented actions with their default bindings", () => {
    expect(HOTKEY_ACTIONS).toHaveLength(14);
    const byId = Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a.id, a.def]));
    expect(byId.nav_dashboard).toBe("g d");
    expect(byId.nav_sources).toBe("g s");
    expect(byId.nav_portfolios).toBe("g p");
    expect(byId.nav_movements).toBe("g m");
    expect(byId.nav_tags).toBe("g t");
    expect(byId.nav_recurring).toBe("g r");
    expect(byId.nav_savings).toBe("g v");
    expect(byId.nav_whims).toBe("g w");
    expect(byId.nav_notifications).toBe("g n");
    expect(byId.nav_settings).toBe("g ,");
    expect(byId.new_movement).toBe("c m");
    expect(byId.new_recurring).toBe("c r");
    expect(byId.focus_search).toBe("/");
    expect(byId.toggle_theme).toBe("Alt+t");
  });
});

describe("hotkeys — normalizeKey", () => {
  it("lowercases a bare letter", () => {
    expect(normalizeKey({ key: "G" })).toBe("g");
    expect(normalizeKey({ key: "d" })).toBe("d");
  });
  it("keeps single non-letter keys verbatim", () => {
    expect(normalizeKey({ key: "/" })).toBe("/");
    expect(normalizeKey({ key: "," })).toBe(",");
  });
  it("builds Alt+t", () => {
    expect(normalizeKey({ key: "t", altKey: true })).toBe("Alt+t");
  });
  it("builds Ctrl+Shift+k for a printable shifted letter", () => {
    expect(normalizeKey({ key: "K", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+k");
  });
  it("adds Shift for non-printable keys (Shift+Enter)", () => {
    expect(normalizeKey({ key: "Enter", shiftKey: true })).toBe("Shift+Enter");
  });
  it("orders modifiers Ctrl,Alt,Shift,Meta", () => {
    expect(normalizeKey({ key: "p", ctrlKey: true, altKey: true, metaKey: true })).toBe("Ctrl+Alt+Meta+p");
  });
});

describe("hotkeys — override resolution", () => {
  it("defaults when there are no overrides", () => {
    const b = resolveBindings({});
    expect(b.nav_dashboard).toBe("g d");
    expect(b.toggle_theme).toBe("Alt+t");
  });
  it("an override replaces the default", () => {
    const b = resolveBindings({ nav_dashboard: "g h" });
    expect(b.nav_dashboard).toBe("g h");
  });
  it("an empty-string override disables the action", () => {
    const b = resolveBindings({ focus_search: "" });
    expect(b.focus_search).toBe("");
  });
  it("ignores unknown override keys", () => {
    const b = resolveBindings({ not_an_action: "g z" });
    expect(b).not.toHaveProperty("not_an_action");
  });
  it("parseOverrides tolerates malformed / non-object JSON", () => {
    expect(parseOverrides("{not json")).toEqual({});
    expect(parseOverrides("[1,2]")).toEqual({});
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides('{"nav_tags":"g x"}')).toEqual({ nav_tags: "g x" });
  });
  it("pruneOverrides keeps only deltas from defaults", () => {
    const all = Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a.id, a.def]));
    expect(pruneOverrides(all)).toEqual({});
    expect(pruneOverrides({ ...all, nav_tags: "g x", focus_search: "" })).toEqual({
      nav_tags: "g x",
      focus_search: "",
    });
  });
});

describe("hotkeys — matchKey", () => {
  const bindings = resolveBindings({});

  it("fires a single-key action directly", () => {
    expect(matchKey("/", bindings, null)).toEqual({ type: "action", id: "focus_search" });
  });
  it("fires a modifier+key action directly", () => {
    expect(matchKey("Alt+t", bindings, null)).toEqual({ type: "action", id: "toggle_theme" });
  });
  it("treats the first key of a chord as a pending prefix", () => {
    expect(matchKey("g", bindings, null)).toEqual({ type: "chord-prefix", key: "g" });
    expect(matchKey("c", bindings, null)).toEqual({ type: "chord-prefix", key: "c" });
  });
  it("completes a chord when the prefix is pending", () => {
    expect(matchKey("d", bindings, "g")).toEqual({ type: "action", id: "nav_dashboard" });
    expect(matchKey("m", bindings, "c")).toEqual({ type: "action", id: "new_movement" });
    expect(matchKey(",", bindings, "g")).toEqual({ type: "action", id: "nav_settings" });
  });
  it("matches chords case-insensitively", () => {
    expect(matchKey("S", bindings, "g")).toEqual({ type: "action", id: "nav_sources" });
  });
  it("after a failed chord, falls back to a fresh single/prefix match", () => {
    // pending "g" then "/" — no "g /" chord, but "/" is focus_search.
    expect(matchKey("/", bindings, "g")).toEqual({ type: "action", id: "focus_search" });
    // pending "c" then "g" — no "c g" chord, but "g" starts a new chord.
    expect(matchKey("g", bindings, "c")).toEqual({ type: "chord-prefix", key: "g" });
  });
  it("returns none for unbound keys", () => {
    expect(matchKey("q", bindings, null)).toEqual({ type: "none" });
  });
  it("respects a custom override binding", () => {
    const custom = resolveBindings({ nav_dashboard: "h" });
    expect(matchKey("h", custom, null)).toEqual({ type: "action", id: "nav_dashboard" });
    // the old default no longer fires
    expect(matchKey("d", custom, "g")).toEqual({ type: "none" });
  });
  it("a disabled action never matches", () => {
    const disabled = resolveBindings({ focus_search: "" });
    expect(matchKey("/", disabled, null)).toEqual({ type: "none" });
  });
});

describe("hotkeys — guards", () => {
  it("isTypingTarget detects form fields and contenteditable", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
  it("isPassthroughCombo lets native shortcuts flow", () => {
    expect(isPassthroughCombo({ key: "c", ctrlKey: true })).toBe(true);
    expect(isPassthroughCombo({ key: "v", metaKey: true })).toBe(true);
    expect(isPassthroughCombo({ key: "f", ctrlKey: true })).toBe(true);
    expect(isPassthroughCombo({ key: "t", altKey: true })).toBe(false);
    expect(isPassthroughCombo({ key: "k", ctrlKey: true })).toBe(false);
  });
});
