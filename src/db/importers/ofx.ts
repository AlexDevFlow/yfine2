/**
 * OFX / QFX bank-statement import. Dependency-free SGML/XML reader (no heavy npm
 * dep, no network calls) — faithful port of services/importers/ofx_parser.py
 * (refactor-analysis/imports.md §2.5).
 *
 * OFX is SGML-ish: tags may be unclosed (`<TAG>value` on one line) or properly
 * closed XML (`<TAG>value</TAG>`). We extract each <STMTTRN> block and read
 * DTPOSTED (date), TRNAMT (signed amount → direction), NAME + MEMO (note) and
 * FITID (external_ref / dedupe key). <CURDEF> sets detected_currency; <ORG> the
 * source hint. Multiple <STMTRS>/accounts are merged with a warning, matching
 * the original.
 */
import { parseAmount, type ParseResult, type ParsedMovement } from "./csv";
import { round2 } from "@/domain/money";

export interface OfxParsed extends ParseResult {
  detectedSourceHint: string | null;
}

/** Sniff OFX content: "OFXHEADER" or "<OFX>" in the first 1024 chars (uppercased). */
export function sniffOfx(text: string): boolean {
  const head = text.replace(/^\s+/, "").slice(0, 1024).toUpperCase();
  return head.includes("OFXHEADER") || head.includes("<OFX>");
}

/**
 * Read the value of an (unclosed-or-closed) SGML tag from a block.
 * For `<DTPOSTED>20240115` returns "20240115"; for `<NAME>Foo</NAME>` returns "Foo".
 * The value runs until the next `<` or end-of-string.
 */
function tagValue(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i");
  const m = re.exec(block);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

/** OFX dates: YYYYMMDD[HHMMSS][.XXX][+/-TZ] or already-dashed. Returns ISO YYYY-MM-DD. */
export function parseOfxDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // strip a bracketed timezone like [-5:EST]
  const cleaned = s.replace(/\[.*?\]/g, "");
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(cleaned);
  if (compact) {
    const y = Number(compact[1]), mo = Number(compact[2]), d = Number(compact[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const dashed = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(cleaned);
  if (dashed) {
    const mo = Number(dashed[2]), d = Number(dashed[3]);
    // Validate range like the compact branch — otherwise "2024-13-40" would import
    // as a garbage date instead of being dropped.
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${dashed[1]}-${dashed[2].padStart(2, "0")}-${dashed[3].padStart(2, "0")}`;
    }
  }
  return null;
}

export function parseOfx(text: string): OfxParsed {
  const empty: OfxParsed = { movements: [], detectedCurrency: null, detectedSourceHint: null, warnings: [], headers: [], needsMapping: false };
  if (!text || !text.trim()) return { ...empty, warnings: ["empty_file"] };

  const movements: ParsedMovement[] = [];
  const warnings: string[] = [];
  let detectedCurrency: string | null = null;
  let detectedSourceHint: string | null = null;

  // Default currency (CURDEF appears once per statement; first wins).
  const curdef = tagValue(text, "CURDEF");
  if (curdef) detectedCurrency = curdef.toUpperCase();
  const org = tagValue(text, "ORG");
  if (org) detectedSourceHint = org;

  // Count statement responses to mirror "multiple_accounts_merged".
  const stmtBlocks = (text.match(/<STMTRS>|<CCSTMTRS>/gi) || []).length;
  if (stmtBlocks > 1) warnings.push("multiple_accounts_merged");

  // Extract each <STMTTRN>...</STMTTRN> (or up to the next <STMTTRN> for SGML).
  const blocks: string[] = [];
  const re = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[1]);
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }

  if (blocks.length === 0) {
    return { movements: [], detectedCurrency, detectedSourceHint, warnings, headers: [], needsMapping: false };
  }

  for (const block of blocks) {
    const amtRaw = tagValue(block, "TRNAMT");
    if (amtRaw == null) continue;
    // Use the shared locale-aware parser (grouping- vs decimal-separator aware)
    // rather than a blind comma→dot swap, which turned a grouped "1,234.56" into NaN
    // and silently dropped the row.
    const amt = parseAmount(amtRaw);
    if (amt == null || !Number.isFinite(amt) || amt === 0) continue;

    const date = parseOfxDate(tagValue(block, "DTPOSTED") || tagValue(block, "DTUSER"));
    if (!date) continue;

    const direction: "in" | "out" = amt >= 0 ? "in" : "out";
    // round2 (EPSILON-compensated, like CSV/XLSX) so the same value imports identically
    // across formats — a bare Math.round disagrees on half-cent boundaries (1.005).
    const amount = round2(Math.abs(amt));

    const name = tagValue(block, "NAME") || "";
    const memo = tagValue(block, "MEMO") || "";
    const note = (name + (memo && name ? " - " + memo : memo)).trim() || null;

    movements.push({ date, amount, direction, note, currency: detectedCurrency });
  }

  return { movements, detectedCurrency, detectedSourceHint, warnings, headers: [], needsMapping: false };
}
