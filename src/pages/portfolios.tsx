import { Coins, Layers, Loader2, Maximize2, Minimize2, Plus, TrendingDown, TrendingUp, Trash2, Pencil, AlertTriangle, CandlestickChart, LineChart as LineChartIcon, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ExchangeRatesEditor } from "@/components/exchange-rates-editor";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DonutChart } from "@/components/ui/donut-chart";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm";
import { PORTFOLIO_RANGES, RangeChart } from "@/components/ui/range-chart";
import { SERIES_COLORS } from "@/components/ui/multi-line-chart";
import { isPreviewDb } from "@/db/connection";
import {
  useCreateHolding,
  useCreatePortfolio,
  useDeleteHolding,
  useAssetSearch,
  useDeletePortfolio,
  useHoldingHistory,
  usePortfolioHistory,
  usePortfoliosView,
  usePreferences,
  useRefreshHolding,
  useRefreshPrices,
  useSources,
  useUpdateHolding,
  type SourceWithBalance,
} from "@/db/queries";
import type { EnrichedHolding, NewHolding, NewPortfolio, PortfolioHolding, PortfolioSummary, PortfoliosOverview } from "@/db/repo/portfolios";
import { CHAINS, type AssetSuggestion } from "@/db/repo/prices";
import { round2 } from "@/domain/money";
import { cn } from "@/lib/cn";
import { dayLabel } from "@/lib/date";
import { formatMoney, formatSigned } from "@/lib/format";
import { useErrorText } from "@/lib/use-error-text";

/** Asset-class → donut/legend color; falls back to the shared series palette. */
const ASSET_COLOR: Record<string, string> = { stock: "var(--primary)", crypto: "var(--warning)" };
const allocColor = (key: string, i: number) => ASSET_COLOR[key] ?? SERIES_COLORS[i % SERIES_COLORS.length];

type SortKey = "weight" | "value" | "pnl" | "name";

/** Sort holdings by the chosen key (numeric desc; name asc). */
function sortHoldings(holdings: PortfolioHolding[], key: SortKey): PortfolioHolding[] {
  const arr = [...holdings];
  if (key === "name") return arr.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const metric = (h: PortfolioHolding) =>
    key === "pnl" ? h.unrealized_pnl_pct ?? -Infinity : h.base_value ?? -Infinity;
  return arr.sort((a, b) => metric(b) - metric(a));
}

/** Lazily-loaded portfolio value-over-time chart (rendered when expanded). */
function PortfolioHistory({ id, currency, locale, sign }: { id: number; currency: string; locale?: string; sign: number }) {
  const { t } = useTranslation();
  const { data, isLoading } = usePortfolioHistory(id);
  if (isLoading) return <p className="pb-2 text-xs text-muted">{t("loading", { defaultValue: "Loading…" })}</p>;
  if (!data || data.length < 2) return <p className="pb-2 text-xs text-muted">{t("not_enough_history", { defaultValue: "Not enough history to chart yet." })}</p>;
  return (
    <div className="pb-1">
      <RangeChart
        points={data}
        height={140}
        ranges={PORTFOLIO_RANGES}
        defaultRange="30d"
        color={sign >= 0 ? "var(--positive)" : "var(--negative)"}
        format={(n) => formatMoney(n, currency, locale)}
        formatDate={(d) => dayLabel(d, locale)}
      />
    </div>
  );
}

/**
 * Per-holding price/value history modal: a value/price metric toggle plus the
 * 7d/30d/90d/1y range buttons; the line is green/red on first-vs-last value.
 * Mirrors the original detail.html holding-history modal.
 */
function HoldingHistoryModal({ holding, locale, onClose }: { holding: EnrichedHolding; locale?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<"value" | "price">("value");
  const { data, isLoading } = useHoldingHistory(holding.id);
  const points = useMemo(
    () => (data ?? []).map((p) => ({ date: p.date, value: metric === "price" ? p.price : p.value })),
    [data, metric],
  );
  const sign = points.length >= 2 ? points[points.length - 1].value - points[0].value : 0;
  const digits = metric === "price" ? 6 : 2;
  return (
    <Modal open onClose={onClose} title={`${t("holding_history", { defaultValue: "Holding history" })}: ${holding.symbol}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {(["value", "price"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={cn(
                "rounded-[var(--radius-control)] px-2 py-0.5 text-xs font-medium transition-colors",
                metric === m ? "bg-accent-soft text-primary" : "text-muted hover:text-foreground",
              )}
            >
              {t(m, { defaultValue: m === "value" ? "Value" : "Price" })}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? (
        <p className="py-8 text-center text-xs text-muted">{t("loading", { defaultValue: "Loading…" })}</p>
      ) : points.length < 2 ? (
        <p className="py-8 text-center text-xs text-muted">{t("no_history_data", { defaultValue: "Not enough history to chart yet." })}</p>
      ) : (
        <RangeChart
          points={points}
          height={260}
          ranges={PORTFOLIO_RANGES}
          defaultRange="30d"
          color={sign >= 0 ? "var(--positive)" : "var(--negative)"}
          format={(n) =>
            metric === "price"
              ? `${n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: digits })} ${holding.currency}`
              : formatMoney(n, holding.currency, locale)
          }
          formatDate={(d) => dayLabel(d, locale)}
        />
      )}
    </Modal>
  );
}

/**
 * Embedded TradingView chart for a single holding (opt-in,
 * portfolio_charts_enabled). Loads external content from tradingview.com, so it
 * is only ever rendered when the user has explicitly enabled charts. Crypto
 * tickers get a USD quote so TradingView can resolve them; the embed allows
 * changing the symbol if our guess is off (e.g. exchange-suffixed stocks).
 */
function HoldingChartModal({ holding, onClose }: { holding: EnrichedHolding; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const dark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
  const tvSymbol = holding.asset_class === "crypto" ? `${holding.symbol}USD` : holding.symbol;
  const params = new URLSearchParams({
    symbol: tvSymbol,
    interval: "D",
    theme: dark ? "dark" : "light",
    style: "1",
    locale: (i18n.resolvedLanguage || "en").slice(0, 2),
    hide_side_toolbar: "1",
    allow_symbol_change: "1",
    save_image: "0",
    timezone: "Etc/UTC",
  });
  const src = `https://s.tradingview.com/widgetembed/?${params.toString()}`;
  return (
    <Modal
      open
      onClose={onClose}
      size={expanded ? "full" : "xl"}
      title={
        <span className="flex items-center gap-2">
          {holding.symbol}{holding.display_name ? ` · ${holding.display_name}` : ""}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? t("shrink", { defaultValue: "Shrink" }) : t("enlarge", { defaultValue: "Enlarge" })}
            title={expanded ? t("shrink", { defaultValue: "Shrink" }) : t("enlarge", { defaultValue: "Enlarge" })}
            className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-foreground"
          >
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </span>
      }
    >
      <div className={cn("w-full overflow-hidden rounded-[var(--radius-control)] border border-border", expanded ? "h-full" : "h-[60vh]")}>
        <iframe
          title={`TradingView ${holding.symbol}`}
          src={src}
          className="h-full w-full border-0"
          allow="fullscreen"
          allowFullScreen
          referrerPolicy="no-referrer"
        />
      </div>
      {!expanded && (
        <p className="mt-2 text-xs text-muted-2">
          {t("tradingview_note", { defaultValue: "Charts by TradingView. The shown symbol may differ from your holding's exchange — change it in the chart if needed." })}
        </p>
      )}
    </Modal>
  );
}

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "CNY", "BTC", "ETH"];

function PortfolioForm({ sources, onCancel, onSubmit, pending, error }: {
  sources: SourceWithBalance[]; onCancel: () => void; onSubmit: (v: NewPortfolio) => void; pending: boolean; error?: string;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"crypto" | "stocks" | "mixed">("mixed");
  const [base, setBase] = useState("EUR");
  const [sourceId, setSourceId] = useState(String(sources[0]?.id ?? ""));
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit({ name: name.trim(), kind, base_currency: base, source_id: Number(sourceId) }); };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={t("name", { defaultValue: "Name" })} htmlFor="pf-name"><Input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("kind", { defaultValue: "Kind" })} htmlFor="pf-kind">
          <Select id="pf-kind" value={kind} onChange={(e) => setKind(e.target.value as "crypto" | "stocks" | "mixed")}>
            <option value="mixed">{t("kind_mixed", { defaultValue: "Mixed" })}</option>
            <option value="crypto">{t("kind_crypto", { defaultValue: "Crypto" })}</option>
            <option value="stocks">{t("kind_stocks", { defaultValue: "Stocks" })}</option>
          </Select>
        </Field>
        <Field label={t("base_currency", { defaultValue: "Base currency" })} htmlFor="pf-base">
          <Select id="pf-base" value={base} onChange={(e) => setBase(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
        </Field>
      </div>
      <Field label={t("linked_source", { defaultValue: "Linked account" })} htmlFor="pf-src">
        <Select id="pf-src" value={sourceId} onChange={(e) => setSourceId(e.target.value)} required>{sources.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>)}</Select>
      </Field>
      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !name.trim() || !sourceId}>{t("save", { defaultValue: "Save" })}</Button>
      </div>
    </form>
  );
}

function HoldingForm({ portfolioId, kind, base, initial, onCancel, onSubmit, pending, error }: {
  portfolioId: number; kind: string; base: string; initial?: EnrichedHolding;
  onCancel: () => void; onSubmit: (v: NewHolding) => void; pending: boolean; error?: string;
}) {
  const { t } = useTranslation();
  const [assetClass, setAssetClass] = useState<"crypto" | "stock">(initial?.asset_class ?? (kind === "crypto" ? "crypto" : "stock"));
  const [symbol, setSymbol] = useState(initial?.symbol ?? "");
  const [displayName, setDisplayName] = useState(initial?.display_name ?? "");
  const [quantity, setQuantity] = useState(initial ? String(initial.quantity) : "");
  const [avgCost, setAvgCost] = useState(initial ? String(initial.avg_cost) : "");
  const [currency, setCurrency] = useState(initial?.currency ?? base);
  const [manual, setManual] = useState((initial?.manual_price ?? 0) === 1);
  const [price, setPrice] = useState(initial?.last_price != null ? String(initial.last_price) : "");
  const [note, setNote] = useState(initial?.note ?? "");
  // Optional on-chain address tracking (crypto only): quantity is synced from the
  // address balance on refresh instead of being entered by hand.
  const [chain, setChain] = useState(initial?.chain ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const tracked = !!chain && address.trim() !== "";
  const onChainChange = (key: string) => {
    setChain(key);
    if (key) {
      setAssetClass("crypto");
      const def = CHAINS.find((c) => c.key === key);
      if (def && !symbol.trim()) { setSymbol(def.symbol); setPicked(def.symbol); }
    }
  };

  // ---- symbol autocomplete (CoinGecko for crypto, Yahoo for stocks) ----
  const [symFocus, setSymFocus] = useState(false);
  const [picked, setPicked] = useState(initial?.symbol?.toUpperCase() ?? "");
  const [active, setActive] = useState(0);
  const [debSym, setDebSym] = useState(symbol);
  useEffect(() => {
    const id = setTimeout(() => setDebSym(symbol), 250);
    return () => clearTimeout(id);
  }, [symbol]);
  const assetSearch = useAssetSearch(assetClass, debSym);
  const suggestions = assetSearch.data ?? [];
  // Hide once the typed value equals the picked symbol (no re-prompt after a choice).
  const showSuggest = symFocus && symbol.trim().length >= 2 && picked !== symbol.trim().toUpperCase() && suggestions.length > 0;
  useEffect(() => setActive(0), [debSym, assetClass]);
  const pick = (s: AssetSuggestion) => {
    setSymbol(s.symbol);
    setPicked(s.symbol);
    if (!displayName.trim() && s.name) setDisplayName(s.name);
    if (s.currency && CURRENCIES.includes(s.currency)) setCurrency(s.currency);
  };

  // Asset-class-adaptive labels/placeholders (tokens vs shares).
  const isCrypto = assetClass === "crypto";
  const symbolPlaceholder = isCrypto
    ? t("symbol_hint_crypto", { defaultValue: "e.g. BTC, ETH, SOL" })
    : t("symbol_hint_stock", { defaultValue: "e.g. AAPL, MSFT, ENI.MI" });
  const quantityLabel = isCrypto
    ? t("num_tokens", { defaultValue: "Number of tokens" })
    : t("num_shares", { defaultValue: "Number of shares" });
  const avgCostLabel = isCrypto
    ? t("avg_cost_per_token", { defaultValue: "Avg cost / token" })
    : t("avg_cost_per_share", { defaultValue: "Avg cost / share" });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      portfolio_id: portfolioId, asset_class: assetClass, symbol: symbol.trim().toUpperCase(),
      display_name: displayName.trim() || null,
      quantity: Number(quantity) || 0, avg_cost: Number(avgCost) || 0, currency,
      manual_price: manual, last_price: manual && price ? Number(price) : null,
      note: note.trim() || null,
      chain: chain || null,
      address: chain ? (address.trim() || null) : null,
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {kind === "mixed" && (
          <Field label={t("asset_class", { defaultValue: "Type" })} htmlFor="h-class">
            <Select id="h-class" value={assetClass} onChange={(e) => setAssetClass(e.target.value as "crypto" | "stock")}>
              <option value="stock">{t("stock", { defaultValue: "Stock" })}</option>
              <option value="crypto">{t("crypto", { defaultValue: "Crypto" })}</option>
            </Select>
          </Field>
        )}
        <Field label={t("symbol", { defaultValue: "Symbol" })} htmlFor="h-sym">
          <div className="relative">
            <Input
              id="h-sym"
              value={symbol}
              onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setPicked(""); }}
              onFocus={() => setSymFocus(true)}
              onBlur={() => setSymFocus(false)}
              onKeyDown={(e) => {
                if (!showSuggest) return;
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, suggestions.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                else if (e.key === "Enter") { e.preventDefault(); pick(suggestions[active]); }
                else if (e.key === "Escape") { setSymFocus(false); }
              }}
              placeholder={symbolPlaceholder}
              autoComplete="off"
              required
              maxLength={32}
              autoFocus
            />
            {symFocus && symbol.trim().length >= 2 && assetSearch.isFetching && picked !== symbol.trim().toUpperCase() && (
              <Loader2 className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-2" />
            )}
            {showSuggest && (
              <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-[var(--radius-control)] border border-border bg-surface py-1 shadow-[var(--shadow-pop)]">
                {suggestions.map((s, i) => (
                  <li key={`${s.symbol}-${i}`}>
                    <button
                      type="button"
                      // mousedown (not click) so we pick BEFORE the input's blur fires.
                      onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                      onMouseEnter={() => setActive(i)}
                      className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm", i === active ? "bg-surface-2" : "hover:bg-surface-2/60")}
                    >
                      <span className="font-medium text-foreground">{s.symbol}</span>
                      {s.name && <span className="min-w-0 flex-1 truncate text-xs text-muted">{s.name}</span>}
                      {s.currency && <span className="shrink-0 text-[11px] text-muted-2">{s.currency}</span>}
                      {s.hint && <span className="shrink-0 text-[11px] text-muted-2">{s.hint}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>
        <Field label={`${t("display_name", { defaultValue: "Display name" })} (${t("optional", { defaultValue: "optional" })})`} htmlFor="h-name"><Input id="h-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label={quantityLabel} htmlFor="h-qty">
          <Input id="h-qty" type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="num" disabled={tracked} title={tracked ? t("qty_from_address", { defaultValue: "Synced from the address on refresh" }) : undefined} />
        </Field>
        <Field label={avgCostLabel} htmlFor="h-cost"><Input id="h-cost" type="number" step="any" value={avgCost} onChange={(e) => setAvgCost(e.target.value)} className="num" /></Field>
        <Field label={t("currency", { defaultValue: "Currency" })} htmlFor="h-ccy"><Select id="h-ccy" value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
      </div>
      {isCrypto && (
        <div className="rounded-[var(--radius-control)] border border-border p-3">
          <p className="text-sm font-medium text-foreground">{t("track_address_title", { defaultValue: "Track an address (optional)" })}</p>
          <p className="mt-0.5 text-xs text-muted">{t("track_address_desc", { defaultValue: "Read the on-chain balance of a public wallet address — the quantity updates automatically on each price refresh." })}</p>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
            <Field label={t("chain", { defaultValue: "Blockchain" })} htmlFor="h-chain">
              <Select id="h-chain" value={chain} onChange={(e) => onChainChange(e.target.value)}>
                <option value="">{t("not_tracked", { defaultValue: "Not tracked" })}</option>
                {CHAINS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </Select>
            </Field>
            {chain && (
              <Field label={t("wallet_address", { defaultValue: "Wallet address" })} htmlFor="h-addr">
                <Input id="h-addr" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t("wallet_address_hint", { defaultValue: "Public address (read-only)" })} autoComplete="off" spellCheck={false} />
              </Field>
            )}
          </div>
          {tracked && <p className="mt-1.5 text-xs text-muted-2">{t("qty_from_address", { defaultValue: "Synced from the address on refresh" })}.</p>}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> {t("manual_price", { defaultValue: "Set price manually" })}
      </label>
      {manual && <Field label={t("price", { defaultValue: "Price" })} htmlFor="h-price"><Input id="h-price" type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)} className="num" /></Field>}
      <Field label={t("note", { defaultValue: "Note" })} htmlFor="h-note">
        <textarea id="h-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-border-strong" />
      </Field>
      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !symbol.trim()}>{t("save", { defaultValue: "Save" })}</Button>
      </div>
    </form>
  );
}

/** Cross-portfolio overview: aggregate totals, asset-class allocation donut, and the
 *  sort / group-by controls that drive every holdings table below. */
function OverviewCard({ overview, sortKey, setSortKey, grouped, setGrouped, locale, onOpenRates }: {
  overview: PortfoliosOverview;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
  grouped: boolean;
  setGrouped: (fn: (g: boolean) => boolean) => void;
  locale?: string;
  onOpenRates: () => void;
}) {
  const { t } = useTranslation();
  const o = overview;
  const slices = o.allocation.map((a, i) => ({ value: a.value, color: allocColor(a.key, i) }));
  const top = o.allocation[0];
  return (
    <Card>
      <CardContent className="py-4">
        <div className="grid gap-5 md:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-2">
              {t("portfolios_overview", { defaultValue: "Overview" })} · {o.displayCurrency}
            </p>
            <p className="num mt-1 text-3xl font-semibold tracking-tight text-foreground">{formatMoney(o.total_value, o.displayCurrency, locale)}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="num text-muted">{t("invested", { defaultValue: "Invested" })}: {formatMoney(o.total_cost, o.displayCurrency, locale)}</span>
              {o.total_pnl != null && (
                <span className={cn("num font-medium", o.total_pnl >= 0 ? "text-positive" : "text-negative")}>
                  {formatSigned(o.total_pnl, o.displayCurrency, locale)} ({o.total_pnl_pct}%)
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-2">
              {t("n_portfolios", { defaultValue: "{{n}} portfolios", n: o.portfolio_count })} · {t("n_holdings", { defaultValue: "{{n}} holdings", n: o.holding_count })}
            </p>
            {o.has_unconverted && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-warning"><AlertTriangle className="h-3.5 w-3.5" />{t("missing_fx", { defaultValue: "Some holdings use a currency with no exchange rate — totals may be approximate." })} <button type="button" onClick={onOpenRates} className="font-medium text-primary hover:underline">{t("missing_fx_link", { defaultValue: "Add exchange rates" })}</button></p>
            )}
            {o.holding_count > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                <span className="mr-1 text-xs text-muted">{t("sort_by", { defaultValue: "Sort" })}:</span>
                {(["weight", "value", "pnl", "name"] as SortKey[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setSortKey(k)}
                    className={cn("rounded-[var(--radius-control)] px-2 py-0.5 text-xs font-medium transition-colors", sortKey === k ? "bg-accent-soft text-primary" : "text-muted hover:text-foreground")}
                  >
                    {t(`sort_${k}`, { defaultValue: k })}
                  </button>
                ))}
                <button
                  onClick={() => setGrouped((g) => !g)}
                  className={cn("ml-1 inline-flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-0.5 text-xs font-medium transition-colors", grouped ? "bg-accent-soft text-primary" : "text-muted hover:text-foreground")}
                >
                  <Layers className="h-3.5 w-3.5" /> {t("group_by_class", { defaultValue: "Group by class" })}
                </button>
              </div>
            )}
          </div>
          {o.allocation.length > 0 && (
            <div className="flex items-center gap-4">
              <div className="relative shrink-0">
                <DonutChart slices={slices} size={128} thickness={18} />
                {top && (
                  <div className="absolute inset-0 grid place-items-center text-center">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-2">{t(top.key, { defaultValue: top.key })}</p>
                      <p className="num text-lg font-semibold text-foreground">{top.pct}%</p>
                    </div>
                  </div>
                )}
              </div>
              <ul className="space-y-1.5 text-sm">
                {o.allocation.map((a, i) => (
                  <li key={a.key} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: allocColor(a.key, i) }} />
                    <span className="text-foreground">{t(a.key, { defaultValue: a.key })}</span>
                    <span className="num text-muted-2">{a.pct}%</span>
                    <span className="num text-xs text-muted-2">· {formatMoney(a.value, o.displayCurrency, locale)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** A portfolio's holdings table: weight bars, recent-change arrows, best/worst markers,
 *  driven by the page-level sort key, and optionally grouped by asset class with subtotals. */
function PortfolioHoldings({ p, sortKey, grouped, locale, pricesEnabled, chartsEnabled, refreshingIds, onRefresh, onHistory, onChart, onEdit, onDelete }: {
  p: PortfolioSummary;
  sortKey: SortKey;
  grouped: boolean;
  locale?: string;
  pricesEnabled: boolean;
  chartsEnabled: boolean;
  refreshingIds: ReadonlySet<number>;
  onRefresh: (id: number) => void;
  onHistory: (h: PortfolioHolding) => void;
  onChart: (h: PortfolioHolding) => void;
  onEdit: (h: PortfolioHolding) => void;
  onDelete: (h: PortfolioHolding) => void;
}) {
  const { t } = useTranslation();
  const base = p.portfolio.base_currency;

  // Best / worst performer within this portfolio (only meaningful with 2+ P/L%s).
  const withPct = p.holdings.filter((h) => h.unrealized_pnl_pct != null);
  let bestId = -1;
  let worstId = -1;
  if (withPct.length >= 2) {
    let best = withPct[0];
    let worst = withPct[0];
    for (const h of withPct) {
      if ((h.unrealized_pnl_pct ?? 0) > (best.unrealized_pnl_pct ?? 0)) best = h;
      if ((h.unrealized_pnl_pct ?? 0) < (worst.unrealized_pnl_pct ?? 0)) worst = h;
    }
    if (best.unrealized_pnl_pct !== worst.unrealized_pnl_pct) {
      bestId = best.id;
      worstId = worst.id;
    }
  }

  const row = (h: PortfolioHolding) => (
    <tr key={h.id} className="cursor-pointer border-t border-border hover:bg-surface-2/40" onClick={() => onHistory(h)} title={t("holding_history", { defaultValue: "Holding history" })}>
      <td className="py-2">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground">{h.symbol}</span>
          <span className="text-xs text-muted">{h.currency}</span>
          {h.id === bestId && <TrendingUp className="h-3.5 w-3.5 text-positive" aria-label={t("best_performer", { defaultValue: "Best performer" })} />}
          {h.id === worstId && <TrendingDown className="h-3.5 w-3.5 text-negative" aria-label={t("worst_performer", { defaultValue: "Worst performer" })} />}
        </div>
        {h.display_name && <p className="text-xs text-muted">{h.display_name}</p>}
        <div className="mt-0.5 flex flex-wrap gap-1">
          <Badge tone={h.asset_class === "crypto" ? "warning" : "primary"}>{t(h.asset_class, { defaultValue: h.asset_class })}</Badge>
          {h.manual_price === 1 && <Badge tone="neutral">{t("manual", { defaultValue: "Manual" })}</Badge>}
          {h.address && <Badge tone="neutral" title={h.address}>⛓ {(h.chain ?? "").toUpperCase()}</Badge>}
        </div>
      </td>
      <td className="num py-2 text-right text-muted">{h.quantity}</td>
      <td className="num py-2 text-right text-muted">{formatMoney(h.avg_cost, h.currency, locale)}</td>
      <td className="num py-2 text-right text-muted">
        <span className="inline-flex items-center justify-end gap-1">
          {h.last_price != null ? formatMoney(h.last_price, h.currency, locale) : "—"}
          {h.change_pct != null && h.change_pct !== 0 && (
            <span className={cn("text-xs", h.change_pct >= 0 ? "text-positive" : "text-negative")}>{h.change_pct >= 0 ? "▲" : "▼"}{Math.abs(h.change_pct)}%</span>
          )}
        </span>
        {h.last_price_at && (
          <span className="block text-xs text-muted-2" title={h.last_price_at}>{new Date(h.last_price_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>
        )}
      </td>
      <td className="num py-2 text-right text-foreground">{h.market_value != null ? formatMoney(h.market_value, h.currency, locale) : "—"}</td>
      <td className="py-2 text-right">
        {h.weight_pct != null ? (
          <div className="flex items-center justify-end gap-1.5">
            <span className="num text-xs text-muted">{h.weight_pct}%</span>
            <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-surface-2 sm:block">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, h.weight_pct))}%` }} />
            </span>
          </div>
        ) : "—"}
      </td>
      <td className={cn("num py-2 text-right", h.unrealized_pnl == null ? "text-muted" : h.unrealized_pnl >= 0 ? "text-positive" : "text-negative")}>
        {h.unrealized_pnl != null ? (
          <>{formatSigned(h.unrealized_pnl, h.currency, locale)} <span className="text-xs">({h.unrealized_pnl_pct}%)</span></>
        ) : "—"}
      </td>
      <td className="py-2 text-right" onClick={(e) => e.stopPropagation()}>
        {pricesEnabled && (h.manual_price !== 1 || (!!h.chain && !!h.address)) && (
          <button onClick={() => onRefresh(h.id)} disabled={refreshingIds.has(h.id)} className="rounded p-1 text-muted hover:text-primary disabled:opacity-50" title={t("refresh_price", { defaultValue: "Refresh price" })}>
            <RefreshCw className={cn("h-3.5 w-3.5", refreshingIds.has(h.id) && "animate-spin")} />
          </button>
        )}
        {chartsEnabled && (
          <button onClick={() => onChart(h)} className="rounded p-1 text-muted hover:text-primary" title={t("view_chart", { defaultValue: "View chart" })}>
            <CandlestickChart className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={() => onEdit(h)} className="rounded p-1 text-muted hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
        <button onClick={() => onDelete(h)} className="rounded p-1 text-muted hover:text-negative"><Trash2 className="h-3.5 w-3.5" /></button>
      </td>
    </tr>
  );

  const head = (
    <thead>
      <tr className="text-left text-xs text-muted">
        <th className="py-1 font-medium">{t("asset", { defaultValue: "Asset" })}</th>
        <th className="py-1 text-right font-medium">{t("quantity", { defaultValue: "Qty" })}</th>
        <th className="py-1 text-right font-medium">{t("avg_cost", { defaultValue: "Avg cost" })}</th>
        <th className="py-1 text-right font-medium">{t("last_price", { defaultValue: "Price" })}</th>
        <th className="py-1 text-right font-medium">{t("market_value", { defaultValue: "Value" })}</th>
        <th className="py-1 text-right font-medium">{t("weight", { defaultValue: "Weight" })}</th>
        <th className="py-1 text-right font-medium">{t("unrealized_pnl", { defaultValue: "P/L" })}</th>
        <th />
      </tr>
    </thead>
  );

  const sorted = sortHoldings(p.holdings, sortKey);

  if (grouped) {
    const groups = new Map<string, PortfolioHolding[]>();
    for (const h of sorted) {
      const g = groups.get(h.asset_class) ?? [];
      g.push(h);
      groups.set(h.asset_class, g);
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {head}
          {[...groups.entries()].map(([cls, hs]) => {
            const subVal = round2(hs.reduce((a, h) => a + (h.base_value ?? 0), 0));
            const hasPnl = hs.some((h) => h.base_pnl != null);
            const subPnl = round2(hs.reduce((a, h) => a + (h.base_pnl ?? 0), 0));
            return (
              <tbody key={cls}>
                <tr className="border-t border-border bg-surface-2/30">
                  <td className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-2" colSpan={4}>{t(cls, { defaultValue: cls })} · {hs.length}</td>
                  <td className="num py-1.5 text-right text-xs font-semibold text-foreground">{formatMoney(subVal, base, locale)}</td>
                  <td />
                  <td className={cn("num py-1.5 text-right text-xs font-semibold", !hasPnl ? "text-muted" : subPnl >= 0 ? "text-positive" : "text-negative")}>{hasPnl ? formatSigned(subPnl, base, locale) : "—"}</td>
                  <td />
                </tr>
                {hs.map(row)}
              </tbody>
            );
          })}
        </table>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {head}
        <tbody>{sorted.map(row)}</tbody>
      </table>
    </div>
  );
}

export function PortfoliosPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const errText = useErrorText();
  const { data: view, isLoading } = usePortfoliosView();
  const list = view?.portfolios;
  const overview = view?.overview;
  const [sortKey, setSortKey] = useState<SortKey>("weight");
  const [grouped, setGrouped] = useState(false);
  const { data: sources } = useSources();
  const { data: prefs } = usePreferences();
  const createP = useCreatePortfolio();
  const delP = useDeletePortfolio();
  const createH = useCreateHolding();
  const updateH = useUpdateHolding();
  const delH = useDeleteHolding();
  const askConfirm = useConfirm();
  const refreshAll = useRefreshPrices();
  const refreshOne = useRefreshHolding();

  const pricesEnabled = (prefs?.portfolio_prices_enabled ?? 0) === 1;
  const chartsEnabled = (prefs?.portfolio_charts_enabled ?? 0) === 1;
  const lastRefreshAt = prefs?.last_price_refresh_at ?? null;
  // Track the SET of holdings currently refreshing, so concurrent per-row refreshes
  // each keep their own spinner (a single id ref mis-attributed under rapid clicks).
  const [refreshingIds, setRefreshingIds] = useState<ReadonlySet<number>>(() => new Set());
  const startRefresh = (id: number) => {
    setRefreshingIds((prev) => new Set(prev).add(id));
    refreshOne.mutate(id, {
      onSettled: () =>
        setRefreshingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
    });
  };

  const [pForm, setPForm] = useState(false);
  const [fxOpen, setFxOpen] = useState(false);
  const [hForm, setHForm] = useState<{ portfolio: PortfolioSummary; editing?: EnrichedHolding }>();
  const [historyHolding, setHistoryHolding] = useState<EnrichedHolding>();
  const [chartHolding, setChartHolding] = useState<EnrichedHolding>();
  const [err, setErr] = useState<string>();
  const [chartOpen, setChartOpen] = useState<Set<number>>(new Set());
  const toggleChart = (id: number) =>
    setChartOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-4">
      {isPreviewDb && <div className="rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">{t("preview_db_note", { defaultValue: "Browser preview with seeded sample data." })}</div>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{t("portfolios_subtitle", { defaultValue: "Investments — manual prices now; live quotes are opt-in." })}</p>
        <div className="flex items-center gap-2">
          {pricesEnabled && (
            <div className="flex items-center gap-2">
              {refreshAll.data != null && !refreshAll.isPending && (
                <span className="text-xs text-muted">{t("prices_updated_count", { defaultValue: "{{count}} updated", count: refreshAll.data })}</span>
              )}
              {lastRefreshAt && (
                <span className="text-xs text-muted-2" title={lastRefreshAt}>{t("last_refreshed", { defaultValue: "Last refreshed" })}: {new Date(lastRefreshAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>
              )}
              <Button
                variant="outline"
                onClick={() => { refreshAll.mutate(); }}
                disabled={refreshAll.isPending}
                title={t("refresh_prices", { defaultValue: "Refresh prices" })}
              >
                <RefreshCw className={cn("h-4 w-4", refreshAll.isPending && "animate-spin")} />
                {refreshAll.isPending ? t("refreshing_prices", { defaultValue: "Refreshing prices" }) : t("refresh_prices", { defaultValue: "Refresh prices" })}
              </Button>
            </div>
          )}
          <Button variant="outline" onClick={() => setFxOpen(true)} title={t("exchange_rates", { defaultValue: "Exchange rates" })}>
            <Coins className="h-4 w-4" /> {t("exchange_rates", { defaultValue: "Exchange rates" })}
          </Button>
          <Button onClick={() => { setErr(undefined); setPForm(true); }} disabled={(sources?.length ?? 0) === 0}><Plus className="h-4 w-4" /> {t("new_portfolio", { defaultValue: "New Portfolio" })}</Button>
        </div>
      </div>
      {!pricesEnabled && (
        <div className="rounded-[var(--radius-control)] border border-border bg-surface-2/40 px-3 py-2 text-xs text-muted">
          {t("prices_off_desc", { defaultValue: "Portfolios show cost basis only. Enable live prices to see market value and P/L." })}{" "}
          <Link to="/settings" className="font-medium text-primary hover:underline">{t("prices_off_enable_link", { defaultValue: "Turn on live prices in Settings" })}</Link>
        </div>
      )}
      {isLoading && <Card className="p-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</Card>}
      {list && list.length === 0 && <Card className="p-10 text-center text-sm text-muted">{t("no_portfolios", { defaultValue: "No portfolios yet." })}</Card>}

      {overview && overview.holding_count > 0 && (
        <OverviewCard overview={overview} sortKey={sortKey} setSortKey={setSortKey} grouped={grouped} setGrouped={setGrouped} locale={locale} onOpenRates={() => setFxOpen(true)} />
      )}

      {(list ?? []).map((p) => (
        <Card key={p.portfolio.id}>
          <CardHeader
            title={<span className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" />{p.portfolio.name}</span>}
            subtitle={`${p.source_name ?? "—"} · ${p.portfolio.base_currency}`}
            action={
              <div className="flex items-center gap-2">
                <div className="text-right">
                  <p className="num text-base font-semibold text-foreground">{formatMoney(p.total_value, p.portfolio.base_currency, locale)}</p>
                  <p className="num text-xs text-muted">{t("invested", { defaultValue: "Invested" })}: {formatMoney(p.total_cost, p.portfolio.base_currency, locale)}</p>
                  {p.total_pnl != null && <p className={cn("num text-xs", p.total_pnl >= 0 ? "text-positive" : "text-negative")}>{formatSigned(p.total_pnl, p.portfolio.base_currency, locale)} ({p.total_pnl_pct}%)</p>}
                </div>
                <button onClick={() => toggleChart(p.portfolio.id)} aria-label={t("history", { defaultValue: "History" })} aria-expanded={chartOpen.has(p.portfolio.id)} className={cn("rounded-md p-1.5 hover:bg-surface-2 hover:text-foreground", chartOpen.has(p.portfolio.id) ? "text-primary" : "text-muted")}><LineChartIcon className="h-4 w-4" /></button>
                <button onClick={() => { void askConfirm({ message: t("portfolio_delete_confirm", { defaultValue: "Delete this portfolio and all its holdings and price history? This cannot be undone." }), tone: "danger" }).then((ok) => { if (ok) delP.mutate(p.portfolio.id); }); }} className="rounded-md p-1.5 text-muted hover:bg-negative-soft hover:text-negative"><Trash2 className="h-4 w-4" /></button>
              </div>
            }
          />
          <CardContent className="pt-3">
            {chartOpen.has(p.portfolio.id) && (
              <div className="mb-3 border-b border-border pb-2">
                <PortfolioHistory id={p.portfolio.id} currency={p.portfolio.base_currency} locale={locale} sign={p.total_pnl ?? 0} />
              </div>
            )}
            {p.has_unconverted && (
              <p className="mb-2 flex items-center gap-1.5 text-xs text-warning"><AlertTriangle className="h-3.5 w-3.5" />{t("missing_fx", { defaultValue: "Some holdings use a currency with no exchange rate — totals may be approximate." })} <button type="button" onClick={() => setFxOpen(true)} className="font-medium text-primary hover:underline">{t("missing_fx_link", { defaultValue: "Add exchange rates" })}</button></p>
            )}
            {p.holdings.length > 0 ? (
              <PortfolioHoldings
                p={p}
                sortKey={sortKey}
                grouped={grouped}
                locale={locale}
                pricesEnabled={pricesEnabled}
                chartsEnabled={chartsEnabled}
                refreshingIds={refreshingIds}
                onRefresh={startRefresh}
                onHistory={setHistoryHolding}
                onChart={setChartHolding}
                onEdit={(h) => { setErr(undefined); setHForm({ portfolio: p, editing: h }); }}
                onDelete={(h) => { void askConfirm({ message: t("holding_delete_confirm", { defaultValue: "Delete this holding and its price history? This cannot be undone." }), tone: "danger" }).then((ok) => { if (ok) delH.mutate(h.id); }); }}
              />
            ) : <p className="text-sm text-muted">{t("no_holdings", { defaultValue: "No holdings yet." })}</p>}
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={() => { setErr(undefined); setHForm({ portfolio: p }); }}><Plus className="h-4 w-4" /> {t("add_holding", { defaultValue: "Add holding" })}</Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <Modal open={fxOpen} onClose={() => setFxOpen(false)} title={t("exchange_rates", { defaultValue: "Exchange rates" })} size="lg">
        <p className="mb-3 text-xs text-muted">{t("exchange_rates_desc", { defaultValue: "Needed to value multi-currency portfolios, the consolidated net worth and cross-currency transfers. A pair reads: 1 of the first currency = rate of the second." })}</p>
        <ExchangeRatesEditor />
      </Modal>

      <Modal open={pForm} onClose={() => setPForm(false)} title={t("new_portfolio", { defaultValue: "New Portfolio" })}>
        <PortfolioForm sources={sources ?? []} pending={createP.isPending} error={err} onCancel={() => setPForm(false)} onSubmit={(v) => createP.mutate(v, { onSuccess: () => setPForm(false), onError: (e) => setErr(errText(e)) })} />
      </Modal>

      {hForm && (
        <Modal open onClose={() => setHForm(undefined)} title={hForm.editing ? t("edit_holding", { defaultValue: "Edit Holding" }) : t("add_holding", { defaultValue: "Add Holding" })}>
          <HoldingForm
            portfolioId={hForm.portfolio.portfolio.id} kind={hForm.portfolio.portfolio.kind} base={hForm.portfolio.portfolio.base_currency} initial={hForm.editing}
            pending={createH.isPending || updateH.isPending} error={err}
            onCancel={() => setHForm(undefined)}
            onSubmit={(v) => {
              const onDone = { onSuccess: () => setHForm(undefined), onError: (e: unknown) => setErr(errText(e)) };
              if (hForm.editing)
                updateH.mutate(
                  {
                    id: hForm.editing.id,
                    // Only send last_price in MANUAL mode. For an auto-priced holding the
                    // form sends last_price: null, which would otherwise wipe the fetched
                    // price on any benign edit (rename/quantity/note). Omitting it leaves
                    // the fetched price intact; turning manual OFF still clears it in the repo.
                    patch: {
                      symbol: v.symbol,
                      display_name: v.display_name,
                      quantity: v.quantity,
                      avg_cost: v.avg_cost,
                      currency: v.currency,
                      note: v.note,
                      manual_price: v.manual_price,
                      chain: v.chain,
                      address: v.address,
                      ...(v.manual_price ? { last_price: v.last_price } : {}),
                    },
                  },
                  onDone,
                );
              else createH.mutate(v, onDone);
            }}
          />
        </Modal>
      )}

      {historyHolding && (
        <HoldingHistoryModal holding={historyHolding} locale={locale} onClose={() => setHistoryHolding(undefined)} />
      )}
      {chartHolding && chartsEnabled && (
        <HoldingChartModal holding={chartHolding} onClose={() => setChartHolding(undefined)} />
      )}
    </div>
  );
}
