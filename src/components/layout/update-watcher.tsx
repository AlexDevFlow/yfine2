/**
 * Launch-time auto-update check. Active only when the user opted in
 * (settings.auto_update_check) AND we're running under Tauri. Runs once per app
 * start, in the background: if a newer signed release exists it raises a
 * non-blocking toast with an "Install & restart" action. Completely silent when
 * disabled, offline, or already up to date — it never blocks or nags.
 *
 * The detailed UI (manual check, release notes, download progress) lives in the
 * Settings → Updates card; this is just the gentle launch nudge.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePreferences } from "@/db/queries";
import { useToast } from "@/components/ui/toast";
import { isTauri } from "@/lib/tauri";
import { checkForUpdate, installPendingUpdate } from "@/lib/updater";

export function UpdateWatcher() {
  const { t } = useTranslation();
  const { data: prefs } = usePreferences();
  const { push } = useToast();
  const ran = useRef(false);

  const enabled = isTauri() && (prefs?.auto_update_check ?? 0) === 1;

  useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true; // once per launch, even if prefs re-emit
    let cancelled = false;

    void (async () => {
      const state = await checkForUpdate();
      if (cancelled || state.kind !== "available") return; // silent unless actionable

      const install = async () => {
        push({
          id: "update-installing",
          title: t("update_downloading", { defaultValue: "Downloading update…" }),
          tone: "info",
          duration: 60000,
        });
        try {
          await installPendingUpdate(); // relaunches on success
        } catch (e) {
          push({
            id: "update-error",
            title: t("update_failed", { defaultValue: "Update failed" }),
            body: e instanceof Error ? e.message : String(e),
            tone: "alert",
          });
        }
      };

      push({
        id: "update-available", // stable id de-dupes if prefs re-render
        title: t("update_available_title", { defaultValue: "Update available" }),
        body: t("update_available_body", {
          defaultValue: "Version {{version}} is ready to install.",
          version: state.version,
        }),
        tone: "info",
        duration: 30000,
        action: {
          label: t("update_install", { defaultValue: "Install & restart" }),
          onClick: () => void install(),
        },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, push, t]);

  return null;
}
