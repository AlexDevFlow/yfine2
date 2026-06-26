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
    initial ? String(initial.amount) : prefill?.amount != null ? String(prefill.amount) : "",
  );
  const [date, setDate] = useState(initial?.date ?? prefill?.date ?? todayISO());
  const [note, setNote] = useState(initial?.note ?? prefill?.note ?? "");
  const [tagIds, setTagIds] = useState<number[]>(initial?.tags.map((x) => x.id) ?? prefill?.tagIds ?? []);

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
        <Field label={t("amount", { defaultValue: "Amount" })} htmlFor="mv-amt">
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
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !amount}>{t("save", { defaultValue: "Save" })}</Button>
      </div>
    </form>
  );
}

// ---- transfer -----------------------------------------------------------

export interface TransferFormValues {
  fromSourceId: number;
  toSourceId: number;
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
  const [fromId, setFromId] = useState<string>(
    initial?.source_id != null ? String(initial.source_id) : String(real[0]?.id ?? ""),
  );
  const [toId, setToId] = useState<string>(
    initial?.partner_source_id != null ? String(initial.partner_source_id) : String(real[1]?.id ?? real[0]?.id ?? ""),
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

  const fromCcy = useMemo(() => real.find((s) => s.id === Number(fromId))?.currency, [real, fromId]);
  const toCcy = useMemo(() => real.find((s) => s.id === Number(toId))?.currency, [real, toId]);
  const crossCurrency = !!fromCcy && !!toCcy && fromCcy !== toCcy;
  const sameSource = fromId !== "" && fromId === toId;

  // Cross-currency auto-fill: prefill the converted amount from the configured
  // rate while the user hasn't overridden it. `convertedValue` is null when no
  // rate exists (→ "no rate" hint; the field stays optional, save isn't blocked).
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
  }, [crossCurrency, convertedValue]);
  const noRate = crossCurrency && amountNum > 0 && convertFetched && convertedValue == null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      fromSourceId: Number(fromId),
      toSourceId: Number(toId),
      amount: parseMoneyInput(amount),
      // Optional: blank converted ⇒ null (1:1 leg), matching the original.
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
          <Select id="tr-from" value={fromId} onChange={(e) => setFromId(e.target.value)} required>
            {real.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("to", { defaultValue: "To" })} htmlFor="tr-to">
          <Select id="tr-to" value={toId} onChange={(e) => setToId(e.target.value)} required>
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
        <Field label={crossCurrency ? `${t("amount", { defaultValue: "Amount" })} (${fromCcy})` : t("amount", { defaultValue: "Amount" })} htmlFor="tr-amt">
          <MoneyInput id="tr-amt" value={amount} onValueChange={setAmount} required className="num" />
        </Field>
        {crossCurrency && (
          <Field
            label={`${t("amount_received", { defaultValue: "Amount received" })} (${toCcy})`}
            htmlFor="tr-to-amt"
            hint={
              noRate
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
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !amount || sameSource || real.length < 2}>
          {t("save", { defaultValue: "Save" })}
        </Button>
      </div>
    </form>
  );
}
