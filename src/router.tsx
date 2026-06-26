import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell";
import { Dashboard } from "@/pages/dashboard";
import { SourcesPage } from "@/pages/sources";
import { SourceDetail } from "@/pages/source-detail";
import { MovementsPage } from "@/pages/movements";
import { RecurringPage } from "@/pages/recurring";
import { NotificationsPage } from "@/pages/notifications";
import { BudgetsPage } from "@/pages/budgets";
import { GoalsPage } from "@/pages/goals";
import { WhimsPage } from "@/pages/whims";
import { PortfoliosPage } from "@/pages/portfolios";
import { SavingsPage } from "@/pages/savings";
import { TagsPage } from "@/pages/tags";
import { SettingsPage } from "@/pages/settings";

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: SourcesPage,
  // `?create=1` opens the New Source form immediately (dashboard quick action).
  validateSearch: (search: Record<string, unknown>): { create?: boolean } =>
    search.create ? { create: true } : {},
});

const sourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources/$id",
  component: SourceDetail,
});

interface MovementsSearch {
  tagIds?: number[];
  /** Pre-applied direction filter (e.g. from the dashboard month modal). */
  direction?: "in" | "out";
  /** Pre-applied "from" date (e.g. month start from the dashboard month modal). */
  dateFrom?: string;
  /** Movement id to scroll-to-and-highlight (global search deep-link). */
  focus?: number;
  /** Open the create form immediately (dashboard quick actions). */
  create?: "movement" | "transfer";
  /** Pre-select this source in the new-movement form (sources page "+" action). */
  source_id?: number;
}

const movementsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/movements",
  component: MovementsPage,
  // Allow deep-linking a pre-applied tag filter (budget card), a direction +
  // from-date (dashboard month modal), or a focused movement id (global search).
  validateSearch: (search: Record<string, unknown>): MovementsSearch => {
    const raw = search.tagIds;
    const arr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const tagIds = arr.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
    const out: MovementsSearch = {};
    if (tagIds.length) out.tagIds = tagIds;
    if (search.direction === "in" || search.direction === "out") out.direction = search.direction;
    if (typeof search.dateFrom === "string" && search.dateFrom) out.dateFrom = search.dateFrom;
    const focus = Number(search.focus);
    if (Number.isFinite(focus) && focus > 0) out.focus = focus;
    if (search.create === "movement" || search.create === "transfer") out.create = search.create;
    const sourceId = Number(search.source_id);
    if (Number.isFinite(sourceId) && sourceId > 0) out.source_id = sourceId;
    return out;
  },
});

const recurringRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recurring",
  component: RecurringPage,
  // `?create=1` opens the New Recurring form immediately (dashboard quick action).
  validateSearch: (search: Record<string, unknown>): { create?: boolean } =>
    search.create ? { create: true } : {},
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications",
  component: NotificationsPage,
});

const budgetsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/budgets", component: BudgetsPage });
const goalsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/goals", component: GoalsPage });
const whimsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/whims", component: WhimsPage });
const portfoliosRoute = createRoute({ getParentRoute: () => rootRoute, path: "/portfolios", component: PortfoliosPage });
const savingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/savings",
  component: SavingsPage,
  // Allow a global-search deep-link to a specific saving.
  validateSearch: (search: Record<string, unknown>): { focus?: number } => {
    const focus = Number(search.focus);
    return Number.isFinite(focus) && focus > 0 ? { focus } : {};
  },
});
const tagsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tags", component: TagsPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  sourcesRoute,
  sourceDetailRoute,
  movementsRoute,
  recurringRoute,
  notificationsRoute,
  budgetsRoute,
  goalsRoute,
  whimsRoute,
  portfoliosRoute,
  savingsRoute,
  tagsRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
