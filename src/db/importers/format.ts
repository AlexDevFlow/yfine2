/**
 * Multi-format import dispatcher: detect the file format (extension first, then
 * a content sniff), route to the right parser (CSV / OFX-QFX / XLSX) and produce
 * a unified PreviewResult. Mirrors services/importers/__init__.py detect_format
 * + the per-format preview wiring. The UI calls previewImport()/commit/undo so
 * it never needs to know which parser ran.
 */
import type { SqlExecutor } from "../types";
import {
  buildPreview,
  detectPreset,
  extractHeaders,
  parseCsv,
  PRESETS,
  type CsvOptions,
  type ParseResult,
  type Preset,
  type PreviewResult,
} from "./csv";
import { parseOfx, sniffOfx } from "./ofx";
import { parseXlsx, sniffXlsx } from "./xlsx";

export type ImportFormat = "csv" | "ofx" | "qfx" | "xlsx";

export const FORMAT_OPTIONS: { value: ImportFormat; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "ofx", label: "OFX" },
  { value: "qfx", label: "QFX" },
  { value: "xlsx", label: "Excel (XLSX)" },
];

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
  /** Decoded UTF-8 text (only meaningful for text formats; cheap to compute). */
  text: string;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

/** Detect format from extension, falling back to a content sniff (ofx→xlsx→csv). */
export function detectFormat(file: ImportFile): ImportFormat | null {
  const ext = extOf(file.name);
  if (ext === ".csv") return "csv";
  if (ext === ".ofx") return "ofx";
  if (ext === ".qfx") return "qfx";
  if (ext === ".xlsx") return "xlsx";

  if (sniffOfx(file.text)) return "ofx";
  if (sniffXlsx(file.bytes)) return "xlsx";
  // CSV sniff: reject binary/markup; accept if the first line has a delimiter.
  const head = file.text.slice(0, 2048).replace(/^﻿/, "");
  if (head.startsWith("<") || head.startsWith("PK") || head.toUpperCase().startsWith("OFXHEADER")) return null;
  const firstLine = head.split(/\r?\n/)[0] ?? "";
  if (/[,;\t|]/.test(firstLine)) return "csv";
  return null;
}

export interface PreviewOptions {
  /** Force a format instead of auto-detecting (CSV / OFX / QFX / XLSX). */
  format?: ImportFormat;
  /** Force a CSV preset id instead of auto-detecting. */
  presetId?: string;
  /** Parser options (column_map, decimal_separator, sheet_name, header_row, …). */
  options?: CsvOptions & { sheet_name?: string; header_row?: number };
  sourceId?: number | null;
}

export interface ImportPreview extends PreviewResult {
  format: ImportFormat;
  detectedSourceHint: string | null;
}

/** Parse + preview any supported file. Returns needsMapping / headers for CSV & XLSX. */
export async function previewImport(db: SqlExecutor, file: ImportFile, opts: PreviewOptions = {}): Promise<ImportPreview> {
  const format = opts.format ?? detectFormat(file);
  if (!format) throw new Error("format_not_detected");

  let result: ParseResult;
  let preset: Preset | null = null;
  let detectedSourceHint: string | null = null;

  if (format === "csv") {
    const userOptions = opts.options ?? {};
    const headers = extractHeaders(file.text, userOptions);
    preset = opts.presetId ? PRESETS.find((p) => p.id === opts.presetId) ?? null : detectPreset(file.text, headers);
    const effective: CsvOptions = { ...(preset?.options ?? {}), ...userOptions };
    result = parseCsv(file.text, effective);
  } else if (format === "ofx" || format === "qfx") {
    const ofx = parseOfx(file.text);
    detectedSourceHint = ofx.detectedSourceHint;
    result = ofx;
  } else {
    result = parseXlsx(file.bytes, opts.options ?? {});
  }

  const preview = await buildPreview(db, result, { sourceId: opts.sourceId ?? null, preset });
  return { ...preview, format, detectedSourceHint };
}
