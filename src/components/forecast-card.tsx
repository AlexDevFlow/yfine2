import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useForecast } from "@/db/queries";
import { cn } from "@/lib/cn";
import { dayLabel } from "@/lib/date";
import { formatMoney } from "@/lib/format";

function MiniLine({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 100;
  const h = 28;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(" ");
  const zeroY = (h - ((0 - min) / span) * h).toFixed(1);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-8 w-full">
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Compact 90-day cashflow forecast — wrapper-less so it can be folded into the
 * Net Worth card (it brings its own labelled, top-bordered section). Renders
 * nothing when there are no recurring items to project from.
 */
export function ForecastSummary({ hidden = false }: { hidden?: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { data, isLoading } = useForecast(90);

  if (isLoading || !data || data.length === 0) return null;

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-2">
        {t("cashflow_forecast", { defaultValue: "90-day forecast" })}
      </p>
      {data.map((f) => (
        <div key={f.currency}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium text-foreground">{f.currency}</span>
            <span className={cn("num font-semibold", f.end >= 0 ? "text-foreground" : "text-negative")}>
              {hidden ? `•••• ${f.currency}` : formatMoney(f.end, f.currency, locale)}
              <span className="ml-1 text-xs text-muted">
                {f.end >= f.start ? <TrendingUp className="inline h-3 w-3 text-positive" /> : <TrendingDown className="inline h-3 w-3 text-negative" />}
              </span>
            </span>
          </div>
          {!hidden && <MiniLine values={f.points.map((p) => p.balance)} />}
          {f.negativeFrom ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-negative">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t("runs_low_on", { defaultValue: "Goes negative on {{date}}", date: dayLabel(f.negativeFrom, locale) })}
            </p>
          ) : (
            !hidden && (
              <p className="num mt-1 text-xs text-muted">
                {t("lowest_point", { defaultValue: "Low: {{amt}}", amt: formatMoney(f.lowest, f.currency, locale) })}
              </p>
            )
          )}
        </div>
      ))}
    </div>
  );
}
