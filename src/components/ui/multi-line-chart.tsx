import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

export interface Series {
  /** Legend label (e.g. the currency code). */
  label: string;
  color: string;
  points: { date: string; value: number }[];
}

/**
 * Multi-series line/area chart (gap 2): one line per currency, drawn over a
 * shared, pre-aligned x-axis (callers forward-fill so every series has a value
 * at every date). Hover reads out each series' value at the nearest index. A
 * legend renders when there is more than one series, mirroring the original
 * dashboard.html behaviour.
 */
export function MultiLineChart({
  series,
  format = (n) => n.toFixed(2),
  formatDate = (d) => d,
  monthDividers = false,
  monthLabel = (d) => d.slice(0, 7),
  height = 160,
  className,
}: {
  series: Series[];
  format?: (n: number) => string;
  formatDate?: (d: string) => string;
  /** Draw faint vertical lines + short labels at each month boundary on the x-axis. */
  monthDividers?: boolean;
  /** Short month label for a divider (e.g. "Jan"). Receives the boundary's ISO date. */
  monthLabel?: (d: string) => string;
  height?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only re-render when the integer pixel width actually changes, so a flurry
    // of sub-pixel ResizeObserver ticks (e.g. while dragging the window edge)
    // doesn't trigger a render per tick.
    const ro = new ResizeObserver((entries) => {
      const next = entries[0].contentRect.width;
      setW((prev) => (Math.round(next) !== Math.round(prev) ? next : prev));
    });
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const padX = 6;
  const padTop = 12;
  // Reserve a little extra bottom space for the month labels when dividers are on.
  const padBottom = monthDividers ? 18 : 12;
  // All series share the same length & dates (callers forward-fill).
  const n = Math.max(0, ...series.map((s) => s.points.length));
  const allValues = series.flatMap((s) => s.points.map((p) => p.value));
  const min = allValues.length ? Math.min(...allValues) : 0;
  const max = allValues.length ? Math.max(...allValues) : 1;
  const span = max - min || 1;
  const innerW = Math.max(1, w - padX * 2);
  const innerH = height - padTop - padBottom;

  const x = (i: number) => (n <= 1 ? padX + innerW / 2 : padX + (i / (n - 1)) * innerW);
  const y = (v: number) => padTop + innerH - ((v - min) / span) * innerH;

  if (n < 2 || w === 0) {
    return <div ref={ref} className={className} style={{ height }} />;
  }

  // Read dates from the LONGEST series so a `hover` index clamped to `n-1`
  // (the longest length) always has a date; series[0] may be shorter.
  const dates = (series.reduce((a, b) => (b.points.length > a.points.length ? b : a)).points).map((p) => p.date);

  // Month boundaries: each index where the YYYY-MM changes (plus the first point).
  // A divider line marks the boundary; the short month label is drawn at the start
  // of its segment, skipped when the segment is too narrow to read.
  const monthBounds: { i: number; iso: string }[] = [];
  if (monthDividers) {
    let prev = "";
    for (let i = 0; i < dates.length; i++) {
      const ym = dates[i].slice(0, 7);
      if (ym !== prev) {
        monthBounds.push({ i, iso: dates[i] });
        prev = ym;
      }
    }
  }

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - padX) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hx = hover != null ? x(hover) : 0;
  const tipLeft = Math.max(4, Math.min(w - 4, hx));
  const tipAlign = hx > w * 0.6 ? "translateX(-100%)" : hx < w * 0.4 ? "translateX(0)" : "translateX(-50%)";

  return (
    <div className={cn("relative", className)}>
      <div ref={ref} className="relative" style={{ height }}>
        <svg
          width={w}
          height={height}
          className="block touch-none"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* Month dividers (behind the lines): faint vertical rule per month start +
              a short label, skipped when its segment is too narrow to read. */}
          {monthBounds.map((b, k) => {
            const bx = x(b.i);
            const nextX = k + 1 < monthBounds.length ? x(monthBounds[k + 1].i) : padX + innerW;
            const wide = nextX - bx >= 22;
            return (
              <g key={`m${b.i}`}>
                {b.i > 0 && (
                  <line x1={bx} y1={padTop} x2={bx} y2={padTop + innerH} stroke="var(--border)" strokeWidth="1" opacity="0.6" />
                )}
                {wide && (
                  <text x={bx + 3} y={height - 5} fontSize="9" fill="var(--muted-2)" className="select-none">
                    {monthLabel(b.iso)}
                  </text>
                )}
              </g>
            );
          })}
          {series.map((s) => {
            const linePts = s.points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
            return (
              <polyline
                key={s.label}
                points={linePts}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
          {hover != null && (
            <line x1={hx} y1={padTop} x2={hx} y2={padTop + innerH} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3 3" />
          )}
          {hover != null &&
            series.map((s) => {
              const p = s.points[hover];
              if (!p) return null;
              return <circle key={s.label} cx={hx} cy={y(p.value)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />;
            })}
        </svg>
        {hover != null && (
          <div
            className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-[var(--radius-control)] border border-border bg-surface px-2 py-1 text-xs shadow-[var(--shadow-pop)]"
            style={{ left: tipLeft, transform: tipAlign }}
          >
            <span className="block text-muted-2">{formatDate(dates[hover])}</span>
            {series.map((s) => {
              // hover is clamped to the LONGEST series, so a shorter one can miss
              // this index — guard like the dot-render block does (else a crash).
              const p = s.points[hover];
              if (!p) return null;
              return (
                <span key={s.label} className="num flex items-center gap-1.5 font-semibold text-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.label} {format(p.value)}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {series.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Stable per-series palette (matches the original dashboard chart colors). */
export const SERIES_COLORS = [
  "var(--primary)",
  "var(--positive)",
  "var(--negative)",
  "var(--warning)",
  "#03c3ec",
  "#8592a3",
];
