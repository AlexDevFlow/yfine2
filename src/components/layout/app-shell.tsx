import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { CommandPalette } from "./command-palette";
import { mobileNavFromLayout, type ResolvedNavItem } from "./nav";
import { useNavLayout } from "./use-nav-layout";
import { NotificationWatcher } from "./notification-watcher";
import { UpdateWatcher } from "./update-watcher";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { useHotkeys } from "./use-hotkeys";
import { ExpandableTabs } from "@/components/ui/expandable-tabs";
import { ChangelogModal } from "@/components/changelog-modal";
import { HelpDrawer } from "@/components/help/help-drawer";
import { usePreferences, useUpdatePreferences } from "@/db/queries";
import { getDb } from "@/db/connection";
import { hasUserData } from "@/db/repo/settings";
import { maybeRefreshPrices, maybeRefreshRates } from "@/db/repo/scheduler";
import { changelogFor, releaseNotesAction, type ChangelogEntry } from "@/lib/changelog";
import { currentVersion } from "@/lib/updater";
import { applyUiScale } from "@/lib/ui-scale";
import { isTypingTarget } from "@/lib/hotkeys";

type NavTo = Parameters<ReturnType<typeof useNavigate>>[0]["to"];

/** Parse the saved bottom-bar page-id list; null when unset/invalid → default. */
function parseBarIds(json: string | null | undefined): string[] | null {
  try {
    const a = JSON.parse(json || "");
    if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string")) return a as string[];
  } catch {
    /* fall through to default */
  }
  return null;
}

/** Spring for the "More"/customize popovers sliding up out of the bar. */
const POPOVER_SPRING = { type: "spring" as const, stiffness: 520, damping: 36, mass: 0.7 };

/**
 * Floating bottom navigation built on ExpandableTabs. Unlike the old md-only
 * BottomNav, this is visible at ALL screen sizes so the "Bottom menu" setting
 * is meaningful on desktop too. The active tab is driven by the current route;
 * tapping a tab navigates to it.
 *
 * Only the first few nav items fit in the bar, so a trailing "More" tab opens a
 * popover with every remaining page — otherwise (with the sidebar hidden in
 * bottom mode) pages past the cap would be reachable only via ⌘K. The popovers
 * slide up out of the bar with a spring (and stagger the rows), giving the
 * "cool expansion" without changing the bar itself.
 */
function FloatingBottomNav() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const resolved = useNavLayout();
  const [moreOpen, setMoreOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { data: prefs } = usePreferences();
  const update = useUpdatePreferences();
  const navSize = prefs?.bottom_nav_size === "sm" || prefs?.bottom_nav_size === "lg" ? prefs.bottom_nav_size : "md";

  // The bar shows the pages chosen in `bottom_nav_json` (right-click to edit);
  // everything else goes to "More". Independent of the sidebar's show/hide.
  const byId = new Map(resolved.map((i) => [i.id, i]));
  const barIds = parseBarIds(prefs?.bottom_nav_json) ?? mobileNavFromLayout(resolved).map((i) => i.id);
  const barSet = new Set(barIds);
  const mainItems = barIds.map((id) => byId.get(id)).filter((x): x is ResolvedNavItem => !!x);
  const moreItems = resolved.filter((i) => !barSet.has(i.id));

  const matches = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  const go = (to: string) => {
    setMoreOpen(false);
    void navigate({ to: to as NavTo });
  };

  // Right-click the bar → choose which pages sit ON the bar (vs in "More").
  // Persists to bottom_nav_json, applied live; added items slot into nav order.
  const toggleBarItem = (id: string) => {
    const next = barSet.has(id)
      ? barIds.filter((x) => x !== id)
      : resolved.filter((i) => i.id === id || barSet.has(i.id)).map((i) => i.id);
    if (!next.length) return; // keep at least one page on the bar
    update.mutate({ bottom_nav_json: JSON.stringify(next) });
  };

  // Close the popovers on outside-click / Escape. (A `fixed inset-0` backdrop
  // can't be used here: the wrapper's -translate-x-1/2 transform reparents
  // `fixed` children, so a backdrop wouldn't cover the viewport — and the popup
  // would be impossible to dismiss.)
  useEffect(() => {
    if (!moreOpen && !customizeOpen) return;
    const close = () => {
      setMoreOpen(false);
      setCustomizeOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen, customizeOpen]);

  // When the active route lives in the overflow, surface that hidden item as its
  // own highlighted chip in the bar — so you can tell *which* "More" page you're
  // on, not just that "More" is active. The chip sits before the ⋯ button (kept
  // for discoverability); clicking it opens the More popover.
  const mainActive = mainItems.findIndex((it) => matches(it.to));
  const activeHidden = mainActive === -1 ? moreItems.find((it) => matches(it.to)) : undefined;

  // Tab defs aligned with the ExpandableTabs array (separators included), so the
  // onChange index maps back to the right action.
  const defs: ({ kind: "nav"; to: string } | { kind: "sep" } | { kind: "more" } | { kind: "active-hidden" })[] = [
    ...mainItems.map((it) => ({ kind: "nav" as const, to: it.to })),
    ...(moreItems.length
      ? [
          { kind: "sep" as const },
          ...(activeHidden ? [{ kind: "active-hidden" as const }] : []),
          { kind: "more" as const },
        ]
      : []),
  ];
  const tabs = [
    ...mainItems.map((it) => ({ title: t(it.key, { defaultValue: it.label }), icon: it.icon })),
    ...(moreItems.length
      ? [
          { type: "separator" as const },
          ...(activeHidden
            ? [{ title: t(activeHidden.key, { defaultValue: activeHidden.label }), icon: activeHidden.icon }]
            : []),
          { title: t("more", { defaultValue: "More" }), icon: MoreHorizontal },
        ]
      : []),
  ];

  // Highlight the active page's tab; if the current route lives in the overflow,
  // highlight the dedicated active-hidden chip instead of the generic ⋯ button.
  const selected =
    mainActive !== -1
      ? mainActive
      : activeHidden
        ? defs.findIndex((d) => d.kind === "active-hidden")
        : null;

  const closePopovers = () => {
    setMoreOpen(false);
    setCustomizeOpen(false);
  };

  return (
    <div
      ref={wrapRef}
      className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2"
      onContextMenu={(e) => {
        e.preventDefault();
        setMoreOpen(false);
        setCustomizeOpen(true);
      }}
    >
      {/* Full-screen dismiss layer. Portalled to <body> so it escapes this
          wrapper's -translate-x-1/2 transform (which would otherwise make a
          `fixed inset-0` child cover only the pill, not the viewport) — giving an
          obvious "tap anywhere to close" target. */}
      {(moreOpen || customizeOpen) &&
        createPortal(
          <div className="fixed inset-0 z-30 bg-black/20" onPointerDown={closePopovers} aria-hidden />,
          document.body,
        )}
      <AnimatePresence>
        {customizeOpen && (
          <motion.div
            style={{ x: "-50%" }}
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={POPOVER_SPRING}
            className="absolute bottom-full left-1/2 z-10 mb-2 max-h-[60vh] w-60 origin-bottom overflow-y-auto rounded-2xl border border-border-strong bg-surface-2 p-1.5 shadow-xl"
          >
            <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-2">
                {t("show_in_menu", { defaultValue: "Show in menu" })}
              </span>
              <button
                type="button"
                onClick={() => setCustomizeOpen(false)}
                aria-label={t("close", { defaultValue: "Close" })}
                className="rounded-md p-0.5 text-muted transition-colors hover:bg-surface hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {resolved.map((it) => {
              const Icon = it.icon;
              return (
                <button
                  key={it.to}
                  type="button"
                  onClick={() => toggleBarItem(it.id)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted" />
                  <span className="flex-1 text-left">{t(it.key, { defaultValue: it.label })}</span>
                  <input type="checkbox" checked={barSet.has(it.id)} readOnly className="pointer-events-none" />
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {moreOpen && (
          <motion.div
            style={{ x: "-50%" }}
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={POPOVER_SPRING}
            className="absolute bottom-full left-1/2 z-10 mb-2 max-h-[60vh] w-56 origin-bottom overflow-y-auto rounded-2xl border border-border-strong bg-surface-2 p-1.5 shadow-xl"
          >
            {moreItems.map((it, i) => {
              const Icon = it.icon;
              const active = matches(it.to);
              return (
                <motion.button
                  key={it.to}
                  type="button"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  // Items rise from the bar (bottom) upward, lightly staggered.
                  transition={{ ...POPOVER_SPRING, delay: (moreItems.length - 1 - i) * 0.022 }}
                  onClick={() => go(it.to)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                    active ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {t(it.key, { defaultValue: it.label })}
                </motion.button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
      <ExpandableTabs
        tabs={tabs}
        selected={selected}
        size={navSize}
        onChange={(index) => {
          if (index == null) return;
          const def = defs[index];
          if (!def) return;
          if (def.kind === "nav") go(def.to);
          // The active-hidden chip and the ⋯ button both open the More popover.
          else if (def.kind === "more" || def.kind === "active-hidden") setMoreOpen((o) => !o);
        }}
      />
    </div>
  );
}

/** Gentle background tick for the opt-in live price refresh. */
const PRICE_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function AppShell() {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("yfine.sidebar") === "1",
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Apply the saved interface-size preference once it loads from the DB.
  const { data: prefs } = usePreferences();
  const updatePrefs = useUpdatePreferences();
  const qc = useQueryClient();
  useEffect(() => {
    if (prefs?.ui_scale) applyUiScale(prefs.ui_scale);
  }, [prefs?.ui_scale]);

  // Opt-in live price refresh on a gentle 15-min interval. maybeRefreshPrices is
  // self-throttling (it skips when the last refresh is < 10 min old) and a no-op
  // when the preference is off — so this stays cheap and never blocks the UI. We
  // invalidate the money-derived views only when something actually changed.
  const pricesEnabled = (prefs?.portfolio_prices_enabled ?? 0) === 1;
  useEffect(() => {
    if (!pricesEnabled) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const db = await getDb();
        // Rates first: a holding priced in USD is worthless to an EUR portfolio
        // total until the USD→EUR rate exists, so refreshing prices without them
        // would leave the same "approximate total" warning up. Both are throttled
        // (12h / 10min) and both fail soft.
        const updated = (await maybeRefreshRates(db)) + (await maybeRefreshPrices(db));
        if (!cancelled && updated > 0) {
          for (const k of ["portfolios", "dashboard", "consolidated", "history", "sources", "rates"]) {
            void qc.invalidateQueries({ queryKey: [k] });
          }
        }
      } catch {
        /* never let a background refresh surface to the UI */
      }
    };
    // Run once on mount: boot no longer refreshes prices inline (it would block
    // the dashboard on a network round-trip), so this is what brings holdings
    // current right after unlock — in the background, invalidating the money
    // views only if something changed. Self-throttled, so it's a no-op when a
    // refresh already ran < 10 min ago.
    void tick();
    const id = window.setInterval(tick, PRICE_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pricesEnabled, qc]);

  // Release notes: shown once, on the first launch after an update. A profile
  // that has never recorded a version (fresh install, or an app that predates
  // this) is stamped silently — the popup is for updates, not for installs.
  const [changelog, setChangelog] = useState<ChangelogEntry | null>(null);
  const seenVersion = prefs?.last_seen_version;
  const prefsLoaded = prefs != null;
  useEffect(() => {
    if (!prefsLoaded) return;
    let cancelled = false;
    void (async () => {
      const version = await currentVersion();
      if (cancelled || !version || version === seenVersion) return;
      const entry = changelogFor(version);
      const action = releaseNotesAction({
        version,
        seen: seenVersion,
        hasEntry: entry != null,
        hasData: await hasUserData(await getDb()),
      });
      if (cancelled || action === "skip") return;
      if (action === "stamp") {
        updatePrefs.mutate({ last_seen_version: version });
        return;
      }
      setChangelog(entry!);
    })();
    return () => { cancelled = true; };
    // updatePrefs is a stable mutation object; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsLoaded, seenVersion]);

  const dismissChangelog = () => {
    const version = changelog?.version;
    setChangelog(null);
    if (version) updatePrefs.mutate({ last_seen_version: version });
  };

  // Mobile navigation mode: "bottom" shows the fixed bottom bar; "sidebar" uses
  // a hamburger-triggered off-canvas sidebar instead (matches the original's
  // get_mobile_nav_mode / body[data-mobile-nav]).
  const mobileNavMode = prefs?.mobile_nav_mode === "bottom" ? "bottom" : "sidebar";

  // Cmd/Ctrl-K toggles the palette; "?" opens the help drawer (skipped while
  // typing, like the hotkey engine). The 14 customizable actions live in
  // useHotkeys below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
        return;
      }
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target as HTMLElement)) {
        e.preventDefault();
        setHelpOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useHotkeys({ onFocusSearch: () => setSearchOpen(true) });

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("yfine.sidebar", next ? "1" : "0");
      return next;
    });

  return (
    <div className="flex h-full overflow-hidden">
      {/* In "bottom" mode the floating nav replaces the sidebar entirely (at all
          screen sizes), so the setting is visible and meaningful on desktop. */}
      {mobileNavMode === "sidebar" && <Sidebar collapsed={collapsed} onToggle={toggle} />}

      {/* Mobile off-canvas sidebar (only in "sidebar" mobile-nav mode) */}
      {mobileNavMode === "sidebar" && mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden" role="dialog" aria-modal="true" aria-label={t("menu", { defaultValue: "Menu" })}>
          <div className="flex-1 bg-black/40 backdrop-blur-sm" onMouseDown={() => setMobileNavOpen(false)} />
          <div className="absolute inset-y-0 left-0">
            <Sidebar collapsed={false} onToggle={toggle} mobile onNavigate={() => setMobileNavOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onOpenSearch={() => setSearchOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
          onOpenMobileNav={mobileNavMode === "sidebar" ? () => setMobileNavOpen(true) : undefined}
        />
        <main className="flex-1 overflow-y-auto">
          {/* Extra bottom padding in "bottom" mode so the floating pill never
              covers the last bit of page content. */}
          <div className={mobileNavMode === "bottom"
            ? "mx-auto w-full max-w-[1200px] p-4 pb-28 md:p-6 md:pb-28"
            : "mx-auto w-full max-w-[1200px] p-4 md:p-6"}>
            <Outlet />
          </div>
        </main>
      </div>
      {mobileNavMode === "bottom" && <FloatingBottomNav />}
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
      <NotificationWatcher />
      <UpdateWatcher />
      {changelog && (
        <ChangelogModal
          entry={changelog}
          open
          dateFormat={prefs?.date_format}
          onClose={dismissChangelog}
        />
      )}
    </div>
  );
}
