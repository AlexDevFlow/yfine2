import { Link, useRouterState } from "@tanstack/react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Brand } from "./brand";
import { footerFromLayout, navGroupsFromLayout, type NavItem } from "./nav";
import { useNavLayout } from "./use-nav-layout";

function NavLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
  const Icon = item.icon;
  const label = t(item.key, { defaultValue: item.label });
  return (
    <Link
      to={item.to}
      title={collapsed ? label : undefined}
      onClick={onNavigate}
      className={cn(
        "group relative flex items-center rounded-[var(--radius-control)] py-2 text-sm font-medium transition-[background-color,color,padding] duration-200",
        active
          ? "bg-accent-soft text-primary"
          : "text-muted hover:bg-surface-2 hover:text-foreground",
        collapsed ? "justify-center px-0" : "px-3",
      )}
    >
      {active ? (
        <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-primary" />
      ) : null}
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {/* Label slides/fades with the rail instead of popping — width, margin and
          opacity all animate over the same 200ms as the aside's width. */}
      <span
        className={cn(
          "overflow-hidden truncate whitespace-nowrap transition-all duration-200",
          collapsed ? "ml-0 max-w-0 opacity-0" : "ml-3 max-w-[170px] opacity-100",
        )}
      >
        {label}
      </span>
    </Link>
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  mobile = false,
  onNavigate,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Rendered as the mobile off-canvas drawer (always visible, never collapsed). */
  mobile?: boolean;
  /** Called when a nav link is clicked (used to close the mobile drawer). */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const resolved = useNavLayout();
  const groups = navGroupsFromLayout(resolved);
  const footer = footerFromLayout(resolved);
  return (
    <aside
      className={cn(
        "shrink-0 flex-col overflow-hidden border-r border-border bg-surface",
        mobile ? "flex h-full w-[244px]" : "hidden md:flex md:transition-[width] md:duration-300 md:ease-in-out",
        !mobile && (collapsed ? "w-[68px]" : "w-[244px]"),
      )}
    >
      <div className={cn("flex h-16 items-center px-4", collapsed ? "justify-center" : "justify-between")}>
        <Brand collapsed={collapsed} />
        {!mobile && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? t("expand", { defaultValue: "Expand sidebar" }) : t("collapse", { defaultValue: "Collapse" })}
            title={collapsed ? t("expand", { defaultValue: "Expand sidebar" }) : t("collapse", { defaultValue: "Collapse" })}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
        {groups.map((group) => (
          <div key={group.key} className="space-y-1">
            <p
              className={cn(
                "overflow-hidden px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-2 transition-all duration-200",
                collapsed ? "max-h-0 pb-0 opacity-0" : "max-h-6 pb-1 opacity-100",
              )}
            >
              {t(`navgroup_${group.key}`, { defaultValue: group.label })}
            </p>
            {group.items.map((item) => (
              <NavLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-border px-3 py-3">
        {footer.map((item) => (
          <NavLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </div>
    </aside>
  );
}
