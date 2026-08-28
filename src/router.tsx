import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
// Page components are lazy-loaded (route-level code-splitting) so the webview
// doesn't parse the whole app on launch. The root layout/app-shell is imported
// eagerly because it renders at boot. `defaultPreload: "intent"` below still
// hover-prefetches each page chunk, so nav latency stays hidden.
import { AppShell } from "@/components/layout/app-shell";

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() =>
    import("@/pages/dashboard").then((m) => ({ default: m.Dashboard }))
  ),
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: lazyRouteComponent(() =>
    import("@/pages/sources").then((m) => ({ default: m.SourcesPage }))
  ),
  // `?create=1` opens the New Source form immediately (dashboard quick action).
  validateSearch: (search: Record<string, unknown>): { create?: boolean } =>
    search.create ? { create: true } : {},
});

const sourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources/$id",
  component: lazyRouteComponent(() =>
    import("@/pages/source-detail").then((m) => ({ default: m.SourceDetail }))
  ),
});

interface MovementsSearch {
  tagIds?: number[];
  /** Pre-applied direction filter (e.g. from the dashboard month modal). */
  direction?: "in" | "out";
  /** Pre-applied "from" date (e.g. month start from the dashboard month modal). */
  dateFrom?: string;
  /** Pre-applied "to" date (breakdown drill-downs carry a full range). */
  dateTo?: string;
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
  component: lazyRouteComponent(() =>
    import("@/pages/movements").then((m) => ({ default: m.MovementsPage }))
  ),
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
    if (typeof search.dateTo === "string" && search.dateTo) out.dateTo = search.dateTo;
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
  component: lazyRouteComponent(() =>
    import("@/pages/recurring").then((m) => ({ default: m.RecurringPage }))
  ),
  // `?create=1` opens the New Recurring form immediately (dashboard quick action).
  validateSearch: (search: Record<string, unknown>): { create?: boolean } =>
    search.create ? { create: true } : {},
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications",
  component: lazyRouteComponent(() =>
    import("@/pages/notifications").then((m) => ({ default: m.NotificationsPage }))
  ),
});

const budgetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/budgets",
  component: lazyRouteComponent(() =>
    import("@/pages/budgets").then((m) => ({ default: m.BudgetsPage }))
  ),
});
const goalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/goals",
  component: lazyRouteComponent(() =>
    import("@/pages/goals").then((m) => ({ default: m.GoalsPage }))
  ),
});
const whimsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/whims",
  component: lazyRouteComponent(() =>
    import("@/pages/whims").then((m) => ({ default: m.WhimsPage }))
  ),
});
const portfoliosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/portfolios",
  component: lazyRouteComponent(() =>
    import("@/pages/portfolios").then((m) => ({ default: m.PortfoliosPage }))
  ),
});
const savingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/savings",
  component: lazyRouteComponent(() =>
    import("@/pages/savings").then((m) => ({ default: m.SavingsPage }))
  ),
  // Allow a global-search deep-link to a specific saving.
  validateSearch: (search: Record<string, unknown>): { focus?: number } => {
    const focus = Number(search.focus);
    return Number.isFinite(focus) && focus > 0 ? { focus } : {};
  },
});
const tagsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tags",
  component: lazyRouteComponent(() =>
    import("@/pages/tags").then((m) => ({ default: m.TagsPage }))
  ),
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: lazyRouteComponent(() =>
    import("@/pages/settings").then((m) => ({ default: m.SettingsPage }))
  ),
});

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
