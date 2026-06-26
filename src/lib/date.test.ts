import { describe, it, expect } from "vitest";
import { formatDate, relativeTime, type RelativeTimeStrings } from "./date";

const S: RelativeTimeStrings = {
  just_now: "Just now",
  minutes_ago: "{n}m ago",
  hours_ago: "{n}h ago",
  yesterday: "Yesterday",
  days_ago: "{n}d ago",
};

const NOW = new Date("2026-06-17T12:00:00Z");
/** ISO `ms` milliseconds before NOW. */
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("relativeTime", () => {
  it("returns just-now under a minute", () => {
    expect(relativeTime(ago(0), S, NOW)).toBe("Just now");
    expect(relativeTime(ago(59_000), S, NOW)).toBe("Just now");
  });

  it("returns minutes for 1–59 minutes, interpolating {n}", () => {
    expect(relativeTime(ago(MIN), S, NOW)).toBe("1m ago");
    expect(relativeTime(ago(2 * MIN), S, NOW)).toBe("2m ago");
    expect(relativeTime(ago(59 * MIN), S, NOW)).toBe("59m ago");
  });

  it("interpolates the i18next double-brace {{n}} form (real locale strings)", () => {
    // The locale files + useRelativeTime defaults use "{{n}}m ago"; a single-brace
    // replace produced the literal "{5}m ago". Both forms must fill correctly.
    const dbl: RelativeTimeStrings = { ...S, minutes_ago: "{{n}}m ago", hours_ago: "hace {{n}}h" };
    expect(relativeTime(ago(5 * MIN), dbl, NOW)).toBe("5m ago");
    expect(relativeTime(ago(3 * HOUR), dbl, NOW)).toBe("hace 3h");
  });

  it("returns hours for 1–23 hours", () => {
    expect(relativeTime(ago(HOUR), S, NOW)).toBe("1h ago");
    expect(relativeTime(ago(2 * HOUR), S, NOW)).toBe("2h ago");
    expect(relativeTime(ago(23 * HOUR), S, NOW)).toBe("23h ago");
  });

  it("returns yesterday at exactly one day", () => {
    expect(relativeTime(ago(DAY), S, NOW)).toBe("Yesterday");
    expect(relativeTime(ago(DAY + 5 * HOUR), S, NOW)).toBe("Yesterday");
  });

  it("returns days for 2–29 days", () => {
    expect(relativeTime(ago(2 * DAY), S, NOW)).toBe("2d ago");
    expect(relativeTime(ago(29 * DAY), S, NOW)).toBe("29d ago");
  });

  it("falls back to absolute date at 30+ days", () => {
    const out = relativeTime(ago(30 * DAY), S, NOW, "en-US");
    expect(out).not.toMatch(/ago|Yesterday|Just/);
    // 2026-06-17 minus 30 days = 2026-05-18
    expect(out).toContain("2026");
  });

  it("falls back to absolute date for future timestamps", () => {
    const future = new Date(NOW.getTime() + DAY).toISOString();
    const out = relativeTime(future, S, NOW, "en-US");
    expect(out).not.toMatch(/ago|Yesterday|Just/);
    expect(out).toContain("2026");
  });

  it("returns empty string for null/empty/invalid input", () => {
    expect(relativeTime(null, S, NOW)).toBe("");
    expect(relativeTime(undefined, S, NOW)).toBe("");
    expect(relativeTime("", S, NOW)).toBe("");
    expect(relativeTime("not-a-date", S, NOW)).toBe("");
  });
});

describe("formatDate", () => {
  const ISO = "2026-12-31";

  it("renders dd/mm/yyyy (zero-padded, locale-independent)", () => {
    expect(formatDate(ISO, "dd/mm/yyyy")).toBe("31/12/2026");
    expect(formatDate(ISO, "dd/mm/yyyy", "en-US")).toBe("31/12/2026");
    expect(formatDate("2026-01-05", "dd/mm/yyyy")).toBe("05/01/2026");
  });

  it("renders mm/dd/yyyy", () => {
    expect(formatDate(ISO, "mm/dd/yyyy")).toBe("12/31/2026");
    expect(formatDate("2026-01-05", "mm/dd/yyyy")).toBe("01/05/2026");
  });

  it("renders yyyy-mm-dd", () => {
    expect(formatDate(ISO, "yyyy-mm-dd")).toBe("2026-12-31");
    expect(formatDate("2026-01-05", "yyyy-mm-dd")).toBe("2026-01-05");
  });

  it("accepts a full ISO timestamp and uses just the date part", () => {
    expect(formatDate("2026-12-31T08:30:00Z", "yyyy-mm-dd")).toBe("2026-12-31");
    expect(formatDate("2026-12-31T08:30:00Z", "mm/dd/yyyy")).toBe("12/31/2026");
  });

  it("falls back to the locale-aware day label for unknown/empty format", () => {
    const out = formatDate(ISO, undefined, "en-US");
    // dayLabel("2026-12-31","en-US") → "Thu, Dec 31"; just assert it is NOT numeric-only.
    expect(out).toMatch(/Dec|31/);
    expect(out).not.toBe("31/12/2026");
    expect(formatDate(ISO, "", "en-US")).toBe(out);
    expect(formatDate(ISO, "bogus", "en-US")).toBe(out);
  });

  it("returns empty string for null/undefined and verbatim for unparseable", () => {
    expect(formatDate(null, "dd/mm/yyyy")).toBe("");
    expect(formatDate(undefined, "dd/mm/yyyy")).toBe("");
    expect(formatDate("", "dd/mm/yyyy")).toBe("");
    expect(formatDate("not-a-date", "dd/mm/yyyy")).toBe("not-a-date");
  });
});
