import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDate, monthLabel, todayISO } from "@/lib/date";

const triggerBase =
  "flex h-10 w-full items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_30%,transparent)]";

/** Build the 6×7 (Monday-first) day grid for a `YYYY-MM` view month. */
function buildGrid(viewMonth: string): string[] {
  const [y, m] = viewMonth.split("-").map(Number);
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // 0 = Mon
  const cells: string[] = [];
  // start from the Monday on/just before the 1st
  const start = new Date(Date.UTC(y, m - 1, 1 - firstDow));
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    cells.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return cells;
}

export interface DateInputProps {
  id?: string;
  value: string; // YYYY-MM-DD or ""
  onChange: (value: string) => void;
  /** Inclusive bounds as YYYY-MM-DD. */
  min?: string;
  max?: string;
  /** Render preference (dd/mm/yyyy | mm/dd/yyyy | yyyy-mm-dd); falls back to locale. */
  dateFormat?: string | null;
  required?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Themed, locale-aware date picker — a drop-in replacement for
 * <Input type="date"> that renders a custom popover calendar instead of the
 * native OS control, so the UI matches the rest of the app in light/dark.
 */
export function DateInput({
  id,
  value,
  onChange,
  min,
  max,
  dateFormat,
  required,
  placeholder,
  className,
}: DateInputProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const reactId = useId();
  const fieldId = id ?? reactId;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => (value || todayISO()).slice(0, 7));
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Fixed-position coordinates for the body-portaled popover (null until measured).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Re-anchor the visible month whenever the popover (re)opens.
  useEffect(() => {
    if (open) setView((value || todayISO()).slice(0, 7));
  }, [open, value]);

  // The calendar is portaled to <body> (so it can't be clipped by a modal's
  // overflow or trapped under a scroll container's scrollbar on webkit). Position
  // it under the trigger in viewport coords, flipping above when there's no room,
  // and clamping to the viewport horizontally. Re-place on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    const POP_W = 272; // w-[17rem]
    const place = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const popH = popRef.current?.offsetHeight ?? 330;
      const below = r.bottom + 4;
      const top = below + popH > window.innerHeight - 8 && r.top - 4 - popH > 8 ? r.top - 4 - popH : below;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - POP_W));
      setPos({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Dismiss on outside click / Escape — the portaled popover lives outside wrapRef,
  // so a click inside it must NOT count as "outside".
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const grid = useMemo(() => buildGrid(view), [view]);
  const today = todayISO();

  // Localised Monday-first weekday initials (2024-01-01 was a Monday).
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(Date.UTC(2024, 0, 1 + i))).slice(0, 2),
    );
  }, [locale]);

  const inRange = (d: string) => (!min || d >= min) && (!max || d <= max);
  const pick = (d: string) => {
    onChange(d);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        id={fieldId}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(triggerBase, value ? "text-foreground" : "text-muted-2", className)}
      >
        <span className="num truncate">
          {value ? formatDate(value, dateFormat, locale) : (placeholder ?? t("select_date", { defaultValue: "Select date" }))}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {value && !required && (
            <span
              role="button"
              tabIndex={-1}
              aria-label={t("clear", { defaultValue: "Clear" })}
              onClick={(e) => { e.stopPropagation(); onChange(""); }}
              className="rounded p-0.5 text-muted-2 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
          <CalendarDays className="h-4 w-4 text-muted" />
        </span>
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          role="dialog"
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-[60] w-[17rem] rounded-[var(--radius-control)] border border-border bg-surface p-3 shadow-[var(--shadow-pop)]"
        >
          <div className="mb-2 flex items-center justify-between">
            <button type="button" onClick={() => setView((v) => shiftMonth(v, -1))} aria-label={t("previous", { defaultValue: "Previous" })} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-foreground">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold capitalize text-foreground">{monthLabel(view, locale)}</span>
            <button type="button" onClick={() => setView((v) => shiftMonth(v, 1))} aria-label={t("next", { defaultValue: "Next" })} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-foreground">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-0.5">
            {weekdays.map((w, i) => (
              <span key={i} className="grid h-6 place-items-center text-[10px] font-medium uppercase tracking-wide text-muted-2">{w}</span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((d) => {
              const outside = d.slice(0, 7) !== view;
              const selected = d === value;
              const isToday = d === today;
              const disabled = !inRange(d);
              return (
                <button
                  key={d}
                  type="button"
                  disabled={disabled}
                  onClick={() => pick(d)}
                  className={cn(
                    "num grid h-8 place-items-center rounded-md text-sm transition-colors",
                    selected
                      ? "bg-primary font-semibold text-primary-foreground"
                      : disabled
                        ? "text-muted-2 opacity-40"
                        : outside
                          ? "text-muted-2 hover:bg-surface-2"
                          : "text-foreground hover:bg-surface-2",
                    !selected && isToday && "ring-1 ring-inset ring-primary",
                  )}
                >
                  {Number(d.slice(8, 10))}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
            <button type="button" onClick={() => pick(today)} className="text-xs font-medium text-primary hover:underline">
              {t("today", { defaultValue: "Today" })}
            </button>
            {value && !required && (
              <button type="button" onClick={() => { onChange(""); setOpen(false); }} className="text-xs font-medium text-muted hover:text-foreground">
                {t("clear", { defaultValue: "Clear" })}
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
