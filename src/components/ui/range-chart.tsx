import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, type ChartPoint } from "@/components/ui/line-chart";
import { cn } from "@/lib/cn";

export interface Range {
  key: string;
  days: number;
}

/** Default range set: 30d/90d/1y/all (sources, net worth). */
export const DEFAULT_RANGES: Range[] = [
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
  { key: "1y", days: 365 },
  { key: "all", days: Infinity },
];

/** Portfolio/holding range set: 7d/30d/90d/1y (matches the original charts). */
export const PORTFOLIO_RANGES: Range[] = [
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
  { key: "1y", days: 365 },
];

function cutoffISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** LineChart with range buttons and client-side slicing. */
export function RangeChart({
  points,
  format,
  formatDate,
  height = 150,
  ranges = DEFAULT_RANGES,
  defaultRange,
  color,
  monthDividers = true,
  monthLabel,
}: {
  points: ChartPoint[];
  format?: (n: number) => string;
  formatDate?: (d: string) => string;
  height?: number;
  ranges?: Range[];
  defaultRange?: string;
  color?: string;
  /** Month rules + labels on the x-axis (default on — see LineChart). */
  monthDividers?: boolean;
  monthLabel?: (d: string) => string;
}) {
  const { t } = useTranslation();
  const [range, setRange] = useState<string>(defaultRange ?? ranges[ranges.length - 1].key);
  const series = useMemo(() => {
    const days = (ranges.find((r) => r.key === range) ?? ranges[ranges.length - 1]).days;
    if (days === Infinity) return points;
    const cut = cutoffISO(days);
    const f = points.filter((p) => p.date >= cut);
    return f.length >= 2 ? f : points;
  }, [points, range, ranges]);

  return (
    <div>
      <div className="mb-2 flex justify-end gap-1">
        {ranges.map((r) => (
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
      <LineChart
        points={series}
        height={height}
        format={format}
        formatDate={formatDate}
        color={color}
        monthDividers={monthDividers}
        monthLabel={monthLabel}
      />
    </div>
  );
}
