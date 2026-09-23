/**
 * Spreadsheet / PDF exports with selectable sections (parity with the original
 * app's Excel + PDF export). Pure client-side via SheetJS and jsPDF.
 *
 * Data contract (refactor-analysis/exports-data.md §3.4): the report ALWAYS
 * leads with an "Overview" sheet/page carrying net-worth-by-currency KPIs plus
 * source/movement/tag counts, and every section carries a summary band
 * (income/expense/net, monthly-equivalence, by-status totals) before its table.
 * Sections are emitted in a fixed canonical order; an empty selection exports
 * all sections (invariant #14).
 */
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { SqlExecutor } from "./types";
import * as sources from "./repo/sources";
import * as movements from "./repo/movements";
import * as tags from "./repo/tags";
import * as recurring from "./repo/recurring";
import * as savings from "./repo/savings";
import * as whims from "./repo/whims";
import { netWorth } from "./repo/dashboard";
import { getSettings, parseNetWorthExcluded } from "./repo/settings";
import { netWorthByCurrency, round2 } from "@/domain/money";
import { todayISO } from "@/lib/date";
import { version as APP_VERSION } from "../../package.json";

export type SectionKey = "sources" | "movements" | "tags" | "recurring" | "savings" | "whims";

/** Excel display format for monetary cells (Excel renders separators per the OS locale). */
const MONEY_FMT = "#,##0.00";
/** Detail-table column headers whose numeric cells are money (vs counts/percentages). */
const MONEY_HEADERS = new Set(["Amount", "Balance", "Starting"]);
/** A summary label ending in a currency tag, e.g. "Net Worth (EUR)" / "Income (—)". */
const CURRENCY_LABEL = /\([A-Z]{3}\)$|\(—\)$/;

/**
 * Tag monetary cells in a freshly built worksheet with a thousands+2dp number
 * format: every currency-labelled summary value (col B) and every numeric cell in
 * a money column of the detail table. Counts/percentages are left as-is. `aoa` is
 * the pre-`safeRow` array (same cell positions as the sheet) used to classify cells.
 */
function formatMoneyCells(
  ws: XLSX.WorkSheet,
  aoa: (string | number)[][],
  columns?: string[],
  columnsRowIndex = -1,
): void {
  const set = (r: number, c: number) => {
    const a = XLSX.utils.encode_cell({ r, c });
    if (ws[a] && ws[a].t === "n") ws[a].z = MONEY_FMT;
  };
  for (let r = 0; r < aoa.length; r++) {
    if (typeof aoa[r][0] === "string" && CURRENCY_LABEL.test(aoa[r][0] as string) && typeof aoa[r][1] === "number") set(r, 1);
  }
  if (columns && columnsRowIndex >= 0) {
    const moneyCols = columns.map((c, i) => (MONEY_HEADERS.has(c) ? i : -1)).filter((i) => i >= 0);
    for (let r = columnsRowIndex + 1; r < aoa.length; r++) {
      for (const c of moneyCols) if (typeof aoa[r][c] === "number") set(r, c);
    }
  }
}

export const EXPORT_SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "sources", label: "Sources" },
  { key: "movements", label: "Movements" },
  { key: "tags", label: "Tags" },
  { key: "recurring", label: "Recurring" },
  { key: "savings", label: "Savings" },
  { key: "whims", label: "Whims" },
];

/**
 * Monthly-equivalence factors for recurring items — the SAME ones the
 * Recurring page's summary uses, so the exported "Monthly expense" never
 * disagrees with the number shown in the app (the legacy export rounded to
 * 30 days/month and 4.33 weeks/month and drifted from it).
 */
const FREQ_MONTHLY_FACTOR: Record<string, number> = recurring.MONTHLY_MULTIPLIER;

interface Section {
  title: string;
  /** Label/value summary KPIs shown above the table (income/expense/net, …). */
  summary: [string, string | number][];
  columns: string[];
  rows: (string | number)[][];
}

interface Overview {
  title: string;
  /** Net-worth-by-currency + count KPIs (label, value). */
  kpis: [string, string | number][];
}

/** Cached source list + batch balances (identical fetch used by overview + sources section). */
type SourceData = { list: Awaited<ReturnType<typeof sources.listSources>>; balances: Awaited<ReturnType<typeof sources.getBalancesBatch>> };

/**
 * Lazily fetch the source list + batch balances at most once per export run.
 * buildOverview and buildSection('sources') need the identical data; the FIRST
 * caller triggers the real queries (at the same point in the await sequence as
 * before), and the second reuses the in-flight/resolved promise — removing the
 * redundant duplicate fetch without changing observable query ordering.
 */
function makeSourceCache(db: SqlExecutor): () => Promise<SourceData> {
  let cached: Promise<SourceData> | undefined;
  return () => {
    if (!cached) {
      cached = Promise.all([
        sources.listSources(db, { includeHidden: true }),
        sources.getBalancesBatch(db),
      ]).then(([list, balances]) => ({ list, balances }));
    }
    return cached;
  };
}

/**
 * Net-worth-by-currency block plus source/movement/tag counts (data contract
 * §3.4). net_worth = starting_balance + Σin − Σout per source, grouped by
 * currency with NO FX netting (invariant #13).
 */
async function buildOverview(db: SqlExecutor, sourceCache: () => Promise<SourceData>): Promise<Overview> {
  const { list } = await sourceCache();
  // The SAME figure the dashboard prints: cash + linked portfolio value, per
  // currency, honouring the accounts the user left out of net worth. A
  // cash-only sum here disagreed with the app as soon as a portfolio existed.
  const excluded = parseNetWorthExcluded((await getSettings(db)).net_worth_excluded_json);
  const nw = await netWorth(db, excluded);
  const [movCount, tagCount] = await Promise.all([
    db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements`),
    db.select<{ c: number }>(`SELECT COUNT(*) c FROM tags`),
  ]);
  const kpis: [string, string | number][] = [];
  for (const ccy of Object.keys(nw).sort()) kpis.push([`Net Worth (${ccy})`, round2(nw[ccy])]);
  kpis.push(["Total Sources", list.length]);
  kpis.push(["Movements", movCount[0]?.c ?? 0]);
  kpis.push(["Tags", tagCount[0]?.c ?? 0]);
  return { title: "Overview", kpis };
}

/**
 * Group signed in/out amounts by currency (label fallback "—" for a null currency),
 * sorted by code. Totals must never be summed ACROSS currencies — €1000 + $500 is
 * not "1500" — so every monetary summary that spans rows of different currencies
 * goes through this and is reported per currency.
 */
function inOutByCurrency<T>(
  rows: T[],
  ccy: (r: T) => string | null,
  dir: (r: T) => "in" | "out",
  amt: (r: T) => number,
): [string, { in: number; out: number }][] {
  const m = new Map<string, { in: number; out: number }>();
  for (const r of rows) {
    const c = ccy(r) ?? "—";
    const e = m.get(c) ?? { in: 0, out: 0 };
    if (dir(r) === "in") e.in += amt(r);
    else e.out += amt(r);
    m.set(c, e);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function buildSection(db: SqlExecutor, key: SectionKey, sourceCache: () => Promise<SourceData>): Promise<Section> {
  switch (key) {
    case "sources": {
      const { list, balances } = await sourceCache();
      const nw = netWorthByCurrency(
        list.map((s) => ({ currency: s.currency, balance: balances.get(s.id) ?? s.starting_balance })),
      );
      return {
        title: "Sources",
        summary: Object.keys(nw).sort().map((ccy) => [`Net Worth (${ccy})`, round2(nw[ccy])] as [string, number]),
        columns: ["Name", "Currency", "Balance", "Starting", "Yield %", "Fund"],
        rows: list.map((s) => [s.name, s.currency, balances.get(s.id) ?? s.starting_balance, s.starting_balance, s.yield_rate, s.is_savings_fund ? "yes" : ""]),
      };
    }
    case "movements": {
      const items = await movements.listMovements(db, {}, { limit: 100000 });
      // Transfers move money between own accounts — not income/expense — and
      // stat-excluded rows opt out of totals, so both stay out of the summary
      // (matching the in-app KPI band / sumMovements). Totals are per currency.
      const counted = items.filter((m) => m.transfer_pair_id == null && m.exclude_from_stats !== 1);
      const summary: [string, string | number][] = [];
      for (const [ccy, { in: ti, out: to }] of inOutByCurrency(counted, (m) => m.source_currency, (m) => m.direction, (m) => m.amount)) {
        summary.push([`Income (${ccy})`, round2(ti)], [`Expense (${ccy})`, round2(to)], [`Net (${ccy})`, round2(ti - to)]);
      }
      summary.push(["Movements", items.length]);
      return {
        title: "Movements",
        summary,
        columns: ["Date", "Direction", "Amount", "Currency", "Account", "Note", "Tags"],
        rows: items.map((m) => [m.date, m.direction, m.amount, m.source_currency ?? "", m.source_name ?? "", m.note ?? "", m.tags.map((t) => t.name).join(", ")]),
      };
    }
    case "tags": {
      const list = await tags.listTagsWithUsage(db);
      const totalUsage = list.reduce((a, t) => a + t.movement_count, 0);
      return {
        title: "Tags",
        summary: [["Tags", list.length], ["Tagged movements", totalUsage]],
        columns: ["Name", "Color", "Movements", "Budgets"],
        rows: list.map((t) => [t.name, t.color ?? "", t.movement_count, t.budget_count]),
      };
    }
    case "recurring": {
      const today = todayISO();
      const list = await recurring.listRecurring(db, today);
      // Monthly-equivalent income/expense, per currency (don't cross-sum
      // currencies), over the rules still running — an ended rule is listed in
      // the table but no longer projects (same rule as the Recurring page).
      const running = list.filter((r) => recurring.isRuleActive(r, today));
      const summary: [string, string | number][] = [];
      for (const [ccy, { in: mi, out: mo }] of inOutByCurrency(running, (r) => r.currency, (r) => r.direction, (r) => r.amount * (FREQ_MONTHLY_FACTOR[r.frequency] ?? 1))) {
        summary.push([`Monthly income (${ccy})`, round2(mi)], [`Monthly expense (${ccy})`, round2(mo)], [`Monthly net (${ccy})`, round2(mi - mo)]);
      }
      summary.push(["Recurring", list.length]);
      return {
        title: "Recurring",
        summary,
        columns: ["Name", "Direction", "Amount", "Currency", "Frequency", "Next due"],
        rows: list.map((r) => [r.name, r.direction, r.amount, r.currency, r.frequency, r.next_due_date]),
      };
    }
    case "savings": {
      const list = await savings.listSavings(db, { limit: 100000 });
      const byCcy = new Map<string, number>();
      for (const s of list) byCcy.set(s.currency, (byCcy.get(s.currency) ?? 0) + s.amount);
      const summary: [string, string | number][] = [...byCcy.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ccy, total]) => [`Total Saved (${ccy})`, round2(total)] as [string, number]);
      summary.push(["Savings", list.length]);
      return {
        title: "Savings",
        summary,
        columns: ["Date", "Amount", "Currency", "From", "Note", "Tags"],
        rows: list.map((s) => [s.date, s.amount, s.currency, s.from_source_name ?? "", s.note ?? "", s.tags.map((t) => t.name).join(", ")]),
      };
    }
    case "whims": {
      const list = await whims.listWhims(db);
      const byCcy = new Map<string, { pending: number; purchased: number }>();
      for (const w of list) {
        const e = byCcy.get(w.currency) ?? { pending: 0, purchased: 0 };
        if (w.status === "pending") e.pending += w.amount;
        else if (w.status === "purchased") e.purchased += w.amount;
        byCcy.set(w.currency, e);
      }
      const summary: [string, string | number][] = [];
      for (const [ccy, e] of [...byCcy.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        summary.push([`Pending (${ccy})`, round2(e.pending)], [`Purchased (${ccy})`, round2(e.purchased)]);
      }
      summary.push(["Dismissed", list.filter((w) => w.status === "dismissed").length], ["Whims", list.length]);
      return {
        title: "Whims",
        summary,
        columns: ["Name", "Amount", "Currency", "Priority", "Status"],
        rows: list.map((w) => [w.name, w.amount, w.currency, w.priority, w.status]),
      };
    }
  }
}

/**
 * Resolve the section list: keep only known keys, in the canonical
 * EXPORT_SECTIONS order, and fall back to ALL sections when the selection is
 * empty (excel_export.py:749-751 / pdf_export.py:989-991, invariant #14).
 */
function resolveSections(selected: SectionKey[]): SectionKey[] {
  const want = new Set(selected);
  const ordered = EXPORT_SECTIONS.map((s) => s.key).filter((k) => want.has(k));
  return ordered.length ? ordered : EXPORT_SECTIONS.map((s) => s.key);
}

async function collect(db: SqlExecutor, selected: SectionKey[], sourceCache: () => Promise<SourceData>): Promise<Section[]> {
  const out: Section[] = [];
  for (const k of resolveSections(selected)) out.push(await buildSection(db, k, sourceCache));
  return out;
}

/**
 * Spreadsheet formula-injection guard: a string cell starting with =,+,-,@ (or a
 * leading tab/CR) is executed as a formula when the .xlsx is opened. Prefix a
 * single quote so user-supplied notes/names render as plain text. Numbers pass
 * through untouched so they stay numeric.
 */
function safeCell(c: string | number): string | number {
  if (typeof c !== "string") return c;
  return /^[=+\-@\t\r]/.test(c) ? `'${c}` : c;
}
const safeRow = (r: (string | number)[]) => r.map(safeCell);

export async function exportExcel(db: SqlExecutor, selected: SectionKey[]): Promise<Uint8Array> {
  const sourceCache = makeSourceCache(db);
  const keys = resolveSections(selected);
  const sections = await collect(db, keys, sourceCache);
  const wb = XLSX.utils.book_new();

  // Always lead with the Overview sheet (net-worth-by-currency KPIs + counts).
  const overview = await buildOverview(db, sourceCache);
  const overviewAoa: (string | number)[][] = [["Yfine"], [`v${APP_VERSION} · Export ${todayISO()}`], [], [overview.title]];
  for (const [label, value] of overview.kpis) overviewAoa.push([label, value]);
  overviewAoa.push([], ["Contents"]);
  for (const s of sections) overviewAoa.push([s.title]);
  const overviewWs = XLSX.utils.aoa_to_sheet(overviewAoa.map(safeRow));
  formatMoneyCells(overviewWs, overviewAoa);
  XLSX.utils.book_append_sheet(wb, overviewWs, overview.title.slice(0, 31));

  for (const s of sections) {
    const aoa: (string | number)[][] = [[s.title]];
    for (const [label, value] of s.summary) aoa.push([label, value]);
    aoa.push([]);
    const columnsRowIndex = aoa.length; // the header row sits right here, before the data
    aoa.push(s.columns, ...s.rows);
    const ws = XLSX.utils.aoa_to_sheet(aoa.map(safeRow));
    formatMoneyCells(ws, aoa, s.columns, columnsRowIndex);
    XLSX.utils.book_append_sheet(wb, ws, s.title.slice(0, 31));
  }
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export async function exportPdf(db: SqlExecutor, selected: SectionKey[], title = "Yfine export"): Promise<Uint8Array> {
  const sourceCache = makeSourceCache(db);
  const keys = resolveSections(selected);
  const sections = await collect(db, keys, sourceCache);
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(18);
  doc.text("Yfine", 14, 16);
  doc.setFontSize(11);
  doc.text(title, 14, 23);
  // Provenance: when it was produced and the span it covers (exports are all-time).
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generated ${generatedAt} · Yfine v${APP_VERSION} · Period: all dates`, 14, 28);
  doc.setTextColor(0);

  // Cover KPI block: net-worth-by-currency + counts.
  const overview = await buildOverview(db, sourceCache);
  autoTable(doc, {
    head: [["Overview", ""]],
    body: overview.kpis.map(([label, value]) => [label, String(value)]),
    startY: 33,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [99, 102, 241] },
    margin: { left: 14, right: 14, bottom: 14 },
  });
  // @ts-expect-error lastAutoTable is augmented on the doc at runtime by the plugin
  let y = (doc.lastAutoTable?.finalY ?? 40) + 10;

  for (const s of sections) {
    if (y > 180) { doc.addPage(); y = 16; }
    doc.setFontSize(13);
    doc.text(s.title, 14, y);
    y += 2;
    if (s.summary.length) {
      autoTable(doc, {
        body: s.summary.map(([label, value]) => [label, String(value)]),
        startY: y + 2,
        styles: { fontSize: 8 },
        bodyStyles: { fillColor: [231, 231, 255] },
        margin: { left: 14, right: 14, bottom: 14 },
      });
      // @ts-expect-error runtime-augmented
      y = (doc.lastAutoTable?.finalY ?? y + 10) + 4;
    }
    autoTable(doc, {
      head: [s.columns],
      // Same formula-injection guard as the Excel path, so PDF and Excel render
      // identical cell text (a leading =,+,-,@ is quoted).
      body: s.rows.map((r) => safeRow(r).map((c) => String(c))),
      startY: y + 2,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [99, 102, 241] },
      margin: { left: 14, right: 14, bottom: 14 },
    });
    // @ts-expect-error lastAutoTable is augmented on the doc at runtime by the plugin
    y = (doc.lastAutoTable?.finalY ?? y + 20) + 10;
  }

  // Footer on every page (added last, once the total page count is known):
  // provenance on the left, "Page X of Y" on the right. autoTable's bottom margin
  // above reserves space so tables never overlap this band.
  const pageCount = doc.getNumberOfPages();
  const ph = doc.internal.pageSize.getHeight();
  const pw = doc.internal.pageSize.getWidth();
  doc.setFontSize(8);
  doc.setTextColor(150);
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.text(`Generated ${generatedAt} · Yfine v${APP_VERSION}`, 14, ph - 6);
    doc.text(`Page ${i} of ${pageCount}`, pw - 14, ph - 6, { align: "right" });
  }
  doc.setTextColor(0);
  return new Uint8Array(doc.output("arraybuffer"));
}
