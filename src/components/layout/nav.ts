import {
  ArrowLeftRight,
  Bell,
  LayoutDashboard,
  PiggyBank,
  PieChart,
  Repeat,
  Settings,
  Sparkles,
  Tag,
  Target,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  /** Stable id used for layout persistence (matches the original's nav ids). */
  id: string;
  to: string;
  /** i18n key (falls back to `label` if the key is missing) */
  key: string;
  label: string;
  icon: LucideIcon;
  /** Section the item belongs to — used to group the sidebar. */
  section: NavSection;
}

export type NavSection = "overview" | "money" | "plan" | "invest" | "organize" | "system";

export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

/**
 * The full default nav, in default order. This is the single source of truth
 * the layout-merge resolver applies the user's saved layout on top of (mirrors
 * DEFAULT_NAV_ITEMS in the original i18n.py).
 */
export const DEFAULT_NAV_ITEMS: NavItem[] = [
  { id: "dashboard", to: "/", key: "dashboard", label: "Dashboard", icon: LayoutDashboard, section: "overview" },
  { id: "sources", to: "/sources", key: "sources", label: "Sources", icon: Wallet, section: "money" },
  { id: "movements", to: "/movements", key: "movements", label: "Movements", icon: ArrowLeftRight, section: "money" },
  { id: "recurring", to: "/recurring", key: "recurring", label: "Recurring", icon: Repeat, section: "money" },
  { id: "budgets", to: "/budgets", key: "budgets", label: "Budgets", icon: PieChart, section: "plan" },
  { id: "goals", to: "/goals", key: "goals", label: "Goals", icon: Target, section: "plan" },
  { id: "savings", to: "/savings", key: "savings", label: "Savings", icon: PiggyBank, section: "plan" },
  { id: "whims", to: "/whims", key: "whims", label: "Whims", icon: Sparkles, section: "plan" },
  { id: "portfolios", to: "/portfolios", key: "portfolios", label: "Portfolios", icon: TrendingUp, section: "invest" },
  { id: "tags", to: "/tags", key: "tags", label: "Tags", icon: Tag, section: "organize" },
  { id: "notifications", to: "/notifications", key: "notifications", label: "Notifications", icon: Bell, section: "system" },
  { id: "settings", to: "/settings", key: "settings", label: "Settings", icon: Settings, section: "system" },
];

/** Section display order + i18n group keys for the sidebar. */
export const SECTION_ORDER: NavSection[] = ["overview", "money", "plan", "invest", "organize", "system"];

const SECTION_LABEL: Record<NavSection, string> = {
  overview: "Overview",
  money: "Money",
  plan: "Plan",
  invest: "Invest",
  organize: "Organize",
  system: "System",
};

/** Footer-pinned ids: rendered at the bottom of the sidebar, not in a group. */
export const FOOTER_IDS = new Set(["notifications", "settings"]);

export interface ResolvedNavItem extends NavItem {
  visible: boolean;
}

/**
 * Merge a saved layout (array of `{id, visible}`) on top of the defaults —
 * faithful port of i18n.py:get_nav_items(). Items present in defaults but
 * missing from the saved layout keep their default position, anchored next to
 * their default predecessors so a newly-added nav entry never silently hides
 * (or jumps section) for upgrading users.
 */
export function resolveNavLayout(navLayoutJson: string | null | undefined): ResolvedNavItem[] {
  let layout: unknown;
  try {
    layout = JSON.parse(navLayoutJson || "[]");
  } catch {
    layout = [];
  }
  const entries = Array.isArray(layout) ? (layout as unknown[]) : [];

  const defaultsById = new Map(DEFAULT_NAV_ITEMS.map((d) => [d.id, d]));
  const defaultOrder = DEFAULT_NAV_ITEMS.map((d) => d.id);
  const result: ResolvedNavItem[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const eid = (entry as { id?: unknown }).id;
    if (typeof eid !== "string" || !defaultsById.has(eid) || seen.has(eid)) continue;
    const base = defaultsById.get(eid)!;
    const visible = (entry as { visible?: unknown }).visible;
    result.push({ ...base, visible: visible === undefined ? true : Boolean(visible) });
    seen.add(eid);
  }

  // Insert any default item the saved layout didn't mention next to its default
  // predecessors (keeping it in its section), rather than dumping it last.
  for (const d of DEFAULT_NAV_ITEMS) {
    if (seen.has(d.id)) continue;
    const preceding = new Set(defaultOrder.slice(0, defaultOrder.indexOf(d.id)));
    let insertAt = 0;
    result.forEach((existing, idx) => {
      if (preceding.has(existing.id)) insertAt = idx + 1;
    });
    result.splice(insertAt, 0, { ...d, visible: true });
    seen.add(d.id);
  }

  return result;
}

/**
 * Build sidebar groups from a resolved layout: visible items only, grouped by
 * section in each item's resolved order. Footer-pinned items are excluded.
 */
export function navGroupsFromLayout(resolved: ResolvedNavItem[]): NavGroup[] {
  const groups: NavGroup[] = [];
  const bySection = new Map<NavSection, NavItem[]>();
  for (const item of resolved) {
    if (!item.visible || FOOTER_IDS.has(item.id)) continue;
    const arr = bySection.get(item.section) ?? [];
    arr.push(item);
    bySection.set(item.section, arr);
  }
  for (const section of SECTION_ORDER) {
    const items = bySection.get(section);
    if (items?.length) groups.push({ key: section, label: SECTION_LABEL[section], items });
  }
  return groups;
}

/** Footer items (notifications, settings) that are visible, in resolved order. */
export function footerFromLayout(resolved: ResolvedNavItem[]): NavItem[] {
  return resolved.filter((i) => i.visible && FOOTER_IDS.has(i.id));
}

/**
 * Mobile bottom-bar items: the visible items in resolved order, capped so the
 * bar stays usable. Keeps the user's chosen order/visibility.
 */
export function mobileNavFromLayout(resolved: ResolvedNavItem[], limit = 5): NavItem[] {
  return resolved.filter((i) => i.visible).slice(0, limit);
}

/** Static full list for the command palette + page-title lookup (default order). */
export const ALL_NAV: NavItem[] = DEFAULT_NAV_ITEMS;
