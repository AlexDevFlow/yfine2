/**
 * Arithmetic-aware amount input — a React port of static/js/math-input.js.
 *
 * The user can type an expression like `100+25*1.22`; a small "= 152.50" preview
 * appears and pressing Enter or blurring the field commits the computed value.
 * Plain numbers behave normally (the preview only shows when an operator is
 * present). Decimal commas are normalized so "1,5+2" works in IT/ES locales.
 *
 * Safety: only `0-9 . , + - * / ( ) space` are accepted. A small recursive-
 * descent parser evaluates those tokens without `eval`/`Function`, so it also
 * works under Tauri's strict Content Security Policy.
 */
import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "./input";

const SAFE_RE = /^[\d\s+\-*/().,]+$/;
const HAS_OP_RE = /[+\-*/()]/;
const MAX_INPUT_LENGTH = 256;

/**
 * Normalize a single numeric token's separators to a JS-parseable form.
 *
 * A bare `,`→`.` swap is wrong: `,` is both the IT/ES decimal separator AND the
 * en-US/UK thousands separator, so "1,000" would become 1 (a silent ×1000 error)
 * and "1,000.50" would become invalid. Rules per token:
 *  - both `.` and `,` present → the rightmost is the decimal; the other is
 *    grouping and is stripped (handles "1,000.50" and "1.234,56").
 *  - only commas, more than one → all grouping → stripped ("1,000,000").
 *  - a single comma followed by exactly 3 digits → grouping → stripped ("1,000").
 *  - otherwise a single comma is a decimal comma → "." ("1,5", "12,50").
 */
/**
 * Strip leading zeros from a token's integer part to keep normalized numbers
 * canonical. Keeps one digit and never touches the fraction ("0125"→"125",
 * "0.5"→"0.5", "10.05"→"10.05").
 */
function stripIntZeros(tok: string): string {
  const dot = tok.indexOf(".");
  const int = dot === -1 ? tok : tok.slice(0, dot);
  const frac = dot === -1 ? "" : tok.slice(dot);
  return int.replace(/^0+(?=\d)/, "") + frac;
}

function normalizeNumber(tok: string): string {
  const hasComma = tok.includes(",");
  const hasDot = tok.includes(".");
  let s: string;
  if (hasComma && hasDot) {
    s =
      tok.lastIndexOf(",") > tok.lastIndexOf(".")
        ? tok.replace(/\./g, "").replace(/,/g, ".") // comma is the decimal
        : tok.replace(/,/g, ""); // dot is the decimal, commas are grouping
  } else if (hasComma) {
    const parts = tok.split(",");
    if (parts.length > 2) {
      s = tok.replace(/,/g, ""); // 1,000,000 → grouping
    } else if (parts[1].length === 3 && !/^0+$/.test(parts[0])) {
      // single comma + 3 fraction digits is grouping ("1,000") — UNLESS the integer
      // part is only zero(s): "0,125" is a decimal (0.125), never 125-thousands.
      s = tok.replace(/,/g, "");
    } else {
      s = tok.replace(/,/g, "."); // 1,5 / 0,125 → decimal comma
    }
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(tok)) {
    // Two or more dot groups can only be grouping ("1.000.000"); a single dot
    // stays the decimal point, since "1.000" is one euro in a dot-decimal
    // locale. Anything else with several dots ("1..2") is still rejected.
    s = tok.replace(/\./g, "");
  } else {
    s = tok;
  }
  return stripIntZeros(s);
}

/**
 * Evaluate a normalized arithmetic expression without dynamic code execution.
 * Grammar: addition/subtraction, multiplication/division, unary signs, numbers
 * and parentheses.
 */
function evaluateArithmetic(input: string): number | null {
  let pos = 0;
  const skipSpaces = () => {
    while (/\s/.test(input[pos] ?? "")) pos += 1;
  };

  const parseNumber = (): number | null => {
    skipSpaces();
    const start = pos;
    let digits = 0;
    while (/\d/.test(input[pos] ?? "")) {
      pos += 1;
      digits += 1;
    }
    if (input[pos] === ".") {
      pos += 1;
      while (/\d/.test(input[pos] ?? "")) {
        pos += 1;
        digits += 1;
      }
    }
    if (digits === 0) return null;
    const value = Number(input.slice(start, pos));
    return Number.isFinite(value) ? value : null;
  };

  const parsePrimary = (): number | null => {
    skipSpaces();
    if (input[pos] !== "(") return parseNumber();
    pos += 1;
    const value = parseExpression();
    skipSpaces();
    if (value === null || input[pos] !== ")") return null;
    pos += 1;
    return value;
  };

  const parseUnary = (): number | null => {
    skipSpaces();
    if (input[pos] === "+" || input[pos] === "-") {
      const sign = input[pos];
      pos += 1;
      const value = parseUnary();
      if (value === null) return null;
      return sign === "-" ? -value : value;
    }
    return parsePrimary();
  };

  const parseTerm = (): number | null => {
    let value = parseUnary();
    if (value === null) return null;
    while (true) {
      skipSpaces();
      const op = input[pos];
      if (op !== "*" && op !== "/") break;
      pos += 1;
      const rhs = parseUnary();
      if (rhs === null) return null;
      value = op === "*" ? value * rhs : value / rhs;
      if (!Number.isFinite(value)) return null;
    }
    return value;
  };

  function parseExpression(): number | null {
    let value = parseTerm();
    if (value === null) return null;
    while (true) {
      skipSpaces();
      const op = input[pos];
      if (op !== "+" && op !== "-") break;
      pos += 1;
      const rhs = parseTerm();
      if (rhs === null) return null;
      value = op === "+" ? value + rhs : value - rhs;
      if (!Number.isFinite(value)) return null;
    }
    return value;
  }

  const value = parseExpression();
  skipSpaces();
  return value !== null && pos === input.length && Number.isFinite(value) ? value : null;
}

/** Evaluate a whitelisted arithmetic expression, or null if invalid. Exported for tests. */
export function evalMoneyExpr(expr: string): number | null {
  let raw = String(expr ?? "").trim();
  if (!raw) return null;
  if (raw.length > MAX_INPUT_LENGTH) return null;
  // Humans type money with a currency symbol ("€50", "50 €") and spaces as
  // thousands grouping ("1 000"). Strip any currency symbol, then close
  // digit-to-digit gaps so grouping spaces don't split one number into two
  // tokens — spaces around operators ("10 + 5") are untouched.
  raw = raw.replace(/\p{Sc}/gu, "").replace(/(\d)\s+(?=\d)/g, "$1").trim();
  if (!raw) return null;
  if (!SAFE_RE.test(raw)) return null;
  // Normalize each numeric token independently so separators in "1,5+2,5" or
  // "1,000+250" are interpreted per-operand, not across the whole expression.
  const s = raw.replace(/[\d.,]+/g, normalizeNumber);
  return evaluateArithmetic(s);
}

/**
 * Keep a controlled amount field limited to characters that can form a number
 * or one of the supported arithmetic expressions. Currency symbols are simply
 * removed (useful when pasting a formatted amount); any other unexpected text
 * rejects the whole edit so `12abc34` can never silently turn into `1234`.
 */
export function sanitizeMoneyInput(next: string, previous = ""): string {
  const cleaned = String(next ?? "")
    .replace(/\p{Sc}/gu, "")
    .replace(/[\u00a0\u202f]/g, " ");
  return cleaned.length <= MAX_INPUT_LENGTH && (cleaned === "" || SAFE_RE.test(cleaned))
    ? cleaned
    : previous;
}

/** Locale-aware, ungrouped display form that remains unambiguous to the parser. */
export function formatMoneyInputValue(n: number, locale?: string): string {
  const rounded = Math.round(n * 1e6) / 1e6;
  return new Intl.NumberFormat(locale, {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(rounded);
}

/**
 * Parse a MoneyInput's raw string value to a number (grouping- and expression-aware),
 * returning 0 when invalid/empty. Consumers MUST use this instead of `Number(raw)`:
 * a grouped value like "1.234,56" is a valid display string the field may still hold
 * (commit normalizes on blur, but submit can fire first / via Enter), and `Number()`
 * would turn it into NaN → a silently-saved 0.
 */
export function parseMoneyInput(s: string): number {
  return evalMoneyExpr(s) ?? 0;
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value"> & {
  value: string;
  /** Receives the (possibly committed) string value. */
  onValueChange: (v: string) => void;
};

/**
 * Drop-in replacement for a numeric amount <Input>. Kept as type=text +
 * inputmode=decimal so it can hold an expression; commits to the computed number
 * on Enter/blur.
 */
export const MoneyInput = forwardRef<HTMLInputElement, Props>(function MoneyInput(
  { value, onValueChange, ...rest },
  ref,
) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | null>(null);

  const recompute = (v: string) => {
    if (!v || !HAS_OP_RE.test(v)) {
      setPreview(null);
      return;
    }
    const r = evalMoneyExpr(v);
    setPreview(
      r === null
        ? { ok: false, text: "= —" }
        : { ok: true, text: `= ${formatMoneyInputValue(r, locale)}` },
    );
  };

  const commit = () => {
    // Normalize ANY valid input (expression, decimal comma, or grouped number like
    // "1.234,56") to the app locale's ungrouped display form on blur/Enter.
    // Invalid input is left as-is for the user to fix.
    const r = evalMoneyExpr(value);
    if (r !== null) onValueChange(formatMoneyInputValue(r, locale));
    setPreview(null);
  };

  return (
    <div>
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => {
          const next = sanitizeMoneyInput(e.target.value, value);
          // React normally restores a controlled value after the event, but if
          // the rejected edit equals the current state no parent render is
          // guaranteed. Restore it eagerly so an invalid character never even
          // flashes/sticks in the native input.
          if (next !== e.target.value) e.currentTarget.value = next;
          onValueChange(next);
          recompute(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && preview?.ok) {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        {...rest}
      />
      {preview && (
        <small className={preview.ok ? "mt-1 block text-xs text-positive" : "mt-1 block text-xs text-negative"}>
          {preview.text}
        </small>
      )}
    </div>
  );
});
