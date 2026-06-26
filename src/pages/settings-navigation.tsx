/**
 * Settings cards for the frontend-shell customization features:
 *   - Hotkeys: master toggle + per-action key-capture rebinding (override-only
 *     persistence to hotkeys_json), faithful to settings/index.html.
 *   - Menu Layout: HTML5 drag-reorder + visibility toggles, persisted to
 *     nav_layout_json; a layout-changing save reloads so every consumer
 *     (sidebar + bottom nav) reflects it (the user prefers reload over a
 *     "reload to see" prompt).
 *   - Mobile Navigation mode: sidebar vs bottom bar on small screens.
 */
import { GripVertical, RotateCcw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { usePreferences, useUpdatePreferences } from "@/db/queries";
import {
  resolveNavLayout,
  type ResolvedNavItem,
} from "@/components/layout/nav";
import {
  HOTKEY_ACTIONS,
  normalizeKey,
  parseOverrides,
  pruneOverrides,
} from "@/lib/hotkeys";
import { cn } from "@/lib/cn";

/* ------------------------------------------------------------------ Hotkeys */

export function HotkeysCard() {
  const { t } = useTranslation();
  const { data: prefs } = usePreferences();
  const update = useUpdatePreferences();

  const enabled = (prefs?.hotkeys_enabled ?? 1) === 1;
  const overrides = useMemo(() => parseOverrides(prefs?.hotkeys_json), [prefs?.hotkeys_json]);

  // Working copy of effective bindings (defaults + overrides), edited live.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const base: Record<string, string> = {};
    for (const a of HOTKEY_ACTIONS) base[a.id] = a.id in overrides ? overrides[a.id] : a.def;
    return base;
  });
  // Track per-row chord capture state: the first key of a two-key chord.
  const captureRef = useRef<Record<string, string>>({});
  // Always-latest mirror of `values` so onBlur persists the just-typed binding even
  // if blur fires before the keystroke's state update has re-rendered.
  const valuesRef = useRef<Record<string, string>>(values);
  valuesRef.current = values;

  // Re-seed when the stored overrides change (e.g. after a reset elsewhere).
  const overridesKey = JSON.stringify(overrides);
  const seededRef = useRef(overridesKey);
  if (seededRef.current !== overridesKey) {
    seededRef.current = overridesKey;
    const base: Record<string, string> = {};
    for (const a of HOTKEY_ACTIONS) base[a.id] = a.id in overrides ? overrides[a.id] : a.def;
    setValues(base);
  }

  const persist = (next: Record<string, string>) => {
    update.mutate({ hotkeys_json: JSON.stringify(pruneOverrides(next)) });
  };

  const setValue = (id: string, value: string, persistNow = false) => {
    setValues((prev) => {
      const next = { ...prev, [id]: value };
      valuesRef.current = next; // keep the mirror in sync synchronously
      if (persistNow) persist(next);
      return next;
    });
  };

  const onKeyDown = (id: string, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") return; // allow focus movement
    e.preventDefault();
    if (e.key === "Escape") {
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      captureRef.current[id] = "";
      setValue(id, "", true); // empty = disabled
      return;
    }
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // lone modifier
    const combo = normalizeKey(e);
    const prevCapture = captureRef.current[id];
    // Chord support: if a single key was just captured, append to make "g d".
    if (prevCapture && prevCapture.split(" ").length < 2 && prevCapture.indexOf("+") === -1) {
      captureRef.current[id] = "";
      setValue(id, `${prevCapture} ${combo}`, true);
    } else {
      captureRef.current[id] = combo;
      setValue(id, combo, false);
    }
  };

  const onBlur = (id: string) => {
    captureRef.current[id] = "";
    persist(valuesRef.current);
  };

  const reset = (id: string) => {
    const def = HOTKEY_ACTIONS.find((a) => a.id === id)?.def ?? "";
    captureRef.current[id] = "";
    setValue(id, def, true);
  };

  return (
    <Card>
      <CardHeader title={t("hotkeys", { defaultValue: "Keyboard Shortcuts" })} subtitle={t("hotkeys_desc", { defaultValue: "Press the bound keys anywhere in the app to navigate. Skipped while typing in inputs." })} />
      <CardContent className="space-y-3 pt-3">
        <label className="flex items-center gap-2 text-sm font-medium text-foreground">
          <input type="checkbox" checked={enabled} onChange={(e) => update.mutate({ hotkeys_enabled: e.target.checked })} />
          {t("hotkeys_master_toggle", { defaultValue: "Enable keyboard shortcuts" })}
        </label>
        <div className={cn("overflow-hidden rounded-[var(--radius-control)] border border-border", !enabled && "opacity-50")}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-muted-2">
                <th className="px-3 py-2 font-medium">{t("action", { defaultValue: "Action" })}</th>
                <th className="px-3 py-2 font-medium" style={{ width: 200 }}>{t("shortcut", { defaultValue: "Shortcut" })}</th>
                <th className="px-3 py-2" style={{ width: 56 }} />
              </tr>
            </thead>
            <tbody>
              {HOTKEY_ACTIONS.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{t(a.labelKey, { defaultValue: a.id })}</div>
                    <div className="text-xs text-muted-2">{a.def}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      value={values[a.id] ?? ""}
                      readOnly
                      disabled={!enabled}
                      placeholder={t("hotkeys_press_keys", { defaultValue: "Press keys…" })}
                      onFocus={() => { captureRef.current[a.id] = ""; }}
                      onKeyDown={(e) => onKeyDown(a.id, e)}
                      onBlur={() => onBlur(a.id)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button type="button" variant="outline" size="sm" disabled={!enabled} onClick={() => reset(a.id)} aria-label={t("reset", { defaultValue: "Reset" })} title={t("reset", { defaultValue: "Reset" })}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">{t("hotkeys_capture_hint", { defaultValue: "Click a shortcut field and press the key combo. Backspace clears it (disables that action)." })}</p>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- Menu layout */

export function MenuLayoutCard() {
  const { t } = useTranslation();
  const { data: prefs } = usePreferences();
  const update = useUpdatePreferences();

  // Local, drag-editable copy of the resolved layout. Seeded from prefs.
  const layoutKey = prefs?.nav_layout_json ?? "[]";
  const [items, setItems] = useState<ResolvedNavItem[]>(() => resolveNavLayout(layoutKey));
  const seededRef = useRef(layoutKey);
  if (seededRef.current !== layoutKey) {
    seededRef.current = layoutKey;
    setItems(resolveNavLayout(layoutKey));
  }
  const dragId = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; above: boolean } | null>(null);

  // Persist, then reload so the live sidebar/bottom-nav reflect the new layout
  // (the user prefers a reload to a "reload to see" prompt).
  const save = (next: ResolvedNavItem[], reload: boolean) => {
    const json = JSON.stringify(next.map((i) => ({ id: i.id, visible: i.visible })));
    update.mutate(
      { nav_layout_json: json },
      reload ? { onSuccess: () => setTimeout(() => location.reload(), 250) } : undefined,
    );
  };

  const toggleVisible = (id: string) => {
    setItems((prev) => {
      const next = prev.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i));
      save(next, true);
      return next;
    });
  };

  const onDrop = (targetId: string, above: boolean) => {
    const from = dragId.current;
    dragId.current = null;
    setDropTarget(null);
    if (!from || from === targetId) return;
    setItems((prev) => {
      const next = [...prev];
      const fromIdx = next.findIndex((i) => i.id === from);
      const [moved] = next.splice(fromIdx, 1);
      let targetIdx = next.findIndex((i) => i.id === targetId);
      if (!above) targetIdx += 1;
      next.splice(targetIdx, 0, moved);
      save(next, true);
      return next;
    });
  };

  const resetLayout = () => {
    setItems(resolveNavLayout("[]"));
    update.mutate({ nav_layout_json: "[]" }, { onSuccess: () => setTimeout(() => location.reload(), 250) });
  };

  return (
    <Card>
      <CardHeader title={t("menu_layout", { defaultValue: "Sidebar Menu" })} subtitle={t("menu_layout_desc", { defaultValue: "Show, hide and reorder items in the side menu. Mobile bottom nav is unaffected." })} />
      <CardContent className="space-y-3 pt-3">
        <ul className="overflow-hidden rounded-[var(--radius-control)] border border-border">
          {items.map((item) => {
            const Icon = item.icon;
            const isTarget = dropTarget?.id === item.id;
            return (
              <li
                key={item.id}
                draggable
                onDragStart={() => { dragId.current = item.id; }}
                onDragEnd={() => { dragId.current = null; setDropTarget(null); }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!dragId.current || dragId.current === item.id) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDropTarget({ id: item.id, above: e.clientY - rect.top < rect.height / 2 });
                }}
                onDrop={() => onDrop(item.id, dropTarget?.id === item.id ? dropTarget.above : true)}
                className={cn(
                  "nav-layout-item flex items-center gap-3 border-b border-border bg-surface px-3 py-2.5 last:border-0",
                  dragId.current === item.id && "nav-layout-dragging",
                  isTarget && (dropTarget?.above ? "nav-layout-drop-above" : "nav-layout-drop-below"),
                )}
              >
                <GripVertical className="h-4 w-4 shrink-0 text-muted-2" aria-label={t("drag_to_reorder", { defaultValue: "Drag to reorder" })} />
                <Icon className="h-[18px] w-[18px] shrink-0 text-primary" />
                <span className="flex-1 truncate text-sm font-medium text-foreground">{t(item.key, { defaultValue: item.label })}</span>
                <span className="hidden text-[11px] uppercase tracking-wide text-muted-2 sm:inline">{t(`navgroup_${item.section}`, { defaultValue: item.section })}</span>
                <label className="flex items-center" title={t("visible", { defaultValue: "Visible" })}>
                  <input type="checkbox" checked={item.visible} onChange={() => toggleVisible(item.id)} />
                </label>
              </li>
            );
          })}
        </ul>
        <Button type="button" variant="outline" size="sm" onClick={resetLayout}>
          <RotateCcw className="h-3.5 w-3.5" /> {t("reset_to_default", { defaultValue: "Reset to default" })}
        </Button>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------- Mobile navigation */

export function MobileNavCard() {
  const { t } = useTranslation();
  const { data: prefs } = usePreferences();
  const update = useUpdatePreferences();
  const mode = prefs?.mobile_nav_mode === "bottom" ? "bottom" : "sidebar";
  const navSize = prefs?.bottom_nav_size === "sm" || prefs?.bottom_nav_size === "lg" ? prefs.bottom_nav_size : "md";

  const OPTS: { value: "sidebar" | "bottom"; labelKey: string; label: string; descKey: string; desc: string }[] = [
    { value: "sidebar", labelKey: "mobile_nav_sidebar", label: "Side Menu", descKey: "mobile_nav_sidebar_desc", desc: "Slide-out sidebar menu on small screens" },
    { value: "bottom", labelKey: "mobile_nav_bottom", label: "Bottom Menu", descKey: "mobile_nav_bottom_desc", desc: "Fixed bottom navigation bar like mobile apps" },
  ];

  const SIZE_OPTS: { value: "sm" | "md" | "lg"; labelKey: string; label: string }[] = [
    { value: "sm", labelKey: "nav_size_sm", label: "Compact" },
    { value: "md", labelKey: "nav_size_md", label: "Comfortable" },
    { value: "lg", labelKey: "nav_size_lg", label: "Large" },
  ];

  return (
    <Card>
      <CardHeader title={t("mobile_navigation", { defaultValue: "Mobile Navigation" })} />
      <CardContent className="space-y-4 pt-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {OPTS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => update.mutate({ mobile_nav_mode: o.value })}
              className={cn(
                "rounded-[var(--radius-control)] border p-3 text-left transition-colors",
                mode === o.value ? "border-primary bg-accent-soft" : "border-border hover:bg-surface-2",
              )}
            >
              <div className={cn("text-sm font-medium", mode === o.value ? "text-primary" : "text-foreground")}>
                {t(o.labelKey, { defaultValue: o.label })}
              </div>
              <div className="text-xs text-muted">{t(o.descKey, { defaultValue: o.desc })}</div>
            </button>
          ))}
        </div>

        {/* Bottom-bar size only matters when the bottom bar is the active mode. */}
        {mode === "bottom" && (
          <div className="space-y-1.5">
            <div className="text-sm font-medium text-foreground">{t("nav_size", { defaultValue: "Bottom Bar Size" })}</div>
            <div className="flex gap-2">
              {SIZE_OPTS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => update.mutate({ bottom_nav_size: o.value })}
                  className={cn(
                    "flex-1 rounded-[var(--radius-control)] border px-3 py-2 text-sm font-medium transition-colors",
                    navSize === o.value ? "border-primary bg-accent-soft text-primary" : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
                  )}
                >
                  {t(o.labelKey, { defaultValue: o.label })}
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Combined navigation/shortcut customization section for the settings page. */
export function NavigationSettings() {
  return (
    <>
      <MobileNavCard />
      <MenuLayoutCard />
      <HotkeysCard />
    </>
  );
}
