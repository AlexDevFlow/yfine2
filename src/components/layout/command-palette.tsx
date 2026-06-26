import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  CornerDownLeft,
  PieChart,
  PiggyBank,
  Repeat,
  Search,
  Sparkles,
  Tag,
  Target,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearch } from "@/db/queries";
import {
  buildSearchTarget,
  SEARCH_GROUP_ORDER,
  type SearchItem,
  type SearchType,
} from "@/db/repo/search";
import { cn } from "@/lib/cn";
import { ALL_NAV } from "./nav";

type Scope = "all" | "page" | SearchType;

const TYPE_ICON: Record<SearchType, LucideIcon> = {
  movement: ArrowLeftRight,
  source: Wallet,
  tag: Tag,
  saving: PiggyBank,
  whim: Sparkles,
  recurring: Repeat,
  goal: Target,
  budget: PieChart,
  portfolio: TrendingUp,
};

interface Row {
  key: string;
  scope: Scope;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** Rich entity context (search results only). */
  item?: SearchItem;
}

/** Split a label so the matched substring can be wrapped in <mark>. */
function highlightParts(label: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text: label, match: false }];
  const lower = label.toLowerCase();
  const needle = q.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let i = 0;
  while (i < label.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      parts.push({ text: label.slice(i), match: false });
      break;
    }
    if (idx > i) parts.push({ text: label.slice(i, idx), match: false });
    parts.push({ text: label.slice(idx, idx + needle.length), match: true });
    i = idx + needle.length;
  }
  return parts.length ? parts : [{ text: label, match: false }];
}

function Highlighted({ label, query }: { label: string; query: string }) {
  return (
    <>
      {highlightParts(label, query).map((p, i) =>
        p.match ? (
          <mark key={i} className="bg-transparent font-semibold text-primary">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Per-type context line (amount/date/source/tags/status/frequency). */
function EntityContext({ item }: { item: SearchItem }) {
  const { t } = useTranslation();
  const fmtAmt = (n: number, ccy?: string) => `${n.toFixed(2)}${ccy ? " " + ccy : ""}`;
  if (item.type === "movement") {
    const sign = item.is_transfer ? "" : item.direction === "in" ? "+" : "−";
    return (
      <span className="flex items-center gap-1.5">
        <span className={cn("num", item.is_transfer ? "text-muted" : item.direction === "in" ? "text-positive" : "text-negative")}>
          {sign}
          {fmtAmt(item.amount ?? 0, item.currency)}
        </span>
        <span className="text-muted-2">· {item.source ?? t("external", { defaultValue: "External" })} · {item.date}</span>
        {item.tags?.slice(0, 3).map((tag) => (
          <span key={tag.id} className="inline-flex items-center gap-0.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: tag.color ?? "var(--muted-2)" }} />
            {tag.name}
          </span>
        ))}
      </span>
    );
  }
  if (item.type === "source") return <span className="text-muted-2">{item.currency}</span>;
  if (item.type === "saving")
    return <span className="num text-positive">+{fmtAmt(item.amount ?? 0, item.currency)} <span className="text-muted-2">· {item.date}</span></span>;
  if (item.type === "tag") return <span className="text-muted-2">{t("usage_count", { defaultValue: "{{n}} uses", n: item.count ?? 0 })}</span>;
  if (item.type === "whim")
    return <span className="num text-muted-2">{fmtAmt(item.amount ?? 0, item.currency)} · {t(`whim_status_${item.status}`, { defaultValue: item.status ?? "" })}</span>;
  if (item.type === "recurring")
    return (
      <span className="num text-muted-2">
        {item.direction === "in" ? "+" : "−"}{fmtAmt(item.amount ?? 0, item.currency)} · {t(`freq_${item.frequency}`, { defaultValue: item.frequency ?? "" })}
        {item.next_due_date ? ` · ${item.next_due_date}` : ""}
      </span>
    );
  if (item.type === "budget")
    return (
      <span className="num text-muted-2">
        {fmtAmt(item.amount ?? 0, item.currency)} · {t(`period_${item.period}`, { defaultValue: item.period ?? "" })}
      </span>
    );
  if (item.type === "portfolio")
    return <span className="text-muted-2">{t(`portfolio_kind_${item.kind}`, { defaultValue: item.kind ?? "" })}{item.currency ? ` · ${item.currency}` : ""}</span>;
  return null;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const [scope, setScope] = useState<Scope>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  // 220ms debounce (matches legacy)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 220);
    return () => window.clearTimeout(id);
  }, [query]);

  const search = useSearch(debounced);

  useEffect(() => {
    if (open) {
      setQuery("");
      setDebounced("");
      setActive(0);
      setScope("all");
      const id = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const go = (target: { to: string; search?: Record<string, unknown> }) => {
    onClose();
    void navigate(target as Parameters<typeof navigate>[0]);
  };

  // Build grouped rows: pages first, then entity groups in GROUP_ORDER.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pageRows: Row[] = ALL_NAV.map((i) => ({ ...i, name: t(i.key, { defaultValue: i.label }) }))
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .map<Row>((i) => ({
        key: `page:${i.to}`,
        scope: "page",
        label: i.name,
        icon: i.icon,
        onSelect: () => go({ to: i.to }),
      }));

    const byType = new Map<SearchType, Row[]>();
    for (const r of search.data ?? []) {
      const arr = byType.get(r.type) ?? [];
      arr.push({
        key: `${r.type}:${r.id}`,
        scope: r.type,
        label: r.label,
        icon: TYPE_ICON[r.type],
        onSelect: () => go(buildSearchTarget(r)),
        item: r,
      });
      byType.set(r.type, arr);
    }

    const out: { scope: Scope; titleKey: string; titleDefault: string; rows: Row[] }[] = [];
    if (pageRows.length) out.push({ scope: "page", titleKey: "pages", titleDefault: "Pages", rows: pageRows });
    for (const type of SEARCH_GROUP_ORDER) {
      const rows = byType.get(type);
      if (rows?.length) out.push({ scope: type, titleKey: type, titleDefault: type, rows });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, search.data, t]);

  // Available scopes (chips): all + every present group.
  const scopes = useMemo<Scope[]>(() => ["all", ...groups.map((g) => g.scope)], [groups]);

  // Visible groups after applying the active scope chip.
  const visibleGroups = useMemo(
    () => (scope === "all" ? groups : groups.filter((g) => g.scope === scope)),
    [groups, scope],
  );

  // Flat list (scope-filtered) for keyboard nav / selection.
  const flat = useMemo<Row[]>(() => visibleGroups.flatMap((g) => g.rows), [visibleGroups]);

  // Reset the highlight to the top whenever the result set changes (not just its
  // length): a refined query can yield a different list of the same length, and a
  // length-only clamp would leave `active` pointing at an unrelated row — so Enter
  // would fire the wrong entity.
  useEffect(() => {
    setActive(0);
  }, [flat]);

  // Keep scope valid as result groups change.
  useEffect(() => {
    if (!scopes.includes(scope)) setScope("all");
  }, [scopes, scope]);

  if (!open) return null;

  const cycleScope = (dir: 1 | -1) => {
    const i = scopes.indexOf(scope);
    const next = (i + dir + scopes.length) % scopes.length;
    setScope(scopes[next]);
    setActive(0);
  };

  return (
    <div
      className="yn-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="yn-slide-down w-full max-w-lg overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-pop)]"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Tab") {
            e.preventDefault();
            cycleScope(e.shiftKey ? -1 : 1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % Math.max(1, flat.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + flat.length) % Math.max(1, flat.length));
          } else if (e.key === "Enter" && flat[active]) {
            e.preventDefault();
            flat[active].onSelect();
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search", { defaultValue: "Search" }) + "…"}
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-2"
          />
        </div>

        {scopes.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            {scopes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setScope(s);
                  setActive(0);
                }}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                  scope === s ? "bg-accent-soft text-primary" : "text-muted hover:text-foreground",
                )}
              >
                {s === "all"
                  ? t("all", { defaultValue: "All" })
                  : s === "page"
                    ? t("pages", { defaultValue: "Pages" })
                    : t(s, { defaultValue: s })}
              </button>
            ))}
            <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-2 sm:flex">
              <kbd className="rounded border border-border px-1">Tab</kbd>
              {t("to_filter", { defaultValue: "to filter" })}
            </span>
          </div>
        )}

        <ul className="max-h-[340px] overflow-y-auto p-2">
          {flat.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted">
              {t("no_results", { defaultValue: "No results" })}
            </li>
          ) : (
            visibleGroups.map((g) => {
              let flatIndexBase = 0;
              for (const vg of visibleGroups) {
                if (vg === g) break;
                flatIndexBase += vg.rows.length;
              }
              return (
                <li key={g.scope}>
                  <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-2">
                    {g.scope === "page" ? t("pages", { defaultValue: "Pages" }) : t(g.titleKey, { defaultValue: g.titleDefault })}
                    <span className="ml-1 text-muted-2/70">({g.rows.length})</span>
                  </p>
                  <ul>
                    {g.rows.map((row, ri) => {
                      const i = flatIndexBase + ri;
                      const Icon = row.icon;
                      return (
                        <li key={row.key}>
                          <button
                            type="button"
                            onMouseEnter={() => setActive(i)}
                            onClick={row.onSelect}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-left text-sm",
                              i === active ? "bg-accent-soft text-primary" : "text-foreground",
                            )}
                          >
                            <Icon className="h-[18px] w-[18px] shrink-0 text-muted" />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate">
                                <Highlighted label={row.label} query={query} />
                              </span>
                              {row.item && (
                                <span className="truncate text-xs text-muted">
                                  <EntityContext item={row.item} />
                                </span>
                              )}
                            </span>
                            {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-2" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
