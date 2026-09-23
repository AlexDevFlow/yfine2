import { RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useDeleteRate, useExchangeRates, usePreferences, useRefreshRates, useSources, useUpsertRate } from "@/db/queries";
import { cn } from "@/lib/cn";
import { formatDate, todayISO } from "@/lib/date";

/** Local calendar day of a UTC ISO timestamp (falls back to the raw value when unparseable). */
function localDay(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : todayISO(d);
}
import { BASE_CURRENCY_CODES, currencyFlag } from "@/lib/format";
import { useErrorText } from "@/lib/use-error-text";

/**
 * The exchange-rate table, shared by Settings → Currencies and the modal on the
 * Portfolios page. Without a rate the app cannot value a USD holding inside an
 * EUR portfolio: it leaves it out of the total and marks it approximate — so
 * this editor has to be reachable from where that warning appears, not only
 * from Settings.
 *
 * Rates can be typed by hand (offline, authoritative) or fetched in one click
 * from the ECB via Frankfurter (+ CoinGecko for crypto).
 */
export function ExchangeRatesEditor() {
  const { t, i18n } = useTranslation();
  const { data: prefs } = usePreferences();
  const { data: rates } = useExchangeRates();
  const { data: sources } = useSources();
  const upsert = useUpsertRate();
  const remove = useDeleteRate();
  const refresh = useRefreshRates();
  const { push } = useToast();
  const errorText = useErrorText();
  const locale = i18n.resolvedLanguage;

  const [from, setFrom] = useState(prefs?.base_currency ?? "EUR");
  const [to, setTo] = useState("USD");
  const [rate, setRate] = useState("");
  // The preferences usually load AFTER this mounts: pick the user's base
  // currency up once it arrives (unless they already changed the pair), and
  // never leave the form on a same-currency pair like USD → USD.
  const seeded = useRef(false);
  useEffect(() => {
    const base = prefs?.base_currency?.toUpperCase();
    if (!base || seeded.current) return;
    seeded.current = true;
    setFrom(base);
    if (base === to) setTo(base === "EUR" ? "USD" : "EUR");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs?.base_currency]);
  // Per-row edit buffers, keyed by rate id: an inline input the user can retype
  // freely (empty / mid-typing states included) before it is committed on blur.
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const parseRate = (v: string): number | null => {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const save = (f: string, tCode: string, value: string, onDone?: () => void) => {
    const n = parseRate(value);
    if (f === tCode || n == null) {
      push({ title: t("invalid_rate", { defaultValue: "Enter a rate greater than 0 between two different currencies." }), tone: "alert" });
      return;
    }
    upsert.mutate({ from: f, to: tCode, rate: n }, {
      onSuccess: () => onDone?.(),
      onError: (e) => push({ title: errorText(e), tone: "alert" }),
    });
  };

  const runRefresh = () => {
    refresh.mutate(undefined, {
      onSuccess: (res) => {
        if (res.offline) {
          push({ title: t("rates_offline", { defaultValue: "Couldn't reach the rate provider — your saved rates are unchanged." }), tone: "alert" });
          return;
        }
        // Nothing fetched and nothing missing means the user simply holds one
        // currency — say that, rather than reporting a bare "0 rates updated".
        if (res.updated === 0 && res.unsupported.length === 0) {
          push({ title: t("rates_none_needed", { defaultValue: "Nothing to convert — all your money is already in {{ccy}}.", ccy: res.pivot }), tone: "info" });
          return;
        }
        push({
          title: t("rates_updated", { defaultValue: "{{n}} rates updated", n: res.updated }),
          body: res.unsupported.length > 0
            ? t("rates_unsupported", { defaultValue: "No provider quotes {{list}} — enter those by hand.", list: res.unsupported.join(", ") })
            : t("rates_quoted_against", { defaultValue: "Quoted against {{ccy}}.", ccy: res.pivot }),
          tone: res.updated > 0 ? "success" : "info",
        });
      },
      onError: (e) => push({ title: errorText(e), tone: "alert" }),
    });
  };

  // Currencies that actually appear in the user's accounts come first: those are
  // the ones a missing rate breaks. The full list stays available below them.
  const inUse = [...new Set((sources ?? []).map((s) => s.currency.toUpperCase()))];
  const options = [...inUse, ...BASE_CURRENCY_CODES.filter((c) => !inUse.includes(c))];
  const ccySelect = (id: string, value: string, onChange: (v: string) => void) => (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((c) => <option key={c} value={c}>{currencyFlag(c)} {c}</option>)}
    </Select>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={refresh.isPending} onClick={runRefresh}>
          <RefreshCw className={cn("h-4 w-4", refresh.isPending && "animate-spin")} />
          {t("update_rates", { defaultValue: "Update rates online" })}
        </Button>
        <p className="text-xs text-muted">
          {t("rates_source_hint", { defaultValue: "Fetches from the European Central Bank (frankfurter.app) and CoinGecko for crypto. Nothing is sent about you." })}
        </p>
      </div>

      {(rates?.length ?? 0) > 0 ? (
        <div className="overflow-hidden rounded-[var(--radius-control)] border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-muted-2">
                <th className="px-3 py-2 font-medium">{t("pair", { defaultValue: "Pair" })}</th>
                <th className="px-3 py-2 font-medium" style={{ width: 180 }}>{t("rate", { defaultValue: "Rate" })}</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell" style={{ width: 130 }}>{t("updated", { defaultValue: "Updated" })}</th>
                <th className="px-3 py-2" style={{ width: 56 }} />
              </tr>
            </thead>
            <tbody>
              {(rates ?? []).map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium text-foreground">
                    1 {currencyFlag(r.from_currency)} {r.from_currency} = {currencyFlag(r.to_currency)} {r.to_currency}
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      className="h-8"
                      inputMode="decimal"
                      aria-label={`${r.from_currency} → ${r.to_currency}`}
                      value={drafts[r.id] ?? String(r.rate)}
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                      onBlur={() => {
                        const draft = drafts[r.id];
                        if (draft === undefined || draft === String(r.rate)) return;
                        // The draft is dropped only once the write lands, so the
                        // field keeps showing the typed value instead of flashing
                        // back to the old rate while the mutation is in flight.
                        save(r.from_currency, r.to_currency, draft, () =>
                          setDrafts((d) => { const next = { ...d }; delete next[r.id]; return next; }),
                        );
                      }}
                    />
                  </td>
                  <td className="hidden px-3 py-2 text-xs text-muted sm:table-cell">
                    {/* updated_at is a UTC instant: show the LOCAL calendar day, not the UTC date part. */}
                    {formatDate(localDay(r.updated_at), prefs?.date_format, locale)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove.mutate(r.id)} aria-label={t("delete", { defaultValue: "Delete" })} title={t("delete", { defaultValue: "Delete" })}>
                      <Trash2 className="h-3.5 w-3.5 text-negative" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-[var(--radius-control)] border border-dashed border-border px-3 py-4 text-sm text-muted">
          {t("no_rates", { defaultValue: "No exchange rates yet — amounts in other currencies are left out of your totals. Add a pair below or fetch them online." })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <Field label={t("from_currency", { defaultValue: "From" })} htmlFor="fx-from">{ccySelect("fx-from", from, setFrom)}</Field>
        <Field label={t("to_currency", { defaultValue: "To" })} htmlFor="fx-to">{ccySelect("fx-to", to, setTo)}</Field>
        <Field label={t("rate", { defaultValue: "Rate" })} htmlFor="fx-rate">
          <Input id="fx-rate" inputMode="decimal" placeholder="1.09" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Button disabled={upsert.isPending} onClick={() => save(from, to, rate, () => setRate(""))}>
          {t("add_rate", { defaultValue: "Add rate" })}
        </Button>
      </div>
    </div>
  );
}
