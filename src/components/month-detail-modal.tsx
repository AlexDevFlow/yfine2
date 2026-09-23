import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, List, PieChart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/modal";
import { BreakdownPanel } from "@/components/breakdown-panel";
import { useMonthlyMovements, useToggleExclude } from "@/db/queries";
import { round2 } from "@/domain/money";
import { cn } from "@/lib/cn";
import { dayLabel, monthEnd, monthStart, todayISO } from "@/lib/date";
import { formatMoney } from "@/lib/format";
import type { MovementFilters } from "@/db/repo/movements";

// The breakdown panel scopes itself by its own period picker (default: this
// month), so it needs no filters of its own — hoisted to keep the reference stable.
const NO_FILTERS: MovementFilters = {};

/**
 * Month-detail modal (gap 1, invariants 24-25). Opens on the BREAKDOWN tab —
 * clicking the Income/Expense total is a question about where the money went,
 * and the charts answer it directly; the row-by-row list is one click away.
 *
 * The list tab shows every current-month non-transfer movement for a direction
 * (including excluded rows), with:
 *  - per-source filter chips that visually hide a source (with its non-excluded
 *    subtotal) — client-only;
 *  - struck-through excluded rows that do NOT count toward the live total;
 *  - per-row exclude toggles that mutate the movement and live-refresh the modal
 *    + the dashboard cards (toggleExclude invalidates ["dashboard"]).
 */
export function MonthDetailModal({
  direction,
  primary,
  locale,
  dateFormat,
  onClose,
}: {
  direction: "in" | "out" | null;
  primary: string;
  locale?: string;
  dateFormat?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: rows = [], isLoading } = useMonthlyMovements(direction);
  const toggleExclude = useToggleExclude();
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"breakdown" | "list">("breakdown");
  // Reopening on the other total is a fresh question — start from the charts
  // again, with every account visible (the modal stays mounted between opens).
  useEffect(() => {
    setTab("breakdown");
    setHiddenSources(new Set());
  }, [direction]);

  const sign = direction === "in" ? "+" : "−";
  const colorClass = direction === "in" ? "text-positive" : "text-negative";

  // Per-source non-excluded subtotals for chips. Keyed by name AND currency:
  // two accounts both called "Cash" (EUR and USD) must not merge into one chip
  // whose subtotal adds euros to dollars.
  const chipKey = (m: { source_name: string | null; source_currency: string | null }) =>
    `${m.source_name ?? t("external", { defaultValue: "External" })}\u0000${m.source_currency ?? ""}`;
  const chips = useMemo(() => {
    const map = new Map<string, { label: string; subtotal: number }>();
    for (const m of rows) {
      const key = chipKey(m);
      const cur = map.get(key) ?? { label: m.source_name ?? t("external", { defaultValue: "External" }), subtotal: 0 };
      if (!m.exclude_from_stats) cur.subtotal = round2(cur.subtotal + m.amount);
      map.set(key, cur);
    }
    return [...map.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, t]);

  const visibleRows = useMemo(
    () => rows.filter((m) => !hiddenSources.has(chipKey(m))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, hiddenSources, t],
  );
  // Totals must be computed PER CURRENCY — summing mixed-currency amounts and
  // labelling them with the dashboard's primary currency is meaningless (mirrors
  // the movements-calendar net rollup). "" keys rows with no resolvable currency.
  const totals = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of visibleRows) {
      if (m.exclude_from_stats) continue;
      const c = m.source_currency ?? "";
      map.set(c, round2((map.get(c) ?? 0) + m.amount));
    }
    return [...map.entries()];
  }, [visibleRows]);

  const toggleSource = (name: string) =>
    setHiddenSources((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const goAll = () => {
    onClose();
    // Both bounds: without dateTo a rent payment already booked for next month
    // would join a list titled "this month".
    void navigate({
      to: "/movements",
      search: { ...(direction ? { direction } : {}), dateFrom: monthStart(todayISO()), dateTo: monthEnd(todayISO()) },
    });
  };

  const title =
    direction === "in"
      ? t("income_this_month", { defaultValue: "Income this month" })
      : t("expenses_this_month", { defaultValue: "Expenses this month" });

  return (
    <Modal
      open={direction != null}
      onClose={onClose}
      title={title}
      size="xl"
      footer={tab === "list" ? (
        <div className="flex w-full items-center justify-between">
          <strong className={cn("num text-sm", colorClass)}>
            {t("balance", { defaultValue: "Balance" })}:{" "}
            {totals.length === 0
              ? `${sign}${formatMoney(0, primary, locale)}`
              : totals.map(([c, v]) => `${sign}${c ? formatMoney(v, c, locale) : v.toFixed(2)}`).join(" · ")}
          </strong>
          <button onClick={goAll} className="inline-flex items-center gap-1 text-xs font-medium text-primary">
            {t("view_all", { defaultValue: "View All" })}
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : undefined}
    >
      <div className="mb-3 flex overflow-hidden rounded-[var(--radius-control)] border border-border-strong">
        {([["breakdown", "breakdown", "Breakdown", PieChart], ["list", "movements", "Movements", List]] as const).map(
          ([key, i18nKey, fallback, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={cn(
                "flex h-8 flex-1 items-center justify-center gap-1.5 text-xs font-medium transition-colors",
                tab === key ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(i18nKey, { defaultValue: fallback })}
            </button>
          ),
        )}
      </div>

      {tab === "breakdown" && direction && (
        <BreakdownPanel
          baseFilters={NO_FILTERS}
          initialDirection={direction}
          defaultPeriod="this_month"
          locale={locale}
          dateFormat={dateFormat}
          onNavigate={onClose}
        />
      )}

      {tab === "list" && chips.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {chips.map(([key, { label, subtotal }]) => {
            const off = hiddenSources.has(key);
            const ccy = key.split("\u0000")[1];
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleSource(key)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                  off ? "bg-negative-soft text-negative line-through" : "bg-positive-soft text-positive",
                )}
              >
                {label} ({ccy ? formatMoney(subtotal, ccy, locale) : subtotal.toFixed(2)})
              </button>
            );
          })}
        </div>
      )}

      {tab === "list" && (isLoading ? (
        <p className="py-6 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</p>
      ) : visibleRows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t("no_movements", { defaultValue: "No movements yet." })}</p>
      ) : (
        <ul className="divide-y divide-border">
          {visibleRows.map((m) => {
            // Each row renders in its OWN source currency (plain figure when the
            // source is external/unknown), like the calendar day list.
            const ccy = m.source_currency ?? undefined;
            return (
            <li
              key={m.id}
              className={cn(
                "flex items-center justify-between gap-3 py-2.5",
                m.exclude_from_stats && "text-muted line-through opacity-60",
              )}
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">
                  {m.note || m.source_name || t("external", { defaultValue: "External" })}
                </p>
                <p className="truncate text-xs text-muted">
                  {(m.source_name ?? t("external", { defaultValue: "External" }))} · {dayLabel(m.date, locale)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className={cn("num text-sm font-semibold", colorClass)}>
                  {sign}
                  {ccy ? formatMoney(m.amount, ccy, locale) : m.amount.toFixed(2)}
                </span>
                <label className="flex items-center" title={t("exclude_from_stats", { defaultValue: "Exclude from stats" })}>
                  <input
                    type="checkbox"
                    checked={m.exclude_from_stats}
                    onChange={() => toggleExclude.mutate(m.id)}
                  />
                </label>
              </div>
            </li>
            );
          })}
        </ul>
      ))}
    </Modal>
  );
}
