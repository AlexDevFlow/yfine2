import { Link, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, Bell, BellOff, CheckCheck, HelpCircle, Info, Menu, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brand } from "./brand";
import { ALL_NAV } from "./nav";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { PrivacyControl } from "./privacy-control";
import { cn } from "@/lib/cn";
import { useRelativeTime } from "@/lib/use-relative-time";
import {
  useDeleteNotification,
  useMarkAllRead,
  useMarkRead,
  useRecentUnread,
  useUnreadCount,
} from "@/db/queries";
import type { NotificationType } from "@/db/repo/notifications";

const ICON: Record<NotificationType, typeof Info> = {
  info: Info,
  alert: Bell,
  warning: AlertTriangle,
};
const TONE: Record<NotificationType, string> = {
  info: "bg-accent-soft text-primary",
  alert: "bg-warning-soft text-warning",
  warning: "bg-negative-soft text-negative",
};

function NotificationBell() {
  const { t } = useTranslation();
  const { data: unread = 0 } = useUnreadCount();
  const { data: recent = [] } = useRecentUnread(5);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const del = useDeleteNotification();
  const relTime = useRelativeTime();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("notifications", { defaultValue: "Notifications" })}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-negative px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-40 w-80 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-pop)]"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold text-foreground">
              {t("notifications", { defaultValue: "Notifications" })}
            </span>
            {recent.length > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                {t("mark_all_read", { defaultValue: "Mark all as read" })}
              </button>
            )}
          </div>

          <ul className="max-h-80 overflow-y-auto">
            {recent.length === 0 && (
              <li className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted">
                <BellOff className="h-6 w-6 text-muted-2" />
                {t("no_notifications", { defaultValue: "No notifications." })}
              </li>
            )}
            {recent.map((n) => {
              const Icon = ICON[n.type] ?? Info;
              return (
                <li key={n.id} className="flex items-start gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0">
                  <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", TONE[n.type] ?? TONE.info)}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <button
                    type="button"
                    onClick={() => markRead.mutate(n.id)}
                    className="min-w-0 flex-1 text-left"
                    title={t("mark_read", { defaultValue: "Mark as read" })}
                  >
                    <p className="truncate text-sm font-medium text-foreground">{n.title}</p>
                    <p className="truncate text-xs text-muted">{n.body}</p>
                    <p className="mt-0.5 text-[11px] text-muted-2" title={new Date(n.created_at).toLocaleString()}>
                      {relTime(n.created_at)}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => del.mutate(n.id)}
                    aria-label={t("dismiss", { defaultValue: "Dismiss" })}
                    className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-negative-soft hover:text-negative"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-border p-2">
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="block rounded-[var(--radius-control)] bg-surface-2 py-1.5 text-center text-sm font-medium text-foreground transition-colors hover:bg-border"
            >
              {t("view_all", { defaultValue: "View All" })}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function usePageTitle(): string {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const match =
    pathname === "/"
      ? ALL_NAV[0]
      : ALL_NAV.find((i) => i.to !== "/" && pathname.startsWith(i.to));
  if (!match) return "Yfine";
  return t(match.key, { defaultValue: match.label });
}

export function Topbar({
  onOpenSearch,
  onOpenHelp,
  onOpenMobileNav,
}: {
  onOpenSearch: () => void;
  onOpenHelp: () => void;
  /** When set, a hamburger button is shown on mobile (sidebar nav mode). */
  onOpenMobileNav?: () => void;
}) {
  const { t } = useTranslation();
  const title = usePageTitle();
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background px-4 md:px-6">
      <div className="flex items-center gap-2 md:hidden">
        {onOpenMobileNav && (
          <button
            type="button"
            onClick={onOpenMobileNav}
            aria-label={t("menu", { defaultValue: "Menu" })}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <Brand />
      </div>
      <h1 className="hidden text-lg font-semibold tracking-tight text-foreground md:block">
        {title}
      </h1>

      <div className="flex flex-1 justify-end md:justify-center">
        <button
          type="button"
          onClick={onOpenSearch}
          className="group flex h-9 w-full max-w-sm items-center gap-2.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-muted transition-colors hover:border-border-strong"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">{t("search", { defaultValue: "Search" })}…</span>
          <kbd className="hidden rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted-2 sm:inline">
            {mod} K
          </kbd>
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenHelp}
          aria-label={t("help", { defaultValue: "Help" })}
          title={`${t("help", { defaultValue: "Help" })} (?)`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <HelpCircle className="h-[18px] w-[18px]" />
        </button>
        <PrivacyControl />
        <NotificationBell />
        <ThemeToggle />
      </div>
    </header>
  );
}
