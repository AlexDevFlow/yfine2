import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, type ChartPoint } from "@/components/ui/line-chart";
import { cn } from "@/lib/cn";
import { addDaysISO, todayISO } from "@/lib/date";

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

/** `days` ago in the LOCAL calendar (movement/snapshot dates are local days). */
/**
 * The points of a step series that fall inside a window starting at `cut`,
 * led by the value the series carried INTO the window (re-dated to the cutoff)
 * so a quiet stretch draws as the flat line it was. Falling back to the whole
 * history when few points land in the window — the old behaviour — showed
 * years of data under a "30d" label. Only a series with nothing at all before
 * or inside the window is returned as-is.
 */
export function sliceWindow<P extends { date: string }>(points: readonly P[], cut: string): P[] {
  const inside = points.filter((p) => p.date >= cut);
  let carried: P | undefined;
  for (const p of points) {
    if (p.date < cut) carried = p;
    else break;
  }
  if (!carried) return inside.length > 0 ? inside : [...points];
  return [{ ...carried, date: cut }, ...inside];
}

function cutoffISO(days: number): string {
  return addDaysISO(todayISO(), -days);
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
    return sliceWindow(points, cutoffISO(days));
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
