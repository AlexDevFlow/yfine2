import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

export interface ChartPoint {
  date: string;
  value: number;
}

/**
 * Dependency-free interactive line/area chart. Hover (or touch-drag) anywhere
 * to read the date + value at the nearest point via a crosshair + tooltip.
 * Renders in real pixels (ResizeObserver) so the dot stays circular.
 */
export function LineChart({
  points,
  format = (n) => n.toFixed(2),
  formatDate = (d) => d,
  monthDividers = false,
  monthLabel = (d) => d.slice(0, 7),
  height = 160,
  className,
  color,
}: {
  points: ChartPoint[];
  format?: (n: number) => string;
  formatDate?: (d: string) => string;
  /** Draw faint vertical rules + short labels at each month boundary on the x-axis,
   *  so the line reads as a timeline instead of an anonymous curve. Mirrors
   *  MultiLineChart, which the dashboard net-worth chart already uses. */
  monthDividers?: boolean;
  /** Short month label for a divider (e.g. "Jan"). Receives the boundary's ISO date. */
  monthLabel?: (d: string) => string;
  height?: number;
  className?: string;
  /** Stroke/fill color. Defaults to the primary token. */
  color?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
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
  const padY = 12;
  // Reserve a little extra bottom space for the month labels when dividers are on.
  const padBottom = monthDividers ? 18 : padY;
  const n = points.length;
  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const span = max - min || 1;
  const innerW = Math.max(1, w - padX * 2);
  const innerH = height - padY - padBottom;

  const x = (i: number) => (n <= 1 ? padX + innerW / 2 : padX + (i / (n - 1)) * innerW);
  const y = (v: number) => padY + innerH - ((v - min) / span) * innerH;

  if (n < 2 || w === 0) {
    // Still mount the ref container so width can be measured on next paint.
    return <div ref={ref} className={className} style={{ height }} />;
  }

  const linePts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const baseline = padY + innerH;
  const areaPts = `${padX},${baseline} ${linePts} ${(padX + innerW).toFixed(1)},${baseline}`;

  // Month boundaries: each index where the YYYY-MM changes (plus the first point).
  const monthBounds: { i: number; iso: string }[] = [];
  if (monthDividers) {
    let prev = "";
    for (let i = 0; i < n; i++) {
      const ym = points[i].date.slice(0, 7);
      if (ym !== prev) {
        monthBounds.push({ i, iso: points[i].date });
        prev = ym;
      }
    }
  }
  // Per-instance unique id: a value-derived id collides when two charts share the
  // same point count + rounded min/max, making url(#gid) resolve to the first def.
  const gid = `lc${uid.replace(/:/g, "")}`;
  const stroke = color ?? "var(--primary)";

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - padX) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hp = hover != null ? points[hover] : null;
  const hx = hover != null ? x(hover) : 0;
  const hy = hp ? y(hp.value) : 0;
  // Keep the tooltip inside the container.
  const tipLeft = Math.max(4, Math.min(w - 4, hx));
  const tipAlign = hx > w * 0.6 ? "translateX(-100%)" : hx < w * 0.4 ? "translateX(0)" : "translateX(-50%)";

  return (
    <div ref={ref} className={cn("relative", className)} style={{ height }}>
      <svg
        width={w}
        height={height}
        className="block touch-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Month dividers sit behind the line: a faint rule per month start plus a
            short label, skipped when its segment is too narrow to read. */}
        {monthBounds.map((b, k) => {
          const bx = x(b.i);
          const nextX = k + 1 < monthBounds.length ? x(monthBounds[k + 1].i) : padX + innerW;
          const wide = nextX - bx >= 22;
          return (
            <g key={`m${b.i}`}>
              {b.i > 0 && (
                <line x1={bx} y1={padY} x2={bx} y2={baseline} stroke="var(--border)" strokeWidth="1" opacity="0.6" />
              )}
              {wide && (
                <text x={bx + 3} y={height - 5} fontSize="9" fill="var(--muted-2)" className="select-none">
                  {monthLabel(b.iso)}
                </text>
              )}
            </g>
          );
        })}
        <polyline points={areaPts} fill={`url(#${gid})`} stroke="none" />
        <polyline
          points={linePts}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hp && (
          <>
            <line x1={hx} y1={padY} x2={hx} y2={baseline} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={hx} cy={hy} r="4" fill={stroke} stroke="var(--surface)" strokeWidth="2" />
          </>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-[var(--radius-control)] border border-border bg-surface px-2 py-1 text-xs shadow-[var(--shadow-pop)]"
          style={{ left: tipLeft, transform: tipAlign }}
        >
          <span className="block text-muted-2">{formatDate(hp.date)}</span>
          <span className="num font-semibold text-foreground">{format(hp.value)}</span>
        </div>
      )}
    </div>
  );
}
