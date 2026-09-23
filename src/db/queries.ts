import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDb } from "./connection";
import * as sources from "./repo/sources";
import * as movements from "./repo/movements";
import * as dashboard from "./repo/dashboard";
import * as breakdown from "./repo/breakdown";
import * as recurring from "./repo/recurring";
import * as notifications from "./repo/notifications";
import * as budgets from "./repo/budgets";
import * as goals from "./repo/goals";
import * as whims from "./repo/whims";
import * as portfolios from "./repo/portfolios";
import * as prices from "./repo/prices";
import { importFile, resetAllData } from "./backup";
import { commitCsv, undoImport } from "./importers/csv";
import * as settingsRepo from "./repo/settings";
import * as templatesRepo from "./repo/movement-templates";
import * as rates from "./repo/exchange-rates";
import * as fx from "./repo/fx";
import { createSplit, type NewSplit } from "./repo/splits";
import { forecastCashflow } from "./repo/forecast";
import { consolidatedNetWorth } from "./repo/consolidate";
import { searchAll, type SearchItem } from "./repo/search";
import * as tags from "./repo/tags";
import * as savings from "./repo/savings";
import * as savingsMigration from "./repo/savings-migration";
import * as history from "./repo/history";
import * as attachments from "./repo/attachments";
import { round2 } from "@/domain/money";
import { addMonthsISO, monthEnd, monthStart, todayISO } from "@/lib/date";
import type { SourceRow, TagRow } from "./schema-types";
import { withTx } from "./tx";
import type { SqlExecutor } from "./types";

/**
 * withTx + deferred attachment-file cleanup. Delete cascades only STAGE their
 * on-disk unlinks (see stageAttachmentUnlinks): flush them once the tx has
 * COMMITTED, discard them on rollback — so a failed transaction can never
 * leave live DB rows pointing at already-deleted files. Every mutation in this
 * layer funnels through here; the flush is best-effort and never throws.
 */
async function withTxAndCleanup<T>(db: SqlExecutor, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  let staged: string[] = [];
  const result = await withTx(db, async (tx) => {
    attachments.beginUnlinkStaging();
    try {
      return await fn(tx);
    } finally {
      // Capture inside the tx body — the withTx mutex is still held, so an
      // overlapping queued transaction can never clobber this tx's names.
      staged = attachments.endUnlinkStaging();
    }
  });
  // Reached only on COMMIT; on rollback the throw above skips the unlink and
  // the captured names are dropped (rows still exist, files must stay).
  await attachments.unlinkStoredFiles(staged);
  return result;
}

// Every money-derived view. Mutations that can ripple anywhere money lives
// (goal allocations, whim purchases, budget rules, restores, tag merges)
// invalidate the lot — cheap against the local DB and avoids subtle stale views.
const MONEY_KEYS = ["movements", "sources", "dashboard", "budgets", "goals", "whims", "recurring", "forecast", "consolidated", "portfolios", "notifications", "savings", "history", "movementCounts", "goalAllocations"];
function invalidateMoney(qc: ReturnType<typeof useQueryClient>) {
  for (const k of MONEY_KEYS) void qc.invalidateQueries({ queryKey: [k] });
}

// Plain movement ops (create/edit/delete/transfer/split/bulk) write only to
// `movements`/`movement_tag` — plus the goal_allocations rows a delete cascades
// away; they never touch recurring/whim/portfolio definitions or generate
// notifications (those come from the boot scheduler and source ops). So they
// only need the views *derived* from movements — goal progress, allocation
// lists and tag usage counts included — sparing a refetch of the always-mounted
// notification badge on every single edit.
// `whims` is here because a goal-allocation movement deleted from the list
// changes the linked whim's "saved so far" bar.
const MOVEMENT_KEYS = ["movements", "sources", "dashboard", "budgets", "goals", "goalAllocations", "whims", "tags", "forecast", "consolidated", "savings", "history", "movementCounts"];
function invalidateMovementMoney(qc: ReturnType<typeof useQueryClient>) {
  for (const k of MOVEMENT_KEYS) void qc.invalidateQueries({ queryKey: [k] });
}

export interface SourceWithBalance extends SourceRow {
  /** Cash balance: starting balance + movements. Excludes portfolios. */
  balance: number;
  /** Market value of the portfolios linked to this source, in its currency. */
  portfolio_value: number;
  /** Cash + portfolios — what the account is actually worth, and what net worth counts. */
  total_value: number;
  /** A linked portfolio couldn't be converted into this source's currency. */
  portfolio_unconverted: boolean;
}

export function useSources() {
  return useQuery({
    queryKey: ["sources"],
    queryFn: async (): Promise<SourceWithBalance[]> => {
      const db = await getDb();
      const [list, balances, pfValues] = await Promise.all([
        sources.listSources(db, { includeHidden: true }),
        sources.getBalancesBatch(db),
        portfolios.valueBySource(db),
      ]);
      return list.map((s) => {
        const balance = balances.get(s.id) ?? round2(s.starting_balance);
        const pf = pfValues.get(s.id);
        return {
          ...s,
          balance,
          portfolio_value: pf?.value ?? 0,
          total_value: round2(balance + (pf?.value ?? 0)),
          portfolio_unconverted: pf?.unconverted ?? false,
        };
      });
    },
  });
}

export function useCreateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: sources.NewSource) => {
      const db = await getDb();
      return sources.createSource(db, data);
    },
    // A starting balance is money: it feeds the net-worth history, the
    // consolidated total and the forecast, not just the sources list.
    onSuccess: () => invalidateMoney(qc),
  });
}

export function useUpdateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: number; patch: sources.SourcePatch }) => {
      const db = await getDb();
      return sources.updateSource(db, v.id, v.patch);
    },
    // Name/currency/fund edits ripple into every money-derived view (movement
    // rows, budgets, forecasts…), not just the sources list — refresh the lot.
    onSuccess: () => invalidateMoney(qc),
  });
}

export function useDeleteSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: number; action: sources.DeleteAction }) => {
      const db = await getDb();
      // Multi-table cascade (movements, tags, attachments, holdings, portfolios,
      // recurring, the source row) — must be atomic or a mid-cascade failure
      // corrupts the DB. Mirrors useMergeSources below.
      return withTxAndCleanup(db, (tx) => sources.deleteSource(tx, v.id, v.action));
    },
    // The cascade reaches movements/allocations on OTHER sources too — refresh
    // every money-derived view, mirroring useMergeSources.
    onSuccess: () => invalidateMoney(qc),
  });
}

export function useSetFundVisibility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: number; hidden: boolean }) => {
      const db = await getDb();
      return sources.setFundVisibility(db, v.id, v.hidden);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

/** Merge one same-currency, non-fund source into another (reassigns + deletes). */
export function useMergeSources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { fromId: number; toId: number }) => {
      const db = await getDb();
      return withTxAndCleanup(db, (tx) => sources.mergeSources(tx, v.fromId, v.toId));
    },
    onSuccess: () => invalidateMoney(qc),
  });
}

/** Movement/recurring/portfolio counts a delete will affect (gates the dialog). */
export function useSourceDependencies(id: number | null) {
  return useQuery({
    queryKey: ["sources", "deps", id],
    enabled: id != null,
    queryFn: async () =>
      id != null ? sources.getSourceDependencies(await getDb(), id) : null,
  });
}

// ---- tags ----
export function useTags() {
  return useQuery({
    queryKey: ["tags"],
    queryFn: async (): Promise<TagRow[]> => tags.listTags(await getDb()),
  });
}

export function useTagsWithUsage() {
  return useQuery({
    queryKey: ["tags", "usage"],
    queryFn: async () => tags.listTagsWithUsage(await getDb()),
  });
}

function useTagMutation<TArgs, TResult>(fn: (db: import("./types").SqlExecutor, a: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: TArgs) => {
      const db = await getDb();
      return withTxAndCleanup(db, (tx) => fn(tx, a));
    },
    // Tag edits ripple into every tagged movement, budget rules, and the dashboard.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tags"] });
      invalidateMoney(qc);
    },
  });
}

export const useCreateTag = () => useTagMutation((db, data: tags.NewTag) => tags.createTag(db, data));
export const useUpdateTag = () => useTagMutation((db, v: { id: number; patch: tags.TagPatch }) => tags.updateTag(db, v.id, v.patch));
export const useDeleteTag = () => useTagMutation((db, id: number) => tags.deleteTag(db, id));
export const useMergeTags = () => useTagMutation((db, v: { fromId: number; intoId: number }) => tags.mergeTags(db, v.fromId, v.intoId));

// ---- savings ----
/** Per-page size for the savings list (matches the legacy per_page=50). */
export const SAVINGS_PAGE_SIZE = 50;

export interface SavingsPage {
  items: savings.EnrichedSaving[];
  total: number;
}

/** Paginated + filtered savings list with the matching total count. */
export function useSavings(
  page = 1,
  filters: savings.SavingsFilters = {},
  pageSize = SAVINGS_PAGE_SIZE,
) {
  return useQuery({
    queryKey: ["savings", "list", page, filters, pageSize],
    queryFn: async (): Promise<SavingsPage> => {
      const db = await getDb();
      const offset = (page - 1) * pageSize;
      const [items, total] = await Promise.all([
        savings.listSavings(db, { ...filters, limit: pageSize, offset }),
        savings.countSavings(db, filters),
      ]);
      return { items, total };
    },
  });
}

/** Per-currency aggregate stat cards: all-time total, this month, last month. */
export function useSavingsTotals() {
  return useQuery({
    queryKey: ["savings", "totals"],
    queryFn: async () => {
      const db = await getDb();
      const today = todayISO();
      const lastMonth = monthStart(addMonthsISO(monthStart(today), -1));
      const [total, thisMonth, last] = await Promise.all([
        savings.totalSaved(db),
        savings.totalSavedPeriod(db, monthStart(today), monthEnd(today)),
        savings.totalSavedPeriod(db, lastMonth, monthEnd(lastMonth)),
      ]);
      return { total, thisMonth, lastMonth: last };
    },
  });
}

/** Contributions-trend (tab 1) + fund-balance-trend (tab 2) for the savings charts. */
export function useSavingsTrends(months = 12) {
  return useQuery({
    queryKey: ["savings", "trends", months],
    queryFn: async () => {
      const db = await getDb();
      const [contributions, fundBalance] = await Promise.all([
        savings.monthlyTrend(db, months),
        savings.fundBalanceTrend(db, months),
      ]);
      return { contributions, fundBalance };
    },
  });
}

/** Savings in a given month (YYYY-MM) — the calendar drill-down. */
export function useSavingsByMonth(yearMonth: string | null) {
  return useQuery({
    queryKey: ["savings", "byMonth", yearMonth],
    enabled: yearMonth != null,
    queryFn: async () => (yearMonth ? savings.savingsByMonth(await getDb(), yearMonth) : []),
  });
}

export const useCreateSaving = () => useBroadMutation((db, data: savings.NewSaving) => savings.createSaving(db, data));
export const useUpdateSaving = () =>
  useBroadMutation((db, v: { id: number; patch: savings.SavingPatch }) => savings.updateSaving(db, v.id, v.patch));
export const useDeleteSaving = () => useBroadMutation((db, id: number) => savings.deleteSaving(db, id));

// ---- legacy savings migration wizard ----
export function useSavingsWizardStatus() {
  return useQuery({
    queryKey: ["savings", "wizard"],
    queryFn: async () => {
      const db = await getDb();
      const needed = await savingsMigration.needsWizard(db);
      return { needed, preview: needed ? await savingsMigration.previewWizard(db) : null };
    },
  });
}
export const useRunSavingsWizard = () =>
  useBroadMutation((db, v: { mode: savingsMigration.WizardMode; unifiedSourceId?: number | null }) =>
    savingsMigration.runWizard(db, v.mode, { unifiedSourceId: v.unifiedSourceId }),
  );

// ---- history (charts / sparklines) ----
export function useNetWorthHistory(currency: string | null) {
  return useQuery({
    queryKey: ["history", "networth", currency],
    enabled: currency != null,
    queryFn: async () => (currency ? history.netWorthHistory(await getDb(), currency) : []),
  });
}
export function useSourceHistory(sourceId: number) {
  return useQuery({
    queryKey: ["history", "source", sourceId],
    queryFn: async () => history.sourceBalanceHistory(await getDb(), sourceId),
  });
}
export function useMovementCounts() {
  return useQuery({
    queryKey: ["movementCounts"],
    queryFn: async () => Object.fromEntries(await history.movementCounts(await getDb())) as Record<number, number>,
  });
}

// ---- attachments (Tauri-only) ----
export function useAttachments(movementId: number | null) {
  return useQuery({
    queryKey: ["attachments", movementId],
    enabled: movementId != null,
    queryFn: async () => (movementId != null ? attachments.listAttachments(await getDb(), movementId) : []),
  });
}
export function useAttachmentCounts() {
  return useQuery({
    queryKey: ["attachmentCounts"],
    queryFn: async () => Object.fromEntries(await attachments.attachmentCounts(await getDb())) as Record<number, number>,
  });
}
export function useAddAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { movementId: number; file: { name: string; type: string; bytes: Uint8Array } }) =>
      attachments.addAttachment(await getDb(), v.movementId, v.file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["attachments"] });
      void qc.invalidateQueries({ queryKey: ["attachmentCounts"] });
    },
  });
}
export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (att: attachments.AttachmentRow) => attachments.deleteAttachment(await getDb(), att),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["attachments"] });
      void qc.invalidateQueries({ queryKey: ["attachmentCounts"] });
    },
  });
}

// ---- movements ----
/**
 * Paginated movement list. The main page pages at 50/row (offset-based, matching
 * the original); other callers (calendar, source detail) pass a large pageSize
 * with offset 0 to fetch everything within their own date/source scope.
 */
export function useMovements(filters: movements.MovementFilters, pageSize = 50, offset = 0) {
  return useQuery({
    queryKey: ["movements", filters, pageSize, offset],
    queryFn: async () => {
      const db = await getDb();
      const [items, total] = await Promise.all([
        movements.listMovements(db, filters, { limit: pageSize, offset }),
        movements.countMovements(db, filters),
      ]);
      return { items, total };
    },
  });
}

/** In/out totals + count across all rows matching `filters` — drives the KPI summary band. */
export function useMovementSums(filters: movements.MovementFilters) {
  return useQuery({
    queryKey: ["movements", "sums", filters],
    queryFn: async () => {
      const db = await getDb();
      const [sums, count] = await Promise.all([
        movements.sumMovements(db, filters),
        movements.countMovements(db, filters),
      ]);
      return { ...sums, count };
    },
  });
}

/**
 * Spending/income breakdown for whatever `filters` select — categories, accounts,
 * biggest movements, month curve. Keyed under "movements" so every movement
 * mutation refreshes it along with the list it was opened from.
 *
 * When the filters carry a full date range the same-length preceding window is
 * summed too, so the panel can show a "vs previous period" delta.
 */
export function useBreakdown(filters: movements.MovementFilters | null, currency?: string) {
  return useQuery({
    queryKey: ["movements", "breakdown", filters, currency ?? null],
    enabled: filters != null,
    queryFn: async () => {
      const db = await getDb();
      const f = filters!;
      const data = await breakdown.spendingBreakdown(db, f, { currency });
      if (!f.dateFrom || !f.dateTo) return { ...data, previousTotal: null, previousFrom: null, previousTo: null };
      const prev = breakdown.previousRange(f.dateFrom, f.dateTo);
      const totals = await breakdown.totalByCurrency(db, { ...f, dateFrom: prev.from, dateTo: prev.to });
      return { ...data, previousTotal: totals[data.currency] ?? 0, previousFrom: prev.from, previousTo: prev.to };
    },
  });
}

// ---- quick-add templates + saved views (settings JSON blobs) ----
export function useMovementTemplates() {
  return useQuery({
    queryKey: ["movementTemplates"],
    queryFn: async () => templatesRepo.listTemplates(await getDb()),
  });
}
export function useSaveTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (templates: templatesRepo.MovementTemplate[]) =>
      templatesRepo.saveTemplates(await getDb(), templates),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["movementTemplates"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
export function useSavedViews() {
  return useQuery({
    queryKey: ["savedViews"],
    queryFn: async () => templatesRepo.listSavedViews(await getDb()),
  });
}
export function useSaveSavedViews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (views: templatesRepo.SavedView[]) => templatesRepo.saveSavedViews(await getDb(), views),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["savedViews"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

// ---- cross-currency conversion (transfer auto-fill) ----
export function useConvert(amount: number, from: string | undefined, to: string | undefined) {
  return useQuery({
    queryKey: ["convert", amount, from, to],
    enabled: amount > 0 && !!from && !!to && from !== to,
    queryFn: async () =>
      from && to ? rates.convert(await getDb(), amount, from, to) : null,
    staleTime: 60_000,
  });
}

// ---- exchange rates (Settings -> Currencies) ----
// A rate change re-values portfolios, the consolidated net worth and every
// transfer auto-fill, so writes invalidate the money views wholesale.
export function useExchangeRates() {
  return useQuery({ queryKey: ["rates"], queryFn: async () => rates.listRates(await getDb()) });
}

function useRateMutation<TArgs, TResult>(fn: (db: SqlExecutor, a: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: TArgs) => fn(await getDb(), a),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rates"] });
      void qc.invalidateQueries({ queryKey: ["convert"] });
      invalidateMoney(qc);
    },
  });
}

export const useUpsertRate = () =>
  useRateMutation((db, v: { from: string; to: string; rate: number }) => rates.upsertRate(db, v.from, v.to, v.rate));
export const useDeleteRate = () => useRateMutation((db, id: number) => rates.deleteRate(db, id));

/** Manual "Update rates" — network call, outside any transaction. Never throws
 *  for an outage: the result reports it via `offline` instead. */
export const useRefreshRates = () => useRateMutation((db, _a: void) => fx.refreshRates(db));

/** Money mutations run atomically (withTx) and refresh every derived view. */
function useMoneyMutation<TArgs, TResult>(fn: (db: import("./types").SqlExecutor, args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: TArgs) => {
      const db = await getDb();
      return withTxAndCleanup(db, (tx) => fn(tx, args));
    },
    onSuccess: () => invalidateMovementMoney(qc),
  });
}

// ---- dashboard + search ----
export function useDashboard(comparisonMonths = 6) {
  return useQuery({
    queryKey: ["dashboard", comparisonMonths],
    queryFn: async () => {
      const db = await getDb();
      const today = todayISO();
      const ms = monthStart(today);
      const me = monthEnd(today);
      const excluded = settingsRepo.parseNetWorthExcluded(
        (await settingsRepo.getSettings(db)).net_worth_excluded_json,
      );
      const [nw, flow, savings, recent, upcoming, counts] = await Promise.all([
        dashboard.netWorth(db, excluded),
        dashboard.monthlyFlow(db, ms, me),
        dashboard.monthlySavings(db, ms, me),
        movements.listMovements(db, { excludeTransferIn: true }, { limit: 6 }),
        dashboard.upcomingRecurring(db, today, 5),
        dashboard.counts(db),
      ]);
      const primaryCurrency =
        Object.entries(nw).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] ?? "EUR";
      const comparison = await dashboard.monthlyComparison(db, primaryCurrency, comparisonMonths, today);
      return { netWorth: nw, primaryCurrency, flow, savings, recent, upcoming, comparison, counts };
    },
  });
}

/** Per-currency net-worth-over-time series (one line per currency). */
export function useNetWorthHistoryAll() {
  return useQuery({
    queryKey: ["history", "networthAll"],
    queryFn: async () => {
      const db = await getDb();
      const excluded = settingsRepo.parseNetWorthExcluded((await settingsRepo.getSettings(db)).net_worth_excluded_json);
      return history.netWorthHistoryAll(db, excluded);
    },
  });
}

/** Per-row current-month movements for the month-detail modal (incl. excluded). */
export function useMonthlyMovements(direction: "in" | "out" | null) {
  return useQuery({
    queryKey: ["dashboard", "monthMovements", direction],
    enabled: direction != null,
    queryFn: async () => {
      if (direction == null) return [];
      const db = await getDb();
      const today = todayISO();
      return dashboard.monthlyMovements(db, direction, monthStart(today), monthEnd(today));
    },
  });
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    queryFn: async (): Promise<SearchItem[]> => searchAll(await getDb(), q, 8),
    enabled: q.trim().length >= 2,
    staleTime: 5_000,
  });
}

// ---- recurring ----
export function useRecurring() {
  return useQuery({
    queryKey: ["recurring"],
    queryFn: async () => {
      const db = await getDb();
      const today = todayISO();
      const [items, summary] = await Promise.all([
        recurring.listRecurring(db, today),
        recurring.monthlySummary(db),
      ]);
      return { items, summary, today };
    },
  });
}

function useRecurringMutation<TArgs, TResult>(fn: (db: import("./types").SqlExecutor, a: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: TArgs) => {
      const db = await getDb();
      return withTxAndCleanup(db, (tx) => fn(tx, a));
    },
    onSuccess: () => invalidateMoney(qc),
  });
}
export const useCreateRecurring = () => useRecurringMutation((db, data: recurring.NewRecurring) => recurring.createRecurring(db, data));
export const useUpdateRecurring = () => useRecurringMutation((db, v: { id: number; patch: recurring.RecurringPatch }) => recurring.updateRecurring(db, v.id, v.patch));
export const useDeleteRecurring = () => useRecurringMutation((db, id: number) => recurring.deleteRecurring(db, id));
export const useApplyRecurring = () => useRecurringMutation((db, v: { id: number; amount?: number; note?: string }) => recurring.applyRecurringById(db, v.id, { amount: v.amount, note: v.note }, todayISO()));

// ---- notifications ----
// New notifications arrive out-of-band (the boot scheduler, source ops). Poll a
// modest 30s — matching the legacy base.html setInterval — so the badge, page
// and bell dropdown surface them without a manual refresh.
const NOTIF_POLL_MS = 30_000;
/** Per-page size for the notifications page (matches the legacy per_page=20). */
export const NOTIF_PAGE_SIZE = 20;

export interface NotificationsPage {
  items: notifications.NotificationRow[];
  total: number;
}

/** Paginated + filtered notifications with the matching total count. */
export function useNotifications(
  page = 1,
  filter: notifications.NotificationFilter = {},
  pageSize = NOTIF_PAGE_SIZE,
) {
  return useQuery({
    queryKey: ["notifications", "list", page, filter, pageSize],
    refetchInterval: NOTIF_POLL_MS,
    queryFn: async (): Promise<NotificationsPage> => {
      const db = await getDb();
      const offset = (page - 1) * pageSize;
      const [items, total] = await Promise.all([
        notifications.listNotifications(db, { ...filter, limit: pageSize, offset }),
        notifications.countNotifications(db, filter),
      ]);
      return { items, total };
    },
  });
}

/** Recent unread notifications for the topbar bell dropdown (newest first). */
export function useRecentUnread(limit = 5) {
  return useQuery({
    queryKey: ["notifications", "recent", limit],
    refetchInterval: NOTIF_POLL_MS,
    queryFn: async () =>
      notifications.listNotifications(await getDb(), { unreadOnly: true, limit }),
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ["notifications", "unread"],
    refetchInterval: NOTIF_POLL_MS,
    queryFn: async () => notifications.unreadCount(await getDb()),
  });
}

/**
 * Global read/unread counts across the WHOLE table (not the current page slice).
 * The bulk actions ("Mark all read", "Delete read") act table-wide, so their
 * enabled state must be driven by these, not by the visible rows.
 */
export function useNotificationCounts() {
  return useQuery({
    queryKey: ["notifications", "counts"],
    refetchInterval: NOTIF_POLL_MS,
    queryFn: async () => {
      const db = await getDb();
      const [total, unread] = await Promise.all([
        notifications.countNotifications(db, {}),
        notifications.unreadCount(db),
      ]);
      return { total, unread, read: total - unread };
    },
  });
}
function useNotifMutation<TArgs, TResult>(fn: (db: import("./types").SqlExecutor, a: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: TArgs) => fn(await getDb(), a),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
export const useMarkRead = () => useNotifMutation((db, id: number) => notifications.markRead(db, id));
export const useMarkAllRead = () => useNotifMutation((db, _: void) => notifications.markAllRead(db));
export const useDeleteNotification = () => useNotifMutation((db, id: number) => notifications.deleteNotification(db, id));
export const useDeleteAllRead = () => useNotifMutation((db, _: void) => notifications.deleteAllRead(db));

// ---- budgets / goals / whims (money-moving → broad invalidation) ----
function useBroadMutation<TArgs, TResult>(fn: (db: import("./types").SqlExecutor, a: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: TArgs) => {
      const db = await getDb();
      return withTxAndCleanup(db, (tx) => fn(tx, a));
    },
    onSuccess: () => invalidateMoney(qc),
  });
}

export function useBudgets(offset = 0) {
  return useQuery({ queryKey: ["budgets", offset], queryFn: async () => budgets.listBudgetStatuses(await getDb(), offset) });
}
export const useCreateBudget = () => useBroadMutation((db, data: budgets.NewBudget) => budgets.createBudget(db, data));
export const useUpdateBudget = () => useBroadMutation((db, v: { id: number; patch: budgets.BudgetPatch }) => budgets.updateBudget(db, v.id, v.patch));
export const useDeleteBudget = () => useBroadMutation((db, id: number) => budgets.deleteBudget(db, id));

export function useGoals() {
  return useQuery({ queryKey: ["goals"], queryFn: async () => goals.listGoals(await getDb()) });
}
export const useCreateGoal = () => useBroadMutation((db, data: goals.NewGoal) => goals.createGoal(db, data));
export const useUpdateGoal = () => useBroadMutation((db, v: { id: number; patch: goals.GoalPatch }) => goals.updateGoal(db, v.id, v.patch));
export const useAllocate = () => useBroadMutation((db, v: { goalId: number; input: goals.AllocateInput }) => goals.allocate(db, v.goalId, v.input));
export function useGoalAllocations(goalId: number | null) {
  return useQuery({
    queryKey: ["goalAllocations", goalId],
    enabled: goalId != null,
    queryFn: async () => (goalId != null ? goals.listAllocations(await getDb(), goalId) : []),
  });
}
export const useDeleteAllocation = () => useBroadMutation((db, id: number) => goals.deleteAllocation(db, id));
export const useCloseGoal = () => useBroadMutation((db, v: { id: number; toSourceId: number; date?: string }) => goals.closeGoal(db, v.id, v.toSourceId, v.date));
export const useDeleteGoal = () => useBroadMutation((db, id: number) => goals.deleteGoal(db, id));

export function useWhims() {
  return useQuery({ queryKey: ["whims"], queryFn: async () => whims.listWhims(await getDb()) });
}
export const useCreateWhim = () => useBroadMutation((db, data: whims.NewWhim) => whims.createWhim(db, data));
export const useUpdateWhim = () => useBroadMutation((db, v: { id: number; patch: whims.WhimPatch }) => whims.updateWhim(db, v.id, v.patch));
export const usePurchaseWhim = () => useBroadMutation((db, v: { id: number; sourceId: number; note?: string; tagIds?: number[]; amount?: number }) => whims.purchaseWhim(db, v.id, { sourceId: v.sourceId, note: v.note, tagIds: v.tagIds, amount: v.amount }));
export const useDismissWhim = () => useBroadMutation((db, id: number) => whims.dismissWhim(db, id));
export const useRestoreWhim = () => useBroadMutation((db, id: number) => whims.restoreWhim(db, id));
export const useDeleteWhim = () => useBroadMutation((db, id: number) => whims.deleteWhim(db, id));
export const useStartSaving = () => useBroadMutation((db, id: number) => whims.startSavingForWhim(db, id));

// ---- portfolios ----
export function usePortfolioHistory(id: number) {
  return useQuery({
    queryKey: ["history", "portfolio", id],
    queryFn: async () => portfolios.portfolioValueHistory(await getDb(), id, 3650),
  });
}
/** Per-holding price/value history (full range; sliced client-side by RangeChart). */
export function useHoldingHistory(id: number | null) {
  return useQuery({
    queryKey: ["history", "holding", id],
    enabled: id != null,
    queryFn: async () => (id != null ? portfolios.holdingPriceHistory(await getDb(), id, 3650) : []),
  });
}
export function usePortfolios() {
  return useQuery({
    queryKey: ["portfolios"],
    queryFn: async () => {
      const db = await getDb();
      const list = await portfolios.listPortfolios(db);
      return Promise.all(list.map((p) => portfolios.summarizePortfolio(db, p.id)));
    },
  });
}

/** Detailed portfolios view: per-portfolio summaries (with weights + recent change)
 *  plus the cross-portfolio aggregate overview & asset-class allocation. */
export function usePortfoliosView(displayCurrency?: string) {
  return useQuery({
    queryKey: ["portfolios", "view", displayCurrency ?? null],
    queryFn: async () => portfolios.portfoliosView(await getDb(), displayCurrency),
  });
}
function usePortfolioMutation<TArgs, TResult>(fn: (db: import("./types").SqlExecutor, a: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: TArgs) => {
      const db = await getDb();
      return withTxAndCleanup(db, (tx) => fn(tx, a));
    },
    // A holding/portfolio edit moves money the Sources page counts
    // (portfolio_value / total_value) and re-shapes the value-history charts.
    onSuccess: () => {
      for (const k of ["portfolios", "dashboard", "consolidated", "sources", "history"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}
export const useCreatePortfolio = () => usePortfolioMutation((db, data: portfolios.NewPortfolio) => portfolios.createPortfolio(db, data));
export const useDeletePortfolio = () => usePortfolioMutation((db, id: number) => portfolios.deletePortfolio(db, id));
/**
 * Add a holding, then immediately fetch its price. Without this the new row sits
 * at cost basis until the next 15-minute tick — which reads as the app showing a
 * wrong value (an ICP bought at 13.20 kept being valued at 13.20). The fetch runs
 * AFTER the write commits (network work must never sit inside a transaction) and
 * fails soft: an outage just leaves the price to the next refresh.
 */
export function useCreateHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: portfolios.NewHolding) => {
      const db = await getDb();
      const id = await withTxAndCleanup(db, (tx) => portfolios.createHolding(tx, data));
      if (!data.manual_price && (await portfolios.arePricesEnabled(db))) {
        try {
          await prices.refreshHolding(db, id);
        } catch {
          /* offline / provider down — the periodic refresh will catch it */
        }
      }
      return id;
    },
    onSuccess: () => {
      for (const k of ["portfolios", "dashboard", "consolidated", "sources", "history"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}
export const useUpdateHolding = () => usePortfolioMutation((db, v: { id: number; patch: portfolios.HoldingPatch }) => portfolios.updateHolding(db, v.id, v.patch));
export const useDeleteHolding = () => usePortfolioMutation((db, id: number) => portfolios.deleteHolding(db, id));

// ---- live price refresh (opt-in; CoinGecko + Yahoo via the http transport) ----
// Refreshes run OUTSIDE withTx: they're network-bound and write per-holding, so
// holding a single SQLite transaction open across slow HTTP calls would stall the
// pool. The repo functions persist each successful holding individually + fail
// soft on network errors. After a refresh we invalidate every money-derived view
// (portfolio value feeds net worth/dashboard/consolidated) + record the throttle.
function invalidatePriceViews(qc: ReturnType<typeof useQueryClient>) {
  invalidateMoney(qc);
  void qc.invalidateQueries({ queryKey: ["history"] });
}

/** Manual "Refresh prices" — gated off returns 0, never throws. Returns count updated. */
export function useRefreshPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const db = await getDb();
      const updated = await prices.refreshAllHoldings(db);
      if (updated > 0) await settingsRepo.setLastPriceRefreshAt(db);
      return updated;
    },
    onSuccess: () => invalidatePriceViews(qc),
  });
}

/** Per-holding refresh icon. Skips manual-price holdings (returns false). */
export function useRefreshHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => prices.refreshHolding(await getDb(), id),
    onSuccess: () => invalidatePriceViews(qc),
  });
}

/** Type-ahead symbol search for the add-holding form (CoinGecko / Yahoo). Disabled
 *  until 2+ chars; cached for 5 min; never touches the DB. */
export function useAssetSearch(assetClass: "crypto" | "stock", query: string) {
  return useQuery({
    queryKey: ["asset-search", assetClass, query.trim().toUpperCase()],
    enabled: query.trim().length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => prices.searchAssets(assetClass, query),
  });
}

// ---- backup / restore / csv import ----
export function useImportBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (bytes: Uint8Array) => importFile(await getDb(), bytes),
    onSuccess: () => void qc.invalidateQueries(), // a restore touches everything
  });
}
/** Danger zone: wipe all data and re-seed default tags (settings preserved). */
export function useResetAllData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => resetAllData(await getDb()),
    onSuccess: () => void qc.invalidateQueries(), // a reset touches everything
  });
}
export const useCommitCsv = () => useBroadMutation((db, input: Parameters<typeof commitCsv>[1]) => commitCsv(db, input));
/** Undo a just-committed import by deleting exactly the movements it created. */
export const useUndoImport = () => useBroadMutation((db, movementIds: number[]) => undoImport(db, movementIds));

// ---- settings / preferences ----
export function usePreferences() {
  return useQuery({ queryKey: ["settings"], queryFn: async () => settingsRepo.getSettings(await getDb()) });
}
export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: settingsRepo.SettingsPatch) => settingsRepo.updateSettings(await getDb(), patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      // net_worth_excluded_json / base_currency both change the consolidated total
      // and the net-worth history series.
      void qc.invalidateQueries({ queryKey: ["consolidated"] });
      void qc.invalidateQueries({ queryKey: ["history"] });
    },
  });
}

export const useCreateMovement = () =>
  useMoneyMutation((db, data: movements.NewMovement) => movements.createMovement(db, data));
export const useUpdateMovement = () =>
  useMoneyMutation((db, v: { id: number; patch: movements.MovementPatch }) =>
    movements.updateMovement(db, v.id, v.patch),
  );
export const useDeleteMovement = () =>
  useMoneyMutation((db, id: number) => movements.deleteMovement(db, id));
export const useCreateTransfer = () =>
  useMoneyMutation((db, t: movements.NewTransfer) => movements.createTransfer(db, t));
export const useUpdateTransfer = () =>
  useMoneyMutation((db, v: { outLegId: number; patch: movements.TransferPatch }) =>
    movements.updateTransfer(db, v.outLegId, v.patch),
  );
export const useBulkDelete = () =>
  useMoneyMutation((db, ids: number[]) => movements.bulkDelete(db, ids));
export const useBulkSetTags = () =>
  useMoneyMutation((db, v: { ids: number[]; tagIds: number[]; mode: movements.TagMode }) =>
    movements.bulkSetTags(db, v.ids, v.tagIds, v.mode),
  );
export const useBulkSetSource = () =>
  useMoneyMutation((db, v: { ids: number[]; sourceId: number | null }) =>
    movements.bulkSetSource(db, v.ids, v.sourceId),
  );
export const useToggleExclude = () =>
  useMoneyMutation((db, id: number) => movements.toggleExclude(db, id));
export const useBulkSetExclude = () =>
  useMoneyMutation((db, v: { ids: number[]; value: boolean }) =>
    movements.bulkSetExclude(db, v.ids, v.value),
  );
/** Make a recurring rule from a movement (rolls next_due_date past today). */
export const useMakeRecurring = () =>
  useRecurringMutation((db, v: { movementId: number; frequency: string; applyMode: "auto" | "confirm" }) =>
    recurring.makeRecurringFromMovement(db, v.movementId, v.frequency, v.applyMode, todayISO()),
  );

// ---- NEW features: split / forecast / consolidated ----
export const useCreateSplit = () => useMoneyMutation((db, input: NewSplit) => createSplit(db, input));

export function useForecast(horizonDays = 90) {
  return useQuery({
    queryKey: ["forecast", horizonDays],
    queryFn: async () => forecastCashflow(await getDb(), horizonDays, todayISO()),
  });
}

export function useConsolidated(base: string | null) {
  return useQuery({
    queryKey: ["consolidated", base],
    enabled: !!base,
    queryFn: async () => {
      const db = await getDb();
      const excluded = settingsRepo.parseNetWorthExcluded((await settingsRepo.getSettings(db)).net_worth_excluded_json);
      return consolidatedNetWorth(db, base as string, excluded);
    },
  });
}
