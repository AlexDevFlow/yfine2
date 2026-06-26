import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDb } from "./connection";
import * as sources from "./repo/sources";
import * as movements from "./repo/movements";
import * as dashboard from "./repo/dashboard";
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
import { convert } from "./repo/exchange-rates";
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

// Every money-derived view. Mutations that can ripple anywhere money lives
// (goal allocations, whim purchases, budget rules, restores, tag merges)
// invalidate the lot — cheap against the local DB and avoids subtle stale views.
const MONEY_KEYS = ["movements", "sources", "dashboard", "budgets", "goals", "whims", "recurring", "forecast", "consolidated", "portfolios", "notifications", "savings", "history", "movementCounts", "goalAllocations"];
function invalidateMoney(qc: ReturnType<typeof useQueryClient>) {
  for (const k of MONEY_KEYS) void qc.invalidateQueries({ queryKey: [k] });
}

// Plain movement ops (create/edit/delete/transfer/split/bulk) write only to
// `movements`/`movement_tag`; they never touch recurring/whim/goal/portfolio
// definitions or generate notifications (those come from the boot scheduler and
// source ops). So they only need the views *derived* from movements — sparing a
// refetch of the always-mounted notification badge on every single edit.
const MOVEMENT_KEYS = ["movements", "sources", "dashboard", "budgets", "forecast", "consolidated", "savings", "history", "movementCounts"];
function invalidateMovementMoney(qc: ReturnType<typeof useQueryClient>) {
  for (const k of MOVEMENT_KEYS) void qc.invalidateQueries({ queryKey: [k] });
}

export interface SourceWithBalance extends SourceRow {
  balance: number;
}

export function useSources() {
  return useQuery({
    queryKey: ["sources"],
    queryFn: async (): Promise<SourceWithBalance[]> => {
      const db = await getDb();
      const [list, balances] = await Promise.all([
        sources.listSources(db, { includeHidden: true }),
        sources.getBalancesBatch(db),
      ]);
      return list.map((s) => ({
        ...s,
        balance: balances.get(s.id) ?? round2(s.starting_balance),
      }));
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useUpdateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: number; patch: sources.SourcePatch }) => {
      const db = await getDb();
      return sources.updateSource(db, v.id, v.patch);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
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
      return withTx(db, (tx) => sources.deleteSource(tx, v.id, v.action));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["sources"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
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
      return withTx(db, (tx) => sources.mergeSources(tx, v.fromId, v.toId));
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
      return withTx(db, (tx) => fn(tx, a));
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
      from && to ? convert(await getDb(), amount, from, to) : null,
    staleTime: 60_000,
  });
}

/** Money mutations run atomically (withTx) and refresh every derived view. */
function useMoneyMutation<TArgs, TResult>(fn: (db: import("./types").SqlExecutor, args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: TArgs) => {
      const db = await getDb();
      return withTx(db, (tx) => fn(tx, args));
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
      const [nw, flow, savings, recent, upcoming, counts] = await Promise.all([
        dashboard.netWorth(db),
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
    queryFn: async () => history.netWorthHistoryAll(await getDb()),
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
      return withTx(db, (tx) => fn(tx, a));
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
      return withTx(db, (tx) => fn(tx, a));
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
      return withTx(db, (tx) => fn(tx, a));
    },
    onSuccess: () => {
      for (const k of ["portfolios", "dashboard", "consolidated"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}
export const useCreatePortfolio = () => usePortfolioMutation((db, data: portfolios.NewPortfolio) => portfolios.createPortfolio(db, data));
export const useDeletePortfolio = () => usePortfolioMutation((db, id: number) => portfolios.deletePortfolio(db, id));
export const useCreateHolding = () => usePortfolioMutation((db, data: portfolios.NewHolding) => portfolios.createHolding(db, data));
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
    queryFn: async () => consolidatedNetWorth(await getDb(), base as string),
  });
}
