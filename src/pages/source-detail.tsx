import { Link, useParams } from "@tanstack/react-router";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Search, SlidersHorizontal, TrendingUp, Wallet, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { BalanceHistoryChart } from "@/components/ui/balance-history-chart";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { isPreviewDb } from "@/db/connection";
import { useMovementCounts, useMovementSums, useMovements, usePortfolios, usePreferences, useSources, useTags } from "@/db/queries";
import type { EnrichedMovement, MovementFilters } from "@/db/repo/movements";
import { groupMovementsHierarchically } from "@/domain/grouping";
import { cn } from "@/lib/cn";
import { dayLabel, formatDate, monthLabel } from "@/lib/date";
import { formatMoney, formatSigned } from "@/lib/format";

function Row({ m, locale }: { m: EnrichedMovement; locale?: string }) {
  const { t } = useTranslation();
  const transfer = m.transfer_pair_id != null;
  const ccy = m.source_currency;
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", transfer ? "bg-surface-2 text-muted" : m.direction === "in" ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
          {transfer ? <ArrowLeftRight className="h-4 w-4" /> : m.direction === "in" ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownLeft className="h-4 w-4" />}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{m.note || (transfer ? t("transfer", { defaultValue: "Transfer" }) : t("movement", { defaultValue: "Movement" }))}</p>
          {/* IN legs arrived FROM the partner — point the arrow accordingly. */}
          {transfer && <p className="truncate text-xs text-muted">{m.direction === "in" ? "←" : "→"} {m.partner_source_name ?? "?"}</p>}
          {m.tags.length > 0 && (
            <p className="mt-0.5 flex flex-wrap gap-1">
              {m.tags.map((tag) => (
                <span key={tag.id} className="rounded-[var(--radius-control)] bg-surface-2 px-1.5 text-[11px] text-muted">{tag.name}</span>
              ))}
            </p>
          )}
        </div>
      </div>
      <span className={cn("num text-sm font-semibold", transfer ? "text-muted" : m.direction === "in" ? "text-positive" : "text-foreground")}>
        {ccy
          ? transfer
            ? formatMoney(m.amount, ccy, locale)
            : formatSigned(m.direction === "in" ? m.amount : -m.amount, ccy, locale)
          : transfer
            ? m.amount.toFixed(2)
            : (m.direction === "in" ? m.amount : -m.amount).toFixed(2)}
      </span>
    </li>
  );
}

function FilterChip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[var(--radius-control)] bg-surface-2 py-1 pl-2.5 pr-1.5 text-xs text-foreground">
      {children}
      <button onClick={onRemove} className="rounded p-0.5 text-muted-2 hover:text-foreground"><X className="h-3 w-3" /></button>
    </span>
  );
}

export function SourceDetail() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const params = useParams({ strict: false }) as { id?: string };
  const id = Number(params.id);

  const { data: prefs } = usePreferences();
  const { data: sources } = useSources();
  const { data: counts } = useMovementCounts();
  const { data: portfolios } = usePortfolios();
  const { data: tags } = useTags();

  // Same filter vocabulary as the Movements page, scoped to this account.
  const [q, setQ] = useState("");
  const [direction, setDirection] = useState<"" | "in" | "out">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amtMin, setAmtMin] = useState("");
  const [amtMax, setAmtMax] = useState("");
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  // Month keys the user folded away. Collapsing is per-month and sticky while
  // the page is mounted, mirroring how the movement groups behave elsewhere.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filters: MovementFilters = useMemo(() => ({
    sourceId: id,
    q: q.trim() || undefined,
    direction: direction || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    amountMin: amtMin ? Number(amtMin) : undefined,
    amountMax: amtMax ? Number(amtMax) : undefined,
    tagIds: tagIds.length > 0 ? tagIds : undefined,
  }), [id, q, direction, dateFrom, dateTo, amtMin, amtMax, tagIds]);

  const { data: movements, isLoading } = useMovements(filters, 500);
  const { data: sums } = useMovementSums(filters);

  const source = (sources ?? []).find((s) => s.id === id);
  const groups = useMemo(() => groupMovementsHierarchically(movements?.items ?? []), [movements]);
  const linkedPortfolios = (portfolios ?? []).filter((p) => p.portfolio.source_id === id);

  const activeCount =
    (q.trim() ? 1 : 0) + (direction ? 1 : 0) + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) +
    (amtMin ? 1 : 0) + (amtMax ? 1 : 0) + tagIds.length;
  const clearAll = () => {
    setQ(""); setDirection(""); setDateFrom(""); setDateTo(""); setAmtMin(""); setAmtMax(""); setTagIds([]);
  };
  const toggleMonth = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allMonths = groups.flatMap((y) => y.months.map((m) => m.month));
  const allCollapsed = allMonths.length > 0 && allMonths.every((m) => collapsed.has(m));

  if (!source) {
    return (
      <div className="space-y-4">
        <Link to="/sources" className="inline-flex items-center gap-1 text-sm text-primary"><ChevronLeft className="h-4 w-4" /> {t("sources", { defaultValue: "Sources" })}</Link>
        <Card className="p-10 text-center text-sm text-muted">{t("not_found", { defaultValue: "Not found." })}</Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link to="/sources" className="inline-flex items-center gap-1 text-sm text-primary"><ChevronLeft className="h-4 w-4" /> {t("sources", { defaultValue: "Sources" })}</Link>

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><Wallet className="h-5 w-5 text-primary" />{source.name}</span>}
          subtitle={`${source.currency}${source.yield_rate > 0 ? ` · ${source.yield_rate}% / ${source.yield_period_months}m` : ""}`}
          action={
            <div className="text-right">
              <p className={cn("num text-xl font-semibold", source.total_value < 0 ? "text-negative" : "text-foreground")}>{formatMoney(source.total_value, source.currency, locale)}</p>
              {source.portfolio_value !== 0 && (
                <p className="text-xs text-muted-2">
                  {t("cash", { defaultValue: "Cash" })}: <span className="num">{formatMoney(source.balance, source.currency, locale)}</span>
                  {" · "}
                  {t("portfolios", { defaultValue: "Portfolios" })}: <span className="num">{formatMoney(source.portfolio_value, source.currency, locale)}</span>
                </p>
              )}
              <p className="text-xs text-muted">{t("n_movements", { defaultValue: "{{count}} movements", count: counts?.[id] ?? 0 })}</p>
            </div>
          }
        />
        <CardContent className="pt-2">
          <BalanceHistoryChart sourceId={id} currency={source.currency} locale={locale} height={150} />
        </CardContent>
      </Card>

      {linkedPortfolios.length > 0 && (
        <Card>
          <CardHeader title={t("portfolios", { defaultValue: "Portfolios" })} />
          <CardContent className="pt-2">
            <ul className="divide-y divide-border">
              {linkedPortfolios.map((p) => (
                <li key={p.portfolio.id}>
                  <Link to="/portfolios" className="flex items-center justify-between gap-3 py-2.5">
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground"><TrendingUp className="h-4 w-4 text-primary" />{p.portfolio.name}</span>
                    <span className="flex items-center gap-2">
                      <span className="num text-sm font-semibold text-foreground">{formatMoney(p.total_value, p.portfolio.base_currency, locale)}</span>
                      {p.total_pnl != null && <Badge tone={p.total_pnl >= 0 ? "positive" : "negative"}>{p.total_pnl_pct}%</Badge>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Search + direction + advanced panel — the Movements page vocabulary,
          pre-scoped to this account so the two pages behave the same way. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-2" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search_movements", { defaultValue: "Search movements…" })}
            className="pl-9"
          />
        </div>
        <div className="flex overflow-hidden rounded-[var(--radius-control)] border border-border-strong">
          {([["", "all"], ["in", "income"], ["out", "expense"]] as const).map(([value, key]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDirection(value)}
              className={cn(
                "h-10 px-3 text-sm font-medium transition-colors",
                direction === value ? "bg-accent-soft text-primary" : "text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              {t(key, { defaultValue: key })}
            </button>
          ))}
        </div>
        <Button variant={showFilters || activeCount > 0 ? "secondary" : "outline"} onClick={() => setShowFilters((s) => !s)}>
          <SlidersHorizontal className="h-4 w-4" /> {t("filters", { defaultValue: "Filters" })}{activeCount > 0 ? ` (${activeCount})` : ""}
        </Button>
        {allMonths.length > 0 && (
          <Button
            variant="outline"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(allMonths))}
            title={allCollapsed ? t("expand_all", { defaultValue: "Expand all" }) : t("collapse_all", { defaultValue: "Collapse all" })}
          >
            {allCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {allCollapsed ? t("expand_all", { defaultValue: "Expand all" }) : t("collapse_all", { defaultValue: "Collapse all" })}
          </Button>
        )}
      </div>

      {showFilters && (
        <Card className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t("date_from", { defaultValue: "From date" })}</p>
              <DateInput value={dateFrom} onChange={setDateFrom} dateFormat={prefs?.date_format} />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t("date_to", { defaultValue: "To date" })}</p>
              <DateInput value={dateTo} onChange={setDateTo} dateFormat={prefs?.date_format} />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t("amount_min", { defaultValue: "Min amount" })}</p>
              <Input type="number" step="0.01" min="0" value={amtMin} onChange={(e) => setAmtMin(e.target.value)} className="num" />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t("amount_max", { defaultValue: "Max amount" })}</p>
              <Input type="number" step="0.01" min="0" value={amtMax} onChange={(e) => setAmtMax(e.target.value)} className="num" />
            </div>
          </div>
          {(tags?.length ?? 0) > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">{t("tags", { defaultValue: "Tags" })}</p>
              <div className="flex flex-wrap gap-1.5">
                {(tags ?? []).map((tag) => {
                  const on = tagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => setTagIds((prev) => (on ? prev.filter((x) => x !== tag.id) : [...prev, tag.id]))}
                      className={cn(
                        "rounded-[var(--radius-control)] border px-2.5 py-1 text-xs font-medium transition-colors",
                        on ? "border-primary bg-accent-soft text-primary" : "border-border text-muted hover:text-foreground",
                      )}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {activeCount > 0 && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={clearAll}><X className="h-4 w-4" /> {t("clear_filters", { defaultValue: "Clear filters" })}</Button>
            </div>
          )}
        </Card>
      )}

      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {q.trim() && <FilterChip onRemove={() => setQ("")}>“{q.trim()}”</FilterChip>}
          {direction && <FilterChip onRemove={() => setDirection("")}>{t(direction === "in" ? "income" : "expense", { defaultValue: direction })}</FilterChip>}
          {dateFrom && <FilterChip onRemove={() => setDateFrom("")}>{t("date_from", { defaultValue: "From date" })}: {formatDate(dateFrom, prefs?.date_format, locale)}</FilterChip>}
          {dateTo && <FilterChip onRemove={() => setDateTo("")}>{t("date_to", { defaultValue: "To date" })}: {formatDate(dateTo, prefs?.date_format, locale)}</FilterChip>}
          {amtMin && <FilterChip onRemove={() => setAmtMin("")}>≥ {amtMin}</FilterChip>}
          {amtMax && <FilterChip onRemove={() => setAmtMax("")}>≤ {amtMax}</FilterChip>}
          {tagIds.map((tid) => (
            <FilterChip key={tid} onRemove={() => setTagIds((prev) => prev.filter((x) => x !== tid))}>
              {(tags ?? []).find((x) => x.id === tid)?.name ?? tid}
            </FilterChip>
          ))}
          <button onClick={clearAll} className="ml-0.5 text-xs font-medium text-muted-2 hover:text-foreground">
            {t("clear_all", { defaultValue: "Clear all" })}
          </button>
        </div>
      )}

      {/* Totals for whatever the filters currently select (transfers and
          excluded rows stay out, exactly as on the Movements page). */}
      {sums && (movements?.items.length ?? 0) > 0 && (
        <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
          <span className="text-muted">{t("n_movements", { defaultValue: "{{count}} movements", count: sums.count })}</span>
          <span className="text-positive">+ <span className="num font-semibold">{formatMoney(sums.totalIn, source.currency, locale)}</span></span>
          <span className="text-negative">− <span className="num font-semibold">{formatMoney(sums.totalOut, source.currency, locale)}</span></span>
          <span className={cn("num font-semibold", sums.totalIn - sums.totalOut >= 0 ? "text-positive" : "text-negative")}>
            {formatSigned(sums.totalIn - sums.totalOut, source.currency, locale)}
          </span>
        </Card>
      )}

      {isPreviewDb && (
        <div className="rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">
          {t("preview_db_note", { defaultValue: "Browser preview with seeded sample data." })}
        </div>
      )}
      {isLoading && <Card className="p-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</Card>}
      {movements && groups.length === 0 && (
        <Card className="p-10 text-center text-sm text-muted">
          {activeCount > 0
            ? t("no_movements_match", { defaultValue: "No movements match these filters." })
            : t("no_movements", { defaultValue: "No movements yet." })}
        </Card>
      )}

      {groups.map((year) =>
        year.months.map((month) => {
          const isCollapsed = collapsed.has(month.month);
          return (
            <Card key={month.month} className="overflow-hidden">
              <button
                type="button"
                onClick={() => toggleMonth(month.month)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center justify-between border-b border-border bg-surface-2/40 px-5 py-2.5 text-left transition-colors hover:bg-surface-2"
              >
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  {isCollapsed ? <ChevronRight className="h-4 w-4 text-muted-2" /> : <ChevronDown className="h-4 w-4 text-muted-2" />}
                  {monthLabel(month.month, locale)}
                </h3>
                <div className="flex items-center gap-3 text-xs">
                  {month.totalIn > 0 && <span className="num text-positive">+{month.totalIn.toFixed(2)}</span>}
                  {month.totalOut > 0 && <span className="num text-muted">−{month.totalOut.toFixed(2)}</span>}
                </div>
              </button>
              {!isCollapsed && (
                <div className="px-5">
                  {month.days.map((day) => (
                    <div key={day.date} className="border-b border-border last:border-0">
                      <p className="pt-3 text-xs font-medium uppercase tracking-wide text-muted-2">{dayLabel(day.date, locale)}</p>
                      <ul className="divide-y divide-border">
                        {day.items.map((m) => <Row key={m.id} m={m} locale={locale} />)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        }),
      )}
    </div>
  );
}
