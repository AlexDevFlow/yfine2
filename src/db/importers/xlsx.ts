/**
 * XLSX (Excel) bank-statement import. Port of services/importers/xlsx_parser.py
 * (refactor-analysis/imports.md §2.4) reusing the CSV column-mapping heuristics.
 * Built on the already-bundled `xlsx` (SheetJS) dep — the same one exports use —
 * so no new dependency is added.
 *
 * Contract fixes applied during the port:
 *  - B3: a mapped header missing from the sheet surfaces `column_not_found:<name>`
 *        (CSV-consistent) instead of silently dropping the field.
 *  - B4: the single-amount branch honors `sign_convention="positive_with_type"`
 *        + a `direction`/`type` column (firefly-style), not just the numeric sign.
 */
import * as XLSX from "xlsx";
import { round2 } from "@/domain/money";
import { guessColumnMap, parseAmount, tryParseDate, type CsvOptions, type ParseResult, type ParsedMovement } from "./csv";

const MAX_ROWS = 100000;

/** XLSX files are ZIP archives starting with PK\x03\x04. */
export function sniffXlsx(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) return false;
  // peek the first 4096 bytes for an xlsx-specific marker (best-effort, no full unzip)
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  return head.includes("xl/workbook.xml") || head.includes("[Content_Types].xml") || head.includes("xl/");
}

function normalizeNumber(value: unknown, decimalSep: string): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return parseAmount(String(value), decimalSep);
}

/** SheetJS serial date / Date cell → ISO YYYY-MM-DD. */
function cellDate(value: unknown, dateFormat: string | undefined): string | null {
  if (value instanceof Date) {
    // SheetJS (cellDates:true) constructs date cells at LOCAL midnight, so reading
    // them back with getUTC* shifts the date one day earlier for every UTC+ user
    // (all of Europe/Asia). Use the local components to get the intended calendar day.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF?.parse_date_code?.(value);
    // Require a valid month/day too — a time-only/fractional serial yields m=0,d=0,
    // which would emit "YYYY-00-00" (the CSV/OFX paths both range-check this).
    if (parsed && parsed.y && parsed.m >= 1 && parsed.m <= 12 && parsed.d >= 1 && parsed.d <= 31) {
      return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    }
    return null;
  }
  if (typeof value === "string") return tryParseDate(value, dateFormat);
  return null;
}

export function parseXlsx(bytes: Uint8Array, options: CsvOptions & { sheet_name?: string; header_row?: number } = {}): ParseResult {
  const decimalSep = options.decimal_separator ?? ".";
  const dateFormat = options.date_format;
  const headerRow = Math.max(1, Number(options.header_row ?? 1) || 1);

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: "array", cellDates: true });
  } catch (e) {
    return { movements: [], detectedCurrency: null, warnings: [`parse_error:${(e as Error)?.name ?? "Error"}`], headers: [], needsMapping: false };
  }

  const sheetName = options.sheet_name && wb.SheetNames.includes(options.sheet_name) ? options.sheet_name : wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws) return { movements: [], detectedCurrency: null, warnings: ["no_sheets"], headers: [], needsMapping: false };

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, blankrows: false, defval: null });
  const allRows = aoa.slice(0, MAX_ROWS);
  if (allRows.length < headerRow) return { movements: [], detectedCurrency: null, warnings: ["empty_file"], headers: [], needsMapping: false };

  const headers = (allRows[headerRow - 1] ?? []).map((h) => (h == null ? "" : String(h).trim()));
  const dataRows = allRows.slice(headerRow);

  let columnMap = options.column_map ?? guessColumnMap(headers) ?? undefined;
  if (!columnMap) {
    return { movements: [], detectedCurrency: null, warnings: [`needs_mapping:${headers.join(",")}`], headers, needsMapping: true };
  }

  const headerIndex: Record<string, number> = {};
  for (const [field, name] of Object.entries(columnMap)) {
    const idx = headers.indexOf(name);
    // B3: a mapped header that is missing is an error (CSV-consistent), not a silent drop.
    if (idx === -1) return { movements: [], detectedCurrency: null, warnings: [`column_not_found:${name}`], headers, needsMapping: false };
    headerIndex[field] = idx;
  }

  const movements: ParsedMovement[] = [];
  const warnings: string[] = [];
  let detectedCurrency: string | null = null;

  dataRows.forEach((row, i) => {
    const rowNum = headerRow + 1 + i;
    if (!row || row.every((c) => c == null || (typeof c === "string" && !c.trim()))) return;

    const date = cellDate(headerIndex.date != null ? row[headerIndex.date] : null, dateFormat);
    if (!date) { warnings.push(`row_${rowNum}_bad_date`); return; }

    let amount: number | null = null;
    let direction: "in" | "out" | null = null;

    if (headerIndex.amount_in != null && headerIndex.amount_out != null) {
      const inVal = normalizeNumber(row[headerIndex.amount_in], decimalSep);
      const outVal = normalizeNumber(row[headerIndex.amount_out], decimalSep);
      // Magnitude of whichever column is non-zero (some banks sign outflow negative).
      if (inVal && inVal !== 0) { amount = Math.abs(inVal); direction = "in"; }
      else if (outVal && outVal !== 0) { amount = Math.abs(outVal); direction = "out"; }
    } else {
      const a = normalizeNumber(headerIndex.amount != null ? row[headerIndex.amount] : null, decimalSep);
      if (a == null) { warnings.push(`row_${rowNum}_bad_amount`); return; }
      // B4: honor positive_with_type + a direction/type column on XLSX too.
      if (options.sign_convention === "positive_with_type" && headerIndex.direction != null) {
        const dir = String(row[headerIndex.direction] ?? "").trim().toLowerCase();
        if (["in", "credit", "income", "deposit", "entrata", "credito"].includes(dir)) direction = "in";
        else if (["out", "debit", "expense", "withdrawal", "uscita", "debito"].includes(dir)) direction = "out";
        else direction = a >= 0 ? "in" : "out";
        amount = Math.abs(a);
      } else {
        direction = a >= 0 ? "in" : "out";
        amount = Math.abs(a);
      }
    }

    const rounded = amount == null ? null : round2(amount);
    if (rounded == null || rounded === 0 || (direction !== "in" && direction !== "out")) {
      warnings.push(`row_${rowNum}_zero_or_invalid`);
      return;
    }

    let note: string | null = null;
    if (headerIndex.note != null && row[headerIndex.note] != null) note = String(row[headerIndex.note]).trim() || null;

    let currency: string | null = null;
    if (headerIndex.currency != null && row[headerIndex.currency] != null) {
      currency = String(row[headerIndex.currency]).trim().toUpperCase() || null;
      if (currency && !detectedCurrency) detectedCurrency = currency;
    }

    movements.push({ date, amount: rounded, direction, note, currency });
  });

  return { movements, detectedCurrency, warnings, headers, needsMapping: false };
}

/** Sheet names for a workbook (lets the UI offer a sheet picker if needed). */
export function xlsxSheetNames(bytes: Uint8Array): string[] {
  try {
    return XLSX.read(bytes, { type: "array", bookSheets: true }).SheetNames;
  } catch {
    return [];
  }
}
