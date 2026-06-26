/**
 * Arithmetic-aware amount input — a React port of static/js/math-input.js.
 *
 * The user can type an expression like `100+25*1.22`; a small "= 152.50" preview
 * appears and pressing Enter or blurring the field commits the computed value.
 * Plain numbers behave normally (the preview only shows when an operator is
 * present). Decimal commas are normalized so "1,5+2" works in IT/ES locales.
 *
 * Safety: only `0-9 . , + - * / ( ) space` are accepted; evaluation goes through
 * `Function(...)` (NOT eval) AFTER that whitelist check, on a constrained
 * character set, and short-circuits on NaN/Infinity.
 */
import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { Input } from "./input";

const SAFE_RE = /^[\d\s+\-*/().,]+$/;
const HAS_OP_RE = /[+\-*/()]/;

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
 * Strip leading zeros from a token's integer part so the evaluator never sees an
 * octal literal: `Function('return (+(0125))')` throws in strict mode → the value
 * silently became 0. Keeps one digit and never touches the fraction ("0125"→"125",
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
  } else {
    s = tok;
  }
  return stripIntZeros(s);
}

/** Evaluate a whitelisted arithmetic expression, or null if invalid. Exported for tests. */
export function evalMoneyExpr(expr: string): number | null {
  const raw = String(expr ?? "").trim();
  if (!raw) return null;
  if (!SAFE_RE.test(raw)) return null;
  // Normalize each numeric token independently so separators in "1,5+2,5" or
  // "1,000+250" are interpreted per-operand, not across the whole expression.
  const s = raw.replace(/[\d.,]+/g, normalizeNumber);
  try {
    // Unary plus forces numeric context; the whitelist keeps this safe.
    const v = Function('"use strict"; return (+(' + s + "));")() as unknown;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
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
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | null>(null);

  const recompute = (v: string) => {
    if (!v || !HAS_OP_RE.test(v)) {
      setPreview(null);
      return;
    }
    const r = evalMoneyExpr(v);
    setPreview(r === null ? { ok: false, text: "= —" } : { ok: true, text: `= ${fmt(r)}` });
  };

  const commit = () => {
    // Normalize ANY valid input (expression, decimal comma, or grouped number like
    // "1.234,56") to a plain JS-parseable number on blur/Enter. Invalid input is
    // left as-is for the user to fix.
    const r = evalMoneyExpr(value);
    if (r !== null) onValueChange(fmt(r));
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
          onValueChange(e.target.value);
          recompute(e.target.value);
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
