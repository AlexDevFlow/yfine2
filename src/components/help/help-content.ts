/**
 * Bundled help HTML, loaded at build time via Vite's glob import. The raw
 * files live under src/help-content/ (copied verbatim from the original Flask
 * templates/help/). We re-key the glob's absolute-ish paths to bare basenames
 * (e.g. "dashboard.it.html") so the resolver can address them by file name.
 */
const RAW = import.meta.glob("../../help-content/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** path -> html, re-keyed to bare basename. */
export const HELP_CONTENT: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, html]) => {
    const base = path.split("/").pop() ?? path;
    return [base, html];
  }),
);
