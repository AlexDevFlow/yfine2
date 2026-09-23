/**
 * Global search across entities (refactor-analysis/dashboard-search.md §3.27-33).
 * Case-insensitive substring (LIKE %q% with wildcards escaped); movements also
 * match an exact amount when q parses as a positive number. Includes GOALS,
 * closing the legacy gap (BUG-3), and SAVINGS (gap 6, invariants 28/32 — dual
 * source: is_savings_contribution movements joined to fund + legacy savings).
 * Each group capped at `limit`. Results carry per-type entity context (amount,
 * date, source, tags, status, frequency, usage count) so the palette can render
 * grouped, highlighted, contextual rows (gap 3).
 */
import type { SqlExecutor } from "../types";

export type SearchType = "movement" | "source" | "tag" | "saving" | "whim" | "recurring" | "goal" | "budget" | "portfolio";

export interface SearchTag {
  id: number;
  name: string;
  color: string | null;
}

export interface SearchItem {
  type: SearchType;
  id: number;
  label: string;
  sublabel?: string;
  /** Per-type entity context for the palette renderer. */
  amount?: number;
  currency?: string;
  direction?: "in" | "out";
  date?: string;
  source?: string | null;
  is_transfer?: boolean;
  tags?: SearchTag[];
  count?: number;
  status?: string;
  frequency?: string;
  next_due_date?: string | null;
  /** Budget period (weekly/monthly/…) and portfolio kind (crypto/stocks/mixed). */
  period?: string;
  kind?: string;
}

function likeParam(q: string): string {
  return "%" + q.replace(/([\\%_])/g, "\\$1") + "%";
}

export async function searchAll(
  db: SqlExecutor,
  query: string,
  limit = 8,
): Promise<SearchItem[]> {
  const q = query.trim();
  if (q.length < 2 || q.length > 100) return [];
  const like = likeParam(q);
  const out: SearchItem[] = [];

  // --- Movements (enriched with source, tags, transfer flag) ---
  const numeric = Number(q.replace(",", "."));
  const amountMatch = Number.isFinite(numeric) && numeric > 0;
  const movs = await db.select<{
    id: number;
    note: string | null;
    amount: number;
    direction: "in" | "out";
    date: string;
    source_name: string | null;
    currency: string | null;
    transfer_pair_id: number | null;
  }>(
    `SELECT m.id, m.note, m.amount, m.direction, m.date, m.transfer_pair_id, s.name AS source_name, s.currency AS currency
     FROM movements m LEFT JOIN sources s ON m.source_id = s.id
     WHERE m.note LIKE ? ESCAPE '\\'${amountMatch ? " OR m.amount = ?" : ""}
     ORDER BY m.date DESC, m.id DESC LIMIT ?`,
    amountMatch ? [like, numeric, limit] : [like, limit],
  );
  const movTags = await loadTags(db, movs.map((m) => m.id));
  for (const m of movs) {
    out.push({
      type: "movement",
      id: m.id,
      label: m.note || `${m.direction === "in" ? "+" : "−"}${m.amount.toFixed(2)}`,
      sublabel: `${m.source_name ?? "External"} · ${m.date}`,
      amount: m.amount,
      currency: m.currency ?? undefined,
      direction: m.direction,
      date: m.date,
      source: m.source_name,
      is_transfer: m.transfer_pair_id != null,
      tags: movTags.get(m.id) ?? [],
    });
  }

  // --- Sources ---
  const sources = await db.select<{ id: number; name: string; currency: string }>(
    `SELECT id,name,currency FROM sources WHERE name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT ?`,
    [like, limit],
  );
  for (const s of sources) out.push({ type: "source", id: s.id, label: s.name, sublabel: s.currency, currency: s.currency });

  // --- Savings (dual source: contribution movements + legacy savings rows) ---
  const savMovs = await db.select<{ id: number; amount: number; note: string | null; date: string; currency: string | null }>(
    `SELECT m.id, m.amount, m.note, m.date, f.currency AS currency
     FROM movements m JOIN sources f ON m.source_id = f.id
     WHERE m.is_savings_contribution = 1 AND m.note LIKE ? ESCAPE '\\'
     ORDER BY m.date DESC, m.id DESC LIMIT ?`,
    [like, limit],
  );
  const savings: SearchItem[] = savMovs.map((s) => ({
    type: "saving" as const,
    id: s.id,
    label: s.note || `+${s.amount.toFixed(2)}`,
    sublabel: `${s.currency ?? ""} · ${s.date}`.trim(),
    amount: s.amount,
    currency: s.currency ?? undefined,
    date: s.date,
  }));
  const legacy = await db.select<{ id: number; amount: number; currency: string; date: string; description: string | null; note: string | null }>(
    `SELECT id, amount, currency, date, description, note FROM savings
     WHERE description LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\'
     ORDER BY date DESC, id DESC LIMIT ?`,
    [like, like, limit],
  );
  for (const s of legacy) {
    savings.push({
      type: "saving",
      id: s.id,
      label: s.description || s.note || `+${s.amount.toFixed(2)}`,
      sublabel: `${s.currency} · ${s.date}`,
      amount: s.amount,
      currency: s.currency,
      date: s.date,
    });
  }
  // Merge then truncate to limit (movements first), per invariant 32.
  for (const s of savings.slice(0, limit)) out.push(s);

  // --- Tags (with usage count) ---
  const tags = await db.select<{ id: number; name: string; color: string | null; count: number }>(
    `SELECT t.id, t.name, t.color, COUNT(mt.movement_id) AS count
     FROM tags t LEFT JOIN movement_tag mt ON mt.tag_id = t.id
     WHERE t.name LIKE ? ESCAPE '\\'
     GROUP BY t.id ORDER BY t.name COLLATE NOCASE LIMIT ?`,
    [like, limit],
  );
  for (const t of tags) out.push({ type: "tag", id: t.id, label: t.name, count: t.count });

  // --- Whims (with amount + status) ---
  const whims = await db.select<{ id: number; name: string; amount: number; currency: string; status: string }>(
    `SELECT id,name,amount,currency,status FROM whims WHERE name LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT ?`,
    [like, like, limit],
  );
  for (const w of whims) {
    out.push({ type: "whim", id: w.id, label: w.name, amount: w.amount, currency: w.currency, status: w.status });
  }

  // --- Recurring (with amount + frequency + next due date) ---
  const rec = await db.select<{ id: number; name: string; amount: number; currency: string; direction: "in" | "out"; frequency: string; next_due_date: string | null }>(
    `SELECT id,name,amount,currency,direction,frequency,next_due_date FROM recurring_items WHERE name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT ?`,
    [like, limit],
  );
  for (const r of rec) {
    out.push({
      type: "recurring",
      id: r.id,
      label: r.name,
      amount: r.amount,
      currency: r.currency,
      direction: r.direction,
      frequency: r.frequency,
      next_due_date: r.next_due_date,
    });
  }

  // --- Goals ---
  const goals = await db.select<{ id: number; name: string }>(
    `SELECT id,name FROM goals WHERE name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT ?`,
    [like, limit],
  );
  for (const g of goals) out.push({ type: "goal", id: g.id, label: g.name });

  // --- Budgets (tag-based: match the tag name; carry amount + period) ---
  const budgets = await db.select<{ id: number; amount: number; currency: string; period: string; direction: "in" | "out"; tag_name: string }>(
    `SELECT b.id, b.amount, b.currency, b.period, b.direction, t.name AS tag_name
     FROM budgets b JOIN tags t ON t.id = b.tag_id
     WHERE b.active = 1 AND t.name LIKE ? ESCAPE '\\'
     ORDER BY t.name COLLATE NOCASE LIMIT ?`,
    [like, limit],
  );
  for (const b of budgets) {
    out.push({
      type: "budget",
      id: b.id,
      label: b.tag_name,
      amount: b.amount,
      currency: b.currency,
      direction: b.direction,
      period: b.period,
    });
  }

  // --- Portfolios (match name or note; carry kind) ---
  const portfolios = await db.select<{ id: number; name: string; kind: string; base_currency: string }>(
    `SELECT id, name, kind, base_currency FROM portfolios
     WHERE name LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\'
     ORDER BY name COLLATE NOCASE LIMIT ?`,
    [like, like, limit],
  );
  for (const p of portfolios) {
    out.push({ type: "portfolio", id: p.id, label: p.name, kind: p.kind, currency: p.base_currency });
  }

  return out;
}

async function loadTags(db: SqlExecutor, movementIds: number[]): Promise<Map<number, SearchTag[]>> {
  const map = new Map<number, SearchTag[]>();
  if (movementIds.length === 0) return map;
  const ph = movementIds.map(() => "?").join(",");
  const rows = await db.select<{ movement_id: number; id: number; name: string; color: string | null }>(
    `SELECT mt.movement_id, t.id, t.name, t.color
     FROM movement_tag mt JOIN tags t ON t.id = mt.tag_id
     WHERE mt.movement_id IN (${ph}) ORDER BY t.name COLLATE NOCASE`,
    movementIds,
  );
  for (const r of rows) {
    const arr = map.get(r.movement_id) ?? [];
    arr.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.movement_id, arr);
  }
  return map;
}

/**
 * Navigation targets. Sources have a real detail route; the rest deep-link to
 * the list page with a `focus` search param so the page can scroll-and-highlight
 * (gap 5). Use buildSearchRoute() to attach the id.
 */
export const SEARCH_ROUTES: Record<SearchType, string> = {
  movement: "/movements",
  source: "/sources",
  tag: "/tags",
  saving: "/savings",
  whim: "/whims",
  recurring: "/recurring",
  goal: "/goals",
  budget: "/budgets",
  portfolio: "/portfolios",
};

/** Group display order (mirrors the original GROUP_ORDER). */
export const SEARCH_GROUP_ORDER: SearchType[] = [
  "movement",
  "source",
  "saving",
  "whim",
  "recurring",
  "budget",
  "portfolio",
  "tag",
  "goal",
];

/**
 * Deep-link target for a search result (gap 5). Sources have a real detail
 * route; movements deep-link to /movements?focus={id} so the page can
 * scroll-and-highlight; the rest open their list page (no detail route yet).
 */
export function buildSearchTarget(item: SearchItem): { to: string; search?: Record<string, unknown> } {
  if (item.type === "source") return { to: "/sources/$id".replace("$id", String(item.id)) };
  if (item.type === "movement") return { to: "/movements", search: { focus: item.id } };
  if (item.type === "saving") return { to: "/savings", search: { focus: item.id } };
  return { to: SEARCH_ROUTES[item.type] };
}
