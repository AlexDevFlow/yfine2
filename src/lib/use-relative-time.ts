import { useTranslation } from "react-i18next";
import { relativeTime, type RelativeTimeStrings } from "@/lib/date";

/**
 * Returns a memo-friendly `(ts) => label` relative-time formatter wired to the
 * active locale's time_* strings, with the legacy fallbacks as defaults.
 */
export function useRelativeTime(): (ts: string | null | undefined) => string {
  const { t, i18n } = useTranslation();
  const strings: RelativeTimeStrings = {
    just_now: t("time_just_now", { defaultValue: "Just now" }),
    minutes_ago: t("time_minutes_ago", { defaultValue: "{{n}}m ago" }),
    hours_ago: t("time_hours_ago", { defaultValue: "{{n}}h ago" }),
    yesterday: t("time_yesterday", { defaultValue: "Yesterday" }),
    days_ago: t("time_days_ago", { defaultValue: "{{n}}d ago" }),
  };
  const locale = i18n.resolvedLanguage;
  return (ts) => relativeTime(ts, strings, new Date(), locale);
}
