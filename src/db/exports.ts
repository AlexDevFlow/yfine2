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
import { netWorthByCurrency, round2 } from "@/domain/money";
import { todayISO } from "@/lib/date";

export type SectionKey = "sources" | "movements" | "tags" | "recurring" | "savings" | "whims";

export const EXPORT_SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "sources", label: "Sources" },
  { key: "movements", label: "Movements" },
  { key: "tags", label: "Tags" },
  { key: "recurring", label: "Recurring" },
  { key: "savings", label: "Savings" },
  { key: "whims", label: "Whims" },
];

/** Monthly-equivalence factors for recurring items (excel_export.py:527). */
const FREQ_MONTHLY_FACTOR: Record<string, number> = { daily: 30, weekly: 4.33, monthly: 1, yearly: 1 / 12 };

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
  const { list, balances } = await sourceCache();
  const nw = netWorthByCurrency(
    list.map((s) => ({ currency: s.currency, balance: balances.get(s.id) ?? s.starting_balance })),
  );
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
      const totalIn = round2(items.filter((m) => m.direction === "in").reduce((a, m) => a + m.amount, 0));
      const totalOut = round2(items.filter((m) => m.direction === "out").reduce((a, m) => a + m.amount, 0));
      return {
        title: "Movements",
        summary: [["Income", totalIn], ["Expense", totalOut], ["Net", round2(totalIn - totalOut)], ["Movements", items.length]],
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
      const list = await recurring.listRecurring(db, todayISO());
      let monthlyIn = 0;
      let monthlyOut = 0;
      for (const r of list) {
        const factor = FREQ_MONTHLY_FACTOR[r.frequency] ?? 1;
        const monthly = r.amount * factor;
        if (r.direction === "in") monthlyIn += monthly;
        else monthlyOut += monthly;
      }
      return {
        title: "Recurring",
        summary: [
          ["Monthly income", round2(monthlyIn)],
          ["Monthly expense", round2(monthlyOut)],
          ["Monthly net", round2(monthlyIn - monthlyOut)],
          ["Recurring", list.length],
        ],
        columns: ["Name", "Direction", "Amount", "Currency", "Frequency", "Next due"],
        rows: list.map((r) => [r.name, r.direction, r.amount, r.currency, r.frequency, r.next_due_date]),
      };
    }
    case "savings": {
      const list = await savings.listSavings(db, { limit: 100000 });
      const total = round2(list.reduce((a, s) => a + s.amount, 0));
      return {
        title: "Savings",
        summary: [["Total Saved", total], ["Savings", list.length]],
        columns: ["Date", "Amount", "Currency", "From", "Note", "Tags"],
        rows: list.map((s) => [s.date, s.amount, s.currency, s.from_source_name ?? "", s.note ?? "", s.tags.map((t) => t.name).join(", ")]),
      };
    }
    case "whims": {
      const list = await whims.listWhims(db);
      const pending = round2(list.filter((w) => w.status === "pending").reduce((a, w) => a + w.amount, 0));
      const purchased = round2(list.filter((w) => w.status === "purchased").reduce((a, w) => a + w.amount, 0));
      const dismissed = list.filter((w) => w.status === "dismissed").length;
      return {
        title: "Whims",
        summary: [["Pending", pending], ["Purchased", purchased], ["Dismissed", dismissed], ["Whims", list.length]],
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
  const overviewAoa: (string | number)[][] = [["Yfine"], [`Export ${todayISO()}`], [], [overview.title]];
  for (const [label, value] of overview.kpis) overviewAoa.push([label, value]);
  overviewAoa.push([], ["Contents"]);
  for (const s of sections) overviewAoa.push([s.title]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overviewAoa.map(safeRow)), overview.title.slice(0, 31));

  for (const s of sections) {
    const aoa: (string | number)[][] = [[s.title]];
    for (const [label, value] of s.summary) aoa.push([label, value]);
    aoa.push([]);
    aoa.push(s.columns, ...s.rows);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa.map(safeRow)), s.title.slice(0, 31));
  }
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export async function exportPdf(db: SqlExecutor, selected: SectionKey[], title = "Yfine export"): Promise<Uint8Array> {
  const sourceCache = makeSourceCache(db);
  const keys = resolveSections(selected);
  const sections = await collect(db, keys, sourceCache);
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(18);
  doc.text("Yfine", 14, 16);
  doc.setFontSize(11);
  doc.text(title, 14, 23);

  // Cover KPI block: net-worth-by-currency + counts.
  const overview = await buildOverview(db, sourceCache);
  autoTable(doc, {
    head: [["Overview", ""]],
    body: overview.kpis.map(([label, value]) => [label, String(value)]),
    startY: 28,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [99, 102, 241] },
    margin: { left: 14, right: 14 },
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
        margin: { left: 14, right: 14 },
      });
      // @ts-expect-error runtime-augmented
      y = (doc.lastAutoTable?.finalY ?? y + 10) + 4;
    }
    autoTable(doc, {
      head: [s.columns],
      body: s.rows.map((r) => r.map((c) => String(c))),
      startY: y + 2,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [99, 102, 241] },
      margin: { left: 14, right: 14 },
    });
    // @ts-expect-error lastAutoTable is augmented on the doc at runtime by the plugin
    y = (doc.lastAutoTable?.finalY ?? y + 20) + 10;
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
