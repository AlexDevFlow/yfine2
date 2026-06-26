import { describe, it, expect } from "vitest";
import { makeMemDb } from "@/test/sqlite";
import type { SqlExecutor } from "../types";
import { createSource } from "./sources";
import { updateSettings } from "./settings";
import {
  listSavedViews,
  listTemplates,
  saveSavedViews,
  saveTemplates,
} from "./movement-templates";

async function addTag(db: SqlExecutor, name: string): Promise<number> {
  const r = await db.select<{ id: number }>(
    `INSERT INTO tags (name,created_at,updated_at) VALUES (?,?,?) RETURNING id`,
    [name, "t", "t"],
  );
  return r[0].id;
}

describe("quick-add templates", () => {
  it("round-trips a saved template", async () => {
    const { db } = await makeMemDb();
    const s = await createSource(db, { name: "Wallet", currency: "EUR" });
    const tag = await addTag(db, "Food");
    await saveTemplates(db, [
      { name: "Coffee", direction: "out", source_id: s.id, amount: 2.5, tag_ids: [tag], note: "morning" },
    ]);
    const out = await listTemplates(db);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Coffee", direction: "out", source_id: s.id, amount: 2.5, note: "morning" });
    expect(out[0].tag_ids).toEqual([tag]);
  });

  it("prunes stale source/tag ids and skips nameless entries", async () => {
    const { db } = await makeMemDb();
    // hand-write a blob with a missing source (999), a missing tag (888), and a nameless item
    await updateSettings(db, {
      movement_templates_json: JSON.stringify([
        { name: "Ghost", direction: "out", source_id: 999, amount: "10", tag_ids: [888], note: null },
        { direction: "in" }, // no name → dropped
        { name: "Weird dir", direction: "sideways" }, // direction normalized to "out"
      ]),
    });
    const out = await listTemplates(db);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "Ghost", source_id: null, amount: 10, tag_ids: [] });
    expect(out[1]).toMatchObject({ name: "Weird dir", direction: "out" });
  });

  it("tolerates a corrupt blob", async () => {
    const { db } = await makeMemDb();
    await updateSettings(db, { movement_templates_json: "not json" });
    expect(await listTemplates(db)).toEqual([]);
  });
});

describe("saved views", () => {
  it("round-trips a view and prunes non-object params", async () => {
    const { db } = await makeMemDb();
    await saveSavedViews(db, [{ name: "Groceries Q2", params: { tag_ids: [1, 2], date_from: "2026-04-01" } }]);
    const out = await listSavedViews(db);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Groceries Q2");
    expect(out[0].params).toMatchObject({ tag_ids: [1, 2], date_from: "2026-04-01" });

    // a view with a missing/array params is dropped
    await updateSettings(db, {
      saved_views_json: JSON.stringify([{ name: "bad", params: [1, 2] }, { name: "ok", params: {} }]),
    });
    const out2 = await listSavedViews(db);
    expect(out2.map((v) => v.name)).toEqual(["ok"]);
  });
});
