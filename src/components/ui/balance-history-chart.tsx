import { useTranslation } from "react-i18next";
import { RangeChart } from "@/components/ui/range-chart";
import { useSourceHistory } from "@/db/queries";
import { dayLabel, monthLabel } from "@/lib/date";
import { formatMoney } from "@/lib/format";

/** Balance-over-time chart for one source/fund. Lazily fetches its history. */
export function BalanceHistoryChart({ sourceId, currency, locale, height = 120 }: {
  sourceId: number;
  currency: string;
  locale?: string;
  height?: number;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useSourceHistory(sourceId);
  if (isLoading) return <div className="px-4 pb-4 text-xs text-muted">{t("loading", { defaultValue: "Loading…" })}</div>;
  if (!data || data.length < 2) {
    return <div className="px-4 pb-4 text-xs text-muted">{t("not_enough_history", { defaultValue: "Not enough history to chart yet." })}</div>;
  }
  return (
    <div className="px-4 pb-3">
      <RangeChart
        points={data}
        height={height}
        format={(n) => formatMoney(n, currency, locale)}
        formatDate={(d) => dayLabel(d, locale)}
        monthLabel={(d) => {
          const label = monthLabel(d, locale).split(" ")[0].slice(0, 3);
          // Year on each January so a multi-year range stays unambiguous.
          return d.slice(5, 7) === "01" ? `${label} '${d.slice(2, 4)}` : label;
        }}
      />
    </div>
  );
}
