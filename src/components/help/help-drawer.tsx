import { HelpCircle, X } from "lucide-react";
import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { HELP_CONTENT } from "./help-content";
import { pageKeyForPath, resolveHelp } from "./help-resolver";

/**
 * Right-side contextual help drawer — faithful port of base.html's #helpDrawer
 * offcanvas. Shows help for the CURRENT route in the active locale, with the
 * en→default fallback cascade. Content is app-bundled/trusted HTML, rendered
 * via dangerouslySetInnerHTML inside the `.yn-help-body` styled container.
 */
export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const page = pageKeyForPath(pathname);
  const resolved = resolveHelp(HELP_CONTENT, page, i18n.resolvedLanguage ?? "en");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={t("help", { defaultValue: "Help" })}>
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onMouseDown={onClose} />
      <aside className="yn-help-drawer flex h-full flex-col bg-surface shadow-[var(--shadow-pop)]">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <HelpCircle className="h-5 w-5 text-primary" />
            {t("help", { defaultValue: "Help" })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close", { defaultValue: "Close" })}
            className="text-muted transition-colors hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="yn-help-body flex-1 overflow-y-auto">
          {resolved ? (
            <div dangerouslySetInnerHTML={{ __html: resolved.html }} />
          ) : (
            <p className="text-sm text-muted">{t("no_help_available", { defaultValue: "No help available for this page." })}</p>
          )}
        </div>
      </aside>
    </div>
  );
}
