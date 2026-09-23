import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bookmark, CalendarDays, Check, ChevronDown, ChevronRight, EyeOff, Hash, Layers, ListChecks, Paperclip, Pencil, PieChart, Plus, Repeat, Scale, Search, SlidersHorizontal, Tag as TagIcon, Trash2, X, Zap } from "lucide-react";
import { getRouteApi } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { MoneyInput, evalMoneyExpr } from "@/components/ui/money-input";
import { Modal } from "@/components/ui/modal";
import { SplitForm } from "@/components/split-form";
import { BreakdownModal } from "@/components/breakdown-panel";
import { MovementsCalendar } from "./movements-calendar";
import { AttachmentsModal } from "./movements-attachments";
import { isPreviewDb } from "@/db/connection";
import { isTauri } from "@/lib/tauri";
import {
  useAttachmentCounts,
  useBulkDelete,
  useBulkSetExclude,
  useBulkSetSource,
  useBulkSetTags,
  useCreateMovement,
  useCreateSplit,
  useCreateTransfer,
  useDeleteMovement,
  useMakeRecurring,
  useMovements,
  useMovementSums,
  useMovementTemplates,
  usePreferences,
  useSaveSavedViews,
  useSavedViews,
  useSaveTemplates,
  useSources,
  useTags,
  useToggleExclude,
  useUpdatePreferences,
  useUpdateMovement,
  useUpdateTransfer,
} from "@/db/queries";
import type { EnrichedMovement, MovementFilters } from "@/db/repo/movements";
import type { MovementTemplate, SavedView } from "@/db/repo/movement-templates";
import type { NewSplit } from "@/db/repo/splits";
import { groupMovementsHierarchically } from "@/domain/grouping";
import { cn } from "@/lib/cn";
import { formatDate, monthLabel, todayISO } from "@/lib/date";
import { formatMoney, formatSigned } from "@/lib/format";
import { useErrorText } from "@/lib/use-error-text";
import {
  MovementForm,
  TransferForm,
  type MovementFormValues,
  type TransferFormValues,
} from "./movements-forms";

const movementsRouteApi = getRouteApi("/movements");

function isTransfer(m: EnrichedMovement) {
  return m.transfer_pair_id != null;
}

/** One readable, info-complete line for a movement — used when copying a selection. */
function formatMovementLine(m: EnrichedMovement, locale?: string, dateFmt?: string | null): string {
  const transfer = isTransfer(m);
  const ccy = m.source_currency ?? "";
  const date = formatDate(m.date, dateFmt, locale);
  const amount = ccy
    ? transfer
      ? formatMoney(m.amount, ccy, locale)
      : formatSigned(m.direction === "in" ? m.amount : -m.amount, ccy, locale)
    : m.amount.toFixed(2);
  const note = m.note || (transfer ? "Transfer" : "");
  const where = transfer
    ? `${m.source_name ?? "?"} → ${m.partner_source_name ?? "?"}`
    : m.source_name ?? "External";
  const tags = m.tags.length ? `  #${m.tags.map((t) => t.name).join(" #")}` : "";
  return [date, amount, note, where].filter(Boolean).join("  ·  ") + tags;
}


/**
 * Net-balance badge: `+X.XX (+Y.Y%)`, where Y% = net / totalIn × 100 (guarded
 * against div-by-zero). Mirrors the original's per-period rollup badge.
 */
function NetBadge({ totalIn, totalOut }: { totalIn: number; totalOut: number }) {
  const net = Math.round((totalIn - totalOut) * 100) / 100;
  const pct = totalIn === 0 ? null : Math.round((net / totalIn) * 1000) / 10;
  const sign = net > 0 ? "+" : net < 0 ? "−" : "";
  return (
    <span className={cn("num font-semibold", net > 0 ? "text-positive" : net < 0 ? "text-negative" : "text-muted")}>
      {sign}{Math.abs(net).toFixed(2)}
      {pct != null && <span className="ml-0.5 font-normal opacity-80">({net >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(1)}%)</span>}
    </span>
  );
}

/**
 * KPI summary band: income / expense / net / count across ALL rows matching the
 * active filters (via useMovementSums — not just the current page). Amounts use
 * the base currency when one is set, else a plain figure (mixed-currency safe,
 * matching how the period rollup badges already render raw sums).
 */
function SummaryBand({
  totalIn,
  totalOut,
  count,
  avg,
  ccy,
  locale,
  activeDir,
  onPick,
  onBreakdown,
}: {
  totalIn: number;
  totalOut: number;
  count: number;
  avg: number;
  ccy?: string;
  locale?: string;
  /** Current direction filter ("" = all) — drives the active card highlight. */
  activeDir: string;
  /** Click a card to filter the list by that direction ("" clears it). */
  onPick: (dir: string) => void;
  /** Open the breakdown for a direction (the little chart button on each card). */
  onBreakdown: (dir: "in" | "out") => void;
}) {
  const { t } = useTranslation();
  const net = Math.round((totalIn - totalOut) * 100) / 100;
  const pct = totalIn === 0 ? null : Math.round((net / totalIn) * 1000) / 10;
  const money = (n: number) => (ccy ? formatMoney(n, ccy, locale) : n.toFixed(2));
  const signed = (n: number) => (ccy ? formatSigned(n, ccy, locale) : (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2));

  const cards = [
    {
      key: "in",
      label: t("income", { defaultValue: "Income" }),
      icon: <ArrowUpRight className="h-3.5 w-3.5" />,
      tone: "in" as const,
      dir: "in",
      analyse: "in" as const,
      hint: t("filter_income_hint", { defaultValue: "Show only income" }),
      value: <span className="text-positive">+{money(totalIn)}</span>,
    },
    {
      key: "out",
      label: t("expense", { defaultValue: "Expense" }),
      icon: <ArrowDownLeft className="h-3.5 w-3.5" />,
      tone: "out" as const,
      dir: "out",
      analyse: "out" as const,
      hint: t("filter_expense_hint", { defaultValue: "Show only expenses" }),
      value: <span className="text-negative">−{money(totalOut)}</span>,
    },
    {
      key: "net",
      label: t("net", { defaultValue: "Net" }),
      icon: <Scale className="h-3.5 w-3.5" />,
      tone: "net" as const,
      dir: "",
      analyse: "out" as const,
      hint: t("filter_all_hint", { defaultValue: "Show all directions" }),
      value: <span className={net > 0 ? "text-positive" : net < 0 ? "text-negative" : "text-foreground"}>{signed(net)}</span>,
      sub: pct != null ? (
        <span className={net >= 0 ? "text-positive" : "text-negative"}>
          {net >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(1)}% {t("of_income", { defaultValue: "of income" })}
        </span>
      ) : null,
    },
    {
      key: "count",
      label: t("movements", { defaultValue: "Movements" }),
      icon: <Hash className="h-3.5 w-3.5" />,
      tone: "count" as const,
      dir: "",
      analyse: "out" as const,
      hint: t("filter_all_hint", { defaultValue: "Show all directions" }),
      value: <span className="text-foreground">{count}</span>,
      sub: count > 0 ? <span>{t("avg_per_movement", { defaultValue: "avg {{v}}", v: money(avg) })}</span> : null,
    },
  ];

  const iconTone: Record<string, string> = {
    in: "bg-positive-soft text-positive",
    out: "bg-negative-soft text-negative",
    net: "bg-accent-soft text-primary",
    count: "bg-surface-2 text-muted",
  };

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => {
        // A card is "active" when it represents the current direction filter.
        // The Net/Movements cards (dir "") only count as active when no filter is set.
        const active = c.dir !== "" ? activeDir === c.dir : activeDir === "";
        return (
          <Card
            key={c.key}
            role="button"
            tabIndex={0}
            title={c.hint}
            aria-pressed={active}
            onClick={() => onPick(c.dir === activeDir ? "" : c.dir)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(c.dir === activeDir ? "" : c.dir); } }}
            className={cn(
              "relative cursor-pointer select-none p-4 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring hover:shadow-[var(--shadow-pop)]",
              active && "ring-1 ring-primary/50",
            )}
          >
            {/* Analyse this total: charts of where the money went. Stops the
                click from also toggling the card's direction filter. */}
            <button
              type="button"
              title={t("breakdown_hint", { defaultValue: "See where the money went" })}
              aria-label={t("breakdown", { defaultValue: "Breakdown" })}
              onClick={(e) => { e.stopPropagation(); onBreakdown(c.analyse); }}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg text-muted-2 transition-colors hover:bg-surface-2 hover:text-primary"
            >
              <PieChart className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-lg", iconTone[c.tone])}>{c.icon}</span>
              {c.label}
            </div>
            <p className="num mt-2.5 text-2xl font-extrabold tracking-tight">{c.value}</p>
            <p className="num mt-0.5 text-xs text-muted">{c.sub ?? <span>&nbsp;</span>}</p>
          </Card>
        );
      })}
    </div>
  );
}

/** Removable pill summarising one active advanced filter. */
function FilterChip({ children, color, onRemove }: { children: ReactNode; color?: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-accent-soft px-2.5 py-1 text-xs font-medium text-primary">
      {color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />}
      {children}
      <button onClick={onRemove} className="rounded-full opacity-70 hover:opacity-100" aria-label="Remove filter">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// Memoized so unrelated parent re-renders (notably the per-mousemove
// `setSelected` during drag-paint) don't re-render all ~1000 rows. Effective
// only because every prop is referentially stable: the callbacks below are
// id-keyed and wrapped in `useCallback` by the parent (see `rowCallbacks`),
// `m`/`attachCount`/`locale` come straight from query data, and the
// per-row booleans (`selected`/`highlight`) only change for the affected row.
const MovementRow = memo(function MovementRow({
  m,
  locale,
  onEdit,
  onDelete,
  onMakeRecurring,
  onToggleExclude,
  onAttach,
  attachCount,
  selectMode,
  selected,
  onSelectDown,
  onSelectEnter,
  highlight,
}: {
  m: EnrichedMovement;
  locale?: string;
  /** Id-keyed so the parent can pass one stable callback to every row. */
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onMakeRecurring?: (id: number) => void;
  onToggleExclude?: (id: number) => void;
  onAttach?: (id: number) => void;
  attachCount?: number;
  /** Checkbox-selection mode: rows become drag-to-select targets. */
  selectMode?: boolean;
  selected?: boolean;
  /** Press on a row (starts a drag-paint, toggling this row). */
  onSelectDown?: (id: number) => void;
  /** Drag entered this row (paint it with the in-progress selection state). */
  onSelectEnter?: (id: number) => void;
  highlight?: boolean;
}) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlight) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight]);
  // Bind the row's id once so the markup keeps its zero-arg handlers unchanged.
  const id = m.id;
  const handleEdit = useCallback(() => onEdit(id), [onEdit, id]);
  const handleDelete = useCallback(() => onDelete(id), [onDelete, id]);
  const handleMakeRecurring = useCallback(() => onMakeRecurring?.(id), [onMakeRecurring, id]);
  const handleToggleExclude = useCallback(() => onToggleExclude?.(id), [onToggleExclude, id]);
  const handleAttach = useCallback(() => onAttach?.(id), [onAttach, id]);
  const handleSelectDown = useCallback(() => onSelectDown?.(id), [onSelectDown, id]);
  const handleSelectEnter = useCallback(() => onSelectEnter?.(id), [onSelectEnter, id]);
  const transfer = isTransfer(m);
  const excluded = m.exclude_from_stats === 1;
  const sourceLabel = m.source_name ?? (m.source_id == null ? t("external", { defaultValue: "External" }) : t("deleted", { defaultValue: "Deleted" }));
  const ccy = m.source_currency;
  const amountText = ccy
    ? transfer
      ? formatMoney(m.amount, ccy, locale)
      : formatSigned(m.direction === "in" ? m.amount : -m.amount, ccy, locale)
    : m.amount.toFixed(2);

  return (
    <li
      ref={rowRef}
      data-mv-id={m.id}
      onMouseDown={selectMode ? handleSelectDown : undefined}
      onMouseEnter={selectMode ? handleSelectEnter : undefined}
      className={cn(
        // Rows are never text-selectable (avoids the ugly native highlight);
        // selection is done with the checkboxes / drag-paint instead.
        "group flex select-none items-center justify-between gap-3 rounded-[var(--radius-control)] py-2.5 transition-colors",
        selectMode && "-mx-2 cursor-pointer px-2",
        selected && "bg-accent-soft",
        highlight && "-mx-2 bg-accent-soft px-2 ring-1 ring-primary/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {selectMode && (
          <input type="checkbox" checked={!!selected} readOnly tabIndex={-1} className="pointer-events-none h-4 w-4 shrink-0" aria-label={t("select", { defaultValue: "Select" })} />
        )}
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
            transfer ? "bg-surface-2 text-muted" : m.direction === "in" ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative",
          )}
        >
          {transfer ? <ArrowLeftRight className="h-4 w-4" /> : m.direction === "in" ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownLeft className="h-4 w-4" />}
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
            <span className="truncate">{m.note || (transfer ? t("transfer", { defaultValue: "Transfer" }) : sourceLabel)}</span>
            {excluded && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted" title={t("exclude_from_stats", { defaultValue: "Exclude from stats" })}>
                <EyeOff className="h-3 w-3" /> {t("excluded", { defaultValue: "Excluded" })}
              </span>
            )}
          </p>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="shrink-0 truncate">{transfer ? `${sourceLabel} → ${m.partner_source_name ?? "?"}` : sourceLabel}</span>
            {m.tags.map((tag) => (
              <span key={tag.id} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: tag.color ?? "var(--muted-2)" }} />
                {tag.name}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1" onMouseDown={selectMode ? (e) => e.stopPropagation() : undefined}>
        <span className={cn("num mr-1 text-sm font-semibold", transfer ? "text-muted" : m.direction === "in" ? "text-positive" : "text-foreground")}>
          {amountText}
        </span>
        {onAttach && (
          <button onClick={handleAttach} aria-label={t("attachments", { defaultValue: "Attachments" })} className={cn("relative rounded-md p-1.5 transition-opacity hover:bg-surface-2 hover:text-foreground", attachCount ? "text-primary opacity-100" : "text-muted opacity-0 group-hover:opacity-100")}>
            <Paperclip className="h-4 w-4" />
            {!!attachCount && <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[9px] text-primary-foreground">{attachCount}</span>}
          </button>
        )}
        {onToggleExclude && (
          <button onClick={handleToggleExclude} aria-label={t("exclude_from_stats", { defaultValue: "Exclude from stats" })} className={cn("rounded-md p-1.5 transition-opacity hover:bg-surface-2 hover:text-foreground", excluded ? "text-primary opacity-100" : "text-muted opacity-0 group-hover:opacity-100")}>
            <EyeOff className="h-4 w-4" />
          </button>
        )}
        {onMakeRecurring && !transfer && (
          <button onClick={handleMakeRecurring} aria-label={t("make_recurring", { defaultValue: "Make recurring" })} className="rounded-md p-1.5 text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-foreground group-hover:opacity-100">
            <Repeat className="h-4 w-4" />
          </button>
        )}
        <button onClick={handleEdit} aria-label={t("edit", { defaultValue: "Edit" })} className="rounded-md p-1.5 text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-foreground group-hover:opacity-100">
          <Pencil className="h-4 w-4" />
        </button>
        <button onClick={handleDelete} aria-label={t("delete", { defaultValue: "Delete" })} className="rounded-md p-1.5 text-muted opacity-0 transition-opacity hover:bg-negative-soft hover:text-negative group-hover:opacity-100">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
});

export function MovementsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const errText = useErrorText();
  // Deep-link search params: ?tagIds= (budget card), ?direction=&dateFrom=
  // (dashboard month modal), ?focus= (global search scroll-and-highlight).
  const { tagIds: initialTagIds, direction: initialDir, dateFrom: initialDateFrom, dateTo: initialDateTo, focus: focusId, create: createParam, source_id: createSourceId } = movementsRouteApi.useSearch();
  const navigate = movementsRouteApi.useNavigate();

  const [q, setQ] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [filterDir, setFilterDir] = useState(initialDir ?? "");
  const [showFilters, setShowFilters] = useState(!!initialDateFrom);
  const [dateFrom, setDateFrom] = useState(initialDateFrom ?? "");
  const [dateTo, setDateTo] = useState(initialDateTo ?? "");
  const [amtMin, setAmtMin] = useState("");
  const [amtMax, setAmtMax] = useState("");
  const [filterTagIds, setFilterTagIds] = useState<number[]>(initialTagIds ?? []);
  const [tagMatch, setTagMatch] = useState<"or" | "and">("or");
  // Which direction the breakdown dialog is analysing (null = closed).
  const [breakdownDir, setBreakdownDir] = useState<"in" | "out" | null>(null);
  // The list is grouped by year/month/day, which only reads correctly when the
  // whole filtered set is loaded (otherwise per-period rollups reflect a single
  // page and disagree with the KPI cards). So we load everything up to a generous
  // cap instead of paginating; past the cap a note nudges the user to filter.
  const LOAD_CAP = 1000;

  // Advanced = date + amount (tags now live in the always-visible quick-filter strip).
  const advancedCount =
    (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (amtMin ? 1 : 0) + (amtMax ? 1 : 0);
  const clearAdvanced = () => {
    setDateFrom(""); setDateTo(""); setAmtMin(""); setAmtMax("");
  };

  const filters = useMemo<MovementFilters>(
    () => ({
      excludeTransferIn: true,
      q: q.trim() || undefined,
      sourceId: filterSource === "" ? undefined : Number(filterSource),
      direction: (filterDir || undefined) as "in" | "out" | undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      amountMin: amtMin ? Number(amtMin) : undefined,
      amountMax: amtMax ? Number(amtMax) : undefined,
      tagIds: filterTagIds.length ? filterTagIds : undefined,
      tagMatch,
    }),
    [q, filterSource, filterDir, dateFrom, dateTo, amtMin, amtMax, filterTagIds, tagMatch],
  );

  const { data, isLoading, error } = useMovements(filters, LOAD_CAP, 0);
  // The KPI band is a stable overview of the scope (source/date/amount/tags). It
  // ignores BOTH the free-text search AND the direction filter, so typing in the
  // search box or clicking the Income/Expense card only narrows the list below —
  // the totals never jump or zero out the other cards.
  const sumsFilters = useMemo<MovementFilters>(
    () => ({ ...filters, q: undefined, direction: undefined }),
    [filters],
  );
  const { data: sums } = useMovementSums(sumsFilters);
  const { data: sources } = useSources();
  const { data: tags } = useTags();
  const { data: prefs } = usePreferences();
  const { data: templates } = useMovementTemplates();
  const { data: savedViews } = useSavedViews();
  // Transfers must NOT target savings funds (they have a dedicated save/withdraw
  // flow that maintains fund invariants). The old `|| true` made this a no-op.
  const realSources = useMemo(() => (sources ?? []).filter((s) => s.is_savings_fund === 0), [sources]);

  const createMovement = useCreateMovement();
  const makeRecurring = useMakeRecurring();
  const updateMovement = useUpdateMovement();
  const createTransfer = useCreateTransfer();
  const updateTransfer = useUpdateTransfer();
  const del = useDeleteMovement();
  const toggleExclude = useToggleExclude();
  const bulkExclude = useBulkSetExclude();
  const saveTemplates = useSaveTemplates();
  const saveViews = useSaveSavedViews();
  const updatePrefs = useUpdatePreferences();

  const total = data?.total ?? 0;
  const loaded = data?.items.length ?? 0;
  const truncated = total > loaded;

  /** Persist the last-used source after a successful create/transfer (new entries only). */
  const rememberSource = (sourceId: number | null) => {
    if (sourceId != null && prefs && prefs.last_source_id !== sourceId) {
      updatePrefs.mutate({ last_source_id: sourceId });
    }
  };

  const [mvModal, setMvModal] = useState<{ open: boolean; editing?: EnrichedMovement; prefill?: MovementFormValues }>({ open: false });
  const [trModal, setTrModal] = useState<{ open: boolean; editing?: EnrichedMovement }>({ open: false });

  // Dashboard quick action: open the create form when ?create=… arrives, then
  // strip the param so clicking the same action again re-triggers it.
  useEffect(() => {
    if (!createParam) return;
    // On a cold navigation sources may not have resolved yet — deciding the
    // transfer guard (or stripping the param) before they load would silently
    // drop the deep link. Wait for the query; the effect re-runs on data.
    if (createParam === "transfer" && sources === undefined) return;
    setFormError(undefined); // don't carry a stale error from a previous form
    if (createParam === "movement") {
      // The sources page "+" action deep-links a source to pre-select.
      const prefill: MovementFormValues | undefined =
        createSourceId != null
          ? { source_id: createSourceId, amount: 0, direction: "out", date: todayISO(), note: "", tagIds: [] }
          : undefined;
      setMvModal({ open: true, prefill });
    } else if (createParam === "transfer" && realSources.length >= 2) {
      // Same guard as the toolbar Transfer button — fewer than 2 real sources
      // makes the transfer modal unusable.
      setTrModal({ open: true });
    }
    void navigate({ to: "/movements", search: (prev) => ({ ...prev, create: undefined, source_id: undefined }), replace: true });
  }, [createParam, createSourceId, navigate, realSources, sources]);
  const [deleting, setDeleting] = useState<EnrichedMovement>();
  const [recurringFrom, setRecurringFrom] = useState<EnrichedMovement>();
  const [recFreq, setRecFreq] = useState("monthly");
  const [recApplyMode, setRecApplyMode] = useState<"auto" | "confirm">("confirm");
  const [attachFor, setAttachFor] = useState<EnrichedMovement>();
  // Quick-add / saved-view / manage menus + modals.
  const [quickMenu, setQuickMenu] = useState(false);
  const [viewsMenu, setViewsMenu] = useState(false);
  const [tagMenu, setTagMenu] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  const [manageTemplatesOpen, setManageTemplatesOpen] = useState(false);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [tplDraft, setTplDraft] = useState<MovementTemplate>({ name: "", direction: "out", source_id: null, amount: null, tag_ids: [], note: null });
  const tauri = isTauri();
  const { data: attachCounts } = useAttachmentCounts();
  const [formError, setFormError] = useState<string>();
  const [splitOpen, setSplitOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkMoveTo, setBulkMoveTo] = useState("");
  const createSplit = useCreateSplit();
  const bulkDelete = useBulkDelete();
  const bulkMove = useBulkSetSource();
  const bulkSetTags = useBulkSetTags();
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagIds, setBulkTagIds] = useState<number[]>([]);
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove" | "replace">("add");
  const toggleBulkTag = (id: number) =>
    setBulkTagIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const clearSel = () => setSelected(new Set());

  // Drag-to-paint selection (in select mode): press a row to start, drag over
  // others to extend. The first row's current state decides whether the drag
  // selects or deselects, so dragging back over a row undoes it.
  const dragRef = useRef<{ active: boolean; selecting: boolean }>({ active: false, selecting: true });
  // Stable so the memoized rows don't re-render every time `selected` changes
  // (each mousemove). The press direction is decided from the latest set inside
  // the functional updater, then mirrored onto dragRef for the drag to read.
  const beginDrag = useCallback((id: number) => {
    setSelected((s) => {
      const selecting = !s.has(id);
      dragRef.current = { active: true, selecting };
      const n = new Set(s);
      if (selecting) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);
  const extendDrag = useCallback((id: number) => {
    if (!dragRef.current.active) return;
    const { selecting } = dragRef.current;
    setSelected((s) => {
      if (selecting ? s.has(id) : !s.has(id)) return s; // already in target state
      const n = new Set(s);
      if (selecting) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);
  useEffect(() => {
    const up = () => { dragRef.current.active = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Ctrl/Cmd+C copies the checkbox-selected movements as readable text. Guarded
  // so it never hijacks a genuine text copy (input focus or a real selection).
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (selected.size === 0) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae as HTMLElement).isContentEditable)) return;
      const ws = window.getSelection();
      if (ws && !ws.isCollapsed) return;
      const lines = (data?.items ?? [])
        .filter((m) => selected.has(m.id))
        .map((m) => formatMovementLine(m, locale, prefs?.date_format));
      if (!lines.length) return;
      e.clipboardData?.setData("text/plain", lines.join("\n"));
      e.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, [selected, data, locale, prefs?.date_format]);

  // Prune the bulk selection to currently-visible rows whenever the loaded set
  // changes (filter/search/tag/page). Otherwise a bulk Delete/Move/Exclude/Tag
  // would silently act on rows the user filtered out of view.
  useEffect(() => {
    const items = data?.items;
    if (!items) return;
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(items.map((m) => m.id));
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [data]);

  const submitSplit = (v: NewSplit) => {
    setFormError(undefined);
    createSplit.mutate(v, { onSuccess: () => setSplitOpen(false), onError: (e) => setFormError(errText(e)) });
  };

  const groups = useMemo(() => groupMovementsHierarchically(data?.items ?? []), [data]);

  // Collapsible month/day groups (like the original). Keys are collapsed; default open.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const openEdit = (m: EnrichedMovement) => {
    setFormError(undefined);
    if (isTransfer(m)) setTrModal({ open: true, editing: m });
    else setMvModal({ open: true, editing: m });
  };

  // Stable, id-keyed row handlers so every MovementRow gets referentially
  // constant callbacks (the precondition for React.memo to actually skip
  // re-renders during drag-paint / unrelated parent state changes). The handlers
  // that need the full movement resolve it from a ref to the latest loaded set,
  // so they keep the same identity even as `data` updates.
  const itemsRef = useRef<EnrichedMovement[]>([]);
  itemsRef.current = data?.items ?? [];
  const byId = useCallback((id: number) => itemsRef.current.find((x) => x.id === id), []);
  const rowEdit = useCallback((id: number) => { const m = byId(id); if (m) openEdit(m); }, [byId]);
  const rowDelete = useCallback((id: number) => { const m = byId(id); if (m) setDeleting(m); }, [byId]);
  const rowMakeRecurring = useCallback((id: number) => {
    const m = byId(id);
    if (m) { setRecFreq("monthly"); setRecApplyMode("confirm"); setRecurringFrom(m); }
  }, [byId]);
  // useMutation returns a NEW object every render — depend on the stable
  // `mutate` fn (destructured), or this callback changes identity each render
  // and defeats the row memoization above.
  const { mutate: toggleExcludeMutate } = toggleExclude;
  const rowToggleExclude = useCallback((id: number) => toggleExcludeMutate(id), [toggleExcludeMutate]);
  const rowAttach = useCallback((id: number) => { const m = byId(id); if (m) setAttachFor(m); }, [byId]);

  const submitMovement = (v: MovementFormValues) => {
    setFormError(undefined);
    const onErr = (e: unknown) => setFormError(errText(e));
    if (mvModal.editing) {
      updateMovement.mutate(
        { id: mvModal.editing.id, patch: { source_id: v.source_id, amount: v.amount, direction: v.direction, date: v.date, note: v.note, tagIds: v.tagIds } },
        { onSuccess: () => setMvModal({ open: false }), onError: onErr },
      );
    } else {
      createMovement.mutate(
        { source_id: v.source_id, amount: v.amount, direction: v.direction, date: v.date, note: v.note, tagIds: v.tagIds },
        { onSuccess: () => { rememberSource(v.source_id); setMvModal({ open: false }); }, onError: onErr },
      );
    }
  };

  const submitTransfer = (v: TransferFormValues) => {
    setFormError(undefined);
    const onErr = (e: unknown) => setFormError(errText(e));
    const patch = {
      fromSourceId: v.fromSourceId,
      toSourceId: v.toSourceId,
      amount: v.amount,
      toAmount: v.toAmount,
      date: v.date,
      note: v.note,
      tagIds: v.tagIds,
    };
    if (trModal.editing) {
      updateTransfer.mutate(
        { outLegId: trModal.editing.id, patch },
        { onSuccess: () => setTrModal({ open: false }), onError: onErr },
      );
    } else {
      createTransfer.mutate(patch, { onSuccess: () => { rememberSource(v.fromSourceId); setTrModal({ open: false }); }, onError: onErr });
    }
  };

  // ---- quick-add templates ----
  const applyTemplate = (tpl: MovementTemplate) => {
    setQuickMenu(false);
    setFormError(undefined);
    // One-click: open the create form pre-filled, dated today, amount editable.
    setMvModal({
      open: true,
      prefill: {
        source_id: tpl.source_id,
        amount: tpl.amount ?? 0,
        direction: tpl.direction,
        date: todayISO(),
        note: tpl.note ?? "",
        tagIds: tpl.tag_ids,
      },
    });
  };
  const addTemplate = () => {
    if (!tplDraft.name.trim()) return;
    saveTemplates.mutate([...(templates ?? []), { ...tplDraft, name: tplDraft.name.trim() }], {
      onSuccess: () => setTplDraft({ name: "", direction: "out", source_id: null, amount: null, tag_ids: [], note: null }),
    });
  };
  const deleteTemplate = (idx: number) => {
    saveTemplates.mutate((templates ?? []).filter((_, i) => i !== idx));
  };

  // ---- saved views ----
  const applyView = (v: SavedView) => {
    setViewsMenu(false);
    const p = v.params as Record<string, unknown>;
    setQ(typeof p.q === "string" ? p.q : "");
    setFilterSource(p.source_id != null ? String(p.source_id) : "");
    setFilterDir(typeof p.direction === "string" ? p.direction : "");
    setDateFrom(typeof p.date_from === "string" ? p.date_from : "");
    setDateTo(typeof p.date_to === "string" ? p.date_to : "");
    setAmtMin(p.amount_min != null ? String(p.amount_min) : "");
    setAmtMax(p.amount_max != null ? String(p.amount_max) : "");
    setFilterTagIds(Array.isArray(p.tag_ids) ? (p.tag_ids as number[]) : []);
    setTagMatch(p.tag_match === "and" ? "and" : "or");
    if (typeof p.date_from === "string" || Array.isArray(p.tag_ids) || p.amount_min != null) setShowFilters(true);
  };
  const currentViewParams = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    if (q.trim()) p.q = q.trim();
    if (filterSource) p.source_id = Number(filterSource);
    if (filterDir) p.direction = filterDir;
    if (dateFrom) p.date_from = dateFrom;
    if (dateTo) p.date_to = dateTo;
    if (amtMin) p.amount_min = Number(amtMin);
    if (amtMax) p.amount_max = Number(amtMax);
    if (filterTagIds.length) { p.tag_ids = filterTagIds; p.tag_match = tagMatch; }
    return p;
  };
  const saveCurrentView = () => {
    if (!newViewName.trim()) return;
    saveViews.mutate([...(savedViews ?? []), { name: newViewName.trim(), params: currentViewParams() }], {
      onSuccess: () => { setNewViewName(""); setSaveViewOpen(false); },
    });
  };
  const deleteView = (idx: number) => {
    saveViews.mutate((savedViews ?? []).filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-4">
      {isPreviewDb && (
        <div className="rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">
          {t("preview_db_note", { defaultValue: "Browser preview with seeded sample data (in-memory). The packaged app uses your real database." })}
        </div>
      )}

      {/* KPI summary band — income / expense / net / count for the active scope
          (filters minus search). Each card filters the list by its direction. */}
      {data && ((sums?.count ?? 0) > 0 || advancedCount > 0 || !!filterSource || !!filterDir) && (
        <SummaryBand
          totalIn={sums?.totalIn ?? 0}
          totalOut={sums?.totalOut ?? 0}
          count={sums?.count ?? 0}
          // Mean over the rows the totals were built from — transfers and
          // stat-excluded rows are in `count` but not in the sums.
          avg={(sums?.countedRows ?? 0) > 0 ? Math.round(((sums?.totalIn ?? 0) + (sums?.totalOut ?? 0)) / (sums!.countedRows) * 100) / 100 : 0}
          ccy={prefs?.base_currency ?? undefined}
          locale={locale}
          activeDir={filterDir}
          onPick={setFilterDir}
          onBreakdown={setBreakdownDir}
        />
      )}

      {/* Breakdown of the same scope the KPI band summarises (filters minus the
          text search), so the charts and the cards can never disagree. */}
      <BreakdownModal
        open={breakdownDir != null}
        onClose={() => setBreakdownDir(null)}
        baseFilters={sumsFilters}
        initialDirection={breakdownDir ?? "out"}
        defaultPeriod={dateFrom || dateTo ? "as_filtered" : "all"}
        locale={locale}
        dateFormat={prefs?.date_format}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search", { defaultValue: "Search" }) + "…"} className="pl-9" />
        </div>

        {/* Direction — segmented control (replaces the plain select). */}
        <div className="inline-flex shrink-0 rounded-[var(--radius-control)] border border-border bg-surface-2 p-0.5">
          {([
            { v: "", label: t("all", { defaultValue: "All" }), icon: null },
            { v: "in", label: t("income", { defaultValue: "Income" }), icon: <ArrowUpRight className="h-3.5 w-3.5" /> },
            { v: "out", label: t("expense", { defaultValue: "Expense" }), icon: <ArrowDownLeft className="h-3.5 w-3.5" /> },
          ] as const).map((opt) => {
            const on = filterDir === opt.v;
            return (
              <button
                key={opt.v || "all"}
                type="button"
                onClick={() => setFilterDir(opt.v)}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-[calc(var(--radius-control)-3px)] px-3 text-sm font-medium transition-colors",
                  on
                    ? cn("bg-surface shadow-[var(--shadow-card)]", opt.v === "in" ? "text-positive" : opt.v === "out" ? "text-negative" : "text-foreground")
                    : "text-muted hover:text-foreground",
                )}
              >
                {opt.icon}{opt.label}
              </button>
            );
          })}
        </div>

        <Select value={filterSource} onChange={(e) => setFilterSource(e.target.value)} className="w-auto shrink-0">
          <option value="">{t("all_sources", { defaultValue: "All sources" })}</option>
          {(sources ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
        <Button variant={showFilters || advancedCount > 0 ? "secondary" : "outline"} onClick={() => setShowFilters((s) => !s)}>
          <SlidersHorizontal className="h-4 w-4" /> {t("filters", { defaultValue: "Filters" })}
          {advancedCount > 0 && <span className="ml-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{advancedCount}</span>}
        </Button>

        {/* Tag filter — dropdown with search (scales to many tags). */}
        {(tags?.length ?? 0) > 0 && (
          <div className="relative">
            <Button variant={filterTagIds.length > 0 ? "secondary" : "outline"} onClick={() => { setTagMenu((s) => !s); setViewsMenu(false); setQuickMenu(false); }}>
              <TagIcon className="h-4 w-4" /> {t("tags", { defaultValue: "Tags" })}
              {filterTagIds.length > 0 && <span className="ml-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{filterTagIds.length}</span>}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            {tagMenu && (
              <div className="absolute left-0 z-30 mt-1 w-64 rounded-[var(--radius-control)] border border-border bg-surface p-2 shadow-[var(--shadow-card)]">
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-2" />
                  <Input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder={t("search_tags", { defaultValue: "Search tags" }) + "…"} className="h-8 pl-8 text-sm" autoFocus />
                </div>
                {filterTagIds.length > 1 && (
                  <div className="mb-1.5 flex items-center justify-between px-0.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-2">{t("match", { defaultValue: "Match" })}</span>
                    <div className="flex items-center gap-1 text-xs">
                      {(["or", "and"] as const).map((m) => (
                        <button key={m} onClick={() => setTagMatch(m)} className={cn("rounded-full px-2 py-0.5 font-medium", tagMatch === m ? "bg-accent-soft text-primary" : "text-muted hover:text-foreground")}>
                          {m === "or" ? t("match_any", { defaultValue: "Any" }) : t("match_all", { defaultValue: "All" })}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="max-h-60 space-y-0.5 overflow-y-auto">
                  {(tags ?? [])
                    .filter((tg) => !tagQuery.trim() || tg.name.toLowerCase().includes(tagQuery.trim().toLowerCase()))
                    .map((tg) => {
                      const on = filterTagIds.includes(tg.id);
                      return (
                        <button
                          key={tg.id}
                          onClick={() => setFilterTagIds((s) => (on ? s.filter((x) => x !== tg.id) : [...s, tg.id]))}
                          className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors", on ? "bg-accent-soft text-primary" : "text-foreground hover:bg-surface-2")}
                        >
                          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tg.color ?? "var(--muted-2)" }} />
                          <span className="min-w-0 flex-1 truncate">{tg.name}</span>
                          {on && <Check className="h-4 w-4 shrink-0" />}
                        </button>
                      );
                    })}
                  {(tags ?? []).filter((tg) => !tagQuery.trim() || tg.name.toLowerCase().includes(tagQuery.trim().toLowerCase())).length === 0 && (
                    <p className="px-2 py-3 text-center text-xs text-muted">{t("no_results", { defaultValue: "No results" })}</p>
                  )}
                </div>
                {filterTagIds.length > 0 && (
                  <button onClick={() => setFilterTagIds([])} className="mt-1.5 flex w-full items-center justify-center gap-1.5 border-t border-border pt-2 text-xs font-medium text-muted hover:text-foreground">
                    <X className="h-3.5 w-3.5" /> {t("clear", { defaultValue: "Clear" })}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Secondary actions cluster — compact icon buttons, pushed to the right. */}
        <div className="ml-auto flex items-center gap-1.5">

        {/* Saved views menu */}
        <div className="relative">
          <Button variant="outline" size="icon" className="h-10 w-10" title={t("saved_views", { defaultValue: "Saved views" })} aria-label={t("saved_views", { defaultValue: "Saved views" })} onClick={() => { setViewsMenu((s) => !s); setQuickMenu(false); }}>
            <Bookmark className="h-4 w-4" />
          </Button>
          {viewsMenu && (
            <div className="absolute right-0 z-30 mt-1 w-60 rounded-[var(--radius-control)] border border-border bg-surface p-1 shadow-[var(--shadow-card)]">
              {(savedViews ?? []).length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted">{t("no_saved_views", { defaultValue: "No saved views" })}</p>
              ) : (
                (savedViews ?? []).map((v, i) => (
                  <div key={i} className="flex items-center justify-between gap-1 rounded-md px-1 hover:bg-surface-2">
                    <button onClick={() => applyView(v)} className="min-w-0 flex-1 truncate py-1.5 pl-1.5 text-left text-sm text-foreground">{v.name}</button>
                    <button onClick={() => deleteView(i)} aria-label={t("delete", { defaultValue: "Delete" })} className="rounded p-1 text-muted hover:text-negative"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))
              )}
              <button onClick={() => { setViewsMenu(false); setNewViewName(""); setSaveViewOpen(true); }} className="mt-1 flex w-full items-center gap-1.5 border-t border-border px-2 py-2 text-sm font-medium text-primary hover:bg-surface-2">
                <Plus className="h-4 w-4" /> {t("save_view", { defaultValue: "Save current view" })}
              </button>
            </div>
          )}
        </div>

        {/* Quick add (templates) menu */}
        <div className="relative">
          <Button variant="outline" size="icon" className="h-10 w-10" title={t("quick_add", { defaultValue: "Quick add" })} aria-label={t("quick_add", { defaultValue: "Quick add" })} onClick={() => { setQuickMenu((s) => !s); setViewsMenu(false); }}>
            <Zap className="h-4 w-4" />
          </Button>
          {quickMenu && (
            <div className="absolute right-0 z-30 mt-1 w-60 rounded-[var(--radius-control)] border border-border bg-surface p-1 shadow-[var(--shadow-card)]">
              {(templates ?? []).length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted">{t("no_templates", { defaultValue: "No templates yet" })}</p>
              ) : (
                (templates ?? []).map((tpl, i) => (
                  <button key={i} onClick={() => applyTemplate(tpl)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-surface-2">
                    <span className="min-w-0 truncate">{tpl.name}</span>
                    {tpl.amount != null && <span className="num shrink-0 text-xs text-muted">{tpl.amount.toFixed(2)}</span>}
                  </button>
                ))
              )}
              <button onClick={() => { setQuickMenu(false); setManageTemplatesOpen(true); }} className="mt-1 flex w-full items-center gap-1.5 border-t border-border px-2 py-2 text-sm font-medium text-primary hover:bg-surface-2">
                <SlidersHorizontal className="h-4 w-4" /> {t("manage_templates", { defaultValue: "Manage templates" })}
              </button>
            </div>
          )}
        </div>

        <Button variant="outline" size="icon" className="h-10 w-10" title={t("split", { defaultValue: "Split" })} aria-label={t("split", { defaultValue: "Split" })} onClick={() => { setFormError(undefined); setSplitOpen(true); }}>
          <Layers className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" className="h-10 w-10" title={t("calendar", { defaultValue: "Calendar" })} aria-label={t("calendar", { defaultValue: "Calendar" })} onClick={() => setCalendarOpen(true)}>
          <CalendarDays className="h-4 w-4" />
        </Button>
        <Button variant={selectMode ? "secondary" : "outline"} size="icon" className="h-10 w-10" title={t("select", { defaultValue: "Select" })} aria-label={t("select", { defaultValue: "Select" })} onClick={() => { setSelectMode((s) => !s); clearSel(); }}>
          <ListChecks className="h-4 w-4" />
        </Button>

        <span className="mx-0.5 h-6 w-px bg-border" aria-hidden />

        <Button variant="outline" onClick={() => { setFormError(undefined); setTrModal({ open: true }); }} disabled={(realSources?.length ?? 0) < 2}>
          <ArrowLeftRight className="h-4 w-4" /> {t("transfer", { defaultValue: "Transfer" })}
        </Button>
        <Button onClick={() => { setFormError(undefined); setMvModal({ open: true }); }}>
          <Plus className="h-4 w-4" /> {t("new_movement", { defaultValue: "New Movement" })}
        </Button>
        </div>
      </div>

      {showFilters && (
        <Card className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t("date_from", { defaultValue: "From date" })}</p>
              <DateInput value={dateFrom} onChange={setDateFrom} />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t("date_to", { defaultValue: "To date" })}</p>
              <DateInput value={dateTo} onChange={setDateTo} />
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
          {advancedCount > 0 && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={clearAdvanced}><X className="h-4 w-4" /> {t("clear_filters", { defaultValue: "Clear filters" })}</Button>
            </div>
          )}
        </Card>
      )}

      {/* Active advanced-filter chips — removable, visible even when the panel is collapsed. */}
      {advancedCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {dateFrom && (
            <FilterChip onRemove={() => setDateFrom("")}>{t("date_from", { defaultValue: "From date" })}: {formatDate(dateFrom, prefs?.date_format, locale)}</FilterChip>
          )}
          {dateTo && (
            <FilterChip onRemove={() => setDateTo("")}>{t("date_to", { defaultValue: "To date" })}: {formatDate(dateTo, prefs?.date_format, locale)}</FilterChip>
          )}
          {amtMin && (
            <FilterChip onRemove={() => setAmtMin("")}>≥ {amtMin}</FilterChip>
          )}
          {amtMax && (
            <FilterChip onRemove={() => setAmtMax("")}>≤ {amtMax}</FilterChip>
          )}
          <button onClick={clearAdvanced} className="ml-0.5 text-xs font-medium text-muted-2 hover:text-foreground">
            {t("clear_all", { defaultValue: "Clear all" })}
          </button>
        </div>
      )}

      {selectMode && selected.size > 0 && (
        <div className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface p-2 shadow-[var(--shadow-card)]">
          <span className="px-1 text-sm font-medium text-foreground">{t("n_selected", { defaultValue: "{{n}} selected", n: selected.size })}</span>
          <Select value={bulkMoveTo} onChange={(e) => setBulkMoveTo(e.target.value)} className="w-auto">
            <option value="">{t("move_to", { defaultValue: "Move to…" })}</option>
            {(sources ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Button size="sm" variant="outline" disabled={!bulkMoveTo || bulkMove.isPending} onClick={() => bulkMove.mutate({ ids: [...selected], sourceId: Number(bulkMoveTo) }, { onSuccess: () => { clearSel(); setBulkMoveTo(""); } })}>
            {t("move", { defaultValue: "Move" })}
          </Button>
          <Button size="sm" variant="outline" disabled={(tags?.length ?? 0) === 0} onClick={() => { setBulkTagIds([]); setBulkTagMode("add"); setBulkTagOpen(true); }}>
            <TagIcon className="h-4 w-4" /> {t("tags", { defaultValue: "Tags" })}
          </Button>
          <Button size="sm" variant="outline" disabled={bulkExclude.isPending} onClick={() => bulkExclude.mutate({ ids: [...selected], value: true }, { onSuccess: clearSel })}>
            <EyeOff className="h-4 w-4" /> {t("bulk_exclude", { defaultValue: "Exclude" })}
          </Button>
          <Button size="sm" variant="outline" disabled={bulkExclude.isPending} onClick={() => bulkExclude.mutate({ ids: [...selected], value: false }, { onSuccess: clearSel })}>
            {t("bulk_include", { defaultValue: "Include" })}
          </Button>
          <Button size="sm" variant="danger" disabled={bulkDelete.isPending} onClick={() => bulkDelete.mutate([...selected], { onSuccess: clearSel })}>
            <Trash2 className="h-4 w-4" /> {t("delete", { defaultValue: "Delete" })}
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSel} aria-label={t("clear", { defaultValue: "Clear" })}><X className="h-4 w-4" /></Button>
        </div>
      )}

      {isLoading && <Card className="p-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</Card>}
      {error && <Card className="p-8 text-center text-sm text-negative">{errText(error)}</Card>}

      {data && groups.length === 0 && (
        <Card className="p-10 text-center text-sm text-muted">{t("no_movements", { defaultValue: "No movements yet." })}</Card>
      )}

      {groups.map((year) => {
        const yearCount = year.months.reduce((acc, mo) => acc + mo.days.reduce((a, d) => a + d.items.length, 0), 0);
        const yearKey = `year:${year.year}`;
        const yearCollapsed = collapsed.has(yearKey);
        return (
        <div key={year.year} className="space-y-3">
          {/* Year-level rollup header: count + in/out totals + net% badge. */}
          <button
            type="button"
            onClick={() => toggleCollapse(yearKey)}
            className="flex w-full items-center justify-between px-1 text-left"
            aria-expanded={!yearCollapsed}
          >
            <h2 className="flex items-center gap-1.5 text-base font-bold text-foreground">
              {yearCollapsed ? <ChevronRight className="h-4 w-4 text-muted" /> : <ChevronDown className="h-4 w-4 text-muted" />}
              {year.year}
              <span className="ml-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">{t("n_items", { defaultValue: "{{count}} items", count: yearCount })}</span>
            </h2>
            <div className="flex items-center gap-3 text-xs">
              {year.totalIn > 0 && <span className="num text-positive">+{year.totalIn.toFixed(2)}</span>}
              {year.totalOut > 0 && <span className="num text-muted">−{year.totalOut.toFixed(2)}</span>}
              <NetBadge totalIn={year.totalIn} totalOut={year.totalOut} />
            </div>
          </button>
          {!yearCollapsed && year.months.map((month) => {
            const monthKey = `month:${month.month}`;
            const monthCollapsed = collapsed.has(monthKey);
            const monthCount = month.days.reduce((a, d) => a + d.items.length, 0);
            return (
              <Card key={month.month} className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleCollapse(monthKey)}
                  className="flex w-full items-center justify-between border-b border-border bg-surface-2/40 px-5 py-2.5 text-left transition-colors hover:bg-surface-2/70"
                  aria-expanded={!monthCollapsed}
                >
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    {monthCollapsed ? <ChevronRight className="h-4 w-4 text-muted" /> : <ChevronDown className="h-4 w-4 text-muted" />}
                    {monthLabel(month.month, locale)}
                    <span className="ml-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{monthCount}</span>
                  </h3>
                  <div className="flex items-center gap-3 text-xs">
                    {month.totalIn > 0 && <span className="num text-positive">+{month.totalIn.toFixed(2)}</span>}
                    {month.totalOut > 0 && <span className="num text-muted">−{month.totalOut.toFixed(2)}</span>}
                    <NetBadge totalIn={month.totalIn} totalOut={month.totalOut} />
                  </div>
                </button>
                {/* In/out ratio bar — quick visual of the month's income vs spend split. */}
                {(month.totalIn > 0 || month.totalOut > 0) && (
                  <div className="flex h-1 w-full overflow-hidden bg-surface-2">
                    <div className="bg-positive" style={{ width: `${(month.totalIn / (month.totalIn + month.totalOut)) * 100}%` }} />
                    <div className="bg-negative" style={{ width: `${(month.totalOut / (month.totalIn + month.totalOut)) * 100}%` }} />
                  </div>
                )}
                {!monthCollapsed && (
                  <div className="px-5">
                    {month.days.map((day) => {
                      const dayKey = `day:${day.date}`;
                      const dayCollapsed = collapsed.has(dayKey);
                      return (
                        <div key={day.date} className="border-b border-border last:border-0">
                          <button
                            type="button"
                            onClick={() => toggleCollapse(dayKey)}
                            className="flex w-full items-center justify-between gap-2 pt-3 pb-1 text-left hover:[&_.daylabel]:text-foreground"
                            aria-expanded={!dayCollapsed}
                          >
                            <span className="daylabel flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-2">
                              {dayCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                              {formatDate(day.date, prefs?.date_format, locale)}
                              {dayCollapsed && <span className="ml-1 normal-case text-muted-2">· {t("n_items", { defaultValue: "{{count}} items", count: day.items.length })}</span>}
                            </span>
                            {(day.totalIn > 0 || day.totalOut > 0) && (
                              <span className={cn("num text-xs font-semibold", day.totalIn - day.totalOut > 0 ? "text-positive" : day.totalIn - day.totalOut < 0 ? "text-muted" : "text-muted-2")}>
                                {day.totalIn - day.totalOut >= 0 ? "+" : "−"}{Math.abs(day.totalIn - day.totalOut).toFixed(2)}
                              </span>
                            )}
                          </button>
                          {!dayCollapsed && (
                            <ul className="divide-y divide-border">
                              {day.items.map((m) => (
                                <MovementRow
                                  key={m.id}
                                  m={m}
                                  locale={locale}
                                  onEdit={rowEdit}
                                  onDelete={rowDelete}
                                  onMakeRecurring={rowMakeRecurring}
                                  onToggleExclude={rowToggleExclude}
                                  onAttach={tauri ? rowAttach : undefined}
                                  attachCount={attachCounts?.[m.id] ?? 0}
                                  selectMode={selectMode}
                                  selected={selectMode ? selected.has(m.id) : undefined}
                                  onSelectDown={selectMode ? beginDrag : undefined}
                                  onSelectEnter={selectMode ? extendDrag : undefined}
                                  highlight={focusId != null && m.id === focusId}
                                />
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
        );
      })}

      {truncated && (
        <p className="px-1 text-xs text-muted">
          {t("movements_truncated", {
            defaultValue: "Showing the most recent {{shown}} of {{total}} — narrow with filters or search to see the rest.",
            shown: loaded,
            total,
          })}
        </p>
      )}

      <Modal open={mvModal.open} onClose={() => setMvModal({ open: false })} title={mvModal.editing ? t("edit_movement", { defaultValue: "Edit Movement" }) : t("new_movement", { defaultValue: "New Movement" })}>
        <MovementForm
          key={mvModal.editing ? `edit-${mvModal.editing.id}` : mvModal.prefill ? "prefill" : "new"}
          initial={mvModal.editing}
          prefill={mvModal.prefill}
          lastSourceId={prefs?.last_source_id ?? null}
          sources={sources ?? []}
          tags={tags ?? []}
          pending={createMovement.isPending || updateMovement.isPending}
          error={formError}
          onCancel={() => setMvModal({ open: false })}
          onSubmit={submitMovement}
        />
      </Modal>

      <Modal open={trModal.open} onClose={() => setTrModal({ open: false })} title={trModal.editing ? t("edit_transfer", { defaultValue: "Edit Transfer" }) : t("new_transfer", { defaultValue: "New Transfer" })}>
        <TransferForm
          initial={trModal.editing}
          sources={realSources ?? []}
          tags={tags ?? []}
          pending={createTransfer.isPending || updateTransfer.isPending}
          error={formError}
          onCancel={() => setTrModal({ open: false })}
          onSubmit={submitTransfer}
        />
      </Modal>

      <Modal
        open={bulkTagOpen}
        onClose={() => setBulkTagOpen(false)}
        title={t("bulk_tag_title", { defaultValue: "Tag {{n}} movements", n: selected.size })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkTagOpen(false)}>{t("cancel", { defaultValue: "Cancel" })}</Button>
            <Button
              disabled={bulkSetTags.isPending || bulkTagIds.length === 0}
              onClick={() => bulkSetTags.mutate({ ids: [...selected], tagIds: bulkTagIds, mode: bulkTagMode }, { onSuccess: () => { setBulkTagOpen(false); clearSel(); } })}
            >
              {t("apply", { defaultValue: "Apply" })}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {(["add", "remove", "replace"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setBulkTagMode(m)} className={cn("h-9 rounded-[var(--radius-control)] border text-sm font-medium", bulkTagMode === m ? "border-primary bg-accent-soft text-primary" : "border-border text-muted")}>
                {t(`tag_mode_${m}`, { defaultValue: m })}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(tags ?? []).map((tg) => {
              const on = bulkTagIds.includes(tg.id);
              return (
                <button key={tg.id} type="button" onClick={() => toggleBulkTag(tg.id)} className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors", on ? "border-primary bg-accent-soft text-primary" : "border-border text-muted hover:text-foreground")}>
                  <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: tg.color ?? "var(--muted-2)" }} />
                  {tg.name}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted">{t("bulk_tag_hint", { defaultValue: "Add appends, Remove strips, Replace sets exactly these tags." })}</p>
        </div>
      </Modal>

      <Modal open={splitOpen} onClose={() => setSplitOpen(false)} title={t("split_transaction", { defaultValue: "Split transaction" })}>
        <SplitForm
          sources={sources ?? []}
          tags={tags ?? []}
          pending={createSplit.isPending}
          error={formError}
          onCancel={() => setSplitOpen(false)}
          onSubmit={submitSplit}
        />
      </Modal>

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(undefined)}
          title={t("delete", { defaultValue: "Delete" })}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(undefined)}>{t("cancel", { defaultValue: "Cancel" })}</Button>
              <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(deleting.id, { onSuccess: () => setDeleting(undefined) })}>
                {t("delete", { defaultValue: "Delete" })}
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted">
            {isTransfer(deleting)
              ? t("confirm_delete_transfer", { defaultValue: "This will remove both legs of the transfer." })
              : t("confirm_delete_movement", { defaultValue: "This movement will be permanently deleted." })}
          </p>
        </Modal>
      )}

      {calendarOpen && <MovementsCalendar onClose={() => setCalendarOpen(false)} locale={locale} />}
      {attachFor && <AttachmentsModal movementId={attachFor.id} onClose={() => setAttachFor(undefined)} />}

      {recurringFrom && (
        <Modal
          open
          onClose={() => setRecurringFrom(undefined)}
          title={t("make_recurring", { defaultValue: "Make recurring" })}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRecurringFrom(undefined)}>{t("cancel", { defaultValue: "Cancel" })}</Button>
              <Button
                disabled={makeRecurring.isPending}
                onClick={() => {
                  setFormError(undefined);
                  makeRecurring.mutate(
                    { movementId: recurringFrom.id, frequency: recFreq, applyMode: recApplyMode },
                    { onSuccess: () => setRecurringFrom(undefined), onError: (e) => setFormError(errText(e)) },
                  );
                }}
              >
                {t("create", { defaultValue: "Create" })}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-muted">
              {t("make_recurring_hint", { defaultValue: "Create a recurring rule from \"{{name}}\" ({{amt}}).", name: recurringFrom.note || recurringFrom.source_name || "—", amt: recurringFrom.source_currency ? formatSigned(recurringFrom.direction === "in" ? recurringFrom.amount : -recurringFrom.amount, recurringFrom.source_currency, locale) : String(recurringFrom.amount) })}
            </p>
            <div>
              <p className="mb-1 text-sm font-medium text-foreground">{t("frequency", { defaultValue: "Frequency" })}</p>
              <Select value={recFreq} onChange={(e) => setRecFreq(e.target.value)}>
                {(["daily", "weekly", "monthly", "yearly"] as const).map((f) => (
                  <option key={f} value={f}>{t(`freq_${f}`, { defaultValue: f })}</option>
                ))}
              </Select>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium text-foreground">{t("apply_mode", { defaultValue: "When due" })}</p>
              <div className="grid grid-cols-2 gap-2">
                {(["confirm", "auto"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRecApplyMode(mode)}
                    className={cn("h-10 rounded-[var(--radius-control)] border text-sm font-medium", recApplyMode === mode ? "border-primary bg-accent-soft text-primary" : "border-border text-muted hover:text-foreground")}
                  >
                    {mode === "confirm" ? t("apply_mode_confirm", { defaultValue: "Ask to confirm" }) : t("apply_mode_auto", { defaultValue: "Apply automatically" })}
                  </button>
                ))}
              </div>
            </div>
            {formError ? <p className="text-sm text-negative">{formError}</p> : null}
          </div>
        </Modal>
      )}

      {/* Save current filter as a view */}
      <Modal
        open={saveViewOpen}
        onClose={() => setSaveViewOpen(false)}
        title={t("save_view", { defaultValue: "Save current view" })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveViewOpen(false)}>{t("cancel", { defaultValue: "Cancel" })}</Button>
            <Button disabled={!newViewName.trim() || saveViews.isPending} onClick={saveCurrentView}>{t("save", { defaultValue: "Save" })}</Button>
          </>
        }
      >
        <Field label={t("view_name", { defaultValue: "View name" })} htmlFor="view-name">
          <Input id="view-name" value={newViewName} onChange={(e) => setNewViewName(e.target.value)} autoFocus maxLength={200} />
        </Field>
      </Modal>

      {/* Manage quick-add templates */}
      <Modal open={manageTemplatesOpen} onClose={() => setManageTemplatesOpen(false)} title={t("manage_templates", { defaultValue: "Manage templates" })}>
        <div className="space-y-4">
          {(templates ?? []).length > 0 && (
            <ul className="divide-y divide-border">
              {(templates ?? []).map((tpl, i) => (
                <li key={i} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{tpl.name}</p>
                    <p className="text-xs text-muted">
                      {tpl.direction === "in" ? t("income", { defaultValue: "Income" }) : t("expense", { defaultValue: "Expense" })}
                      {tpl.amount != null && ` · ${tpl.amount.toFixed(2)}`}
                    </p>
                  </div>
                  <button onClick={() => deleteTemplate(i)} aria-label={t("delete", { defaultValue: "Delete" })} className="rounded p-1.5 text-muted hover:text-negative"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-3 rounded-[var(--radius-control)] border border-border p-3">
            <p className="text-sm font-medium text-foreground">{t("add_template", { defaultValue: "Add template" })}</p>
            <Field label={t("template_name", { defaultValue: "Template name" })} htmlFor="tpl-name">
              <Input id="tpl-name" value={tplDraft.name} onChange={(e) => setTplDraft((d) => ({ ...d, name: e.target.value }))} maxLength={200} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              {(["out", "in"] as const).map((dir) => (
                <button key={dir} type="button" onClick={() => setTplDraft((d) => ({ ...d, direction: dir }))} className={cn("h-9 rounded-[var(--radius-control)] border text-sm font-medium", tplDraft.direction === dir ? "border-primary bg-accent-soft text-primary" : "border-border text-muted")}>
                  {dir === "in" ? t("income", { defaultValue: "Income" }) : t("expense", { defaultValue: "Expense" })}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("amount_optional", { defaultValue: "Amount (optional)" })} htmlFor="tpl-amt">
                <MoneyInput id="tpl-amt" value={tplDraft.amount != null ? String(tplDraft.amount) : ""} onValueChange={(v) => setTplDraft((d) => ({ ...d, amount: v.trim() === "" ? null : evalMoneyExpr(v) }))} className="num" />
              </Field>
              <Field label={t("source", { defaultValue: "Source" })} htmlFor="tpl-src">
                <Select id="tpl-src" value={tplDraft.source_id != null ? String(tplDraft.source_id) : ""} onChange={(e) => setTplDraft((d) => ({ ...d, source_id: e.target.value === "" ? null : Number(e.target.value) }))}>
                  <option value="">{t("external", { defaultValue: "External (no account)" })}</option>
                  {(sources ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            </div>
            <Field label={t("note", { defaultValue: "Note" })} htmlFor="tpl-note">
              <Input id="tpl-note" value={tplDraft.note ?? ""} onChange={(e) => setTplDraft((d) => ({ ...d, note: e.target.value || null }))} maxLength={1000} />
            </Field>
            <div className="flex justify-end">
              <Button size="sm" disabled={!tplDraft.name.trim() || saveTemplates.isPending} onClick={addTemplate}>
                <Plus className="h-4 w-4" /> {t("add_template", { defaultValue: "Add template" })}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
