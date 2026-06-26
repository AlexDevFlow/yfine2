/**
 * Shared input validators, ported from the original schemas/validators.py.
 * Repos throw DomainError so the UI can localize; keep these pure of i18n.
 */
import { DomainError } from "@/db/errors";

// ISO-4217 allow-list (the common subset the app supports), mirroring
// schemas/validators.py:VALID_CURRENCY_CODES. A code outside this set would
// silently never match a real source, so reject it up front.
export const VALID_CURRENCY_CODES = new Set([
  "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "CNY", "INR", "BRL",
  "KRW", "MXN", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN",
  "HRK", "TRY", "RUB", "ZAR", "NZD", "SGD", "HKD", "TWD", "THB", "IDR",
  "MYR", "PHP", "ARS", "CLP", "COP", "PEN", "BTC", "ETH", "AED", "SAR",
  "EGP", "NGN", "KES", "GHS", "MAD", "TND", "ILS", "UAH", "ISK", "GEL",
]);

export const MAX_CURRENCY_LENGTH = 5;
export const MAX_NAME_LENGTH = 200;

/** Normalize + validate a currency code (2-5 chars, in the ISO-4217 allow-list). */
export function validateCurrency(raw: string): string {
  const v = (raw ?? "").trim().toUpperCase();
  if (v.length < 2 || v.length > MAX_CURRENCY_LENGTH || !VALID_CURRENCY_CODES.has(v)) {
    throw new DomainError("invalid_currency");
  }
  return v;
}

/** Trim + validate a name (non-empty, <= 200 chars). */
export function validateName(raw: string): string {
  const v = (raw ?? "").trim();
  if (!v) throw new DomainError("invalid_name");
  if (v.length > MAX_NAME_LENGTH) throw new DomainError("invalid_name");
  return v;
}
