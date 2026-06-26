// Non-fiat codes Intl can't format with proper precision (it would clamp to 2dp).
const CRYPTO = new Set(["BTC", "ETH", "LTC", "XRP", "ADA", "SOL", "DOT", "DOGE", "BCH", "BNB"]);

/** Format a monetary amount. Crypto codes keep up to 8 decimals (Intl truncates to 2). */
export function formatMoney(
  amount: number,
  currency: string,
  locale?: string,
): string {
  const code = (currency || "").toUpperCase();
  if (CRYPTO.has(code) || code.length !== 3) {
    // not a fiat ISO-4217 code: plain number + suffix, preserving precision
    const digits = CRYPTO.has(code) ? 8 : 2;
    return `${amount.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: digits })} ${code}`;
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).format(amount);
  } catch {
    return `${amount.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
  }
}

/**
 * The 38 base-currency choices (incl. BTC/ETH) mapped to flag emoji, ported
 * verbatim from i18n._CURRENCY_FLAGS / currency_flag(). Order matches the
 * legacy settings base_currency dropdown.
 */
export const CURRENCY_FLAGS: Record<string, string> = {
  EUR: "🇪🇺", USD: "🇺🇸", GBP: "🇬🇧", CHF: "🇨🇭", JPY: "🇯🇵", CAD: "🇨🇦",
  AUD: "🇦🇺", CNY: "🇨🇳", INR: "🇮🇳", BRL: "🇧🇷", KRW: "🇰🇷", MXN: "🇲🇽",
  SEK: "🇸🇪", NOK: "🇳🇴", DKK: "🇩🇰", PLN: "🇵🇱", CZK: "🇨🇿", HUF: "🇭🇺",
  RON: "🇷🇴", BGN: "🇧🇬", HRK: "🇭🇷", TRY: "🇹🇷", RUB: "🇷🇺", ZAR: "🇿🇦",
  NZD: "🇳🇿", SGD: "🇸🇬", HKD: "🇭🇰", TWD: "🇹🇼", THB: "🇹🇭", IDR: "🇮🇩",
  MYR: "🇲🇾", PHP: "🇵🇭", ARS: "🇦🇷", CLP: "🇨🇱", COP: "🇨🇴", PEN: "🇵🇪",
  BTC: "₿", ETH: "💎",
};

/** Currency codes offered by the base_currency selector (in display order). */
export const BASE_CURRENCY_CODES = Object.keys(CURRENCY_FLAGS);

/** Flag emoji for a currency code, or "" — mirrors i18n.currency_flag(). */
export function currencyFlag(code: string): string {
  return CURRENCY_FLAGS[code] ?? "";
}

/** Signed amount with explicit + / − prefix, for movement rows. */
export function formatSigned(
  amount: number,
  currency: string,
  locale?: string,
): string {
  const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return sign + formatMoney(Math.abs(amount), currency, locale);
}
