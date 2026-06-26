import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/modal";
import { useMonthlyMovements, useToggleExclude } from "@/db/queries";
import { round2 } from "@/domain/money";
import { cn } from "@/lib/cn";
import { dayLabel, monthStart, todayISO } from "@/lib/date";
import { formatMoney } from "@/lib/format";

/**
 * Month-detail modal (gap 1, invariants 24-25). Lists every current-month
 * non-transfer movement for a direction (including excluded rows), with:
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
  onClose,
}: {
  direction: "in" | "out" | null;
  primary: string;
  locale?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: rows = [], isLoading } = useMonthlyMovements(direction);
  const toggleExclude = useToggleExclude();
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());

  const sign = direction === "in" ? "+" : "−";
  const colorClass = direction === "in" ? "text-positive" : "text-negative";

  // Per-source non-excluded subtotals for chips (key by display name).
  const chips = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of rows) {
      const name = m.source_name ?? t("external", { defaultValue: "External" });
      const cur = map.get(name) ?? 0;
      map.set(name, m.exclude_from_stats ? cur : round2(cur + m.amount));
    }
    return [...map.entries()];
  }, [rows, t]);

  const visibleRows = useMemo(
    () => rows.filter((m) => !hiddenSources.has(m.source_name ?? t("external", { defaultValue: "External" }))),
    [rows, hiddenSources, t],
  );
  const total = useMemo(
    () => round2(visibleRows.filter((m) => !m.exclude_from_stats).reduce((s, m) => s + m.amount, 0)),
    [visibleRows],
  );

  const toggleSource = (name: string) =>
    setHiddenSources((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const goAll = () => {
    onClose();
    void navigate({
      to: "/movements",
      search: { ...(direction ? { direction } : {}), dateFrom: monthStart(todayISO()) },
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
      footer={
        <div className="flex w-full items-center justify-between">
          <strong className={cn("num text-sm", colorClass)}>
            {t("balance", { defaultValue: "Balance" })}: {sign}
            {formatMoney(total, primary, locale)}
          </strong>
          <button onClick={goAll} className="inline-flex items-center gap-1 text-xs font-medium text-primary">
            {t("view_all", { defaultValue: "View All" })}
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      }
    >
      {chips.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {chips.map(([name, subtotal]) => {
            const off = hiddenSources.has(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleSource(name)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                  off ? "bg-negative-soft text-negative line-through" : "bg-positive-soft text-positive",
                )}
              >
                {name} ({subtotal.toFixed(2)})
              </button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <p className="py-6 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</p>
      ) : visibleRows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t("no_movements", { defaultValue: "No movements yet." })}</p>
      ) : (
        <ul className="divide-y divide-border">
          {visibleRows.map((m) => (
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
                  {formatMoney(m.amount, primary, locale)}
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
          ))}
        </ul>
      )}
    </Modal>
  );
}
