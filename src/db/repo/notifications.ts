import type { SqlExecutor } from "../types";

export type NotificationType = "info" | "alert" | "warning";

export interface NotificationRow {
  id: number;
  type: NotificationType;
  title: string;
  body: string;
  related_entity: string | null;
  is_read: number;
  created_at: string;
}

const now = () => new Date().toISOString();

export async function createNotification(
  db: SqlExecutor,
  n: { type: NotificationType; title: string; body: string; related_entity?: string | null },
): Promise<void> {
  await db.execute(
    `INSERT INTO notifications (type,title,body,related_entity,is_read,created_at) VALUES (?,?,?,?,0,?)`,
    [n.type, n.title, n.body, n.related_entity ?? null, now()],
  );
}

/** True if an UNREAD notification exists for this exact related_entity. */
export async function hasUnread(db: SqlExecutor, relatedEntity: string): Promise<boolean> {
  const r = await db.select<{ c: number }>(
    `SELECT COUNT(*) c FROM notifications WHERE related_entity = ? AND is_read = 0`,
    [relatedEntity],
  );
  return (r[0]?.c ?? 0) > 0;
}

/** Filter applied to a notification list/count, mirroring the legacy
 * `filter` query param: unread-only or a single type, applied in SQL so paging
 * and counts both reflect the active filter. */
export interface NotificationFilter {
  unreadOnly?: boolean;
  type?: NotificationType;
}

/** Build the shared WHERE clause + params for list/count, given a filter. */
function whereFor(filter: NotificationFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.unreadOnly) clauses.push("is_read = 0");
  if (filter.type) {
    clauses.push("type = ?");
    params.push(filter.type);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export async function listNotifications(
  db: SqlExecutor,
  opts: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType } = {},
): Promise<NotificationRow[]> {
  const { sql: where, params } = whereFor(opts);
  return db.select<NotificationRow>(
    `SELECT id,type,title,body,related_entity,is_read,created_at FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit ?? 100, opts.offset ?? 0],
  );
}

/** Total rows matching `filter` (ignores limit/offset), for pagination. */
export async function countNotifications(
  db: SqlExecutor,
  filter: NotificationFilter = {},
): Promise<number> {
  const { sql: where, params } = whereFor(filter);
  const r = await db.select<{ c: number }>(
    `SELECT COUNT(*) c FROM notifications ${where}`,
    params,
  );
  return r[0]?.c ?? 0;
}

export async function unreadCount(db: SqlExecutor): Promise<number> {
  const r = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM notifications WHERE is_read = 0`);
  return r[0]?.c ?? 0;
}

export async function markRead(db: SqlExecutor, id: number): Promise<void> {
  await db.execute(`UPDATE notifications SET is_read = 1 WHERE id = ?`, [id]);
}

export async function markAllRead(db: SqlExecutor): Promise<void> {
  await db.execute(`UPDATE notifications SET is_read = 1 WHERE is_read = 0`);
}

export async function deleteNotification(db: SqlExecutor, id: number): Promise<void> {
  await db.execute(`DELETE FROM notifications WHERE id = ?`, [id]);
}

export async function deleteAllRead(db: SqlExecutor): Promise<void> {
  await db.execute(`DELETE FROM notifications WHERE is_read = 1`);
}
