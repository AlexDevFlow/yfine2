import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import {
  countNotifications,
  createNotification,
  listNotifications,
  type NotificationType,
} from "./notifications";
import type { SqlExecutor } from "@/db/types";

/** Insert `n` notifications of a type with controllable created_at ordering. */
async function seed(
  db: SqlExecutor,
  type: NotificationType,
  n: number,
  opts: { read?: boolean; from?: number } = {},
): Promise<void> {
  const from = opts.from ?? 0;
  for (let i = 0; i < n; i++) {
    // created_at strictly increasing so DESC ordering is deterministic.
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, from + i)).toISOString();
    await db.execute(
      `INSERT INTO notifications (type,title,body,related_entity,is_read,created_at) VALUES (?,?,?,?,?,?)`,
      [type, `${type}-${from + i}`, "body", null, opts.read ? 1 : 0, ts],
    );
  }
}

describe("notifications repo: pagination + count", () => {
  it("listNotifications pages with LIMIT/OFFSET, newest first, no overlap", async () => {
    const { db } = await makeMemDb();
    await seed(db, "info", 25);

    const page1 = await listNotifications(db, { limit: 20, offset: 0 });
    const page2 = await listNotifications(db, { limit: 20, offset: 20 });

    expect(page1).toHaveLength(20);
    expect(page2).toHaveLength(5);
    // Newest first: info-24 is the most recent row.
    expect(page1[0].title).toBe("info-24");
    expect(page1[19].title).toBe("info-5");
    expect(page2[0].title).toBe("info-4");
    // No id appears on both pages.
    const ids1 = new Set(page1.map((n) => n.id));
    expect(page2.some((n) => ids1.has(n.id))).toBe(false);
  });

  it("defaults to limit 100 / offset 0 when unspecified", async () => {
    const { db } = await makeMemDb();
    await seed(db, "info", 3);
    const all = await listNotifications(db);
    expect(all).toHaveLength(3);
    expect(all[0].title).toBe("info-2");
  });

  it("countNotifications returns the total ignoring limit/offset", async () => {
    const { db } = await makeMemDb();
    await seed(db, "info", 42);
    expect(await countNotifications(db)).toBe(42);
    // count is independent of any page window
    const page = await listNotifications(db, { limit: 20, offset: 40 });
    expect(page).toHaveLength(2);
  });

  it("applies the unreadOnly filter to both list and count", async () => {
    const { db } = await makeMemDb();
    await seed(db, "info", 5, { read: false, from: 0 });
    await seed(db, "info", 3, { read: true, from: 100 });

    expect(await countNotifications(db)).toBe(8);
    expect(await countNotifications(db, { unreadOnly: true })).toBe(5);
    const unread = await listNotifications(db, { unreadOnly: true, limit: 50 });
    expect(unread).toHaveLength(5);
    expect(unread.every((n) => n.is_read === 0)).toBe(true);
  });

  it("applies the type filter to both list and count", async () => {
    const { db } = await makeMemDb();
    await seed(db, "info", 4, { from: 0 });
    await seed(db, "alert", 3, { from: 100 });
    await seed(db, "warning", 2, { from: 200 });

    expect(await countNotifications(db, { type: "alert" })).toBe(3);
    expect(await countNotifications(db, { type: "warning" })).toBe(2);
    const alerts = await listNotifications(db, { type: "alert", limit: 50 });
    expect(alerts).toHaveLength(3);
    expect(alerts.every((n) => n.type === "alert")).toBe(true);
  });

  it("combines unreadOnly + type in the same filter", async () => {
    const { db } = await makeMemDb();
    await seed(db, "alert", 3, { read: false, from: 0 });
    await seed(db, "alert", 2, { read: true, from: 100 });

    expect(await countNotifications(db, { type: "alert", unreadOnly: true })).toBe(3);
    const rows = await listNotifications(db, { type: "alert", unreadOnly: true, limit: 50 });
    expect(rows).toHaveLength(3);
    expect(rows.every((n) => n.type === "alert" && n.is_read === 0)).toBe(true);
  });

  it("createNotification is unread by default and counted", async () => {
    const { db } = await makeMemDb();
    await createNotification(db, { type: "warning", title: "Budget", body: "Over 90%" });
    const rows = await listNotifications(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_read).toBe(0);
    expect(await countNotifications(db, { unreadOnly: true })).toBe(1);
  });
});
