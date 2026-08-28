import { Sparkles, Wrench, Bug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/date";
import { pick, type ChangeKind, type ChangelogEntry } from "@/lib/changelog";

const KIND: Record<ChangeKind, { icon: typeof Sparkles; labelKey: string; label: string; className: string }> = {
  new: { icon: Sparkles, labelKey: "changelog_new", label: "New", className: "bg-accent-soft text-primary" },
  improved: { icon: Wrench, labelKey: "changelog_improved", label: "Improved", className: "bg-positive-soft text-positive" },
  fixed: { icon: Bug, labelKey: "changelog_fixed", label: "Fixed", className: "bg-warning-soft text-warning" },
};

/**
 * Release notes for one version. Opens by itself on the first launch after an
 * update (see the app shell) and on demand from Settings.
 */
export function ChangelogModal({ entry, open, onClose, dateFormat }: {
  entry: ChangelogEntry;
  open: boolean;
  onClose: () => void;
  dateFormat?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={t("whats_new_in", { defaultValue: "What's new in {{version}}", version: entry.version })}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {entry.headline && (
            <p className="max-w-prose text-sm text-muted">{pick(entry.headline, lang)}</p>
          )}
          <span className="shrink-0 text-xs text-muted-2">{formatDate(entry.date, dateFormat, lang)}</span>
        </div>

        <ul className="space-y-3">
          {entry.items.map((item, i) => {
            const kind = KIND[item.kind];
            const Icon = kind.icon;
            return (
              <li key={i} className="rounded-[var(--radius-control)] border border-border p-3">
                <div className="flex items-start gap-2.5">
                  <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-control)]", kind.className)}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{pick(item.title, lang)}</span>
                      <span className={cn("rounded-[var(--radius-control)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", kind.className)}>
                        {t(kind.labelKey, { defaultValue: kind.label })}
                      </span>
                    </p>
                    {item.body && <p className="mt-1 text-sm leading-relaxed text-muted">{pick(item.body, lang)}</p>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex justify-end">
          <Button onClick={onClose}>{t("got_it", { defaultValue: "Got it" })}</Button>
        </div>
      </div>
    </Modal>
  );
}
