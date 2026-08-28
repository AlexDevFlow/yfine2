import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownLeft, ArrowUpRight, CalendarRange, Hash, Repeat, Sigma, TrendingDown, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DonutChart } from "@/components/ui/donut-chart";
import { Modal } from "@/components/ui/modal";
import { useBreakdown } from "@/db/queries";
import type { BreakdownSlice } from "@/db/repo/breakdown";
import type { MovementFilters } from "@/db/repo/movements";
import { cn } from "@/lib/cn";
import { addMonthsISO, formatDate, monthEnd, monthLabel, monthStart, todayISO } from "@/lib/date";
import { formatMoney } from "@/lib/format";

/**
 * "Where did it actually go?" — the analysis behind an Income/Expense total.
 *
 * The panel never invents a scope of its own: it takes the caller's filters
 * (the dashboard's current month, or the Movements page's active filter set)
 * and only overrides the DATE RANGE, driven by its own period picker. So the
 * figures always reconcile with the list the user came from.
 *
 * Everything is per currency — the switcher appears only when the range really
 * does hold more than one, and amounts are never converted (same rule as net
 * worth). See db/repo/breakdown.ts for how multi-tag rows are attributed.
 */

/** Slice colours for categories/accounts the user hasn't coloured themselves. */
const PALETTE = ["var(--primary)", "#03c3ec", "#ffab00", "#71dd37", "#7367f0", "#e83e8c", "#00cfe8", "#ff6b6b"];
const NEUTRAL = "#8592a3";

type PeriodKey = "as_filtered" | "this_month" | "last_month" | "last_3m" | "last_12m" | "this_year" | "all";

function resolveRange(
  period: PeriodKey,
  base: MovementFilters,
): { dateFrom?: string; dateTo?: string } {
  const today = todayISO();
  switch (period) {
    case "as_filtered":
      return { dateFrom: base.dateFrom, dateTo: base.dateTo };
    case "this_month":
      return { dateFrom: monthStart(today), dateTo: monthEnd(today) };
    case "last_month": {
      const prev = addMonthsISO(monthStart(today), -1);
      return { dateFrom: monthStart(prev), dateTo: monthEnd(prev) };
    }
    case "last_3m":
      return { dateFrom: monthStart(addMonthsISO(monthStart(today), -2)), dateTo: monthEnd(today) };
    case "last_12m":
      return { dateFrom: monthStart(addMonthsISO(monthStart(today), -11)), dateTo: monthEnd(today) };
    case "this_year":
      return { dateFrom: `${today.slice(0, 4)}-01-01`, dateTo: `${today.slice(0, 4)}-12-31` };
    case "all":
      return {};
  }
}

/** Colour for a slice: the tag's own colour wins, else a stable palette slot. */
function sliceColor(s: BreakdownSlice, i: number): string {
  if (s.color) return s.color;
  if (s.key === "untagged" || s.key === "external") return NEUTRAL;
  return PALETTE[i % PALETTE.length];
}

function Tile({ label, value, sub, icon: Icon, tone }: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  tone?: string;
}) {
  return (
    <div className="rounded-[var(--radius-control)] bg-surface-2 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </p>
      <p className={cn("num mt-1 text-lg font-bold tracking-tight", tone ?? "text-foreground")}>{value}</p>
      <p className="num mt-0.5 text-[11px] text-muted">{sub ?? <span>&nbsp;</span>}</p>
    </div>
  );
}

/** One "label — bar — amount — %" row, used for both categories and accounts. */
function BarRow({ label, color, amount, share, count, money, onClick, title }: {
  label: string;
  color: string;
  amount: number;
  share: number;
  count: number;
  money: (n: number) => string;
  onClick?: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        "block w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left transition-colors",
        onClick && "hover:bg-surface-2",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate text-sm text-foreground">{label}</span>
          <span className="shrink-0 text-[11px] text-muted-2">
            {t("n_movements_short", { defaultValue: "{{n}} mov.", n: count })}
          </span>
        </span>
        <span className="num shrink-0 text-sm font-semibold text-foreground">
          {money(amount)}
          <span className="ml-1.5 text-xs font-normal text-muted">{(share * 100).toFixed(1)}%</span>
        </span>
      </div>
      <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.max(2, share * 100).toFixed(1)}%`, background: color }}
        />
      </span>
    </Tag>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-2">{title}</h4>
      {children}
    </section>
  );
}

export function BreakdownPanel({
  baseFilters,
  initialDirection = "out",
  defaultPeriod = "this_month",
  locale,
  dateFormat,
  onNavigate,
}: {
  /** Scope to analyse. Its date range is replaced by the period picker. */
  baseFilters: MovementFilters;
  initialDirection?: "in" | "out";
  defaultPeriod?: PeriodKey;
  locale?: string;
  dateFormat?: string | null;
  /** Called right before a drill-down navigation (hosts use it to close). */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [direction, setDirection] = useState<"in" | "out">(initialDirection);
  const [period, setPeriod] = useState<PeriodKey>(defaultPeriod);
  const [currency, setCurrency] = useState<string | undefined>(undefined);

  const filters = useMemo<MovementFilters>(() => {
    const range = resolveRange(period, baseFilters);
    return {
      ...baseFilters,
      // Free text is a list-level concern; analysing "the scope" is the point here.
      q: undefined,
      direction,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    };
  }, [baseFilters, period, direction]);

  const { data, isLoading } = useBreakdown(filters, currency);

  const ccy = data?.currency ?? "";
  const money = (n: number) => (ccy ? formatMoney(n, ccy, locale) : n.toFixed(2));
  const total = data?.total ?? 0;
  const share = (n: number) => (total > 0 ? n / total : 0);

  const periods: { key: PeriodKey; label: string }[] = [
    ...(baseFilters.dateFrom || baseFilters.dateTo
      ? [{ key: "as_filtered" as const, label: t("period_as_filtered", { defaultValue: "As filtered" }) }]
      : []),
    { key: "this_month", label: t("this_month", { defaultValue: "This month" }) },
    { key: "last_month", label: t("last_month", { defaultValue: "Last month" }) },
    { key: "last_3m", label: t("last_3_months", { defaultValue: "Last 3 months" }) },
    { key: "last_12m", label: t("last_12_months", { defaultValue: "Last 12 months" }) },
    { key: "this_year", label: t("this_year", { defaultValue: "This year" }) },
    { key: "all", label: t("all_time", { defaultValue: "All time" }) },
  ];

  const delta =
    data?.previousTotal != null && data.previousTotal > 0
      ? Math.round(((data.total - data.previousTotal) / data.previousTotal) * 1000) / 10
      : null;
  // For expenses "more" is bad, for income "more" is good — colour accordingly.
  const deltaGood = delta == null ? null : direction === "out" ? delta <= 0 : delta >= 0;

  const goMovements = (extra: Record<string, unknown>) => {
    onNavigate?.();
    void navigate({
      to: "/movements",
      search: {
        direction,
        ...(filters.dateFrom ? { dateFrom: filters.dateFrom } : {}),
        ...(filters.dateTo ? { dateTo: filters.dateTo } : {}),
        ...extra,
      },
    });
  };

  const weekdayNames = useMemo(
    // 2024-01-01 was a Monday, so this yields the Monday-first names the
    // breakdown's byWeekday array is ordered by, in the user's language.
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" }),
      ),
    [locale],
  );

  return (
    <div className="space-y-4">
      {/* Direction + period + currency controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-[var(--radius-control)] border border-border-strong">
          {([["out", "expense", ArrowDownLeft], ["in", "income", ArrowUpRight]] as const).map(([dir, key, Icon]) => (
            <button
              key={dir}
              type="button"
              onClick={() => setDirection(dir)}
              className={cn(
                "flex h-8 items-center gap-1.5 px-3 text-xs font-medium transition-colors",
                direction === dir ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(key, { defaultValue: key })}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <CalendarRange className="h-3.5 w-3.5" />
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as PeriodKey)}
            className="h-8 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-xs text-foreground"
          >
            {periods.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </label>
        {(data?.currencies.length ?? 0) > 1 && (
          <div className="flex flex-wrap gap-1">
            {data!.currencies.map((c) => (
              <button
                key={c.currency}
                type="button"
                onClick={() => setCurrency(c.currency)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  c.currency === ccy ? "bg-accent-soft text-primary" : "bg-surface-2 text-muted hover:text-foreground",
                )}
              >
                {c.currency || t("external", { defaultValue: "External" })}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading && <p className="py-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</p>}

      {data && data.count === 0 && (
        <p className="py-8 text-center text-sm text-muted">
          {t("nothing_in_period", { defaultValue: "Nothing in this period." })}
        </p>
      )}

      {data && data.count > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile
              label={direction === "out" ? t("expense", { defaultValue: "Expense" }) : t("income", { defaultValue: "Income" })}
              value={money(data.total)}
              tone={direction === "out" ? "text-negative" : "text-positive"}
              icon={Sigma}
              sub={
                delta != null ? (
                  <span className={deltaGood ? "text-positive" : "text-negative"}>
                    {delta >= 0 ? "+" : "−"}{Math.abs(delta).toFixed(1)}% {t("vs_previous_period", { defaultValue: "vs previous" })}
                  </span>
                ) : undefined
              }
            />
            <Tile
              label={t("movements", { defaultValue: "Movements" })}
              value={String(data.count)}
              icon={Hash}
              sub={`${t("average", { defaultValue: "avg" })} ${money(data.avg)}`}
            />
            <Tile
              label={t("median", { defaultValue: "Median" })}
              value={money(data.median)}
              icon={direction === "out" ? TrendingDown : TrendingUp}
              sub={t("median_hint", { defaultValue: "typical size" })}
            />
            <Tile
              label={t("biggest", { defaultValue: "Biggest" })}
              value={money(data.top[0]?.amount ?? 0)}
              icon={direction === "out" ? ArrowDownLeft : ArrowUpRight}
              sub={data.top[0]?.note ?? data.top[0]?.source_name ?? undefined}
            />
          </div>

          {/* Categories: the headline answer to "where did it go?" */}
          <Section title={t("by_category", { defaultValue: "By category" })}>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <div className="relative shrink-0">
                <DonutChart
                  slices={data.byTag.map((s, i) => ({ value: s.total, color: sliceColor(s, i) }))}
                  size={132}
                  thickness={18}
                />
                <div className="absolute inset-0 grid place-items-center text-center">
                  <div>
                    <p className="num text-sm font-bold text-foreground">{money(data.total)}</p>
                    <p className="text-[10px] uppercase tracking-wide text-muted-2">
                      {data.byTag.length} {t("categories", { defaultValue: "categories" })}
                    </p>
                  </div>
                </div>
              </div>
              <div className="w-full space-y-0.5">
                {data.byTag.slice(0, 8).map((s, i) => {
                  const tagId = s.key.startsWith("tag:") ? Number(s.key.slice(4)) : null;
                  return (
                    <BarRow
                      key={s.key}
                      label={s.label ?? t("untagged", { defaultValue: "Untagged" })}
                      color={sliceColor(s, i)}
                      amount={s.total}
                      share={share(s.total)}
                      count={s.count}
                      money={money}
                      title={
                        s.gross !== s.total
                          ? t("tag_gross_hint", { defaultValue: "{{v}} counting every movement with this tag in full", v: money(s.gross) })
                          : undefined
                      }
                      onClick={tagId != null ? () => goMovements({ tagIds: [tagId] }) : undefined}
                    />
                  );
                })}
              </div>
            </div>
            {data.byTag.some((s) => s.gross !== s.total) && (
              <p className="mt-1.5 px-2 text-[11px] text-muted-2">
                {t("multi_tag_split_hint", { defaultValue: "A movement with several tags splits its amount evenly between them, so the shares add up to 100%." })}
              </p>
            )}
          </Section>

          {/* Biggest single movements — the "what blew the budget" list. */}
          <Section title={t("largest_movements", { defaultValue: "Largest movements" })}>
            <ul className="divide-y divide-border">
              {data.top.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => { onNavigate?.(); void navigate({ to: "/movements", search: { focus: m.id } }); }}
                    className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] px-2 py-2 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-foreground">
                        {m.note || m.source_name || t("external", { defaultValue: "External" })}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {formatDate(m.date, dateFormat, locale)}
                        {m.source_name ? ` · ${m.source_name}` : ""}
                        {m.tags.length ? ` · ${m.tags.join(", ")}` : ""}
                      </span>
                    </span>
                    <span className="num shrink-0 text-sm font-semibold text-foreground">
                      {money(m.amount)}
                      <span className="ml-1.5 text-xs font-normal text-muted">{(share(m.amount) * 100).toFixed(1)}%</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>

          {/* Repeated notes: subscriptions and habits hiding in the list. */}
          {data.repeats.length > 0 && (
            <Section title={t("repeated_movements", { defaultValue: "Repeated" })}>
              <ul className="divide-y divide-border">
                {data.repeats.map((r) => (
                  <li key={r.label} className="flex items-center justify-between gap-3 px-2 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Repeat className="h-3.5 w-3.5 shrink-0 text-muted-2" />
                      <span className="truncate text-sm text-foreground">{r.label}</span>
                      <span className="shrink-0 text-[11px] text-muted-2">×{r.count}</span>
                    </span>
                    <span className="num shrink-0 text-sm font-semibold text-foreground">{money(r.total)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Accounts */}
          <Section title={t("by_account", { defaultValue: "By account" })}>
            <div className="space-y-0.5">
              {data.bySource.map((s, i) => {
                const sourceId = s.key.startsWith("source:") ? Number(s.key.slice(7)) : null;
                return (
                  <BarRow
                    key={s.key}
                    label={s.label ?? t("external", { defaultValue: "External" })}
                    color={sliceColor(s, i)}
                    amount={s.total}
                    share={share(s.total)}
                    count={s.count}
                    money={money}
                    onClick={sourceId != null ? () => { onNavigate?.(); void navigate({ to: "/sources/$id", params: { id: String(sourceId) } }); } : undefined}
                  />
                );
              })}
            </div>
          </Section>

          {/* Month curve — only meaningful once the range spans more than one. */}
          {data.byMonth.length > 1 && (
            <Section title={t("month_by_month", { defaultValue: "Month by month" })}>
              <div className="flex h-24 items-end gap-1">
                {data.byMonth.map((m) => {
                  const max = Math.max(...data.byMonth.map((x) => x.total)) || 1;
                  return (
                    <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${monthLabel(m.month, locale)} · ${money(m.total)}`}>
                      <span
                        className={cn("w-full rounded-t", direction === "out" ? "bg-negative/70" : "bg-positive/70")}
                        style={{ height: `${Math.max(2, (m.total / max) * 100)}%` }}
                      />
                      <span className="w-full truncate text-center text-[10px] text-muted-2">
                        {monthLabel(m.month, locale).split(" ")[0].slice(0, 3)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Weekday rhythm — cheap to compute, and it surfaces weekend habits. */}
          <Section title={t("by_weekday", { defaultValue: "By weekday" })}>
            <div className="flex h-20 items-end gap-1.5">
              {data.byWeekday.map((v, i) => {
                const max = Math.max(...data.byWeekday) || 1;
                return (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1" title={money(v)}>
                    <span
                      className={cn("w-full rounded-t", direction === "out" ? "bg-negative/50" : "bg-positive/50")}
                      style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
                    />
                    <span className="text-[10px] text-muted-2">{weekdayNames[i]}</span>
                  </div>
                );
              })}
            </div>
          </Section>

          <button
            type="button"
            onClick={() => goMovements({})}
            className="text-xs font-medium text-primary"
          >
            {t("view_all", { defaultValue: "View All" })}
          </button>
        </>
      )}
    </div>
  );
}

/** The panel in a dialog — used by the Movements page KPI cards. */
export function BreakdownModal({
  open,
  onClose,
  baseFilters,
  initialDirection,
  defaultPeriod,
  locale,
  dateFormat,
}: {
  open: boolean;
  onClose: () => void;
  baseFilters: MovementFilters;
  initialDirection?: "in" | "out";
  defaultPeriod?: PeriodKey;
  locale?: string;
  dateFormat?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} size="xl" title={t("breakdown", { defaultValue: "Breakdown" })}>
      {open && (
        <BreakdownPanel
          baseFilters={baseFilters}
          initialDirection={initialDirection}
          defaultPeriod={defaultPeriod}
          locale={locale}
          dateFormat={dateFormat}
          onNavigate={onClose}
        />
      )}
    </Modal>
  );
}
