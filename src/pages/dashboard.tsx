import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Briefcase, CalendarClock, Eye, EyeOff, Info, PiggyBank, Plus, Repeat, Rocket, SlidersHorizontal, Wallet, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { MultiLineChart, SERIES_COLORS, type Series } from "@/components/ui/multi-line-chart";
import { Slot, SlotMoney } from "@/components/ui/slot";
import { DashboardSkeleton } from "@/components/dashboard-skeleton";
import { ForecastSummary } from "@/components/forecast-card";
import { MonthDetailModal } from "@/components/month-detail-modal";
import { MovementForm, TransferForm } from "@/pages/movements-forms";
import { SourceForm } from "@/pages/sources";
import { RecurringForm } from "@/pages/recurring";
import { isPreviewDb } from "@/db/connection";
import {
  useConsolidated,
  useCreateMovement,
  useCreateRecurring,
  useCreateSource,
  useCreateTransfer,
  useDashboard,
  useNetWorthHistoryAll,
  usePortfolios,
  usePreferences,
  useSources,
  useTags,
  useUpdatePreferences,
} from "@/db/queries";
import { parseNetWorthExcluded } from "@/db/repo/settings";
import { round2 } from "@/domain/money";
import { cn } from "@/lib/cn";
import { addDaysISO, dayLabel, formatDate, monthLabel, todayISO } from "@/lib/date";
import { formatMoney, formatSigned } from "@/lib/format";
import { useErrorText } from "@/lib/use-error-text";

const MASK = "••••••";

/**
 * Which accounts feed the net-worth figure. Defaults to all of them; the
 * selection persists in settings and is honoured by the per-currency totals,
 * the consolidated total and the history chart alike. Excluding an account also
 * excludes the portfolios linked to it — otherwise "don't count this account"
 * would still count its investments.
 */
function NetWorthSourcePicker({ excluded, onChange }: {
  excluded: number[];
  onChange: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  const { data: sources } = useSources();
  const [open, setOpen] = useState(false);
  const list = sources ?? [];
  const included = list.filter((s) => !excluded.includes(s.id)).length;
  const all = list.length;

  const toggle = (id: number) =>
    onChange(excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={t("net_worth_sources", { defaultValue: "Accounts in net worth" })}
        title={t("net_worth_sources", { defaultValue: "Accounts in net worth" })}
        aria-expanded={open}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-[var(--radius-control)] hover:bg-surface-2 hover:text-foreground",
          excluded.length > 0 ? "text-primary" : "text-muted",
        )}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          {/* Click-away layer: a plain overlay keeps this dependency-free and
              still lets the button itself toggle the menu shut. */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-40 w-64 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-[var(--shadow-pop)]">
            <div className="flex items-center justify-between px-1.5 pb-1.5">
              <span className="text-xs font-medium text-muted">
                {t("net_worth_sources", { defaultValue: "Accounts in net worth" })}
              </span>
              <span className="text-[11px] text-muted-2">{included}/{all}</span>
            </div>
            <ul className="max-h-64 overflow-y-auto">
              {list.map((s) => {
                const on = !excluded.includes(s.id);
                return (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-1.5 py-1.5 text-sm hover:bg-surface-2">
                      <input type="checkbox" checked={on} onChange={() => toggle(s.id)} />
                      <span className="min-w-0 flex-1 truncate text-foreground">{s.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-2">{s.currency}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {excluded.length > 0 && (
              <button onClick={() => onChange([])} className="mt-1 w-full rounded-[var(--radius-control)] px-1.5 py-1.5 text-left text-xs font-medium text-primary hover:bg-surface-2">
                {t("select_all", { defaultValue: "Select all" })}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}


const RANGES = [
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
  { key: "1y", days: 365 },
  { key: "all", days: Infinity },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

/** Comparison-chart window options (months clamped 2..36 in the repo). */
const COMPARISON_RANGES = [
  { key: "6m", months: 6 },
  { key: "1y", months: 12 },
  { key: "2y", months: 24 },
] as const;
type CompRangeKey = (typeof COMPARISON_RANGES)[number]["key"];

/** `days` ago in the LOCAL calendar — every movement date in the app is local. */
function cutoffISO(days: number): string {
  return addDaysISO(todayISO(), -days);
}

/** Day-relative badge for upcoming recurring items (invariant 14). */
function DaysBadge({ days }: { days: number }) {
  const { t } = useTranslation();
  if (days < 0)
    return <Badge tone="negative">{t("overdue", { defaultValue: "Overdue by {{n}} days", n: -days })}</Badge>;
  if (days === 0) return <Badge tone="negative">{t("today", { defaultValue: "Today" })}</Badge>;
  if (days === 1) return <Badge tone="neutral">{t("tomorrow", { defaultValue: "Tomorrow" })}</Badge>;
  if (days <= 3) return <Badge tone="warning">{t("days_left", { defaultValue: "{{n}} days left", n: days })}</Badge>;
  return <Badge tone="neutral">{t("days_left", { defaultValue: "{{n}} days left", n: days })}</Badge>;
}

function Stat({
  label,
  value,
  raw,
  tone,
  hidden,
  icon: Icon,
  onClick,
  external,
  externalSign,
}: {
  label: string;
  value: string;
  raw: number;
  tone: "positive" | "negative" | "primary";
  hidden: boolean;
  icon: typeof ArrowUpRight;
  onClick?: () => void;
  external?: string;
  externalSign?: "+" | "−";
}) {
  const { t } = useTranslation();
  const toneClass =
    tone === "positive" ? "text-positive bg-positive-soft" : tone === "negative" ? "text-negative bg-negative-soft" : "text-primary bg-accent-soft";
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      {...(onClick ? { onClick, type: "button" as const } : {})}
      className={cn("flex w-full items-center gap-3 text-left", onClick && "rounded-[var(--radius-control)] transition-colors hover:bg-surface-2")}
    >
      <div className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)]", toneClass)}>
        <Icon className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted">{label}</p>
        <SlotMoney value={raw} text={hidden ? MASK : value} rollOnMount className="num text-base font-semibold text-foreground" />
        {external && !hidden && (
          <p className="text-[11px] text-muted-2">
            ({t("of_which_external", { defaultValue: "of which external" })} {externalSign}
            {external})
          </p>
        )}
      </div>
    </Wrapper>
  );
}

/** Income-vs-expense bars with per-month hover read-out, range totals, and a 6m/1y/2y toggle. */
function MonthlyFlow({ comparison, primary, locale, range, onRange }: {
  comparison: { month: string; income: number; expense: number }[];
  primary: string;
  locale?: string;
  range: CompRangeKey;
  onRange: (r: CompRangeKey) => void;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const maxBar = Math.max(1, ...comparison.flatMap((c) => [c.income, c.expense]));
  const totalIn = round2(comparison.reduce((s, c) => s + c.income, 0));
  const totalOut = round2(comparison.reduce((s, c) => s + c.expense, 0));
  const hc = hover != null ? comparison[hover] : null;

  return (
    <Card className="lg:col-span-7 yn-fill [--d:80ms]">
      <CardHeader
        title={t("monthly_flow", { defaultValue: "Monthly flow" })}
        subtitle={`${t("income_vs_expense", { defaultValue: "Income vs expense" })} · ${primary}`}
        action={
          <div className="flex items-center gap-3 text-xs">
            <span className="num text-positive">+{formatMoney(totalIn, primary, locale)}</span>
            <span className="num text-negative">−{formatMoney(totalOut, primary, locale)}</span>
            <div className="flex gap-1">
              {COMPARISON_RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => onRange(r.key)}
                  className={cn(
                    "rounded-[var(--radius-control)] px-2 py-0.5 font-medium transition-colors",
                    range === r.key ? "bg-accent-soft text-primary" : "text-muted hover:text-foreground",
                  )}
                >
                  {t(r.key, { defaultValue: r.key })}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <CardContent>
        <div className="relative flex h-40 items-end justify-between gap-3">
          {hc && (
            <div className="absolute inset-x-0 -top-1 z-10 flex justify-center">
              <div className="whitespace-nowrap rounded-[var(--radius-control)] border border-border bg-surface px-2.5 py-1 text-xs shadow-[var(--shadow-pop)]">
                <span className="mr-2 font-medium text-foreground">{monthLabel(hc.month, locale)}</span>
                <span className="num text-positive">+{formatMoney(hc.income, primary, locale)}</span>
                <span className="num ml-2 text-negative">−{formatMoney(hc.expense, primary, locale)}</span>
              </div>
            </div>
          )}
          {comparison.map((c, i) => (
            <div
              key={c.month}
              className="flex flex-1 cursor-default flex-col items-center gap-1.5"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover((h) => (h === i ? null : h))}
            >
              <div className={cn("flex w-full items-end justify-center gap-1 rounded-t transition-colors", hover === i && "bg-surface-2/60")} style={{ height: 128 }}>
                <div className="w-1/2 rounded-t bg-positive/80" style={{ height: `${(c.income / maxBar) * 100}%` }} />
                <div className="w-1/2 rounded-t bg-negative/70" style={{ height: `${(c.expense / maxBar) * 100}%` }} />
              </div>
              <span className="text-[11px] text-muted">{monthLabel(c.month, locale).split(" ")[0].slice(0, 3)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-positive" />{t("income", { defaultValue: "Income" })}</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-negative" />{t("expense", { defaultValue: "Expense" })}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** First-run welcome / onboarding state (gap 4). */
function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const steps = [
    { n: 1, key: "welcome_step_1", def: "Create your first source (e.g. Bank Account, Cash)", icon: Wallet, tone: "text-positive bg-positive-soft" },
    { n: 2, key: "welcome_step_2", def: "Record your income and expense movements", icon: ArrowLeftRight, tone: "text-primary bg-accent-soft" },
    { n: 3, key: "welcome_step_3", def: "Set up recurring expenses so you never forget them", icon: Repeat, tone: "text-warning bg-warning-soft" },
  ];
  return (
    <Card className="p-10 text-center">
      <Rocket className="mx-auto h-12 w-12 text-primary" />
      <h3 className="mt-3 text-xl font-semibold text-foreground">{t("welcome_title", { defaultValue: "Welcome to Yfine!" })}</h3>
      <p className="mt-1 text-sm text-muted">{t("welcome_subtitle", { defaultValue: "Start managing your personal finances" })}</p>
      <div className="mx-auto mt-6 grid max-w-2xl gap-3 sm:grid-cols-3">
        {steps.map((s) => (
          <div key={s.n} className="rounded-[var(--radius-card)] border border-border bg-surface-2/40 p-4">
            <span className={cn("mx-auto grid h-10 w-10 place-items-center rounded-[var(--radius-control)]", s.tone)}>
              <s.icon className="h-5 w-5" />
            </span>
            <p className="mt-2 text-xs font-medium text-foreground">{s.n}. {t(s.key, { defaultValue: s.def })}</p>
          </div>
        ))}
      </div>
      <button
        onClick={() => void navigate({ to: "/sources" })}
        className="mt-6 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
      >
        <Plus className="h-4 w-4" /> {t("get_started", { defaultValue: "Get Started" })}
      </button>
    </Card>
  );
}

type QuickAction = "movement" | "transfer" | "source" | "recurring";

/** Quick-action button row — opens the create form in a popup (no page change). */
function QuickActions() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<QuickAction | null>(null);
  const actions: { key: string; def: string; icon: typeof Plus; action: QuickAction; cls: string }[] = [
    { key: "new_movement", def: "New Movement", icon: Plus, action: "movement", cls: "bg-primary text-primary-foreground hover:bg-primary-hover" },
    { key: "new_transfer", def: "New Transfer", icon: ArrowLeftRight, action: "transfer", cls: "bg-surface-2 text-foreground hover:bg-border" },
    { key: "new_source", def: "New Source", icon: Wallet, action: "source", cls: "bg-surface-2 text-foreground hover:bg-border" },
    { key: "new_recurring", def: "New Recurring Item", icon: Repeat, action: "recurring", cls: "bg-surface-2 text-foreground hover:bg-border" },
  ];
  return (
    <>
      <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1">
        {actions.map((a) => (
          <button
            key={a.key}
            onClick={() => setOpen(a.action)}
            className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors", a.cls)}
          >
            <a.icon className="h-4 w-4" /> {t(a.key, { defaultValue: a.def })}
          </button>
        ))}
      </div>
      {open && <QuickCreateModal action={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * Quick-create popup for the dashboard actions. Reuses each page's own create
 * form, then — on success — raises a success toast offering to open the entity
 * in its page (movements deep-link with ?focus so the new row is highlighted).
 */
function QuickCreateModal({ action, onClose }: { action: QuickAction; onClose: () => void }) {
  const { t } = useTranslation();
  const { push } = useToast();
  const navigate = useNavigate();
  const errText = useErrorText();
  const [error, setError] = useState<string>();
  const { data: sources } = useSources();
  const { data: tags } = useTags();
  const { data: prefs } = usePreferences();
  // Transfers must NOT target savings funds (they have a dedicated save/withdraw
  // flow that maintains fund invariants) — mirrors `realSources` in movements.tsx.
  const realSources = useMemo(() => (sources ?? []).filter((s) => s.is_savings_fund === 0), [sources]);

  const createMovement = useCreateMovement();
  const createTransfer = useCreateTransfer();
  const createSource = useCreateSource();
  const createRecurring = useCreateRecurring();

  const onErr = (e: unknown) => setError(errText(e));
  const done = (target: { to: string; search?: Record<string, unknown> }) => {
    push({
      title: t("created_successfully", { defaultValue: "Created successfully" }),
      body: t("view_in_page_q", { defaultValue: "Open it in its page?" }),
      tone: "success",
      action: { label: t("view", { defaultValue: "View" }), onClick: () => void navigate(target as Parameters<typeof navigate>[0]) },
    });
    onClose();
  };

  const title =
    action === "movement" ? t("new_movement", { defaultValue: "New Movement" })
      : action === "transfer" ? t("new_transfer", { defaultValue: "New Transfer" })
        : action === "source" ? t("new_source", { defaultValue: "New Source" })
          : t("new_recurring", { defaultValue: "New Recurring Item" });

  return (
    <Modal open onClose={onClose} title={title}>
      {action === "movement" && (
        <MovementForm
          lastSourceId={prefs?.last_source_id ?? null}
          sources={sources ?? []}
          tags={tags ?? []}
          pending={createMovement.isPending}
          error={error}
          onCancel={onClose}
          onSubmit={(v) => {
            setError(undefined);
            createMovement.mutate(
              { source_id: v.source_id, amount: v.amount, direction: v.direction, date: v.date, note: v.note, tagIds: v.tagIds },
              { onSuccess: (id) => done({ to: "/movements", search: { focus: id } }), onError: onErr },
            );
          }}
        />
      )}
      {action === "transfer" && (
        <TransferForm
          sources={realSources}
          tags={tags ?? []}
          pending={createTransfer.isPending}
          error={error}
          onCancel={onClose}
          onSubmit={(v) => {
            setError(undefined);
            if (v.fromSourceId == null || v.toSourceId == null) return; // both selects are required on create
            createTransfer.mutate(
              { fromSourceId: v.fromSourceId, toSourceId: v.toSourceId, amount: v.amount, toAmount: v.toAmount, date: v.date, note: v.note, tagIds: v.tagIds },
              { onSuccess: (pair) => done({ to: "/movements", search: { focus: pair.outId } }), onError: onErr },
            );
          }}
        />
      )}
      {action === "source" && (
        <SourceForm
          pending={createSource.isPending}
          error={error}
          onCancel={onClose}
          onSubmit={(v) => {
            setError(undefined);
            createSource.mutate(
              { name: v.name, currency: v.currency, starting_balance: v.starting_balance, yield_rate: v.yield_rate, yield_period_months: v.yield_period_months },
              { onSuccess: () => done({ to: "/sources" }), onError: onErr },
            );
          }}
        />
      )}
      {action === "recurring" && (
        <RecurringForm
          sources={sources ?? []}
          pending={createRecurring.isPending}
          error={error}
          onCancel={onClose}
          onSubmit={(v) => {
            setError(undefined);
            createRecurring.mutate(v, { onSuccess: () => done({ to: "/recurring" }), onError: onErr });
          }}
        />
      )}
    </Modal>
  );
}

/** One-time portfolio-prices first-launch prompt (gap 4). */
function PortfolioPrompt({ onChoice }: { onChoice: (enable: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Card className="border-primary/40">
      <CardContent className="flex items-start gap-3 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-accent-soft text-primary">
          <Briefcase className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{t("portfolio_prompt_title", { defaultValue: "Track portfolios with live prices?" })}</p>
          <p className="mt-0.5 text-sm text-muted">{t("portfolio_prompt_desc", { defaultValue: "Yfine can follow your crypto and stock positions using live prices. This needs an internet connection and can be changed anytime." })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => onChoice(true)} className="rounded-[var(--radius-control)] bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
              {t("portfolio_prompt_enable", { defaultValue: "Enable" })}
            </button>
            <button onClick={() => onChoice(false)} className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-border">
              {t("portfolio_prompt_skip", { defaultValue: "Not now" })}
            </button>
          </div>
        </div>
        <button onClick={() => onChoice(false)} aria-label={t("close", { defaultValue: "Close" })} className="text-muted hover:text-foreground">
          <X className="h-5 w-5" />
        </button>
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [compRange, setCompRange] = useState<CompRangeKey>("6m");
  const compMonths = COMPARISON_RANGES.find((r) => r.key === compRange)!.months;
  const { data, isLoading } = useDashboard(compMonths);
  const { data: prefs } = usePreferences();
  const { data: portfolios } = usePortfolios();
  const updatePrefs = useUpdatePreferences();
  const [showTotal, setShowTotal] = useState(false);
  const [range, setRange] = useState<RangeKey>("1y");
  const [monthModal, setMonthModal] = useState<"in" | "out" | null>(null);
  const consolidated = useConsolidated(showTotal && data ? data.primaryCurrency : null);

  const hidden = (prefs?.hide_net_worth ?? 0) === 1;
  const toggleHidden = () => updatePrefs.mutate({ hide_net_worth: !hidden });
  const excludedSources = parseNetWorthExcluded(prefs?.net_worth_excluded_json);

  const view = useMemo(() => {
    if (!data) return null;
    const entries = Object.entries(data.netWorth).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const primary = data.primaryCurrency;
    const flow = data.flow.byCurrency[primary] ?? { income: 0, expense: 0 };
    const saved = data.savings[primary] ?? 0;
    const net = round2(flow.income - flow.expense);
    return { entries, primary, flow, saved, net };
  }, [data]);

  const historyAll = useNetWorthHistoryAll();
  const chartSeries = useMemo<Series[]>(() => {
    const all = historyAll.data ?? [];
    const days = RANGES.find((r) => r.key === range)!.days;
    return all.map((s, i) => {
      let points = s.points;
      if (days !== Infinity) {
        const cut = cutoffISO(days);
        const f = s.points.filter((p) => p.date >= cut);
        points = f.length >= 2 ? f : s.points;
      }
      return { label: s.currency, color: SERIES_COLORS[i % SERIES_COLORS.length], points };
    });
  }, [historyAll.data, range]);

  if (isLoading || !view || !data) {
    return <DashboardSkeleton />;
  }

  // Onboarding: empty DB (no sources AND no movements).
  if (data.counts.sourceCount === 0 && data.counts.movementCount === 0) {
    return (
      <div className="space-y-4">
        <Onboarding />
      </div>
    );
  }

  const fmtMoney = (n: number) => formatMoney(n, view.primary, locale);
  const netWorthValue = data.netWorth[view.primary] ?? 0;

  // One-time portfolio prompt: not yet prompted AND has at least one portfolio.
  const showPortfolioPrompt =
    (prefs?.portfolio_prices_prompted ?? 0) === 0 && (portfolios?.length ?? 0) > 0;
  const choosePortfolio = (enable: boolean) =>
    updatePrefs.mutate({ portfolio_prices_enabled: enable, portfolio_prices_prompted: true });

  return (
    <div className="space-y-4">
      {isPreviewDb && (
        <div className="flex items-center gap-2 rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">
          <Info className="h-3.5 w-3.5" />
          {t("preview_db_note", { defaultValue: "Browser preview with seeded sample data (in-memory). The packaged app uses your real database." })}
        </div>
      )}

      {showPortfolioPrompt && <PortfolioPrompt onChoice={choosePortfolio} />}

      <QuickActions />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Net worth — with This month + 90-day forecast folded in to save space */}
        <Card className="lg:col-span-12 yn-fill [--d:0ms]">
          <CardHeader
            title={t("net_worth", { defaultValue: "Net Worth" })}
            subtitle={view.entries.length > 1 ? t("primary_currency", { defaultValue: "Primary currency" }) + ` · ${view.primary}` : view.primary}
            action={
              <div className="flex items-center gap-2">
                {view.net !== 0 && !hidden && (
                  <Badge tone={view.net >= 0 ? "positive" : "negative"}>
                    {view.net >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}
                    {formatSigned(view.net, view.primary, locale)}
                  </Badge>
                )}
                <NetWorthSourcePicker
                  excluded={excludedSources}
                  onChange={(ids) => updatePrefs.mutate({ net_worth_excluded_json: JSON.stringify(ids) })}
                />
                <button
                  onClick={toggleHidden}
                  aria-label={t("toggle_visibility", { defaultValue: "Toggle visibility" })}
                  className="grid h-8 w-8 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-surface-2 hover:text-foreground"
                >
                  {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            }
          />
          <CardContent className="pt-2">
            <div className="grid gap-6 lg:grid-cols-3">
              {/* Left: hero value + chart */}
              <div className="lg:col-span-2">
                <SlotMoney
                  value={netWorthValue}
                  text={hidden ? MASK : fmtMoney(netWorthValue)}
                  rollOnMount
                  className="num text-4xl font-semibold tracking-tight text-foreground"
                />
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-sm text-muted">{t("over_time", { defaultValue: "Over time" })}</p>
                  <div className="flex gap-1">
                    {RANGES.map((r) => (
                      <button
                        key={r.key}
                        onClick={() => setRange(r.key)}
                        className={cn(
                          "rounded-[var(--radius-control)] px-2 py-0.5 text-xs font-medium transition-colors",
                          range === r.key ? "bg-accent-soft text-primary" : "text-muted hover:text-foreground",
                        )}
                      >
                        {t(r.key, { defaultValue: r.key })}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-2">
                  <MultiLineChart
                    series={chartSeries}
                    height={158}
                    format={hidden ? () => MASK : (n) => n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    formatDate={(d) => dayLabel(d, locale)}
                    monthDividers
                    monthLabel={(d) => {
                      const mLabel = monthLabel(d, locale).split(" ")[0].slice(0, 3);
                      // Show the year on each January so multi-year ranges stay readable.
                      return d.slice(5, 7) === "01" ? `${mLabel} '${d.slice(2, 4)}` : mLabel;
                    }}
                  />
                </div>
                {view.entries.length > 1 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    {view.entries.filter(([c]) => c !== view.primary).map(([ccy, amt]) => (
                      <span key={ccy} className="num rounded-[var(--radius-control)] bg-surface-2 px-2.5 py-1 text-sm text-foreground">
                        {hidden ? `${MASK} ${ccy}` : formatMoney(amt, ccy, locale)}
                      </span>
                    ))}
                    <button onClick={() => setShowTotal((v) => !v)} className="text-xs font-medium text-primary">
                      <Slot
                        text={showTotal ? t("hide_total", { defaultValue: "Hide total" }) : t("show_total_in", { defaultValue: "Total in {{ccy}}", ccy: view.primary })}
                        options={{ direction: showTotal ? "up" : "down" }}
                      />
                    </button>
                  </div>
                )}
                {showTotal && consolidated.data && (
                  <p className="num mt-2 text-sm text-foreground">
                    ≈ {hidden ? `${MASK} ${consolidated.data.base}` : formatMoney(consolidated.data.total, consolidated.data.base, locale)}
                    {consolidated.data.missing.length > 0 && (
                      <span className="text-warning"> ({t("excluding", { defaultValue: "excl." })} {consolidated.data.missing.join(", ")})</span>
                    )}
                  </p>
                )}
              </div>

              {/* Right: this month + 90-day forecast */}
              <div className="flex flex-col gap-4 lg:border-l lg:border-border lg:pl-6">
                <div className="space-y-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-2">
                    {t("this_month", { defaultValue: "This month" })}
                  </p>
                  <Stat
                    label={t("income", { defaultValue: "Income" })}
                    raw={view.flow.income}
                    value={fmtMoney(view.flow.income)}
                    tone="positive"
                    hidden={hidden}
                    icon={ArrowUpRight}
                    onClick={() => setMonthModal("in")}
                    external={data.flow.externalIncome > 0 ? fmtMoney(data.flow.externalIncome) : undefined}
                    externalSign="+"
                  />
                  <Stat
                    label={t("expense", { defaultValue: "Expense" })}
                    raw={view.flow.expense}
                    value={fmtMoney(view.flow.expense)}
                    tone="negative"
                    hidden={hidden}
                    icon={ArrowDownLeft}
                    onClick={() => setMonthModal("out")}
                    external={data.flow.externalExpense > 0 ? fmtMoney(data.flow.externalExpense) : undefined}
                    externalSign="−"
                  />
                  <Stat label={t("saved", { defaultValue: "Saved" })} raw={view.saved} value={fmtMoney(view.saved)} tone="primary" hidden={hidden} icon={PiggyBank} />
                </div>
                <ForecastSummary hidden={hidden} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Monthly flow */}
        <MonthlyFlow comparison={data.comparison} primary={view.primary} locale={locale} range={compRange} onRange={setCompRange} />

        {/* Upcoming recurring */}
        <Card className="lg:col-span-5 yn-fill [--d:120ms]">
          <CardHeader title={t("upcoming_recurring", { defaultValue: "Upcoming" })} action={<CalendarClock className="h-4 w-4 text-muted" />} />
          <CardContent className="pt-2">
            {data.upcoming.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">{t("no_recurring", { defaultValue: "Nothing scheduled." })}</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.upcoming.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{r.name}</p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <p className="text-xs text-muted">{formatDate(r.next_due_date, prefs?.date_format, locale)}</p>
                        <DaysBadge days={r.days_left} />
                      </div>
                    </div>
                    <span className={cn("num text-sm font-semibold", r.direction === "in" ? "text-positive" : "text-foreground")}>
                      {formatSigned(r.direction === "in" ? r.amount : -r.amount, r.currency, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent movements */}
        <Card className="lg:col-span-12 yn-fill [--d:160ms]">
          <CardHeader
            title={t("recent_movements", { defaultValue: "Recent Movements" })}
            subtitle={t("n_total", { defaultValue: "{{n}} total", n: data.counts.movementCount })}
          />
          <CardContent className="pt-2">
            {data.recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">{t("no_movements", { defaultValue: "No movements yet." })}</p>
            ) : (
              <RecentMovements items={data.recent} primary={view.primary} locale={locale} dateFormat={prefs?.date_format} />
            )}
          </CardContent>
        </Card>
      </div>

      <MonthDetailModal direction={monthModal} primary={view.primary} locale={locale} dateFormat={prefs?.date_format} onClose={() => setMonthModal(null)} />
    </div>
  );
}

function RecentMovements({ items, primary, locale, dateFormat }: {
  items: import("@/db/repo/movements").EnrichedMovement[];
  primary: string;
  locale?: string;
  dateFormat?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Already newest-first from the query; group by day so the ordering reads clearly.
  const groups = useMemo(() => {
    const out: { date: string; items: typeof items }[] = [];
    for (const m of items) {
      const last = out[out.length - 1];
      if (last && last.date === m.date) last.items.push(m);
      else out.push({ date: m.date, items: [m] });
    }
    return out;
  }, [items]);

  return (
    <div className="divide-y divide-border">
      {groups.map((g) => (
        <div key={g.date} className="py-1 first:pt-0">
          <p className="py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-2">{formatDate(g.date, dateFormat, locale)}</p>
          <ul>
            {g.items.map((m) => {
              const transfer = m.transfer_pair_id != null;
              const ccy = m.source_currency ?? primary;
              // Compact single-line row: icon · note (source dimmed inline) · amount.
              return (
                <li key={m.id}>
                  {/* Each row jumps to this movement on the Movements page (scroll + highlight). */}
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/movements", search: { focus: m.id } })}
                    title={t("view_movement", { defaultValue: "View movement" })}
                    className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full", transfer ? "bg-surface-2 text-muted" : m.direction === "in" ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
                        {transfer ? <ArrowLeftRight className="h-3 w-3" /> : m.direction === "in" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 truncate text-[13px] text-foreground">
                        {m.note || m.source_name || t("external", { defaultValue: "External" })}
                        {m.note && m.source_name && <span className="text-muted-2"> · {m.source_name}</span>}
                      </span>
                    </span>
                    <span className={cn("num shrink-0 text-[13px] font-semibold", transfer ? "text-muted" : m.direction === "in" ? "text-positive" : "text-foreground")}>
                      {transfer ? formatMoney(m.amount, ccy, locale) : formatSigned(m.direction === "in" ? m.amount : -m.amount, ccy, locale)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
