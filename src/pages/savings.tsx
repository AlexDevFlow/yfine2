import { CalendarDays, ChevronLeft, ChevronRight, LineChart as LineChartIcon, Pencil, PiggyBank, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { BalanceHistoryChart } from "@/components/ui/balance-history-chart";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm";
import { DateInput } from "@/components/ui/date-input";
import { MultiLineChart, SERIES_COLORS, type Series } from "@/components/ui/multi-line-chart";
import { NumberedPagination } from "@/components/ui/pagination";
import { SlotMoney } from "@/components/ui/slot";
import { isPreviewDb } from "@/db/connection";
import {
  SAVINGS_PAGE_SIZE,
  useCreateSaving,
  useDeleteSaving,
  useRunSavingsWizard,
  useSavings,
  useSavingsByMonth,
  useSavingsTotals,
  useSavingsTrends,
  useSavingsWizardStatus,
  useSources,
  useTags,
  useUpdateSaving,
  type SourceWithBalance,
} from "@/db/queries";
import type { EnrichedSaving, NewSaving, SavingPatch, SavingsFilters } from "@/db/repo/savings";
import type { WizardMode } from "@/db/repo/savings-migration";
import type { TagRow } from "@/db/schema-types";
import { round2 } from "@/domain/money";
import { cn } from "@/lib/cn";
import { dayLabel, lastNMonths, monthLabel, todayISO } from "@/lib/date";
import { formatMoney } from "@/lib/format";
import { useErrorText } from "@/lib/use-error-text";

/** Fund balance card with an expandable balance-over-time chart. */
function FundCard({ fund, locale }: { fund: SourceWithBalance; locale?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] bg-accent-soft text-primary">
          <PiggyBank className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted">{fund.name} · {fund.currency}</p>
          <SlotMoney value={fund.balance} text={formatMoney(fund.balance, fund.currency, locale)} className="num text-xl font-semibold text-foreground" />
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={t("history", { defaultValue: "History" })}
          aria-expanded={open}
          className={cn("rounded-md p-2 hover:bg-surface-2 hover:text-foreground", open ? "text-primary" : "text-muted")}
        >
          <LineChartIcon className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div className="border-t border-border pt-2">
          <BalanceHistoryChart sourceId={fund.id} currency={fund.currency} locale={locale} />
        </div>
      )}
    </Card>
  );
}

/** A per-currency aggregate KPI card (total / this-month / last-month). */
function StatCard({ label, totals, locale, onClick }: {
  label: string;
  totals: Record<string, number>;
  locale?: string;
  onClick?: () => void;
}) {
  const entries = Object.entries(totals);
  const body = (
    <>
      <p className="text-xs text-muted">{label}</p>
      {entries.length === 0 ? (
        <p className="num text-xl font-semibold text-muted-2">—</p>
      ) : (
        <div className="mt-0.5 space-y-0.5">
          {entries.map(([ccy, v]) => (
            <p key={ccy} className="num text-lg font-semibold text-foreground">{formatMoney(v, ccy, locale)}</p>
          ))}
        </div>
      )}
    </>
  );
  return onClick ? (
    <Card className="p-4 text-left transition-colors hover:border-border-strong" role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}>
      {body}
    </Card>
  ) : (
    <Card className="p-4">{body}</Card>
  );
}

function TagChips({ tags, selected, onChange }: { tags: TagRow[]; selected: number[]; onChange: (ids: number[]) => void }) {
  if (tags.length === 0) return null;
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
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
            <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: t.color ?? "var(--muted-2)" }} />
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

/** Months covered by the trend charts and the calendar drill-down. */
const TREND_MONTHS = 12;

interface SavingFormValues {
  /** null = the deposit has no from-account (an imported legacy saving) and keeps it that way. */
  fromSourceId: number | null;
  amount: number;
  date: string;
  note: string | null;
  tagIds: number[];
}

/** Create/edit a saving. In edit mode, from-source + currency-fund move in lockstep. */
function SavingForm({ sources, tags, editing, onCancel, onSubmit, pending, error }: {
  sources: SourceWithBalance[];
  tags: TagRow[];
  editing?: EnrichedSaving;
  onCancel: () => void;
  onSubmit: (v: SavingFormValues) => void;
  pending: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  // Funds can't fund a saving — only regular accounts.
  const accounts = sources.filter((s) => s.is_savings_fund === 0);
  // An edited deposit with NO from-account (migrated legacy saving, or its
  // account was deleted as "external") must stay external unless the user picks
  // one — defaulting to the first account would silently debit it on save.
  const external = editing != null && editing.from_source_id == null;
  const [fromSourceId, setFromSourceId] = useState(
    editing ? (editing.from_source_id != null ? String(editing.from_source_id) : "") : String(accounts[0]?.id ?? ""),
  );
  const [amount, setAmount] = useState(editing ? String(editing.amount) : "");
  const [date, setDate] = useState(editing?.date ?? todayISO());
  const [note, setNote] = useState(editing?.note ?? "");
  const [tagIds, setTagIds] = useState<number[]>(editing ? editing.tags.map((t) => t.id) : []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ fromSourceId: fromSourceId === "" ? null : Number(fromSourceId), amount: Number(amount) || 0, date, note: note || null, tagIds });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={t("from", { defaultValue: "From" })} htmlFor="sv-src">
        <Select id="sv-src" value={fromSourceId} onChange={(e) => setFromSourceId(e.target.value)} required={!external}>
          {external && <option value="">{t("external", { defaultValue: "External" })}</option>}
          {accounts.map((s) => (
            <option key={s.id} value={s.id}>{s.name} · {formatMoney(s.balance, s.currency)}</option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("amount", { defaultValue: "Amount" })} htmlFor="sv-amt">
          <Input id="sv-amt" type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus className="num" />
        </Field>
        <Field label={t("date", { defaultValue: "Date" })} htmlFor="sv-date">
          <DateInput id="sv-date" value={date} onChange={setDate} />
        </Field>
      </div>
      <Field label={t("note", { defaultValue: "Note" })} htmlFor="sv-note">
        <Input id="sv-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {tags.length > 0 && <TagChips tags={tags} selected={tagIds} onChange={setTagIds} />}
      <p className="text-xs text-muted">{t("saving_fund_hint", { defaultValue: "Money moves into your savings fund for that currency — your net worth is unchanged." })}</p>
      {accounts.length === 0 && <p className="text-xs text-warning">{t("no_accounts", { defaultValue: "Add a regular account first." })}</p>}
      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !fromSourceId || !amount}>{t("save", { defaultValue: "Save" })}</Button>
      </div>
    </form>
  );
}

/** Legacy-savings migration wizard modal (3 strategies). */
function WizardModal({ open, sources, onClose, onRun, pending, error }: {
  open: boolean;
  sources: SourceWithBalance[];
  onClose: () => void;
  onRun: (mode: WizardMode, unifiedSourceId: number | null) => void;
  pending: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const accounts = sources.filter((s) => s.is_savings_fund === 0);
  const [mode, setMode] = useState<WizardMode>("movements");
  const [unifiedSourceId, setUnifiedSourceId] = useState<string>("");

  const opt = (m: WizardMode, label: string, desc: string, danger = false) => (
    <label className={cn("block cursor-pointer rounded-[var(--radius-control)] border p-3", mode === m ? "border-primary bg-accent-soft" : "border-border")}>
      <span className="flex gap-3">
        <input type="radio" name="wizard-mode" className="mt-0.5" checked={mode === m} onChange={() => setMode(m)} />
        <span>
          <span className={cn("block text-sm font-medium", danger ? "text-negative" : "text-foreground")}>{label}</span>
          <span className="block text-xs text-muted">{desc}</span>
        </span>
      </span>
      {m === "movements" && mode === "movements" && (
        <div className="ml-7 mt-2">
          <Field label={t("wizard_unified_source", { defaultValue: "Where did the money come from?" })} htmlFor="wz-src">
            <Select id="wz-src" value={unifiedSourceId} onChange={(e) => setUnifiedSourceId(e.target.value)}>
              <option value="">{t("wizard_source_none", { defaultValue: "— leave blank (external / no source) —" })}</option>
              {accounts.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </label>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("wizard_title", { defaultValue: "Import historical savings" })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("cancel", { defaultValue: "Cancel" })}</Button>
          <Button onClick={() => onRun(mode, unifiedSourceId ? Number(unifiedSourceId) : null)} disabled={pending}>
            {t("wizard_run", { defaultValue: "Run" })}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">{t("wizard_choose_strategy", { defaultValue: "Pick what to do:" })}</p>
        {opt("movements", t("wizard_mode_movements", { defaultValue: "Import each entry as a historical contribution" }), t("wizard_mode_movements_desc", { defaultValue: "Creates a transfer for every past saving. Keeps full granularity." }))}
        {opt("starting_balance", t("wizard_mode_balance", { defaultValue: "Collapse into the fund's starting balance" }), t("wizard_mode_balance_desc", { defaultValue: "Adds the total amount as the fund's opening balance. Fastest, but you lose the per-entry history." }))}
        {opt("discard", t("wizard_mode_discard", { defaultValue: "Discard history and start fresh" }), t("wizard_mode_discard_desc", { defaultValue: "Deletes every legacy saving entry. Can't be undone." }), true)}
        {error ? <p className="text-sm text-negative">{error}</p> : null}
      </div>
    </Modal>
  );
}

/** Month drill-down modal opened from the "total saved" card. */
function CalendarModal({ months, onClose, locale }: {
  months: { ym: string; totals: Map<string, number> }[];
  onClose: () => void;
  locale?: string;
}) {
  const { t } = useTranslation();
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  const { data: monthItems } = useSavingsByMonth(openMonth);

  return (
    <Modal open onClose={onClose} title={t("savings_calendar", { defaultValue: "Savings by month" })}>
      {openMonth ? (
        <div className="space-y-2">
          <button onClick={() => setOpenMonth(null)} className="inline-flex items-center gap-1 text-sm text-primary">
            <ChevronLeft className="h-4 w-4" /> {t("back", { defaultValue: "Back" })}
          </button>
          <h3 className="text-sm font-semibold text-foreground">{monthLabel(openMonth, locale)}</h3>
          <ul className="divide-y divide-border">
            {(monthItems ?? []).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{s.note || s.from_source_name || t("saving", { defaultValue: "Saving" })}</p>
                  <p className="text-xs text-muted">{dayLabel(s.date, locale)}</p>
                </div>
                <span className="num text-sm font-semibold text-positive">{formatMoney(s.amount, s.currency, locale)}</span>
              </li>
            ))}
            {monthItems && monthItems.length === 0 && (
              <li className="py-4 text-center text-sm text-muted">{t("no_savings", { defaultValue: "No savings logged yet." })}</li>
            )}
          </ul>
        </div>
      ) : months.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">{t("no_savings", { defaultValue: "No savings logged yet." })}</p>
      ) : (
        <ul className="divide-y divide-border">
          {months.map((g) => (
            <li key={g.ym}>
              <button onClick={() => setOpenMonth(g.ym)} className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:text-primary">
                <span className="text-sm font-medium text-foreground">{monthLabel(g.ym, locale)}</span>
                <span className="flex items-center gap-2 text-xs">
                  {[...g.totals.entries()].map(([ccy, total]) => (
                    <span key={ccy} className="num text-positive">+{formatMoney(total, ccy, locale)}</span>
                  ))}
                  <ChevronRight className="h-4 w-4 text-muted" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function SavingsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const errText = useErrorText();

  const { data: sources } = useSources();
  const { data: tags } = useTags();
  const { data: wizard } = useSavingsWizardStatus();
  const { data: totals } = useSavingsTotals();
  const { data: trends } = useSavingsTrends(TREND_MONTHS);

  // Filters + pagination.
  const [page, setPage] = useState(1);
  const [filterCurrency, setFilterCurrency] = useState("");
  const [filterTag, setFilterTag] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const filters: SavingsFilters = {
    currency: filterCurrency || null,
    tagId: filterTag ? Number(filterTag) : null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
  };
  const { data: savingsPage, isLoading } = useSavings(page, filters);
  const savings = savingsPage?.items;
  const total = savingsPage?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SAVINGS_PAGE_SIZE));
  // Clamp during render if the active page no longer exists (e.g. deleting the last
  // rows on the last page shrank the set) — otherwise the user is stranded on a blank
  // page with the pagination control hidden. React bails out when the value is unchanged.
  if (page > pageCount) setPage(pageCount);

  const create = useCreateSaving();
  const update = useUpdateSaving();
  const del = useDeleteSaving();
  const runWizard = useRunSavingsWizard();
  const askConfirm = useConfirm();

  const [form, setForm] = useState<{ editing?: EnrichedSaving } | null>(null);
  const [formError, setFormError] = useState<string>();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardError, setWizardError] = useState<string>();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [chartMode, setChartMode] = useState<"contributions" | "fundBalance">("contributions");

  const funds = (sources ?? []).filter((s) => s.is_savings_fund === 1 && s.balance !== 0);
  const fundCurrencies = [...new Set((sources ?? []).filter((s) => s.is_savings_fund === 1).map((s) => s.currency))].sort();

  // Group the current page's deposits by month with per-currency month totals.
  const months = useMemo(() => {
    const out: { ym: string; items: EnrichedSaving[]; totals: Map<string, number> }[] = [];
    for (const s of savings ?? []) {
      const ym = s.date.slice(0, 7);
      let g = out[out.length - 1];
      if (!g || g.ym !== ym) {
        g = { ym, items: [], totals: new Map() };
        out.push(g);
      }
      g.items.push(s);
      g.totals.set(s.currency, round2((g.totals.get(s.currency) ?? 0) + s.amount));
    }
    return out;
  }, [savings]);

  // Trend chart: one series per currency over a shared month axis (forward-filled).
  const chartSeries: Series[] = useMemo(() => {
    const rows = (chartMode === "contributions" ? trends?.contributions : trends?.fundBalance) ?? [];
    if (rows.length === 0) return [];
    // The chart places points by index, so the axis must carry EVERY month of
    // the window: a month with no deposits is a 0 on the line, not a missing
    // step that makes Feb sit next to May.
    const monthsAxis = [...new Set([...lastNMonths(todayISO(), TREND_MONTHS), ...rows.map((r) => r.month)])].sort();
    const currencies = [...new Set(rows.map((r) => r.currency))].sort();
    const byKey = new Map(rows.map((r) => [`${r.month}|${r.currency}`, r.value]));
    return currencies.map((cur, i) => {
      let last = 0;
      const points = monthsAxis.map((m) => {
        const key = `${m}|${cur}`;
        if (byKey.has(key)) last = byKey.get(key)!;
        // Contributions are flow-per-month (0 when absent); fund balance is a running level (carry last).
        const value = chartMode === "contributions" ? byKey.get(key) ?? 0 : last;
        return { date: `${m}-01`, value };
      });
      return { label: cur, color: SERIES_COLORS[i % SERIES_COLORS.length], points };
    });
  }, [trends, chartMode]);

  // Calendar month list spans the full contributions trend window (not just the
  // current page), so the drill-down browses all recent months.
  const calendarMonths = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const r of trends?.contributions ?? []) {
      if (!map.has(r.month)) map.set(r.month, new Map());
      map.get(r.month)!.set(r.currency, round2((map.get(r.month)!.get(r.currency) ?? 0) + r.value));
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([ym, totals]) => ({ ym, totals }));
  }, [trends]);

  const resetFilters = () => {
    setFilterCurrency("");
    setFilterTag("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };
  const hasFilters = !!(filterCurrency || filterTag || dateFrom || dateTo);

  const submitForm = (v: SavingFormValues) => {
    setFormError(undefined);
    const editing = form?.editing;
    if (editing) {
      const patch: SavingPatch = {
        amount: v.amount,
        date: v.date,
        note: v.note,
        tagIds: v.tagIds,
        // Only re-point the OUT leg when the user actually picked another account.
        ...(v.fromSourceId != null && v.fromSourceId !== editing.from_source_id ? { fromSourceId: v.fromSourceId } : {}),
      };
      update.mutate(
        { id: editing.id, patch },
        { onSuccess: () => setForm(null), onError: (e) => setFormError(errText(e)) },
      );
    } else {
      if (v.fromSourceId == null) return; // the select is required on create
      const data: NewSaving = { fromSourceId: v.fromSourceId, amount: v.amount, date: v.date, note: v.note, tagIds: v.tagIds };
      create.mutate(data, { onSuccess: () => setForm(null), onError: (e) => setFormError(errText(e)) });
    }
  };

  const runWizardMode = (mode: WizardMode, unifiedSourceId: number | null) => {
    setWizardError(undefined);
    runWizard.mutate(
      { mode, unifiedSourceId },
      { onSuccess: () => setWizardOpen(false), onError: (e) => setWizardError(errText(e)) },
    );
  };

  const remove = (id: number) => {
    void askConfirm({ message: t("delete_saving_confirm", { defaultValue: "Delete this saving? The money is refunded to the source account." }), tone: "danger" }).then((ok) => {
      if (ok) del.mutate(id);
    });
  };

  return (
    <div className="space-y-4">
      {isPreviewDb && (
        <div className="rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">
          {t("preview_db_note", { defaultValue: "Browser preview with seeded sample data." })}
        </div>
      )}

      {wizard?.needed && (
        <Card className="flex flex-col gap-2 border-warning bg-warning-soft p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-medium text-foreground">{t("wizard_title", { defaultValue: "Import historical savings" })}</p>
              <p className="text-xs text-muted">
                {t("wizard_intro", { defaultValue: "Yfine moved to a new savings model where money actually flows into a per-currency fund. We need to decide what to do with your existing savings log." })}
              </p>
              {wizard.preview && (
                <p className="mt-1 text-xs text-muted">
                  {t("wizard_preview_count", { defaultValue: "Entries found: {{n}}", n: wizard.preview.count })}
                  {wizard.preview.earliestDate && (
                    <> · {t("wizard_range", { defaultValue: "Range" })}: {wizard.preview.earliestDate} → {wizard.preview.latestDate}</>
                  )}
                </p>
              )}
            </div>
          </div>
          <Button onClick={() => { setWizardError(undefined); setWizardOpen(true); }} className="shrink-0">
            {t("wizard_start", { defaultValue: "Start wizard" })}
          </Button>
        </Card>
      )}

      <div className="flex items-center justify-end">
        <Button onClick={() => { setFormError(undefined); setForm({}); }}>
          <Plus className="h-4 w-4" /> {t("new_saving", { defaultValue: "New Saving" })}
        </Button>
      </div>

      {/* Aggregate KPI cards. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t("savings_this_month", { defaultValue: "Saved this month" })} totals={totals?.thisMonth ?? {}} locale={locale} />
        <StatCard label={t("savings_last_month", { defaultValue: "Saved last month" })} totals={totals?.lastMonth ?? {}} locale={locale} />
        <StatCard label={t("savings_total", { defaultValue: "Total Saved" })} totals={totals?.total ?? {}} locale={locale} onClick={() => setCalendarOpen(true)} />
      </div>

      {funds.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {funds.map((f) => (
            <FundCard key={f.id} fund={f} locale={locale} />
          ))}
        </div>
      )}

      {/* Trend chart with the contributions / fund-balance toggle. */}
      {chartSeries.length > 0 && (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">{t("savings_tab_trend", { defaultValue: "Trend" })}</h3>
            <div className="flex gap-1">
              {(["contributions", "fundBalance"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setChartMode(m)}
                  className={cn("rounded-[var(--radius-control)] px-2.5 py-1 text-xs font-medium transition-colors", chartMode === m ? "bg-accent-soft text-primary" : "text-muted hover:text-foreground")}
                >
                  {m === "contributions" ? t("chart_contributions", { defaultValue: "Contributions" }) : t("chart_fund_balance", { defaultValue: "Fund balance" })}
                </button>
              ))}
            </div>
          </div>
          <MultiLineChart series={chartSeries} height={160} format={(n) => n.toFixed(2)} formatDate={(d) => monthLabel(d.slice(0, 7), locale)} />
        </Card>
      )}

      {/* Filter bar. */}
      <Card className="flex flex-wrap items-end gap-3 p-3">
        <Field label={t("currency", { defaultValue: "Currency" })} htmlFor="f-ccy">
          <Select id="f-ccy" value={filterCurrency} onChange={(e) => { setFilterCurrency(e.target.value); setPage(1); }}>
            <option value="">{t("all", { defaultValue: "All" })}</option>
            {fundCurrencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label={t("tag", { defaultValue: "Tag" })} htmlFor="f-tag">
          <Select id="f-tag" value={filterTag} onChange={(e) => { setFilterTag(e.target.value); setPage(1); }}>
            <option value="">{t("all", { defaultValue: "All" })}</option>
            {(tags ?? []).map((tg) => <option key={tg.id} value={tg.id}>{tg.name}</option>)}
          </Select>
        </Field>
        <Field label={t("date_from", { defaultValue: "From" })} htmlFor="f-from">
          <DateInput id="f-from" value={dateFrom} onChange={(v) => { setDateFrom(v); setPage(1); }} />
        </Field>
        <Field label={t("date_to", { defaultValue: "To" })} htmlFor="f-to">
          <DateInput id="f-to" value={dateTo} onChange={(v) => { setDateTo(v); setPage(1); }} />
        </Field>
        {hasFilters && (
          <Button variant="ghost" onClick={resetFilters}>
            <X className="h-4 w-4" /> {t("reset_filters", { defaultValue: "Reset" })}
          </Button>
        )}
        <button onClick={() => setCalendarOpen(true)} className="ml-auto inline-flex items-center gap-1 rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground" aria-label={t("savings_calendar", { defaultValue: "Savings by month" })}>
          <CalendarDays className="h-4 w-4" />
        </button>
      </Card>

      {isLoading && <Card className="p-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</Card>}
      {savings && savings.length === 0 && (
        <Card className="p-10 text-center text-sm text-muted">
          {hasFilters ? t("no_results", { defaultValue: "No results" }) : t("no_savings", { defaultValue: "No savings logged yet. Start tracking what you save!" })}
        </Card>
      )}

      {months.length > 0 && (
        <div className="space-y-3">
          {months.map((g) => (
            <Card key={g.ym} className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-border bg-surface-2/40 px-4 py-2.5">
                <h3 className="text-sm font-semibold text-foreground">{monthLabel(g.ym, locale)}</h3>
                <div className="flex items-center gap-2 text-xs">
                  {[...g.totals.entries()].map(([ccy, total]) => (
                    <span key={ccy} className="num text-positive">+{formatMoney(total, ccy, locale)}</span>
                  ))}
                </div>
              </div>
              <ul className="divide-y divide-border">
                {g.items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {s.from_source_name ?? t("deleted", { defaultValue: "Deleted" })}
                        {s.note && <span className="text-muted"> · {s.note}</span>}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                        <span>{dayLabel(s.date, locale)}</span>
                        {s.tags.map((tag) => (
                          <span key={tag.id} className="inline-flex items-center">
                            <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: tag.color ?? "var(--muted-2)" }} />
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="num text-sm font-semibold text-positive">{formatMoney(s.amount, s.currency, locale)}</span>
                      <button onClick={() => { setFormError(undefined); setForm({ editing: s }); }} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-foreground" aria-label={t("edit", { defaultValue: "Edit" })}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button onClick={() => remove(s.id)} className="rounded-md p-1.5 text-muted hover:bg-negative-soft hover:text-negative" aria-label={t("delete", { defaultValue: "Delete" })}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {total > SAVINGS_PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <p className="text-xs text-muted">
            {t("showing_of", {
              defaultValue: "Showing {{start}}-{{end}} of {{total}}",
              start: total === 0 ? 0 : (page - 1) * SAVINGS_PAGE_SIZE + 1,
              end: Math.min(page * SAVINGS_PAGE_SIZE, total),
              total,
            })}
          </p>
          <NumberedPagination page={page} totalPages={pageCount} onPageChange={setPage} />
        </div>
      )}

      <Modal
        open={form != null}
        onClose={() => setForm(null)}
        title={form?.editing ? t("edit_saving", { defaultValue: "Edit Saving" }) : t("new_saving", { defaultValue: "New Saving" })}
      >
        {form != null && (
          <SavingForm
            sources={sources ?? []}
            tags={tags ?? []}
            editing={form.editing}
            pending={create.isPending || update.isPending}
            error={formError}
            onCancel={() => setForm(null)}
            onSubmit={submitForm}
          />
        )}
      </Modal>

      <WizardModal
        open={wizardOpen}
        sources={sources ?? []}
        pending={runWizard.isPending}
        error={wizardError}
        onClose={() => setWizardOpen(false)}
        onRun={runWizardMode}
      />

      {calendarOpen && (
        <CalendarModal months={calendarMonths} onClose={() => setCalendarOpen(false)} locale={locale} />
      )}
    </div>
  );
}
