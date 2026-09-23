import { Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { MoneyInput, parseMoneyInput } from "@/components/ui/money-input";
import { splitTotal, type NewSplit, type SplitLine } from "@/db/repo/splits";
import { cn } from "@/lib/cn";
import { todayISO } from "@/lib/date";
import type { SourceWithBalance } from "@/db/queries";
import type { TagRow } from "@/db/schema-types";

export function SplitForm({
  sources,
  tags,
  onCancel,
  onSubmit,
  pending,
  error,
}: {
  sources: SourceWithBalance[];
  tags: TagRow[];
  onCancel: () => void;
  onSubmit: (v: NewSplit) => void;
  pending: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [sourceId, setSourceId] = useState<string>(sources[0]?.id != null ? String(sources[0].id) : "");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<{ amount: string; tagId: string }[]>([
    { amount: "", tagId: "" },
    { amount: "", tagId: "" },
  ]);

  // parseMoneyInput (not Number) so expression / locale-decimal input ("10+5",
  // "1,5") counts toward the Total instead of being silently dropped as NaN.
  const parsedLines: SplitLine[] = lines
    .map((l) => ({ amount: parseMoneyInput(l.amount), tagId: l.tagId ? Number(l.tagId) : null }))
    .filter((l) => l.amount > 0);
  const total = splitTotal(parsedLines);
  // A line the user typed into but that doesn't parse to a positive amount
  // ("-20", "10-") must block Save rather than be dropped from the split silently.
  const hasInvalidLine = lines.some((l) => l.amount.trim() !== "" && !(parseMoneyInput(l.amount) > 0));

  const setLine = (i: number, patch: Partial<{ amount: string; tagId: string }>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      source_id: sourceId === "" ? null : Number(sourceId),
      direction,
      date,
      note: note || null,
      lines: parsedLines,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(["out", "in"] as const).map((d) => (
          <button type="button" key={d} onClick={() => setDirection(d)}
            className={cn("h-10 rounded-[var(--radius-control)] border text-sm font-medium", direction === d ? (d === "in" ? "border-positive bg-positive-soft text-positive" : "border-negative bg-negative-soft text-negative") : "border-border text-muted hover:text-foreground")}>
            {d === "in" ? t("income", { defaultValue: "Income" }) : t("expense", { defaultValue: "Expense" })}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("source", { defaultValue: "Source" })} htmlFor="sp-src">
          <Select id="sp-src" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">{t("external", { defaultValue: "External" })}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>)}
          </Select>
        </Field>
        <Field label={t("date", { defaultValue: "Date" })} htmlFor="sp-date">
          <DateInput id="sp-date" value={date} onChange={setDate} required />
        </Field>
      </div>
      <Field label={t("note", { defaultValue: "Note" })} htmlFor="sp-note">
        <Input id="sp-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("split_note_ph", { defaultValue: "e.g. Supermarket" })} maxLength={1000} />
      </Field>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">{t("split_lines", { defaultValue: "Split into" })}</p>
        {lines.map((l, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select value={l.tagId} onChange={(e) => setLine(i, { tagId: e.target.value })} className="flex-1">
              <option value="">{t("no_tag", { defaultValue: "(no category)" })}</option>
              {tags.map((tg) => <option key={tg.id} value={tg.id}>{tg.name}</option>)}
            </Select>
            <MoneyInput value={l.amount} onValueChange={(v) => setLine(i, { amount: v })} placeholder="0.00" className={cn("num w-28", l.amount.trim() !== "" && !(parseMoneyInput(l.amount) > 0) && "border-negative focus:border-negative")} />
            {lines.length > 1 && (
              <button type="button" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))} className="rounded-md p-2 text-muted hover:text-negative"><X className="h-4 w-4" /></button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => setLines((ls) => [...ls, { amount: "", tagId: "" }])} className="flex items-center gap-1 text-sm text-primary">
          <Plus className="h-4 w-4" /> {t("add_line", { defaultValue: "Add line" })}
        </button>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
        <span className="text-muted">{t("total", { defaultValue: "Total" })}</span>
        <span className="num font-semibold text-foreground">{total.toFixed(2)}</span>
      </div>

      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || parsedLines.length === 0 || hasInvalidLine}>{t("save", { defaultValue: "Save" })}</Button>
      </div>
    </form>
  );
}
