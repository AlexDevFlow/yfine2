import { useMemo } from "react";
import { usePreferences } from "@/db/queries";
import { resolveNavLayout, type ResolvedNavItem } from "./nav";

/**
 * Resolve the user's saved sidebar layout (order + visibility) on top of the
 * defaults. Reads nav_layout_json from the settings row; falls back to the
 * full default nav while preferences are still loading.
 */
export function useNavLayout(): ResolvedNavItem[] {
  const { data: prefs } = usePreferences();
  const json = prefs?.nav_layout_json;
  return useMemo(() => resolveNavLayout(json), [json]);
}
