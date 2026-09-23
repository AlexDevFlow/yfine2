/**
 * CSV bank-statement import. Faithful port of services/importers/csv_parser.py +
 * presets + dedupe + preview/commit (refactor-analysis/imports.md §2). Fixes:
 *  - B1: dedupe is re-run against the FINAL target source at commit (preview-time
 *        flags can't silently let duplicates through).
 *  - B2: a currency-mismatch between the file and the target source is surfaced.
 * (OFX/QFX/XLSX parsers are deferred — CSV is the common path.)
 */
import type { SqlExecutor } from "../types";
import { round2 } from "@/domain/money";
import { createMovement } from "../repo/movements";
import { createSource, getSource } from "../repo/sources";
import { stageAttachmentUnlinks } from "../repo/attachments";

import ynab from "./presets/ynab.json";
import paypal from "./presets/paypal.json";
import revolut from "./presets/revolut.json";
import n26 from "./presets/n26.json";
import firefly from "./presets/firefly_iii.json";

export interface Preset {
  id: string;
  display_name: string;
  format: string;
  currency_hint?: string | null;
  source_hint?: string | null;
  detect?: { headers?: string[]; contains?: string[] };
  options?: CsvOptions;
}
export const PRESETS = [ynab, paypal, revolut, n26, firefly] as unknown as Preset[];

export interface CsvOptions {
  encoding?: string;
  delimiter?: string;
  date_format?: string;
  decimal_separator?: string;
  column_map?: Record<string, string>;
  skip_rows?: number;
  sign_convention?: string;
}

export interface ParsedMovement {
  date: string; // ISO YYYY-MM-DD
  amount: number; // positive
  direction: "in" | "out";
  note: string | null;
  currency: string | null;
}

export interface ParseResult {
  movements: ParsedMovement[];
  detectedCurrency: string | null;
  warnings: string[];
  headers: string[];
  needsMapping: boolean;
}

const SYNONYMS: Record<string, string[]> = {
  date: ["date", "data", "datum", "fecha", "transaction date", "posted date", "started date", "completed date", "data valuta", "data operazione", "data contabile", "booking date", "value date", "дата"],
  amount: ["amount", "importo", "betrag", "valor", "monto", "total", "montant"],
  amount_in: ["credit", "credito", "entrata", "entrate", "income", "in", "eingang", "haber", "accrediti", "inflow", "deposit"],
  amount_out: ["debit", "debito", "uscita", "uscite", "expense", "out", "ausgang", "soll", "addebiti", "outflow", "withdrawal"],
  note: ["note", "description", "descrizione", "memo", "detail", "details", "payee", "merchant", "name", "narration", "reference", "concepto", "causale", "descripcion"],
  currency: ["currency", "valuta", "ccy", "moneda", "waehrung", "wahrung", "devise"],
  direction: ["direction", "type", "tipo", "dir"],
};

function normalizeHeader(h: string): string {
  return (h || "").trim().toLowerCase().replace(/_/g, " ").replace(/-/g, " ");
}

export function guessColumnMap(headers: string[]): Record<string, string> | null {
  const normalized = new Map<string, string>();
  for (const h of headers) if (h) normalized.set(normalizeHeader(h), h);
  const result: Record<string, string> = {};
  for (const [field, syns] of Object.entries(SYNONYMS)) {
    for (const syn of syns) {
      if (normalized.has(syn)) {
        result[field] = normalized.get(syn)!;
        break;
      }
    }
  }
  const hasAmount = "amount" in result || ("amount_in" in result && "amount_out" in result);
  return "date" in result && hasAmount ? result : null;
}

export function parseAmount(input: string, decimalSep = "."): number | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/ /g, "").replace(/ /g, "");
  for (const sym of ["€", "$", "£", "¥", "CHF", "USD", "EUR", "GBP"]) s = s.split(sym).join("");
  if (decimalSep === ",") {
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      // Rightmost separator is the decimal: "1.234,56" → comma; "1,234.56" → dot.
      s = s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(/,/g, ".")
        : s.replace(/,/g, "");
    } else if (hasComma) {
      s = s.replace(/,/g, "."); // "42,10" → decimal comma
    } else if (hasDot) {
      // Only a dot under a comma-decimal preset: strip it as grouping ONLY when it
      // looks like thousands groups ("1.234", "1.234.567"). A lone "-3.50" is a
      // dot-locale export under this preset (e.g. a US PayPal CSV) — keep it as the
      // decimal instead of turning 3.50 into 350.
      if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    }
  } else {
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      s = s.replace(/,/g, ""); // dot decimal, commas are grouping ("1,234.56")
    } else if (hasComma) {
      // Comma-only under a dot-decimal locale: thousands groups ("1,234", "1,234,567")
      // are grouping → strip; otherwise it's a stray decimal comma ("1,5") → dot.
      s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(/,/g, ".");
    } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) {
      // Two or more dot groups can only be grouping ("1.234.567") — a comma-locale
      // export fed to a dot-decimal preset. A single dot stays the decimal.
      s = s.replace(/\./g, "");
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when y-m-d is a real calendar day. A bare 1..31 range check lets
 * "2024-02-31" through, which then sits in the DB as a date no month has (and
 * sorts/filters/charts as if it existed).
 */
export function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Minimal Python-strptime subset for the codes used by presets (%Y %m %d %H %M %S). */
function strptime(s: string, fmt: string): string | null {
  const tokens: string[] = [];
  let regex = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      const code = fmt[++i];
      if (code === "Y") { regex += "(\\d{4})"; tokens.push("Y"); }
      else if ("mdHMS".includes(code)) { regex += "(\\d{1,2})"; tokens.push(code); }
      else regex += code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      regex += fmt[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  const m = new RegExp("^" + regex + "$").exec(s.trim());
  if (!m) return null;
  const part: Record<string, number> = {};
  tokens.forEach((tk, idx) => (part[tk] = Number(m[idx + 1])));
  const y = part.Y, mo = part.m, d = part.d;
  if (!y || !mo || !d || !isValidCalendarDate(y, mo, d)) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const FALLBACK_FORMATS = ["%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%m/%d/%Y", "%m-%d-%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  sept: 9,
};

function iso(y: number, m: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  // pivot 2-digit years like dateutil: <70 → 2000s, else 1900s
  if (y < 100) y = y < 70 ? 2000 + y : 1900 + y;
  if (y < 1 || y > 9999) return null;
  if (!isValidCalendarDate(y, m, d)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Robust day-first fallback mirroring Python's `dateutil.parser.parse(s, dayfirst=True)`.
 * Handles: ISO datetimes with a trailing `Z`/offset, 2-digit years (pivoted),
 * month-name dates ("15 Jan 2024", "Jan 15, 2024"), and ambiguous numeric dates
 * where day-first resolves the order. Without this, such rows are silently dropped.
 */
function dayFirstFallback(s: string): string | null {
  // ISO-ish: 2024-01-15[T... / space ...][Z / +02:00] → take the date part.
  const isoM = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (isoM) return iso(Number(isoM[1]), Number(isoM[2]), Number(isoM[3]));

  // Strip a trailing time/zone if any token group remains date-like below.
  const datePart = s.split(/[T ]/)[0];

  // Month-name forms: "15 Jan 2024", "15-Jan-2024", "Jan 15, 2024", "15 January 24".
  const tokens = s.replace(/,/g, " ").split(/[\s/.\-]+/).map((t) => t.trim()).filter(Boolean);
  const monthTok = tokens.find((t) => MONTHS[t.toLowerCase()] != null);
  if (monthTok) {
    const month = MONTHS[monthTok.toLowerCase()];
    const nums = tokens.filter((t) => /^\d+$/.test(t)).map(Number);
    if (nums.length >= 2) {
      // year = the 4-digit (or larger) number; the other is the day.
      let year = nums.find((n) => n > 31);
      let day: number | undefined;
      if (year != null) day = nums.find((n) => n !== year);
      else { day = nums[0]; year = nums[1]; } // both small → first is day (day-first), second is 2-digit year
      if (day != null && year != null) return iso(year, month, day);
    }
  }

  // Pure numeric, day-first: d[sep]m[sep]y (y may be 2 or 4 digits).
  const parts = datePart.split(/[/.\-]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b, c] = parts.map(Number);
    return iso(c, b, a); // d/m/y; iso() pivots any 2-digit year
  }
  return null;
}

export function tryParseDate(input: string, dateFormat?: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;
  if (dateFormat) {
    const r = strptime(s, dateFormat);
    if (r) return r;
  }
  for (const fmt of FALLBACK_FORMATS) {
    const r = strptime(s, fmt);
    if (r) return r;
  }
  return dayFirstFallback(s);
}

function detectDelimiter(line: string): string {
  const cands = [",", ";", "\t", "|"];
  let best = ",";
  let bestN = -1;
  for (const c of cands) {
    const n = line.split(c).length - 1;
    if (n > bestN) { bestN = n; best = c; }
  }
  return best;
}

/** RFC-4180-ish CSV row reader with quotes. */
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function prep(text: string, options: CsvOptions): { headers: string[]; dataRows: string[][]; delimiter: string } {
  let t = text;
  if (t.startsWith("﻿")) t = t.slice(1);
  let lines = t.split(/\r?\n/);
  const skip = Number(options.skip_rows ?? 0) || 0;
  if (skip) lines = lines.slice(skip);
  t = lines.join("\n");
  const firstLine = lines[0] ?? "";
  const delimiter = options.delimiter || detectDelimiter(firstLine);
  const rows = parseRows(t, delimiter);
  const headers = rows[0] ?? [];
  return { headers, dataRows: rows.slice(1), delimiter };
}

/** Headers for preset detection — respects skip_rows + delimiter (B5 fix). */
export function extractHeaders(text: string, options: CsvOptions = {}): string[] {
  return prep(text, options).headers;
}

export function parseCsv(text: string, options: CsvOptions = {}): ParseResult {
  const { headers, dataRows } = prep(text, options);
  if (headers.length === 0) return { movements: [], detectedCurrency: null, warnings: ["empty_file"], headers: [], needsMapping: false };

  const decimalSep = options.decimal_separator ?? ".";
  let columnMap = options.column_map ?? guessColumnMap(headers) ?? undefined;
  if (!columnMap) {
    return { movements: [], detectedCurrency: null, warnings: [`needs_mapping:${headers.join(",")}`], headers, needsMapping: true };
  }

  // Resolve column_map names case-insensitively (with an exact-match preference):
  // detectPreset() matches headers case-insensitively, so a bank tweaking header
  // casing would otherwise pass detection but resolve zero columns → silent
  // zero-row import. Keep the two policies consistent.
  const lowerHeaders = headers.map((h) => h.trim().toLowerCase());
  const findHeader = (name: string) => {
    const exact = headers.indexOf(name);
    return exact !== -1 ? exact : lowerHeaders.indexOf(name.trim().toLowerCase());
  };
  const headerIndex: Record<string, number> = {};
  for (const [field, name] of Object.entries(columnMap)) {
    const idx = findHeader(name);
    if (idx === -1) return { movements: [], detectedCurrency: null, warnings: [`column_not_found:${name}`], headers, needsMapping: false };
    headerIndex[field] = idx;
  }

  const movements: ParsedMovement[] = [];
  const warnings: string[] = [];
  let detectedCurrency: string | null = null;

  dataRows.forEach((row, i) => {
    const rowNum = i + 2;
    if (!row.length || row.every((c) => (c || "").trim() === "")) return;

    const dRaw = headerIndex.date != null && headerIndex.date < row.length ? row[headerIndex.date] : "";
    const date = tryParseDate(dRaw, options.date_format);
    if (!date) { warnings.push(`row_${rowNum}_bad_date`); return; }

    let amount: number | null = null;
    let direction: "in" | "out" | null = null;

    if (headerIndex.amount_in != null && headerIndex.amount_out != null) {
      const inVal = parseAmount(row[headerIndex.amount_in] ?? "", decimalSep);
      const outVal = parseAmount(row[headerIndex.amount_out] ?? "", decimalSep);
      // Take the magnitude of whichever column is non-zero: some banks sign the
      // outflow column negative, which the old `> 0` test silently dropped.
      if (inVal && inVal !== 0) { amount = Math.abs(inVal); direction = "in"; }
      else if (outVal && outVal !== 0) { amount = Math.abs(outVal); direction = "out"; }
    } else {
      const a = parseAmount(headerIndex.amount != null ? row[headerIndex.amount] ?? "" : "", decimalSep);
      if (a == null) { warnings.push(`row_${rowNum}_bad_amount`); return; }
      if (options.sign_convention === "positive_with_type" && headerIndex.direction != null) {
        const dir = (row[headerIndex.direction] || "").trim().toLowerCase();
        if (["in", "credit", "income", "deposit", "entrata", "credito"].includes(dir)) direction = "in";
        else if (["out", "debit", "expense", "withdrawal", "uscita", "debito"].includes(dir)) direction = "out";
        else direction = a >= 0 ? "in" : "out";
        amount = Math.abs(a);
      } else {
        direction = a >= 0 ? "in" : "out";
        amount = Math.abs(a);
      }
    }

    // round FIRST so sub-cent rows (|amount| < 0.005) that round to 0 are skipped,
    // not emitted as amount:0 (which would later be rejected mid-commit).
    const rounded = amount == null ? null : round2(amount);
    if (rounded == null || rounded === 0 || (direction !== "in" && direction !== "out")) {
      warnings.push(`row_${rowNum}_zero_or_invalid`);
      return;
    }

    let note: string | null = null;
    if (headerIndex.note != null && headerIndex.note < row.length) note = (row[headerIndex.note] || "").trim() || null;

    let currency: string | null = null;
    if (headerIndex.currency != null && headerIndex.currency < row.length) {
      currency = (row[headerIndex.currency] || "").trim().toUpperCase() || null;
      if (currency && !detectedCurrency) detectedCurrency = currency;
    }

    movements.push({ date, amount: rounded, direction, note, currency });
  });

  return { movements, detectedCurrency, warnings, headers, needsMapping: false };
}

export function detectPreset(text: string, headers: string[]): Preset | null {
  const lowerHeaders = headers.map((h) => h.trim().toLowerCase());
  const head = text.slice(0, 4096).toLowerCase();
  for (const p of PRESETS) {
    if (p.format !== "csv") continue;
    const reqHeaders = p.detect?.headers ?? [];
    const reqContains = p.detect?.contains ?? [];
    const headersOk = reqHeaders.every((h) => lowerHeaders.includes(h.toLowerCase()));
    const containsOk = reqContains.every((c) => head.includes(c.toLowerCase()));
    if (headersOk && containsOk && (reqHeaders.length || reqContains.length)) return p;
  }
  return null;
}

// ---- dedupe ----
function rowKey(sourceId: number, m: ParsedMovement): string {
  const note = (m.note || "").trim().toLowerCase();
  return `${sourceId}|${m.date}|${m.amount.toFixed(2)}|${m.direction}|${note}`;
}

export async function markDuplicates(db: SqlExecutor, sourceId: number | null, movements: ParsedMovement[]): Promise<boolean[]> {
  if (sourceId == null || movements.length === 0) return movements.map(() => false);
  const dates = movements.map((m) => m.date).sort();
  const existing = await db.select<{ date: string; amount: number; direction: "in" | "out"; note: string | null }>(
    `SELECT date, amount, direction, note FROM movements WHERE source_id = ? AND date >= ? AND date <= ?`,
    [sourceId, dates[0], dates[dates.length - 1]],
  );
  const seen = new Set(existing.map((e) => rowKey(sourceId, { date: e.date, amount: e.amount, direction: e.direction, note: e.note, currency: null })));
  return movements.map((m) => {
    const k = rowKey(sourceId, m);
    if (seen.has(k)) return true;
    seen.add(k); // intra-batch dedupe
    return false;
  });
}

// ---- preview + commit ----
export interface PreviewResult {
  preset: Preset | null;
  headers: string[];
  needsMapping: boolean;
  detectedCurrency: string | null;
  warnings: string[];
  rows: (ParsedMovement & { index: number; isDuplicate: boolean })[];
  totalIn: number;
  totalOut: number;
  duplicateCount: number;
}

/**
 * Turn a (format-agnostic) ParseResult into a PreviewResult: dedupe against the
 * target source, compute running totals, and assemble per-row flags. Shared by
 * the CSV, OFX/QFX and XLSX preview paths (§2.7).
 */
export async function buildPreview(
  db: SqlExecutor,
  result: ParseResult,
  opts: { sourceId?: number | null; preset?: Preset | null } = {},
): Promise<PreviewResult> {
  const preset = opts.preset ?? null;
  const dupFlags = await markDuplicates(db, opts.sourceId ?? null, result.movements);
  let totalIn = 0;
  let totalOut = 0;
  const rows = result.movements.map((m, i) => {
    if (m.direction === "in") totalIn = round2(totalIn + m.amount);
    else totalOut = round2(totalOut + m.amount);
    return { ...m, index: i, isDuplicate: dupFlags[i] };
  });
  return {
    preset,
    headers: result.headers,
    needsMapping: result.needsMapping && result.movements.length === 0,
    detectedCurrency: result.detectedCurrency ?? preset?.currency_hint ?? null,
    warnings: result.warnings.filter((w) => !w.startsWith("needs_mapping:")),
    rows,
    totalIn,
    totalOut,
    duplicateCount: dupFlags.filter(Boolean).length,
  };
}

export async function previewCsv(
  db: SqlExecutor,
  text: string,
  opts: { presetId?: string; options?: CsvOptions; sourceId?: number | null } = {},
): Promise<PreviewResult> {
  const userOptions = opts.options ?? {};
  const headersForDetect = extractHeaders(text, userOptions);
  const preset = opts.presetId ? PRESETS.find((p) => p.id === opts.presetId) ?? null : detectPreset(text, headersForDetect);
  const effective: CsvOptions = { ...(preset?.options ?? {}), ...userOptions };
  const result = parseCsv(text, effective);
  return buildPreview(db, result, { sourceId: opts.sourceId ?? null, preset });
}

export interface CommitResult {
  imported: number;
  skipped: number;
  sourceId: number;
  currencyWarning?: string;
  /** Ids of the movements created by this batch — drives undoImport (§2.9). */
  createdIds: number[];
}

export interface CommitInput {
  movements: ParsedMovement[];
  sourceId?: number;
  newSource?: { name: string; currency: string; starting_balance?: number };
  tagIds?: number[];
  excludeFromStats?: boolean;
  /**
   * Explicit set of row indices (into `movements`) the user chose to import.
   * When omitted, every non-duplicate row is imported (the default behavior).
   * When present, it OVERRIDES the duplicate filter — letting the user force
   * a flagged duplicate in via the duplicate-review modal (§2.7/§2.8). Rows
   * NOT in the set are skipped regardless of duplicate status.
   */
  includeIndices?: number[];
}

export async function commitCsv(db: SqlExecutor, input: CommitInput): Promise<CommitResult> {
  let sourceId = input.sourceId;
  if (input.newSource) {
    const s = await createSource(db, { name: input.newSource.name, currency: input.newSource.currency, starting_balance: input.newSource.starting_balance ?? 0 });
    sourceId = s.id;
  }
  if (sourceId == null) throw new Error("no target source");
  const source = await getSource(db, sourceId);
  if (!source) throw new Error("source not found");

  // B2: warn when file currency differs from the target source currency.
  let currencyWarning: string | undefined;
  const fileCcy = input.movements.find((m) => m.currency)?.currency;
  if (fileCcy && fileCcy.toUpperCase() !== source.currency.toUpperCase()) {
    currencyWarning = `File currency ${fileCcy} differs from account currency ${source.currency}; amounts imported as-is (no conversion).`;
  }

  // Honor an explicit include-set (duplicate override) when supplied; otherwise
  // B1: re-dedupe against the FINAL target source at commit time.
  const includeSet = input.includeIndices ? new Set(input.includeIndices) : null;
  const dupFlags = includeSet ? null : await markDuplicates(db, sourceId, input.movements);
  let imported = 0;
  let skipped = 0;
  const createdIds: number[] = [];
  for (let i = 0; i < input.movements.length; i++) {
    if (includeSet ? !includeSet.has(i) : dupFlags![i]) { skipped += 1; continue; }
    const m = input.movements[i];
    try {
      const id = await createMovement(db, {
        source_id: sourceId,
        amount: m.amount,
        direction: m.direction,
        date: m.date,
        note: m.note,
        tagIds: input.tagIds,
        exclude_from_stats: input.excludeFromStats,
      });
      createdIds.push(id);
      imported += 1;
    } catch {
      // a single bad row must not abort the batch and lose the rows after it
      skipped += 1;
    }
  }
  return { imported, skipped, sourceId, currencyWarning, createdIds };
}

/**
 * Undo a just-committed import by deleting exactly the movements it created
 * (port of services/importers/undo.py — but scoped by explicit ids returned
 * from commit rather than a fragile created_at window). Removes the movements
 * plus their tag links and attachment rows/files. Idempotent.
 */
export async function undoImport(db: SqlExecutor, movementIds: number[]): Promise<number> {
  if (!movementIds.length) return 0;
  const ph = movementIds.map(() => "?").join(",");
  // stage on-disk attachment files for post-commit unlink so nothing is orphaned
  await stageAttachmentUnlinks(db, movementIds);
  await db.execute(`DELETE FROM movement_tag WHERE movement_id IN (${ph})`, movementIds);
  await db.execute(`DELETE FROM movement_attachments WHERE movement_id IN (${ph})`, movementIds);
  await db.execute(`DELETE FROM goal_allocations WHERE movement_id IN (${ph})`, movementIds);
  const before = await db.select<{ c: number }>(`SELECT COUNT(*) c FROM movements WHERE id IN (${ph})`, movementIds);
  await db.execute(`DELETE FROM movements WHERE id IN (${ph})`, movementIds);
  return before[0]?.c ?? 0;
}
