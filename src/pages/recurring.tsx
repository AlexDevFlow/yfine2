import { getRouteApi } from "@tanstack/react-router";
import { AlertTriangle, CalendarClock, CheckCircle2, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { Modal } from "@/components/ui/modal";
import { isPreviewDb } from "@/db/connection";
import {
  useApplyRecurring,
  useCreateRecurring,
  useDeleteRecurring,
  useRecurring,
  useSources,
  useUpdateRecurring,
} from "@/db/queries";
import type { EnrichedRecurring, NewRecurring } from "@/db/repo/recurring";
import { cn } from "@/lib/cn";
import { dayLabel, todayISO } from "@/lib/date";
import { formatSigned } from "@/lib/format";
import { useErrorText } from "@/lib/use-error-text";
import type { SourceWithBalance } from "@/db/queries";

const recurringRouteApi = getRouteApi("/recurring");

const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;

/** Rich "next due" label + tone, faithful to og: overdue / today / tomorrow / in N days. */
function dueLabel(daysUntil: number, t: (k: string, o?: Record<string, unknown>) => string): { text: string; tone: string } {
  if (daysUntil < 0) return { text: t("overdue", { defaultValue: "Overdue by {{n}} days", n: -daysUntil }), tone: "text-negative font-semibold" };
  if (daysUntil === 0) return { text: t("due_today", { defaultValue: "Due today" }), tone: "text-warning font-semibold" };
  if (daysUntil === 1) return { text: t("due_tomorrow", { defaultValue: "Due tomorrow" }), tone: "text-warning" };
  return { text: t("days_due", { defaultValue: "in {{n}} days", n: daysUntil }), tone: "text-muted" };
}

/** One summary stat tile (monthly outflow / inflow / net). */
function StatTile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-border p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-2">{label}</div>
      <div className={cn("num mt-0.5 text-xl font-bold", tone)}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </div>
  );
}

export function RecurringForm({
  initial,
  sources,
  onCancel,
  onSubmit,
  pending,
  error,
}: {
  initial?: EnrichedRecurring;
  sources: SourceWithBalance[];
  onCancel: () => void;
  onSubmit: (v: NewRecurring) => void;
  pending: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [direction, setDirection] = useState<"in" | "out">(initial?.direction ?? "out");
  const [sourceId, setSourceId] = useState<string>(initial?.source_id != null ? String(initial.source_id) : "");
  const [currency, setCurrency] = useState(initial?.currency ?? "EUR");
  const [frequency, setFrequency] = useState(initial?.frequency ?? "monthly");
  const [start, setStart] = useState(initial?.start_date ?? todayISO());
  const [end, setEnd] = useState(initial?.end_date ?? "");
  const [mode, setMode] = useState<"auto" | "confirm">(initial?.apply_mode ?? "confirm");
  const [alertDays, setAlertDays] = useState(String(initial?.alert_days_before ?? 7));
  const [alertInsufficient, setAlertInsufficient] = useState((initial?.alert_if_insufficient ?? 1) === 1);

  const selectedSource = sources.find((s) => s.id === Number(sourceId));
  const effectiveCurrency = selectedSource ? selectedSource.currency : currency.trim().toUpperCase();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: name.trim(),
      amount: Number(amount) || 0,
      direction,
      currency: effectiveCurrency,
      frequency,
      start_date: start,
      end_date: end || null,
      source_id: sourceId === "" ? null : Number(sourceId),
      apply_mode: mode,
      alert_days_before: Number(alertDays) || 0,
      alert_if_insufficient: alertInsufficient,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={t("name", { defaultValue: "Name" })} htmlFor="rc-name">
        <Input id="rc-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        {(["out", "in"] as const).map((d) => (
          <button type="button" key={d} onClick={() => setDirection(d)}
            className={cn("h-10 rounded-[var(--radius-control)] border text-sm font-medium transition-colors",
              direction === d ? (d === "in" ? "border-positive bg-positive-soft text-positive" : "border-negative bg-negative-soft text-negative") : "border-border text-muted hover:text-foreground")}>
            {d === "in" ? t("income", { defaultValue: "Income" }) : t("expense", { defaultValue: "Expense" })}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("amount", { defaultValue: "Amount" })} htmlFor="rc-amt">
          <Input id="rc-amt" type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required className="num" />
        </Field>
        <Field label={t("frequency", { defaultValue: "Frequency" })} htmlFor="rc-freq">
          <Select id="rc-freq" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`freq_${f}`, { defaultValue: f })}</option>)}
          </Select>
        </Field>
      </div>
      <Field label={t("source", { defaultValue: "Source" })} htmlFor="rc-src">
        <Select id="rc-src" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">{t("external", { defaultValue: "External (no account)" })}</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>)}
        </Select>
      </Field>
      {!selectedSource && (
        <Field label={t("currency", { defaultValue: "Currency" })} htmlFor="rc-ccy">
          <Input id="rc-ccy" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={5} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("start_date", { defaultValue: "Start date" })} htmlFor="rc-start">
          <DateInput id="rc-start" value={start} onChange={setStart} required />
        </Field>
        <Field label={t("end_date_optional", { defaultValue: "End date (optional)" })} htmlFor="rc-end">
          <DateInput id="rc-end" value={end} onChange={setEnd} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("apply_mode", { defaultValue: "When due" })} htmlFor="rc-mode">
          <Select id="rc-mode" value={mode} onChange={(e) => setMode(e.target.value as "auto" | "confirm")}>
            <option value="confirm">{t("mode_confirm", { defaultValue: "Ask me to confirm" })}</option>
            <option value="auto">{t("mode_auto", { defaultValue: "Apply automatically" })}</option>
          </Select>
        </Field>
        <Field label={t("alert_days", { defaultValue: "Remind days before" })} htmlFor="rc-alert">
          <Input id="rc-alert" type="number" min="0" max="365" value={alertDays} onChange={(e) => setAlertDays(e.target.value)} className="num" />
        </Field>
      </div>
      {direction === "out" && (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={alertInsufficient} onChange={(e) => setAlertInsufficient(e.target.checked)} />
          {t("alert_insufficient", { defaultValue: "Warn me if the balance is too low" })}
        </label>
      )}
      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !name.trim() || !amount}>{t("save", { defaultValue: "Save" })}</Button>
      </div>
    </form>
  );
}

/**
 * Manual-apply modal: prefills the amount to the rule's base and lets the user
 * adjust it (one-off override) and add a note. Mirrors templates/recurring/index.html:
 * only sends `amount` when it differs from the base by > 0.001, and `note` when set.
 */
function ApplyForm({
  item,
  locale,
  onCancel,
  onSubmit,
  pending,
  error,
}: {
  item: EnrichedRecurring;
  locale: string | undefined;
  onCancel: () => void;
  onSubmit: (v: { amount?: number; note?: string }) => void;
  pending: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(String(item.amount));
  const [note, setNote] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    const out: { amount?: number; note?: string } = {};
    // Only override the amount when it differs from the base (matches the original's > 0.001 gate).
    if (n > 0 && Math.abs(n - item.amount) > 0.001) out.amount = n;
    const trimmed = note.trim();
    if (trimmed) out.note = trimmed;
    onSubmit(out);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted">
        {item.direction === "in" ? t("income", { defaultValue: "Income" }) : t("expense", { defaultValue: "Expense" })} — {t("adjust_amount_hint", { defaultValue: "You can adjust the amount before confirming (e.g. bonus, extra charges)." })}
      </p>
      <Field label={t("amount", { defaultValue: "Amount" })} htmlFor="ap-amt">
        <Input id="ap-amt" type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus className="num" />
      </Field>
      <p className="text-xs text-muted">
        {t("base_amount", { defaultValue: "Base amount" })}: {formatSigned(item.direction === "in" ? item.amount : -item.amount, item.currency, locale)}. {t("adjust_if_needed", { defaultValue: "Change if this time is different." })}
      </p>
      <Field label={t("note", { defaultValue: "Note" })} htmlFor="ap-note">
        <Input id="ap-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("apply_note_placeholder", { defaultValue: "e.g. Includes bonus, overtime, adjustment..." })} />
      </Field>
      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !(Number(amount) > 0)}>{t("apply_now", { defaultValue: "Apply Now" })}</Button>
      </div>
    </form>
  );
}

export function RecurringPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const errText = useErrorText();
  const { data, isLoading } = useRecurring();
  const { data: sources } = useSources();
  const create = useCreateRecurring();
  const update = useUpdateRecurring();
  const del = useDeleteRecurring();
  const apply = useApplyRecurring();

  const [modal, setModal] = useState<{ open: boolean; editing?: EnrichedRecurring }>({ open: false });
  const [formError, setFormError] = useState<string>();

  // Dashboard quick action: open the New Recurring form when ?create arrives.
  const { create: createParam } = recurringRouteApi.useSearch();
  const navigate = recurringRouteApi.useNavigate();
  useEffect(() => {
    if (!createParam) return;
    setModal({ open: true });
    void navigate({ to: "/recurring", search: {}, replace: true });
  }, [createParam, navigate]);
  const [applying, setApplying] = useState<EnrichedRecurring>();
  const [applyError, setApplyError] = useState<string>();
  const [deleting, setDeleting] = useState<EnrichedRecurring>();
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string }>();
  const [dirFilter, setDirFilter] = useState<"all" | "in" | "out">("all");
  const [freqFilter, setFreqFilter] = useState<string>("all");

  const summaryChips = useMemo(() => Object.entries(data?.summary.byCurrency ?? {}), [data]);
  const items = useMemo(() => {
    let list = data?.items ?? [];
    if (dirFilter !== "all") list = list.filter((r) => r.direction === dirFilter);
    if (freqFilter !== "all") list = list.filter((r) => r.frequency === freqFilter);
    return list;
  }, [data, dirFilter, freqFilter]);

  const submit = (v: NewRecurring) => {
    setFormError(undefined);
    const onErr = (e: unknown) => setFormError(errText(e));
    if (modal.editing) update.mutate({ id: modal.editing.id, patch: v }, { onSuccess: () => setModal({ open: false }), onError: onErr });
    else create.mutate(v, { onSuccess: () => setModal({ open: false }), onError: onErr });
  };

  const doApply = (override: { amount?: number; note?: string }) => {
    if (!applying) return;
    setApplyError(undefined);
    apply.mutate(
      { id: applying.id, ...override },
      {
        onSuccess: () => {
          setApplying(undefined);
          setFeedback({ tone: "success", text: t("applied_successfully", { defaultValue: "Applied successfully" }) });
        },
        onError: (e) => setApplyError(errText(e)),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleting) return;
    const id = deleting.id;
    del.mutate(id, {
      onSuccess: () => {
        setDeleting(undefined);
        setFeedback({ tone: "success", text: t("deleted_successfully", { defaultValue: "Deleted successfully" }) });
      },
      onError: (e) => {
        setDeleting(undefined);
        setFeedback({ tone: "error", text: errText(e) });
      },
    });
  };

  return (
    <div className="space-y-4">
      {isPreviewDb && (
        <div className="rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">
          {t("preview_db_note", { defaultValue: "Browser preview with seeded sample data (in-memory)." })}
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className={cn(
            "flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-3 py-2 text-sm",
            feedback.tone === "success" ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative",
          )}
        >
          <span>{feedback.text}</span>
          <button onClick={() => setFeedback(undefined)} className="text-xs opacity-70 hover:opacity-100">
            {t("dismiss", { defaultValue: "Dismiss" })}
          </button>
        </div>
      )}

      {summaryChips.map(([ccy, b]) => (
        <div key={ccy} className="grid gap-2 sm:grid-cols-3">
          <StatTile
            label={t("monthly_outflow", { defaultValue: "Monthly outflow" })}
            value={formatSigned(-b.outflow, ccy, locale)}
            sub={t("n_items", { defaultValue: "{{count}} items", count: b.countOut })}
            tone="text-negative"
          />
          <StatTile
            label={t("monthly_inflow", { defaultValue: "Monthly inflow" })}
            value={formatSigned(b.inflow, ccy, locale)}
            sub={t("n_items", { defaultValue: "{{count}} items", count: b.countIn })}
            tone="text-positive"
          />
          <StatTile
            label={t("net_monthly", { defaultValue: "Net monthly" })}
            value={formatSigned(b.net, ccy, locale)}
            sub={summaryChips.length === 1 ? `${t("projected", { defaultValue: "Projected" })} · ${ccy}` : t("projected", { defaultValue: "Projected" })}
            tone={b.net >= 0 ? "text-positive" : "text-negative"}
          />
        </div>
      ))}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{t("recurring_subtitle", { defaultValue: "Bills, subscriptions and income on a schedule." })}</p>
        <Button onClick={() => { setFormError(undefined); setModal({ open: true }); }}>
          <Plus className="h-4 w-4" /> {t("new_recurring", { defaultValue: "New Recurring Item" })}
        </Button>
      </div>

      {data && data.items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1.5">
            {(["all", "in", "out"] as const).map((d) => (
              <button key={d} onClick={() => setDirFilter(d)} className={cn("rounded-full px-3 py-1 text-xs font-medium transition-colors", dirFilter === d ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface-2 hover:text-foreground")}>
                {d === "all" ? t("all", { defaultValue: "All" }) : d === "in" ? t("income", { defaultValue: "Income" }) : t("expense", { defaultValue: "Expense" })}
              </button>
            ))}
          </div>
          <Select value={freqFilter} onChange={(e) => setFreqFilter(e.target.value)} className="w-auto">
            <option value="all">{t("all_frequencies", { defaultValue: "All frequencies" })}</option>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`freq_${f}`, { defaultValue: f })}</option>)}
          </Select>
        </div>
      )}

      {isLoading && <Card className="p-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</Card>}
      {data && data.items.length === 0 && (
        <Card className="p-10 text-center text-sm text-muted">{t("no_recurring", { defaultValue: "No recurring items yet." })}</Card>
      )}
      {data && data.items.length > 0 && items.length === 0 && (
        <Card className="p-8 text-center text-sm text-muted">{t("no_match", { defaultValue: "Nothing matches these filters." })}</Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((r) => {
          const due = dueLabel(r.days_until, t);
          return (
            <Card key={r.id} className="relative flex h-full flex-col overflow-hidden">
              {/* Color accent stripe — green for income, red for expense (og parity). */}
              <div className={cn("absolute inset-x-0 top-0 h-1", r.direction === "in" ? "bg-positive" : "bg-negative")} />
              <div className="flex flex-1 flex-col p-4 pt-5">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate font-semibold text-foreground">{r.name}</p>
                  <span className={cn("num shrink-0 text-base font-bold", r.direction === "in" ? "text-positive" : "text-negative")}>
                    {formatSigned(r.direction === "in" ? r.amount : -r.amount, r.currency, locale)}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone="primary">{t(`freq_${r.frequency}`, { defaultValue: r.frequency })}</Badge>
                  <Badge tone={r.apply_mode === "auto" ? "positive" : "warning"}>
                    {r.apply_mode === "auto" ? t("automatic", { defaultValue: "Automatic" }) : t("manual_confirm", { defaultValue: "Manual confirm" })}
                  </Badge>
                  {r.source_name && (
                    <Badge><Wallet className="h-3 w-3" />{r.source_name}</Badge>
                  )}
                </div>

                <div className="mt-3 flex items-center gap-2 text-sm">
                  <CalendarClock className="h-4 w-4 shrink-0 text-muted-2" />
                  <div className="min-w-0">
                    <div className="text-foreground">{dayLabel(r.next_due_date, locale)}</div>
                    <div className={cn("text-xs", due.tone)}>{due.text}</div>
                  </div>
                </div>

                <div className="mt-auto flex items-center gap-1 pt-3">
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => { setApplyError(undefined); setApplying(r); }} title={t("apply_now", { defaultValue: "Apply now" })}>
                    <CheckCircle2 className="h-4 w-4" /> {t("apply_now", { defaultValue: "Apply now" })}
                  </Button>
                  <button onClick={() => { setFormError(undefined); setModal({ open: true, editing: r }); }} aria-label={t("edit", { defaultValue: "Edit" })} title={t("edit", { defaultValue: "Edit" })} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => setDeleting(r)} aria-label={t("delete", { defaultValue: "Delete" })} title={t("delete", { defaultValue: "Delete" })} className="rounded-md p-2 text-muted hover:bg-negative-soft hover:text-negative">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Modal open={modal.open} onClose={() => setModal({ open: false })} title={modal.editing ? t("edit_recurring", { defaultValue: "Edit Recurring Item" }) : t("new_recurring", { defaultValue: "New Recurring Item" })}>
        <RecurringForm initial={modal.editing} sources={sources ?? []} pending={create.isPending || update.isPending} error={formError} onCancel={() => setModal({ open: false })} onSubmit={submit} />
      </Modal>

      <Modal open={!!applying} onClose={() => setApplying(undefined)} title={applying ? `${t("apply", { defaultValue: "Apply" })} · ${applying.name}` : ""}>
        {applying && (
          <ApplyForm item={applying} locale={locale} pending={apply.isPending} error={applyError} onCancel={() => setApplying(undefined)} onSubmit={doApply} />
        )}
      </Modal>

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title={t("delete_recurring", { defaultValue: "Delete recurring item?" })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>{t("cancel", { defaultValue: "Cancel" })}</Button>
            <Button variant="danger" onClick={confirmDelete} disabled={del.isPending}>{t("delete", { defaultValue: "Delete" })}</Button>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <p className="text-sm text-muted">
            {t("confirm_delete_recurring", { defaultValue: "This recurring rule will be permanently deleted." })}
            {deleting ? <span className="mt-1 block font-medium text-foreground">{deleting.name}</span> : null}
          </p>
        </div>
      </Modal>
    </div>
  );
}
