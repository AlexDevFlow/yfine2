/**
 * Yfine keyboard-shortcut engine — port of static/js/hotkeys.js.
 *
 * Pure logic (no DOM, no React) so it can be unit-tested in the node test env:
 *   - the 14 default actions and their bindings (single source of truth)
 *   - key-event normalization ("Alt+t", "Ctrl+Shift+k", "g", "/")
 *   - user override resolution (override replaces default; "" disables)
 *   - chord/single/modifier matching
 *
 * Bindings come in three shapes (matching the original):
 *   - single key:        "n", "/", "?"
 *   - modifier + key:    "Alt+t", "Ctrl+Shift+k"
 *   - chord (sequence):  "g d", "g s"  (two presses within CHORD_TIMEOUT_MS)
 */

/** What a hotkey does. The React hook maps these to real side effects. */
export type HotkeyEffect =
  | { kind: "navigate"; to: string }
  | { kind: "focus_search" }
  | { kind: "toggle_theme" };

export interface HotkeyAction {
  /** Stable id, also the persisted-override key and i18n suffix. */
  id: string;
  /** Default key binding. */
  def: string;
  /** i18n label key (hotkey_<id>). */
  labelKey: string;
  effect: HotkeyEffect;
}

/**
 * The 14 actions, in display order. Mirrors YN_HOTKEY_ACTIONS in the original
 * hotkeys.js, with the legacy URLs mapped to yfine2 routes. yfine2 has no
 * separate /movements/new or /recurring/new pages (creation is modal-driven on
 * the list page), so the two create actions navigate to that list page — the
 * closest faithful equivalent of the original "go create one" intent.
 */
export const HOTKEY_ACTIONS: HotkeyAction[] = [
  { id: "nav_dashboard", def: "g d", labelKey: "hotkey_nav_dashboard", effect: { kind: "navigate", to: "/" } },
  { id: "nav_sources", def: "g s", labelKey: "hotkey_nav_sources", effect: { kind: "navigate", to: "/sources" } },
  { id: "nav_portfolios", def: "g p", labelKey: "hotkey_nav_portfolios", effect: { kind: "navigate", to: "/portfolios" } },
  { id: "nav_movements", def: "g m", labelKey: "hotkey_nav_movements", effect: { kind: "navigate", to: "/movements" } },
  { id: "nav_tags", def: "g t", labelKey: "hotkey_nav_tags", effect: { kind: "navigate", to: "/tags" } },
  { id: "nav_recurring", def: "g r", labelKey: "hotkey_nav_recurring", effect: { kind: "navigate", to: "/recurring" } },
  { id: "nav_savings", def: "g v", labelKey: "hotkey_nav_savings", effect: { kind: "navigate", to: "/savings" } },
  { id: "nav_whims", def: "g w", labelKey: "hotkey_nav_whims", effect: { kind: "navigate", to: "/whims" } },
  { id: "nav_notifications", def: "g n", labelKey: "hotkey_nav_notifications", effect: { kind: "navigate", to: "/notifications" } },
  { id: "nav_settings", def: "g ,", labelKey: "hotkey_nav_settings", effect: { kind: "navigate", to: "/settings" } },
  { id: "new_movement", def: "c m", labelKey: "hotkey_new_movement", effect: { kind: "navigate", to: "/movements" } },
  { id: "new_recurring", def: "c r", labelKey: "hotkey_new_recurring", effect: { kind: "navigate", to: "/recurring" } },
  { id: "focus_search", def: "/", labelKey: "hotkey_focus_search", effect: { kind: "focus_search" } },
  { id: "toggle_theme", def: "Alt+t", labelKey: "hotkey_toggle_theme", effect: { kind: "toggle_theme" } },
];

export const CHORD_TIMEOUT_MS = 1200;

/** Modifier+key combos we let through so native copy/paste/etc. still work. */
const PASSTHROUGH_KEYS = ["a", "c", "v", "x", "z", "y", "f"];

export interface KeyEventLike {
  key: string;
  /** Physical key (e.g. "KeyT"); used so Option/Alt letter combos survive macOS dead-key output. */
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/**
 * Normalize a keyboard event into a binding string, e.g. "Alt+t",
 * "Ctrl+Shift+k", "g", "/". Same semantics as the original _normalizeKey, with
 * two layout fixes:
 *  - with Alt/Ctrl/Meta held, a letter is taken from the PHYSICAL key when
 *    the layout turned it into a symbol (macOS Option+T types "†", which could
 *    never match "Alt+t");
 *  - Shift is only recorded for letters and non-printable keys. A symbol that
 *    needs Shift on the user's layout ("/" is Shift+7 on Italian and Spanish
 *    keyboards) is just that symbol, so the default "/" search shortcut works.
 */
export function normalizeKey(e: KeyEventLike): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  let k = e.key;
  const physical = /^Key([A-Z])$/.exec(e.code ?? "");
  if ((e.altKey || e.ctrlKey || e.metaKey) && physical && !/^[a-z]$/i.test(k)) {
    k = physical[1];
  }
  const printable = k.length === 1;
  const letter = printable && /[a-z]/i.test(k);
  if (e.shiftKey && (!printable || letter)) parts.push("Shift");
  if (printable) k = k.toLowerCase();
  parts.push(k);
  return parts.join("+");
}

/**
 * Resolve effective bindings: start from defaults, apply user overrides. An
 * override of "" disables that action. Unknown override keys are ignored.
 * Returns id → binding string.
 */
export function resolveBindings(overrides: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of HOTKEY_ACTIONS) out[a.id] = a.def;
  for (const id of Object.keys(overrides)) {
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      out[id] = String(overrides[id] ?? "");
    }
  }
  return out;
}

/** Parse a JSON overrides blob defensively (malformed → no overrides). */
export function parseOverrides(json: string | null | undefined): Record<string, string> {
  try {
    const v = JSON.parse(json || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, string>;
  } catch {
    /* fall through */
  }
  return {};
}

/**
 * Keep only the overrides that differ from the default — so future default
 * changes still reach users (matches the original's override-only persistence).
 */
export function pruneOverrides(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of HOTKEY_ACTIONS) {
    const cur = (values[a.id] ?? a.def).trim();
    if (cur !== a.def) out[a.id] = cur;
  }
  return out;
}

function eqi(a: string, b: string): boolean {
  return (a || "").toLowerCase() === (b || "").toLowerCase();
}

export type MatchResult =
  | { type: "action"; id: string }
  | { type: "chord-prefix"; key: string }
  | { type: "none" };

/**
 * Core matcher. Given the normalized key, the resolved bindings, and the
 * currently pending chord prefix (or null), decide what to do:
 *   - "action": fire this action id
 *   - "chord-prefix": this key starts a chord; remember it
 *   - "none": nothing matched
 *
 * Mirrors the three-stage logic in hotkeys.js _onKeyDown (resolve pending
 * chord → direct match → new chord prefix).
 */
export function matchKey(
  normalized: string,
  bindings: Record<string, string>,
  pendingChord: string | null,
): MatchResult {
  // 1) resolving an in-progress chord
  if (pendingChord) {
    const combined = `${pendingChord} ${normalized}`;
    for (const id of Object.keys(bindings)) {
      const b = bindings[id];
      if (b && eqi(b, combined)) return { type: "action", id };
    }
    // fall through: this key may itself be a single action or a new prefix
  }
  // 2) direct match (single key or modifier+key — no space)
  for (const id of Object.keys(bindings)) {
    const b = bindings[id];
    if (!b || b.indexOf(" ") !== -1) continue;
    if (eqi(b, normalized)) return { type: "action", id };
  }
  // 3) new chord prefix?
  for (const id of Object.keys(bindings)) {
    const b = bindings[id];
    if (!b || b.indexOf(" ") === -1) continue;
    const first = b.split(" ")[0];
    if (eqi(first, normalized)) return { type: "chord-prefix", key: normalized };
  }
  return { type: "none" };
}

/** True for keystrokes we must not swallow (typing in a field). */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** True when a Ctrl/Cmd combo should pass through to the browser/OS. */
export function isPassthroughCombo(e: KeyEventLike): boolean {
  return (
    !!(e.ctrlKey || e.metaKey) && PASSTHROUGH_KEYS.indexOf((e.key || "").toLowerCase()) !== -1
  );
}
