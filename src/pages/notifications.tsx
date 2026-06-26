import { AlertTriangle, Bell, CheckCheck, Info, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { NumberedPagination } from "@/components/ui/pagination";
import { cn } from "@/lib/cn";
import { useRelativeTime } from "@/lib/use-relative-time";
import {
  NOTIF_PAGE_SIZE,
  useDeleteAllRead,
  useDeleteNotification,
  useMarkAllRead,
  useMarkRead,
  useNotificationCounts,
  useNotifications,
} from "@/db/queries";
import type { NotificationFilter, NotificationType } from "@/db/repo/notifications";

type Filter = "all" | "unread" | NotificationType;

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

/** Map a UI filter tab to the SQL filter the repo applies. */
function toRepoFilter(f: Filter): NotificationFilter {
  if (f === "unread") return { unreadOnly: true };
  if (f === "all") return {};
  return { type: f };
}

export function NotificationsPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);
  const relTime = useRelativeTime();

  const { data, isLoading } = useNotifications(page, toRepoFilter(filter));
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / NOTIF_PAGE_SIZE));

  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const del = useDeleteNotification();
  const delAllRead = useDeleteAllRead();

  // Drive the table-wide bulk actions off GLOBAL counts, not the current page
  // slice: with the "Unread" filter active every visible row is unread, so a
  // page-local check would always hide "Delete read" even when read rows exist.
  const counts = useNotificationCounts();
  const hasUnread = (counts.data?.unread ?? 0) > 0;
  const hasRead = (counts.data?.read ?? 0) > 0;

  // Switching filters resets to page 1.
  const setFilterTab = (f: Filter) => {
    setFilter(f);
    setPage(1);
  };
  // Clamp during render if the active page no longer exists (e.g. after a
  // clear/delete shrank the result set) — React bails out when unchanged.
  if (page > totalPages) {
    setPage(totalPages);
  }

  const TABS: { key: Filter; label: string }[] = [
    { key: "all", label: t("all", { defaultValue: "All" }) },
    { key: "unread", label: t("unread", { defaultValue: "Unread" }) },
    { key: "alert", label: t("alert", { defaultValue: "Alert" }) },
    { key: "info", label: t("info", { defaultValue: "Info" }) },
    { key: "warning", label: t("warning", { defaultValue: "Warning" }) },
  ];

  const start = total === 0 ? 0 : (page - 1) * NOTIF_PAGE_SIZE + 1;
  const end = Math.min(page * NOTIF_PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{t("notifications_subtitle", { defaultValue: "Alerts, confirmations and warnings." })}</p>
        <div className="flex items-center gap-2">
          {hasRead && (
            <Button variant="ghost" onClick={() => setConfirmClear(true)}>
              <Trash2 className="h-4 w-4" /> {t("delete_all_read", { defaultValue: "Delete read" })}
            </Button>
          )}
          {hasUnread && (
            <Button variant="outline" onClick={() => markAll.mutate()}>
              <CheckCheck className="h-4 w-4" /> {t("mark_all_read", { defaultValue: "Mark all read" })}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilterTab(tab.key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              filter === tab.key ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading && <Card className="p-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</Card>}
      {data && items.length === 0 && (
        <Card className="p-10 text-center text-sm text-muted">{t("no_notifications", { defaultValue: "No notifications." })}</Card>
      )}

      <div className="space-y-2">
        {items.map((n) => {
          const Icon = ICON[n.type] ?? Info;
          return (
            <Card key={n.id} className={cn("flex items-start gap-3 p-4", n.is_read === 0 && "border-l-2 border-l-primary")}>
              <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)]", TONE[n.type] ?? TONE.info)}>
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm", n.is_read === 0 ? "font-semibold text-foreground" : "text-foreground")}>{n.title}</p>
                <p className="text-sm text-muted">{n.body}</p>
                <p className="mt-0.5 text-xs text-muted-2" title={new Date(n.created_at).toLocaleString()}>
                  {relTime(n.created_at)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {n.is_read === 0 && (
                  <button onClick={() => markRead.mutate(n.id)} aria-label={t("mark_read", { defaultValue: "Mark read" })} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-foreground">
                    <CheckCheck className="h-4 w-4" />
                  </button>
                )}
                <button onClick={() => del.mutate(n.id)} aria-label={t("delete", { defaultValue: "Delete" })} className="rounded-md p-1.5 text-muted hover:bg-negative-soft hover:text-negative">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </Card>
          );
        })}
      </div>

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <p className="text-xs text-muted">
            {t("showing_of", { defaultValue: "Showing {{start}}-{{end}} of {{total}}", start, end, total })}
          </p>
          {totalPages > 1 && (
            <NumberedPagination page={page} totalPages={totalPages} onPageChange={setPage} />
          )}
        </div>
      )}

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={t("delete_all_read", { defaultValue: "Delete read" })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              {t("cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                delAllRead.mutate();
                setConfirmClear(false);
              }}
            >
              {t("delete", { defaultValue: "Delete" })}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          {t("confirm_delete_all_read", {
            defaultValue: "All read notifications will be permanently deleted. This cannot be undone.",
          })}
        </p>
      </Modal>
    </div>
  );
}
