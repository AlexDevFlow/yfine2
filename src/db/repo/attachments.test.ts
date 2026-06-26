import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import { createSource } from "./sources";
import { createMovement, deleteMovement } from "./movements";
import { addAttachment, listAttachments, validateAttachment, MAX_PER_MOVEMENT, type FileWriter } from "./attachments";

const PNG: FileWriter = async () => {}; // no-op writer (no fs in node test env)

function file(name: string, type: string, size: number) {
  return { name, type, bytes: new Uint8Array(size) };
}

describe("attachment validation (pure)", () => {
  it("rejects empty, oversize, unsupported, and over-limit", () => {
    expect(() => validateAttachment(file("a.png", "image/png", 0), 0)).toThrow(/attachment_empty/);
    expect(() => validateAttachment(file("a.png", "image/png", 11 * 1024 * 1024), 0)).toThrow(/attachment_too_large/);
    expect(() => validateAttachment(file("a.exe", "application/octet-stream", 10), 0)).toThrow(/attachment_unsupported/);
    expect(() => validateAttachment(file("a.png", "image/png", 10), MAX_PER_MOVEMENT)).toThrow(/attachment_limit_reached/);
  });

  it("accepts allowed types — mime wins over the filename extension", () => {
    expect(validateAttachment(file("r.png", "image/png", 5), 0)).toMatchObject({ ext: ".png", mime: "image/png" });
    // a recognised mime takes precedence over a mismatched extension
    expect(validateAttachment(file("r.pdf", "image/jpeg", 5), 0)).toMatchObject({ ext: ".jpg", mime: "image/jpeg" });
    expect(validateAttachment(file("r.webp", "image/webp", 5), 0)).toMatchObject({ ext: ".webp", mime: "image/webp" });
  });

  it("falls back to the filename extension when the mime is vague", () => {
    // browser sent application/octet-stream for a PDF → resolve by extension + canonicalize mime
    expect(validateAttachment(file("receipt.pdf", "application/octet-stream", 5), 0)).toMatchObject({
      ext: ".pdf",
      mime: "application/pdf",
    });
  });
});

describe("addAttachment (DB + validation)", () => {
  it("enforces the 5-file limit per movement and the empty check", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "A", currency: "EUR" });
    const mid = await createMovement(db, { source_id: s.id, amount: 1, direction: "out", date: "2026-05-01" });

    for (let i = 0; i < MAX_PER_MOVEMENT; i++) {
      await addAttachment(db, mid, file(`r${i}.png`, "image/png", 100), PNG);
    }
    await expect(addAttachment(db, mid, file("x.png", "image/png", 100), PNG)).rejects.toMatchObject({
      code: "attachment_limit_reached",
    });
    const count = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movement_attachments WHERE movement_id = ?`, [mid]);
    expect(count[0].c).toBe(MAX_PER_MOVEMENT);

    // empty-file check (on a fresh movement so the limit check doesn't pre-empt it)
    const mid2 = await createMovement(db, { source_id: s.id, amount: 1, direction: "out", date: "2026-05-02" });
    await expect(addAttachment(db, mid2, file("empty.png", "image/png", 0), PNG)).rejects.toMatchObject({
      code: "attachment_empty",
    });
  });

  it("stores the canonical mime + the resolved extension", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "A", currency: "EUR" });
    const mid = await createMovement(db, { source_id: s.id, amount: 1, direction: "out", date: "2026-05-01" });
    await addAttachment(db, mid, file("receipt.pdf", "application/octet-stream", 200), PNG);
    const rows = await db.select<{ mime_type: string; stored_name: string; size_bytes: number }>(
      `SELECT mime_type, stored_name, size_bytes FROM movement_attachments WHERE movement_id = ?`,
      [mid],
    );
    expect(rows[0].mime_type).toBe("application/pdf");
    expect(rows[0].stored_name.endsWith(".pdf")).toBe(true);
    expect(rows[0].size_bytes).toBe(200);
  });

  it("rejects an attachment on a non-existent movement", async () => {
    const { db } = await makeMemDb();
    await expect(addAttachment(db, 9999, file("r.png", "image/png", 10), PNG)).rejects.toMatchObject({ code: "not_found" });
  });

  it("the delete cascade purges attachment rows (file cleanup is best-effort)", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "A", currency: "EUR" });
    const mid = await createMovement(db, { source_id: s.id, amount: 1, direction: "out", date: "2026-05-01" });
    await addAttachment(db, mid, file("r.png", "image/png", 50), PNG);
    expect((await listAttachments(db, mid)).length).toBe(1);

    // purgeAttachmentFiles runs first; with no fs it swallows the error and the
    // row delete still completes — no orphaned rows remain.
    await deleteMovement(db, mid);
    const left = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movement_attachments WHERE movement_id = ?`, [mid]);
    expect(left[0].c).toBe(0);
  });
});
