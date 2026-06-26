import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTheme } from "@/components/theme/theme-provider";
import { usePreferences } from "@/db/queries";
import {
  CHORD_TIMEOUT_MS,
  HOTKEY_ACTIONS,
  isPassthroughCombo,
  isTypingTarget,
  matchKey,
  normalizeKey,
  parseOverrides,
  resolveBindings,
  type HotkeyAction,
} from "@/lib/hotkeys";

const ACTION_BY_ID: Record<string, HotkeyAction> = Object.fromEntries(
  HOTKEY_ACTIONS.map((a) => [a.id, a]),
);

/**
 * Global keyboard-shortcut engine — React port of static/js/hotkeys.js.
 *
 * Mounts a single capture-phase keydown listener that:
 *   - is gated on the hotkeys_enabled master toggle,
 *   - skips while the user is typing in a field,
 *   - lets native Ctrl/Cmd shortcuts (copy/paste/find/…) flow through,
 *   - resolves bindings from defaults + user overrides (hotkeys_json),
 *   - supports single keys, modifier combos, and two-key chords within 1.2s.
 *
 * Nav/create actions use TanStack navigation; focus_search opens the command
 * palette; toggle_theme flips light/dark.
 */
export function useHotkeys({ onFocusSearch }: { onFocusSearch: () => void }) {
  const navigate = useNavigate();
  const { resolved, setTheme } = useTheme();
  const { data: prefs } = usePreferences();

  // Keep the latest deps in refs so the listener stays stable (mounted once).
  const enabled = (prefs?.hotkeys_enabled ?? 1) === 1;
  const bindings = resolveBindings(parseOverrides(prefs?.hotkeys_json));

  const stateRef = useRef({ enabled, bindings, resolved, onFocusSearch });
  stateRef.current = { enabled, bindings, resolved, onFocusSearch };

  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearPending = () => {
      pendingRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const run = (id: string) => {
      const action = ACTION_BY_ID[id];
      if (!action) return;
      const { onFocusSearch: focusSearch, resolved: theme } = stateRef.current;
      switch (action.effect.kind) {
        case "navigate":
          void navigate({ to: action.effect.to });
          break;
        case "focus_search":
          focusSearch();
          break;
        case "toggle_theme":
          setTheme(theme === "dark" ? "light" : "dark");
          break;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const { enabled: on, bindings: b } = stateRef.current;
      if (!on) return;
      if (isTypingTarget(e.target as HTMLElement)) return;
      if (isPassthroughCombo(e)) return;
      // Leave Cmd/Ctrl-K to the command palette toggle in AppShell.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") return;
      // Lone modifier presses never match.
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;

      const norm = normalizeKey(e);
      const result = matchKey(norm, b, pendingRef.current);
      if (result.type === "action") {
        e.preventDefault();
        e.stopPropagation();
        clearPending();
        run(result.id);
      } else if (result.type === "chord-prefix") {
        clearPending();
        pendingRef.current = result.key;
        timerRef.current = setTimeout(clearPending, CHORD_TIMEOUT_MS);
      } else {
        clearPending();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      clearPending();
    };
  }, [navigate, setTheme]);
}
