import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useMarkRead, useRecentUnread } from "@/db/queries";
import type { NotificationRow, NotificationType } from "@/db/repo/notifications";
import { useToast, type ToastTone } from "@/components/ui/toast";

const SEEN_KEY = "yfine_seen_notifs";

const TONE: Record<NotificationType, ToastTone> = {
  info: "info",
  alert: "alert",
  warning: "warning",
};

/** Load the sessionStorage-persisted set of already-toasted notification ids. */
function loadSeen(): Set<number> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? (raw as number[]) : []);
  } catch {
    return new Set();
  }
}

function persistSeen(seen: Set<number>) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    /* sessionStorage unavailable — degrade to in-memory de-dup */
  }
}

/**
 * Watches the recent-unread poll (30s, via useRecentUnread) and pops a toast for
 * each genuinely new unread notification, de-duped against a sessionStorage
 * "seen" set so the same one is never toasted twice in a session. Ports the
 * pollNotifications/showNotifToast + yfine_seen_notifs logic from base.html.
 * Renders nothing; mount once near the app root.
 */
export function NotificationWatcher() {
  const { t } = useTranslation();
  const { data: recent } = useRecentUnread(5);
  const { push } = useToast();
  const markRead = useMarkRead();
  const seen = useRef<Set<number>>(loadSeen());
  // Skip toasting whatever is already unread when the watcher first mounts:
  // those are pre-existing, not "newly arrived" this session.
  const primed = useRef(false);

  useEffect(() => {
    if (!recent) return;
    const ids = recent.map((n) => n.id);

    if (!primed.current) {
      for (const id of ids) seen.current.add(id);
      persistSeen(seen.current);
      primed.current = true;
      return;
    }

    let added = false;
    for (const n of recent as NotificationRow[]) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      added = true;
      push({
        id: `notif-${n.id}`,
        title: n.title,
        body: n.body,
        tone: TONE[n.type] ?? "info",
        action: {
          label: t("mark_read", { defaultValue: "Mark as read" }),
          onClick: () => markRead.mutate(n.id),
        },
      });
    }
    if (added) persistSeen(seen.current);
    // markRead/push/t are stable; intentionally excluded to avoid re-priming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent]);

  return null;
}
