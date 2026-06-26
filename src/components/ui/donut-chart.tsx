/**
 * Minimal SVG donut chart. Each slice is drawn as a stroked arc on a shared
 * circle via strokeDasharray; a faint track fills the gaps so a single slice
 * still reads as a ring. Center content (e.g. a total) is rendered by the caller
 * over the absolutely-positioned chart.
 */
export interface DonutSlice {
  value: number;
  color: string;
}

export function DonutChart({
  slices,
  size = 132,
  thickness = 18,
  className,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  className?: string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={thickness} />
      {slices.map((s, i) => {
        const len = (s.value / total) * circ;
        const el = (
          <circle
            key={i}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={thickness}
            strokeDasharray={`${len.toFixed(2)} ${(circ - len).toFixed(2)}`}
            strokeDashoffset={(-offset).toFixed(2)}
            transform={`rotate(-90 ${c} ${c})`}
          />
        );
        offset += len;
        return el;
      })}
    </svg>
  );
}
