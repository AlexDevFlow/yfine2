/**
 * Quick-add movement templates and saved filter views.
 *
 * Both are stored as JSON-setting blobs on the singleton settings row
 * (movement_templates_json / saved_views_json), written whole. These read
 * helpers parse defensively and prune references to sources/tags that no longer
 * exist — a faithful port of services/movement_templates.py.
 */
import type { SqlExecutor } from "../types";
import { getSettings, updateSettings } from "./settings";

export interface MovementTemplate {
  name: string;
  direction: "in" | "out";
  source_id: number | null;
  amount: number | null;
  tag_ids: number[];
  note: string | null;
}

/** Filter params captured by a saved view (a subset of MovementFilters, serialized). */
export interface SavedView {
  name: string;
  params: Record<string, unknown>;
}

function parseList(raw: string | null | undefined): unknown[] {
  try {
    const data = JSON.parse(raw || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Parsed quick-add templates with stale source_id / tag_ids pruned. */
export async function listTemplates(db: SqlExecutor): Promise<MovementTemplate[]> {
  const s = await getSettings(db);
  const items = parseList(s.movement_templates_json);
  const validSources = new Set(
    (await db.select<{ id: number }>(`SELECT id FROM sources`)).map((r) => r.id),
  );
  const validTags = new Set((await db.select<{ id: number }>(`SELECT id FROM tags`)).map((r) => r.id));

  const clean: MovementTemplate[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw == null) continue;
    const it = raw as Record<string, unknown>;
    if (!it.name) continue;
    let sid = it.source_id as number | null | undefined;
    if (sid != null && !validSources.has(sid)) sid = null;
    let amount: number | null = null;
    if (it.amount != null) {
      const n = Number(it.amount);
      amount = Number.isFinite(n) ? n : null;
    }
    clean.push({
      name: String(it.name).slice(0, 200),
      direction: it.direction === "in" || it.direction === "out" ? it.direction : "out",
      source_id: sid ?? null,
      amount,
      tag_ids: Array.isArray(it.tag_ids) ? (it.tag_ids as number[]).filter((t) => validTags.has(t)) : [],
      note: (it.note as string) || null,
    });
  }
  return clean;
}

/** Replace the whole templates blob (the UI manages add/delete, then PUTs the array). */
export async function saveTemplates(db: SqlExecutor, templates: MovementTemplate[]): Promise<void> {
  const normalized = templates.slice(0, 200).map((t) => ({
    name: String(t.name).slice(0, 200),
    direction: t.direction === "in" ? "in" : "out",
    source_id: t.source_id ?? null,
    amount: t.amount ?? null,
    tag_ids: Array.isArray(t.tag_ids) ? t.tag_ids : [],
    note: t.note || null,
  }));
  await updateSettings(db, { movement_templates_json: JSON.stringify(normalized) });
}

/** Parsed saved filter views (params passed through; stale ids just match less). */
export async function listSavedViews(db: SqlExecutor): Promise<SavedView[]> {
  const s = await getSettings(db);
  const items = parseList(s.saved_views_json);
  const clean: SavedView[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw == null) continue;
    const it = raw as Record<string, unknown>;
    if (it.name && typeof it.params === "object" && it.params != null && !Array.isArray(it.params)) {
      clean.push({ name: String(it.name).slice(0, 200), params: it.params as Record<string, unknown> });
    }
  }
  return clean;
}

/** Replace the whole saved-views blob. */
export async function saveSavedViews(db: SqlExecutor, views: SavedView[]): Promise<void> {
  const normalized = views.slice(0, 200).map((v) => ({
    name: String(v.name).slice(0, 200),
    params: v.params && typeof v.params === "object" ? v.params : {},
  }));
  await updateSettings(db, { saved_views_json: JSON.stringify(normalized) });
}
