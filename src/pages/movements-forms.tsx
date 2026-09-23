import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { MoneyInput, parseMoneyInput } from "@/components/ui/money-input";
import { cn } from "@/lib/cn";
import { todayISO } from "@/lib/date";
import { useConvert, type SourceWithBalance } from "@/db/queries";
import type { TagRow } from "@/db/schema-types";
import type { EnrichedMovement } from "@/db/repo/movements";

function TagChips({
  tags,
  selected,
  onChange,
}: {
  tags: TagRow[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  if (tags.length === 0) return null;
  const toggle = (id: number) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => {
        const on = selected.includes(t.id);
        return (
          <button
            type="button"
            key={t.id}
            onClick={() => toggle(t.id)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              on ? "border-primary bg-accent-soft text-primary" : "border-border text-muted hover:text-foreground",
            )}
          >
            <span
              className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
              style={{ background: t.color ?? "var(--muted-2)" }}
            />
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

// ---- plain movement -----------------------------------------------------

export interface MovementFormValues {
  source_id: number | null;
  amount: number;
  direction: "in" | "out";
  date: string;
  note: string;
  tagIds: number[];
}

export function MovementForm({
  initial,
  prefill,
  sources,
  tags,
  onSubmit,
  onCancel,
  pending,
  error,
  lastSourceId,
}: {
  initial?: EnrichedMovement;
  /** Quick-add template values: pre-fill a NEW movement (amount stays editable). */
  prefill?: MovementFormValues;
  sources: SourceWithBalance[];
  tags: TagRow[];
  onSubmit: (v: MovementFormValues) => void;
  onCancel: () => void;
  pending: boolean;
  error?: string;
  /** On a NEW movement, pre-select the last-used source if it still exists. */
  lastSourceId?: number | null;
}) {
  const { t } = useTranslation();
  const [direction, setDirection] = useState<"in" | "out">(initial?.direction ?? prefill?.direction ?? "out");
  const defaultSource =
    initial?.source_id != null
      ? String(initial.source_id)
      : prefill?.source_id != null
        ? String(prefill.source_id)
        : !initial && !prefill && lastSourceId != null && sources.some((s) => s.id === lastSourceId)
          ? String(lastSourceId)
          : "";
  const [sourceId, setSourceId] = useState<string>(defaultSource);
  const [amount, setAmount] = useState(
    // A 0/absent prefill amount means "start empty": rendering "0" would enable
    // Save only to guarantee an invalid_amount error on submit.
    initial ? String(initial.amount) : prefill?.amount ? String(prefill.amount) : "",
  );
  const [date, setDate] = useState(initial?.date ?? prefill?.date ?? todayISO());
  const [note, setNote] = useState(initial?.note ?? prefill?.note ?? "");
  const [tagIds, setTagIds] = useState<number[]>(initial?.tags.map((x) => x.id) ?? prefill?.tagIds ?? []);

  // Gate Save on a valid positive result, not just non-emptiness, so malformed
  // or non-positive expressions never reach the repository.
  const amountNum = parseMoneyInput(amount);
  const amountInvalid = amount.trim() !== "" && !(amountNum > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      source_id: sourceId === "" ? null : Number(sourceId),
      amount: parseMoneyInput(amount),
      direction,
      date,
      note,
      tagIds,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(["out", "in"] as const).map((d) => (
          <button
            type="button"
            key={d}
            onClick={() => setDirection(d)}
            className={cn(
              "h-10 rounded-[var(--radius-control)] border text-sm font-medium transition-colors",
              direction === d
                ? d === "in"
                  ? "border-positive bg-positive-soft text-positive"
                  : "border-negative bg-negative-soft text-negative"
                : "border-border text-muted hover:text-foreground",
            )}
          >
            {d === "in" ? t("income", { defaultValue: "Income" }) : t("expense", { defaultValue: "Expense" })}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("amount", { defaultValue: "Amount" })}
          htmlFor="mv-amt"
          hint={amountInvalid ? t("amount_invalid", { defaultValue: "Enter a valid amount greater than zero (numbers only)." }) : undefined}
        >
          <MoneyInput id="mv-amt" value={amount} onValueChange={setAmount} required autoFocus className="num" />
        </Field>
        <Field label={t("date", { defaultValue: "Date" })} htmlFor="mv-date">
          <DateInput id="mv-date" value={date} onChange={setDate} required />
        </Field>
      </div>

      <Field label={t("source", { defaultValue: "Source" })} htmlFor="mv-src">
        <Select id="mv-src" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">{t("external", { defaultValue: "External (no account)" })}</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>
          ))}
        </Select>
      </Field>

      <Field label={t("note", { defaultValue: "Note" })} htmlFor="mv-note">
        <Input id="mv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>

      {tags.length > 0 && (
        <Field label={t("tags", { defaultValue: "Tags" })}>
          <TagChips tags={tags} selected={tagIds} onChange={setTagIds} />
        </Field>
      )}

      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="sticky bottom-0 z-10 -mx-5 -mb-4 flex justify-end gap-2 border-t border-border bg-surface px-5 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !amount || amountInvalid}>{t("save", { defaultValue: "Save" })}</Button>
      </div>
    </form>
  );
}

// ---- transfer -----------------------------------------------------------

export interface TransferFormValues {
  /** null = the leg has no account (a migrated saving) and the edit leaves it that way. */
  fromSourceId: number | null;
  toSourceId: number | null;
  amount: number;
  toAmount: number | null;
  date: string;
  note: string;
  tagIds: number[];
}

export function TransferForm({
  initial,
  sources,
  tags,
  onSubmit,
  onCancel,
  pending,
  error,
}: {
  initial?: EnrichedMovement; // the OUT leg
  sources: SourceWithBalance[];
  tags: TagRow[];
  onSubmit: (v: TransferFormValues) => void;
  onCancel: () => void;
  pending: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const real = sources;
  // A leg with NO account (the savings migration's "external" out-leg) stays
  // external while editing: substituting the first listed account would move
  // money into it on a note-only save. "" is the external option's value.
  const fromExternal = initial != null && initial.source_id == null;
  const toExternal = initial != null && initial.partner_source_id == null;
  const [fromId, setFromId] = useState<string>(
    initial ? (initial.source_id != null ? String(initial.source_id) : "") : String(real[0]?.id ?? ""),
  );
  const [toId, setToId] = useState<string>(
    initial
      ? (initial.partner_source_id != null ? String(initial.partner_source_id) : "")
      : String(real[1]?.id ?? real[0]?.id ?? ""),
  );
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [toAmount, setToAmount] = useState(initial?.partner_amount != null ? String(initial.partner_amount) : "");
  // Once the user types in the converted field we stop auto-filling it (mirrors
  // the original's _toAmountEdited guard). Editing an existing transfer counts
  // as pre-edited so we never clobber a stored converted amount.
  const toEdited = useRef<boolean>(initial?.partner_amount != null);
  const [date, setDate] = useState(initial?.date ?? todayISO());
  const [note, setNote] = useState(initial?.note ?? "");
  const [tagIds, setTagIds] = useState<number[]>(initial?.tags.map((x) => x.id) ?? []);

  // A native <select> whose controlled value is still "" can visually display
  // its first option. That made the form LOOK like "Contanti → Fineco" while
  // React submitted Number("") === 0, and the repository correctly answered
  // "not found". Reconcile async/refetched source lists and always resolve IDs
  // from the actual option objects before enabling/submitting the form.
  useEffect(() => {
    if (real.length === 0) return;
    const validFrom = real.some((s) => String(s.id) === fromId) || (fromExternal && fromId === "");
    const nextFrom = validFrom ? fromId : String(real[0].id);
    const validTo = real.some((s) => String(s.id) === toId) || (toExternal && toId === "");
    let nextTo = validTo ? toId : String(real.find((s) => String(s.id) !== nextFrom)?.id ?? "");
    if (nextTo !== "" && nextTo === nextFrom) {
      nextTo = String(real.find((s) => String(s.id) !== nextFrom)?.id ?? "");
    }
    if (nextFrom !== fromId) setFromId(nextFrom);
    if (nextTo !== toId) setToId(nextTo);
  }, [real, fromId, toId, fromExternal, toExternal]);

  const fromSource = useMemo(() => real.find((s) => String(s.id) === fromId), [real, fromId]);
  const toSource = useMemo(() => real.find((s) => String(s.id) === toId), [real, toId]);
  const fromOk = !!fromSource || (fromExternal && fromId === "");
  const toOk = !!toSource || (toExternal && toId === "");
  const fromCcy = fromSource?.currency;
  const toCcy = toSource?.currency;
  const crossCurrency = !!fromCcy && !!toCcy && fromCcy !== toCcy;
  const sameSource = fromId !== "" && fromId === toId;
  const sourceSelectionInvalid = !fromOk || !toOk;

  const changeFrom = (next: string) => {
    setFromId(next);
    // Keep the pair valid by construction. This also covers an account list
    // changed underneath an open form without leaving Save mysteriously stuck.
    if (next === toId) {
      const alternative = real.find((s) => String(s.id) !== next);
      setToId(String(alternative?.id ?? ""));
    }
  };
  const changeTo = (next: string) => {
    setToId(next);
    if (next === fromId) {
      const alternative = real.find((s) => String(s.id) !== next);
      setFromId(String(alternative?.id ?? ""));
    }
  };

  // Cross-currency auto-fill: prefill the converted amount from the configured
  // rate while the user hasn't overridden it. `convertedValue` is null when no
  // rate exists (→ "no rate" hint; the user must enter the received amount).
  // parseMoneyInput (not Number) so the auto-convert also fires for expression /
  // grouped-locale input ("10+5", "1.234,56") that the save path already accepts.
  const amountNum = parseMoneyInput(amount);
  const { data: convertedValue, isFetched: convertFetched } = useConvert(
    crossCurrency ? amountNum : 0,
    crossCurrency ? fromCcy : undefined,
    crossCurrency ? toCcy : undefined,
  );
  // When the account pair changes the stored/typed converted amount no longer
  // applies — re-enable auto-fill. Skip the first run so editing an existing
  // transfer keeps its pre-edited guard (set from initial.partner_amount).
  const pairInit = useRef(true);
  useEffect(() => {
    if (pairInit.current) { pairInit.current = false; return; }
    toEdited.current = false;
  }, [fromId, toId]);
  useEffect(() => {
    if (!crossCurrency || toEdited.current) return;
    if (convertedValue != null) setToAmount(String(convertedValue));
    // Pair switched to one with NO configured rate: clear a surviving auto-fill —
    // the old number would silently read as an amount in the new target currency.
    else if (convertFetched) setToAmount("");
  }, [crossCurrency, convertedValue, convertFetched]);
  const noRate = crossCurrency && amountNum > 0 && convertFetched && convertedValue == null;

  // Same positive-result gate as MovementForm: malformed or non-positive input
  // is corrected in the form instead of bouncing off the repository.
  const amountInvalid = amount.trim() !== "" && !(amountNum > 0);
  const toAmountMissing = crossCurrency && toAmount.trim() === "";
  const toAmountInvalid = crossCurrency && !toAmountMissing && !(parseMoneyInput(toAmount) > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // The button is disabled in this state; keep the submit boundary defensive
    // against synthetic submission / a source disappearing during the modal.
    if (!fromOk || !toOk) return;
    onSubmit({
      fromSourceId: fromSource?.id ?? null,
      toSourceId: toSource?.id ?? null,
      amount: parseMoneyInput(amount),
      // Same currency uses null so the repository mirrors the amount 1:1.
      toAmount: crossCurrency && toAmount.trim() !== "" ? parseMoneyInput(toAmount) : null,
      date,
      note,
      tagIds,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("from", { defaultValue: "From" })} htmlFor="tr-from">
          <Select id="tr-from" value={fromId} onChange={(e) => changeFrom(e.target.value)} required={!fromExternal}>
            {fromExternal
              ? <option value="">{t("external", { defaultValue: "External" })}</option>
              : <option value="" disabled>{t("select_source", { defaultValue: "Select source" })}</option>}
            {real.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("to", { defaultValue: "To" })} htmlFor="tr-to">
          <Select id="tr-to" value={toId} onChange={(e) => changeTo(e.target.value)} required={!toExternal}>
            {toExternal
              ? <option value="">{t("external", { defaultValue: "External" })}</option>
              : <option value="" disabled>{t("select_source", { defaultValue: "Select source" })}</option>}
            {real.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>
            ))}
          </Select>
        </Field>
      </div>
      {sameSource && (
        <p className="text-xs text-negative">{t("err_same_source", { defaultValue: "Pick two different accounts." })}</p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field
          label={crossCurrency ? `${t("amount", { defaultValue: "Amount" })} (${fromCcy})` : t("amount", { defaultValue: "Amount" })}
          htmlFor="tr-amt"
          hint={amountInvalid ? t("amount_invalid", { defaultValue: "Enter a valid amount greater than zero (numbers only)." }) : undefined}
        >
          <MoneyInput id="tr-amt" value={amount} onValueChange={setAmount} required className="num" />
        </Field>
        {crossCurrency && (
          <Field
            label={`${t("amount_received", { defaultValue: "Amount received" })} (${toCcy})`}
            htmlFor="tr-to-amt"
            hint={
              toAmountInvalid
                ? t("amount_invalid", { defaultValue: "Enter a valid amount greater than zero (numbers only)." })
                : noRate
                  ? t("transfer_no_rate", { defaultValue: "No exchange rate set — enter the amount manually" })
                  : !toEdited.current && toAmount
                    ? t("converted_amount", { defaultValue: "Auto-converted (editable)" })
                    : undefined
            }
          >
            <MoneyInput
              id="tr-to-amt"
              value={toAmount}
              onValueChange={(v) => {
                toEdited.current = true;
                setToAmount(v);
              }}
              required
              className="num"
            />
          </Field>
        )}
        <Field label={t("date", { defaultValue: "Date" })} htmlFor="tr-date">
          <DateInput id="tr-date" value={date} onChange={setDate} required />
        </Field>
      </div>

      <Field label={t("note", { defaultValue: "Note" })} htmlFor="tr-note">
        <Input id="tr-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>

      {tags.length > 0 && (
        <Field label={t("tags", { defaultValue: "Tags" })}>
          <TagChips tags={tags} selected={tagIds} onChange={setTagIds} />
        </Field>
      )}

      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="sticky bottom-0 z-10 -mx-5 -mb-4 flex justify-end gap-2 border-t border-border bg-surface px-5 py-3">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !amount || amountInvalid || toAmountMissing || toAmountInvalid || sameSource || sourceSelectionInvalid || real.length < 2}>
          {t("save", { defaultValue: "Save" })}
        </Button>
      </div>
    </form>
  );
}
