import { Briefcase, Database, Download, FileSpreadsheet, FileJson, FileText, Keyboard, Languages, ListOrdered, Lock, LogOut, Monitor, Moon, Palette, Shield, ShieldCheck, Sun, UploadCloud, Upload, FileUp, Undo2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Slot } from "@/components/ui/slot";
import {
  armEncryptionForSession,
  changeAppPassword,
  isPasswordSet,
  removeAppPassword,
  setAppPassword,
  setRuntimePassword,
} from "@/lib/auth-bridge";
import { isTauri } from "@/lib/tauri";
import { useTheme, type Theme } from "@/components/theme/theme-provider";
import { SUPPORTED_LANGS } from "@/i18n";
import { getDb, isPreviewDb } from "@/db/connection";
import { exportArchive, exportJson, exportMovementsCsv, previewBackup, type BackupPreview } from "@/db/backup";
import { exportExcel, exportPdf, EXPORT_SECTIONS, type SectionKey } from "@/db/exports";
import { PRESETS } from "@/db/importers/csv";
import { previewImport, FORMAT_OPTIONS, type ImportFile, type ImportFormat, type ImportPreview } from "@/db/importers/format";
import { useCommitCsv, useImportBackup, usePreferences, useResetAllData, useSources, useUndoImport, useUpdatePreferences } from "@/db/queries";
import { cn } from "@/lib/cn";
import { DATE_FORMATS, todayISO } from "@/lib/date";
import { downloadBytes, downloadText } from "@/lib/download";
import { useToast } from "@/components/ui/toast";
import { BASE_CURRENCY_CODES, currencyFlag, formatMoney } from "@/lib/format";
import { applyUiScale } from "@/lib/ui-scale";
import { useErrorText } from "@/lib/use-error-text";
import { HotkeysCard, MenuLayoutCard, MobileNavCard } from "./settings-navigation";

const THEME_OPTS: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
];

const UI_SCALES: { value: string; label: string }[] = [
  { value: "small", label: "Compact" },
  { value: "normal", label: "Normal" },
  { value: "large", label: "Large" },
  { value: "xlarge", label: "Extra large" },
];

/** Tema: theme picker + interface size + mobile navigation (og "appearance" tab). */
function AppearanceCard() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { data: prefs } = usePreferences();
  const update = useUpdatePreferences();
  const scale = prefs?.ui_scale ?? "normal";

  return (
    <>
      <Card>
        <CardHeader title={t("theme", { defaultValue: "Theme" })} />
        <CardContent className="space-y-5 pt-3">
          <Field label={t("theme", { defaultValue: "Theme" })}>
            <div className="flex flex-wrap gap-2">
              {THEME_OPTS.map((o) => {
                const Icon = o.icon;
                return (
                  <button key={o.value} type="button"
                    onClick={() => { setTheme(o.value); update.mutate({ theme: o.value }); }}
                    className={cn("flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border px-3 text-sm", theme === o.value ? "border-primary bg-accent-soft text-primary" : "border-border text-muted hover:text-foreground")}>
                    <Icon className="h-4 w-4" /> {t(`theme_${o.value}`, { defaultValue: o.label })}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label={t("ui_size", { defaultValue: "Interface size" })}>
            {(() => {
              const idx = Math.max(0, UI_SCALES.findIndex((o) => o.value === scale));
              return (
                <>
                  <input
                    type="range"
                    min={0}
                    max={UI_SCALES.length - 1}
                    step={1}
                    value={idx}
                    onChange={(e) => { const o = UI_SCALES[Number(e.target.value)]; applyUiScale(o.value); update.mutate({ ui_scale: o.value }); }}
                    className="ui-scale-range w-full"
                    aria-label={t("ui_size", { defaultValue: "Interface size" })}
                  />
                  <div className="mt-1.5 flex justify-between">
                    {UI_SCALES.map((o, i) => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => { applyUiScale(o.value); update.mutate({ ui_scale: o.value }); }}
                        className={cn("text-xs font-medium transition-colors", i === idx ? "text-primary" : "text-muted-2 hover:text-foreground")}
                      >
                        {t(`ui_size_${o.value}`, { defaultValue: o.label })}
                      </button>
                    ))}
                  </div>
                </>
              );
            })()}
            <p className="mt-1.5 text-xs text-muted">{t("ui_size_desc", { defaultValue: "Scale the whole interface up or down." })}</p>
          </Field>
        </CardContent>
      </Card>
      <MobileNavCard />
    </>
  );
}

/** Lingua: language + date format + base currency (og "language" tab). */
function LanguageCard() {
  const { t, i18n } = useTranslation();
  const { data: prefs } = usePreferences();
  const update = useUpdatePreferences();
  return (
    <Card>
      <CardHeader title={t("language", { defaultValue: "Language" })} />
      <CardContent className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-3">
        <Field label={t("language", { defaultValue: "Language" })} htmlFor="pref-lang">
          <Select id="pref-lang" value={i18n.resolvedLanguage} onChange={(e) => { void i18n.changeLanguage(e.target.value); update.mutate({ locale: e.target.value }); }}>
            {SUPPORTED_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
        </Field>
        <Field label={t("date_format", { defaultValue: "Date format" })} htmlFor="pref-date-format">
          <Select id="pref-date-format" value={prefs?.date_format ?? "dd/mm/yyyy"} onChange={(e) => update.mutate({ date_format: e.target.value })}>
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f === "dd/mm/yyyy" ? t("date_format_dmy", { defaultValue: "dd/mm/yyyy" })
                  : f === "mm/dd/yyyy" ? t("date_format_mdy", { defaultValue: "mm/dd/yyyy" })
                  : t("date_format_ymd", { defaultValue: "yyyy-mm-dd" })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("base_currency_setting", { defaultValue: "Base currency" })} htmlFor="pref-base-ccy">
          <Select id="pref-base-ccy" value={prefs?.base_currency ?? ""} onChange={(e) => update.mutate({ base_currency: e.target.value })}>
            <option value="">—</option>
            {BASE_CURRENCY_CODES.map((c) => (
              <option key={c} value={c}>{currencyFlag(c)} {c}</option>
            ))}
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}

/** Portafogli: live portfolio prices + hide-net-worth display toggle. */
function PortfoliosCard() {
  const { t } = useTranslation();
  const { data: prefs } = usePreferences();
  const update = useUpdatePreferences();
  return (
    <Card>
      <CardHeader title={t("portfolios", { defaultValue: "Portfolios" })} />
      <CardContent className="space-y-3 pt-3">
        <label className="flex items-start gap-3 rounded-[var(--radius-control)] border border-border p-3">
          <input type="checkbox" className="mt-0.5" checked={(prefs?.portfolio_prices_enabled ?? 0) === 1} onChange={(e) => update.mutate({ portfolio_prices_enabled: e.target.checked, portfolio_prices_prompted: true })} />
          <span>
            <span className="block text-sm font-medium text-foreground">{t("portfolio_prices_enabled_title", { defaultValue: "Live portfolio prices" })}</span>
            <span className="block text-xs text-muted">
              {(prefs?.portfolio_prices_enabled ?? 0) === 1
                ? t("portfolio_prices_on_desc", { defaultValue: "Prices are fetched online and refreshed periodically." })
                : t("portfolio_prices_off_desc", { defaultValue: "Prices stay manual — nothing is fetched online (opt-in)." })}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-[var(--radius-control)] border border-border p-3">
          <input type="checkbox" className="mt-0.5" checked={(prefs?.portfolio_charts_enabled ?? 0) === 1} onChange={(e) => update.mutate({ portfolio_charts_enabled: e.target.checked })} />
          <span>
            <span className="block text-sm font-medium text-foreground">{t("portfolio_charts_enabled_title", { defaultValue: "TradingView charts" })}</span>
            <span className="block text-xs text-muted">
              {(prefs?.portfolio_charts_enabled ?? 0) === 1
                ? t("portfolio_charts_on_desc", { defaultValue: "A chart button on each holding opens an embedded TradingView chart (loads content from tradingview.com)." })
                : t("portfolio_charts_off_desc", { defaultValue: "No external charts are loaded — enable to embed TradingView charts per holding (opt-in)." })}
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={(prefs?.hide_net_worth ?? 0) === 1} onChange={(e) => update.mutate({ hide_net_worth: e.target.checked })} />
          {t("hide_net_worth", { defaultValue: "Hide net worth by default" })}
        </label>
      </CardContent>
    </Card>
  );
}

/** Privacy mode behavior: hover-reveal toggle + optional unlock code. */
function PrivacyCard() {
  const { t } = useTranslation();
  const { data: prefs } = usePreferences();
  const update = useUpdatePreferences();
  const savedCode = prefs?.privacy_unlock_code ?? "";
  // null = not editing; a string = pending edit buffer for the code field.
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title={t("privacy_mode", { defaultValue: "Privacy mode" })} />
      <CardContent className="space-y-3 pt-3">
        <p className="text-xs text-muted">
          {t("privacy_mode_desc", { defaultValue: "Use the eye button in the top bar to blur every amount across the app. Configure how it behaves below." })}
        </p>
        <label className="flex items-start gap-3 rounded-[var(--radius-control)] border border-border p-3">
          <input type="checkbox" className="mt-0.5" checked={(prefs?.privacy_hover_reveal ?? 1) === 1} onChange={(e) => update.mutate({ privacy_hover_reveal: e.target.checked })} />
          <span>
            <span className="block text-sm font-medium text-foreground">{t("privacy_hover_reveal_title", { defaultValue: "Reveal on hover" })}</span>
            <span className="block text-xs text-muted">
              {t("privacy_hover_reveal_desc", { defaultValue: "When on, hovering a blurred amount briefly shows it. Turn off to keep everything hidden until you disable privacy mode." })}
            </span>
          </span>
        </label>
        <div className="rounded-[var(--radius-control)] border border-border p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground"><Lock className="h-3.5 w-3.5 text-muted" /> {t("privacy_unlock_code_title", { defaultValue: "Unlock code" })}</p>
          <p className="mt-0.5 text-xs text-muted">
            {t("privacy_unlock_code_desc", { defaultValue: "Optional. When set, this code is required to turn privacy mode off. It's a soft on-screen lock, not encryption." })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              type="password"
              inputMode="numeric"
              value={codeDraft ?? ""}
              onChange={(e) => setCodeDraft(e.target.value)}
              placeholder={savedCode ? "••••" : t("privacy_unlock_code_placeholder", { defaultValue: "Set a code" })}
              className="max-w-[160px]"
            />
            <Button size="sm" disabled={codeDraft == null} onClick={() => { update.mutate({ privacy_unlock_code: (codeDraft ?? "").trim() }); setCodeDraft(null); }}>
              {t("save", { defaultValue: "Save" })}
            </Button>
            {savedCode && (
              <Button size="sm" variant="ghost" onClick={() => { update.mutate({ privacy_unlock_code: "" }); setCodeDraft(null); }}>
                {t("clear", { defaultValue: "Clear" })}
              </Button>
            )}
          </div>
          {savedCode && codeDraft == null && <p className="mt-1.5 text-xs text-positive">{t("privacy_unlock_code_set", { defaultValue: "A code is set." })}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function SectionExportDialog({ mode, onClose }: { mode: "excel" | "pdf"; onClose: () => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<SectionKey>>(new Set(EXPORT_SECTIONS.map((s) => s.key)));
  const [busy, setBusy] = useState(false);
  const toggle = (k: SectionKey) => setSelected((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const { push } = useToast();
  const go = async () => {
    setBusy(true);
    try {
      const db = await getDb();
      const keys = [...selected];
      const path = mode === "excel"
        ? await downloadBytes(`yfine-export-${todayISO()}.xlsx`, await exportExcel(db, keys), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        : await downloadBytes(`yfine-export-${todayISO()}.pdf`, await exportPdf(db, keys), "application/pdf");
      push({ title: t("export_done", { defaultValue: "Export complete" }), body: path ?? undefined, tone: "success" });
      onClose();
    } catch (e) {
      push({ title: t("export_failed", { defaultValue: "Export failed" }), body: e instanceof Error ? e.message : String(e), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={mode === "excel" ? t("export_excel", { defaultValue: "Export to Excel" }) : t("export_pdf", { defaultValue: "Export to PDF" })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button disabled={busy || selected.size === 0} onClick={go}>{t("export", { defaultValue: "Export" })}</Button>
      </>}>
      <div className="space-y-2">
        <p className="text-sm text-muted">{t("export_sections_hint", { defaultValue: "Choose which sections to include." })}</p>
        {EXPORT_SECTIONS.map((s) => (
          <label key={s.key} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={selected.has(s.key)} onChange={() => toggle(s.key)} />
            {t(s.key, { defaultValue: s.label })}
          </label>
        ))}
      </div>
    </Modal>
  );
}

function ExportCard() {
  const { t } = useTranslation();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [sectionMode, setSectionMode] = useState<"excel" | "pdf" | null>(null);
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const path = await fn();
      push({ title: t("export_done", { defaultValue: "Export complete" }), body: path ?? undefined, tone: "success" });
    } catch (e) {
      push({ title: t("export_failed", { defaultValue: "Export failed" }), body: e instanceof Error ? e.message : String(e), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title={t("export_data", { defaultValue: "Export" })} subtitle={t("export_hint", { defaultValue: "Download a full backup or a spreadsheet." })} />
      <CardContent className="flex flex-wrap gap-2 pt-3">
        <Button variant="outline" disabled={busy} onClick={() => run(async () => downloadBytes(`yfine-export-${todayISO()}.yfine`, await exportArchive(await getDb(), new Date().toISOString()), "application/zip"))}>
          <Download className="h-4 w-4" /> {t("export_archive", { defaultValue: ".yfine archive" })}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => run(async () => downloadText(`yfine-export-${todayISO()}.json`, await exportJson(await getDb()), "application/json"))}>
          <FileJson className="h-4 w-4" /> JSON
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => run(async () => downloadText(`yfine-movements-${todayISO()}.csv`, await exportMovementsCsv(await getDb()), "text/csv"))}>
          <FileSpreadsheet className="h-4 w-4" /> {t("movements_csv", { defaultValue: "Movements CSV" })}
        </Button>
        <Button variant="outline" onClick={() => setSectionMode("excel")}>
          <FileSpreadsheet className="h-4 w-4" /> {t("excel", { defaultValue: "Excel" })}
        </Button>
        <Button variant="outline" onClick={() => setSectionMode("pdf")}>
          <FileText className="h-4 w-4" /> {t("pdf", { defaultValue: "PDF" })}
        </Button>
      </CardContent>
      {sectionMode && <SectionExportDialog mode={sectionMode} onClose={() => setSectionMode(null)} />}
    </Card>
  );
}

/** Modal: preview record counts in a backup before the destructive restore. */
function ImportPreviewModal({ preview, busy, onConfirm, onClose }: { preview: BackupPreview; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const core = preview.coreTables.filter((c) => c.count > 0);
  const plugins = preview.pluginTables.filter((c) => c.count > 0);
  return (
    <Modal open onClose={onClose} title={t("import_preview", { defaultValue: "Import Preview" })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>{t("restore_data", { defaultValue: "Restore" })}</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-warning">{t("restore_confirm", { defaultValue: "Restoring replaces ALL current data. Continue?" })}</p>
        <div className="flex flex-wrap gap-3 text-xs text-muted">
          <span>{preview.format === "yfine-archive" ? ".yfine" : "JSON"}</span>
          {preview.created_at && <span>{preview.created_at.slice(0, 10)}</span>}
          {preview.attachmentCount > 0 && <span>{t("attachments", { defaultValue: "Attachments" })}: {preview.attachmentCount}</span>}
        </div>
        <div className="max-h-72 overflow-y-auto rounded-[var(--radius-control)] border border-border">
          <table className="w-full text-sm">
            <tbody>
              {core.length === 0 && plugins.length === 0 && (
                <tr><td className="px-3 py-1.5 text-muted">{t("no_data", { defaultValue: "No data" })}</td></tr>
              )}
              {core.map((c) => (
                <tr key={c.table} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 text-muted">{t(c.table, { defaultValue: c.table })}</td>
                  <td className="num px-3 py-1.5 text-right text-foreground">{c.count}</td>
                </tr>
              ))}
              {plugins.map((c) => (
                <tr key={c.table} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 text-muted-2">{c.table}</td>
                  <td className="num px-3 py-1.5 text-right text-foreground">{c.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">{t("import_restart_notice", { defaultValue: "Some plugins will be installed or updated. A restart is required to fully activate them." })}</p>
      </div>
    </Modal>
  );
}

function RestoreCard() {
  const { t } = useTranslation();
  const errText = useErrorText();
  const importBackup = useImportBackup();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [pending, setPending] = useState<{ bytes: Uint8Array; preview: BackupPreview }>();

  const onFile = async (file: File) => {
    setMsg(undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      // Parse-only preview: shows record counts + restart notice before mutating.
      const preview = previewBackup(bytes);
      setPending({ bytes, preview });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };

  const confirmRestore = () => {
    if (!pending) return;
    importBackup.mutate(pending.bytes, {
      onSuccess: () => { setMsg({ ok: true, text: t("restore_ok", { defaultValue: "Backup restored." }) }); setPending(undefined); },
      onError: (e) => { setMsg({ ok: false, text: errText(e) }); setPending(undefined); },
    });
  };

  return (
    <Card>
      <CardHeader title={t("restore_data", { defaultValue: "Restore" })} subtitle={t("restore_hint", { defaultValue: "Import a .yfine archive or JSON backup (replaces everything)." })} />
      <CardContent className="pt-3">
        <input ref={fileRef} type="file" accept=".yfine,.json,application/zip,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
        <Button variant="outline" disabled={importBackup.isPending} onClick={() => fileRef.current?.click()}>
          <Upload className="h-4 w-4" />{" "}
          <Slot
            text={importBackup.isPending ? t("restoring", { defaultValue: "Restoring…" }) : t("choose_backup", { defaultValue: "Choose backup file" })}
            options={{ direction: importBackup.isPending ? "up" : "down" }}
          />
        </Button>
        {msg && <p className={cn("mt-2 text-sm", msg.ok ? "text-positive" : "text-negative")}>{msg.text}</p>}
      </CardContent>
      {pending && (
        <ImportPreviewModal preview={pending.preview} busy={importBackup.isPending} onConfirm={confirmRestore} onClose={() => setPending(undefined)} />
      )}
    </Card>
  );
}

/** Danger zone: wipe everything and re-seed default tags (data.py reset behavior). */
function DangerZoneCard() {
  const { t } = useTranslation();
  const errText = useErrorText();
  const reset = useResetAllData();
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const doReset = () => {
    reset.mutate(undefined, {
      onSuccess: () => { setMsg({ ok: true, text: t("reset_done", { defaultValue: "All data has been reset." }) }); setConfirming(false); },
      onError: (e) => { setMsg({ ok: false, text: errText(e) }); setConfirming(false); },
    });
  };

  return (
    <Card>
      <CardHeader title={t("danger_zone", { defaultValue: "Danger zone" })} subtitle={t("reset_all_data_confirm_1", { defaultValue: "Do you want to delete all your data? This includes every source, movement, tag, recurring item, saving, wishlist entry, and notification." })} />
      <CardContent className="pt-3">
        <Button variant="danger" disabled={reset.isPending} onClick={() => setConfirming(true)}>
          <Trash2 className="h-4 w-4" /> {t("reset_all_data", { defaultValue: "Reset all data" })}
        </Button>
        {msg && <p className={cn("mt-2 text-sm", msg.ok ? "text-positive" : "text-negative")}>{msg.text}</p>}
      </CardContent>
      {confirming && (
        <Modal open onClose={() => setConfirming(false)} title={t("reset_all_data", { defaultValue: "Reset all data" })}
          footer={<>
            <Button variant="ghost" onClick={() => setConfirming(false)}>{t("cancel", { defaultValue: "Cancel" })}</Button>
            <Button variant="danger" disabled={reset.isPending} onClick={doReset}>{t("reset_all_data", { defaultValue: "Reset all data" })}</Button>
          </>}>
          <div className="space-y-2 text-sm">
            <p className="text-foreground">{t("reset_all_data_confirm_1", { defaultValue: "Do you want to delete all your data? This includes every source, movement, tag, recurring item, saving, wishlist entry, and notification." })}</p>
            <p className="text-negative">{t("reset_all_data_confirm_2", { defaultValue: "This action is irreversible. Your data cannot be recovered unless you have an export backup. Proceed?" })}</p>
          </div>
        </Modal>
      )}
    </Card>
  );
}

const NEW_SOURCE = "__new__";
const MAP_FIELDS = [
  { key: "date", required: true },
  { key: "amount", required: false },
  { key: "amount_in", required: false },
  { key: "amount_out", required: false },
  { key: "note", required: false },
  { key: "currency", required: false },
  { key: "direction", required: false },
] as const;

/** Modal: manually map columns when the file's headers can't be auto-guessed (gap 2). */
function MappingModal({ headers, onApply, onClose }: { headers: string[]; onApply: (map: Record<string, string>) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [map, setMap] = useState<Record<string, string>>({});
  const valid = !!map.date && (!!map.amount || (!!map.amount_in && !!map.amount_out));
  return (
    <Modal open onClose={onClose} title={t("import_mapping_title", { defaultValue: "Map the columns" })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button disabled={!valid} onClick={() => onApply(map)}>{t("import_mapping_apply", { defaultValue: "Apply mapping" })}</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">{t("import_mapping_desc", { defaultValue: "The file's columns are not recognized. Map each required field to a column." })}</p>
        {MAP_FIELDS.map((f) => (
          <Field key={f.key} label={t(`import_map_${f.key}`, { defaultValue: f.key }) + (f.required ? " *" : "")} htmlFor={`map-${f.key}`}>
            <Select id={`map-${f.key}`} value={map[f.key] ?? ""} onChange={(e) => setMap((m) => { const n = { ...m }; if (e.target.value) n[f.key] = e.target.value; else delete n[f.key]; return n; })}>
              <option value="">—</option>
              {headers.map((h, i) => <option key={`${h}-${i}`} value={h}>{h}</option>)}
            </Select>
          </Field>
        ))}
        {!valid && <p className="text-xs text-warning">{t("import_map_need_min", { defaultValue: "Map a date column and either an amount or both in/out columns." })}</p>}
      </div>
    </Modal>
  );
}

/** Modal: review detected duplicates and override which rows to import (gap 3). */
function DuplicatesModal({ preview, selected, onConfirm, onClose }: { preview: ImportPreview; selected: Set<number>; onConfirm: (sel: Set<number>) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<number>>(new Set(selected));
  const toggle = (i: number) => setSel((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const setAll = (v: boolean) => setSel(v ? new Set(preview.rows.map((r) => r.index)) : new Set());
  const skipDups = () => setSel(new Set(preview.rows.filter((r) => !r.isDuplicate).map((r) => r.index)));
  return (
    <Modal open onClose={onClose} size="lg" title={t("import_duplicates_title", { defaultValue: "Review duplicate rows" })}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button onClick={() => onConfirm(sel)}>{t("import_confirm_selection", { defaultValue: "Confirm selection" })}</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">{t("import_duplicates_desc", { defaultValue: "Rows that look like duplicates of existing movements are highlighted. Tick the ones you want to import anyway." })}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setAll(true)}>{t("import_select_all", { defaultValue: "Select all" })}</Button>
          <Button size="sm" variant="outline" onClick={() => setAll(false)}>{t("import_deselect_all", { defaultValue: "Deselect all" })}</Button>
          <Button size="sm" variant="outline" onClick={skipDups}>{t("import_skip_duplicates", { defaultValue: "Skip all duplicates" })}</Button>
        </div>
        <div className="max-h-80 overflow-y-auto rounded-[var(--radius-control)] border border-border">
          <table className="w-full text-sm">
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.index} className={cn("border-b border-border last:border-0", r.isDuplicate && "bg-warning-soft")}>
                  <td className="px-3 py-1.5"><input type="checkbox" checked={sel.has(r.index)} onChange={() => toggle(r.index)} /></td>
                  <td className="px-3 py-1.5 text-muted">{r.date}{r.isDuplicate && <span className="ml-1 text-xs text-warning">{t("dup", { defaultValue: "dup" })}</span>}</td>
                  <td className="px-3 py-1.5 truncate">{r.note}</td>
                  <td className={cn("num px-3 py-1.5 text-right", r.direction === "in" ? "text-positive" : "text-foreground")}>{r.direction === "in" ? "+" : "−"}{r.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

function ImportCard() {
  const { t, i18n } = useTranslation();
  const errText = useErrorText();
  const { data: sources } = useSources();
  const commit = useCommitCsv();
  const undo = useUndoImport();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<ImportFile>();
  const [sourceId, setSourceId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newCurrency, setNewCurrency] = useState("");
  const [formatOverride, setFormatOverride] = useState<"" | ImportFormat>("");
  const [presetOverride, setPresetOverride] = useState("");
  const [excludeFromStats, setExcludeFromStats] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [preview, setPreview] = useState<ImportPreview>();
  const [columnMap, setColumnMap] = useState<Record<string, string>>();
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [showMapping, setShowMapping] = useState(false);
  const [showDups, setShowDups] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; createdIds?: number[] }>();
  const [busy, setBusy] = useState(false);

  const creatingNew = sourceId === NEW_SOURCE;

  const runPreview = async (
    f: ImportFile,
    overrides: {
      map?: Record<string, string>;
      format?: ImportFormat | "";
      presetId?: string;
      sourceId?: number | null;
    } = {},
  ) => {
    setBusy(true);
    setResult(undefined);
    try {
      // Prefer explicitly-passed values: the select onChange handlers call setX()
      // and runPreview() in the same tick, so the closure still holds the OLD state
      // — reading state here would preview against the previously selected value.
      const fmt = "format" in overrides ? overrides.format || undefined : formatOverride || undefined;
      const preset = "presetId" in overrides ? overrides.presetId || undefined : presetOverride || undefined;
      const src = "sourceId" in overrides ? overrides.sourceId : sourceId && !creatingNew ? Number(sourceId) : null;
      const p = await previewImport(await getDb(), f, {
        format: fmt,
        presetId: preset,
        sourceId: src,
        options: overrides.map ? { column_map: overrides.map } : undefined,
      });
      setPreview(p);
      setInclude(new Set(p.rows.filter((r) => !r.isDuplicate).map((r) => r.index)));
      if (p.needsMapping) setShowMapping(true);
      if (creatingNew && p.detectedCurrency && !newCurrency) setNewCurrency(p.detectedCurrency);
    } catch (e) {
      setResult({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let text = "";
    try { text = new TextDecoder("utf-8").decode(bytes); } catch { /* binary */ }
    const imp: ImportFile = { name: f.name, bytes, text };
    setFile(imp);
    setPreview(undefined);
    setColumnMap(undefined);
    await runPreview(imp);
  };

  const applyMapping = async (map: Record<string, string>) => {
    setShowMapping(false);
    setColumnMap(map);
    if (file) await runPreview(file, { map });
  };

  const doImport = () => {
    if (!preview || include.size === 0) return;
    if (!creatingNew && !sourceId) return;
    if (creatingNew && (!newName.trim() || !newCurrency.trim())) { setResult({ ok: false, text: t("import_no_source_selected", { defaultValue: "Select a source or create a new one" }) }); return; }
    const movements = preview.rows.map(({ index, isDuplicate, ...m }) => { void index; void isDuplicate; return m; });
    commit.mutate(
      {
        movements,
        sourceId: creatingNew ? undefined : Number(sourceId),
        newSource: creatingNew ? { name: newName.trim(), currency: newCurrency.trim().toUpperCase() } : undefined,
        includeIndices: [...include],
        excludeFromStats,
      },
      {
        onSuccess: (r) => {
          setResult({ ok: true, createdIds: r.createdIds, text: t("import_done", { defaultValue: "Imported {{n}}, skipped {{s}}.", n: r.imported, s: r.skipped }) + (r.currencyWarning ? ` ${r.currencyWarning}` : "") });
          setPreview(undefined); setFile(undefined); setColumnMap(undefined); setInclude(new Set());
        },
        onError: (e) => setResult({ ok: false, text: errText(e) }),
      },
    );
  };

  const doUndo = (ids: number[]) => {
    undo.mutate(ids, {
      onSuccess: () => setResult({ ok: true, text: t("import_undo_success", { defaultValue: "Import undone" }) }),
      onError: (e) => setResult({ ok: false, text: errText(e) }),
    });
  };

  return (
    <Card>
      <CardHeader title={t("import_from_bank", { defaultValue: "Import from bank or app" })} subtitle={t("import_from_bank_desc", { defaultValue: "Import movements from a bank/app export (CSV, OFX/QFX, XLSX). Data is added without replacing anything." })} />
      <CardContent className="space-y-3 pt-3">
        {/* drop zone (gap 10) */}
        <input ref={fileRef} type="file" accept=".csv,.ofx,.qfx,.xlsx,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
        <div role="button" tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void onFile(f); }}
          className={cn("flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] border border-dashed px-4 py-6 text-center transition-colors", dragOver ? "border-primary bg-accent-soft" : "border-border-strong hover:bg-surface-2")}>
          <FileUp className="h-6 w-6 text-muted" />
          <span className="text-sm text-foreground">{t("import_drop_or_click", { defaultValue: "Drop a file here or click to select" })}</span>
          <span className="text-xs text-muted">{t("import_supported_formats", { defaultValue: "Supported: CSV, OFX/QFX, XLSX — banks, YNAB, Firefly III, Revolut, N26 and more" })}</span>
          {file && <span className="text-xs text-primary">{file.name}</span>}
        </div>

        {/* advanced: format + preset override (gap 8) */}
        <button type="button" className="text-xs text-muted hover:text-foreground" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "▾ " : "▸ "}{t("import_advanced_options", { defaultValue: "Advanced options" })}
        </button>
        {advanced && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("import_format_label", { defaultValue: "Format" })} htmlFor="imp-format">
              <Select id="imp-format" value={formatOverride} onChange={(e) => { const v = e.target.value as ImportFormat | ""; setFormatOverride(v); if (file) void runPreview(file, { format: v, ...(columnMap ? { map: columnMap } : {}) }); }}>
                <option value="">{t("import_format_auto", { defaultValue: "Auto-detect" })}</option>
                {FORMAT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </Select>
            </Field>
            <Field label={t("import_preset_label", { defaultValue: "Preset (bank/app)" })} htmlFor="imp-preset">
              <Select id="imp-preset" value={presetOverride} onChange={(e) => { const v = e.target.value; setPresetOverride(v); if (file) void runPreview(file, { presetId: v, ...(columnMap ? { map: columnMap } : {}) }); }}>
                <option value="">{t("import_preset_auto", { defaultValue: "Auto-detect" })}</option>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </Select>
            </Field>
          </div>
        )}

        {/* target source + create-new-source (gap 7) */}
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("import_target_source", { defaultValue: "Import into source" })} htmlFor="imp-src">
            <Select id="imp-src" value={sourceId} onChange={(e) => { const v = e.target.value; setSourceId(v); if (file && v !== NEW_SOURCE) void runPreview(file, { sourceId: v ? Number(v) : null, ...(columnMap ? { map: columnMap } : {}) }); }} className="min-w-[200px]">
              <option value="">{t("select_account", { defaultValue: "Select an account…" })}</option>
              {(sources ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>)}
              <option value={NEW_SOURCE}>+ {t("import_create_new_source", { defaultValue: "Create new source" })}</option>
            </Select>
          </Field>
          {creatingNew && (
            <>
              <Field label={t("source_name", { defaultValue: "Name" })} htmlFor="imp-new-name">
                <Input id="imp-new-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={preview?.detectedSourceHint ?? ""} />
              </Field>
              <Field label={t("currency", { defaultValue: "Currency" })} htmlFor="imp-new-ccy">
                <Input id="imp-new-ccy" value={newCurrency} onChange={(e) => setNewCurrency(e.target.value.toUpperCase())} className="w-24" maxLength={3} />
              </Field>
            </>
          )}
        </div>

        {/* exclude-from-stats (gap 9) */}
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={excludeFromStats} onChange={(e) => setExcludeFromStats(e.target.checked)} />
          {t("import_exclude_from_stats", { defaultValue: "Exclude these movements from statistics" })}
        </label>

        {busy && <p className="text-sm text-muted">{t("import_parsing", { defaultValue: "Parsing file…" })}</p>}

        {preview?.needsMapping && (
          <p className="text-sm text-warning">{t("import_mapping_desc", { defaultValue: "The file's columns are not recognized." })} <button type="button" className="underline" onClick={() => setShowMapping(true)}>{t("import_mapping_title", { defaultValue: "Map the columns" })}</button></p>
        )}

        {preview && !preview.needsMapping && (
          <>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="text-muted">{preview.format.toUpperCase()}</span>
              <span className="text-muted">{t("rows", { defaultValue: "Rows" })}: <b className="text-foreground">{preview.rows.length}</b></span>
              <span className="num text-positive">+{preview.totalIn}</span>
              <span className="num text-negative">−{preview.totalOut}</span>
              {preview.duplicateCount > 0 && (
                <span className="text-warning">{t("duplicates", { defaultValue: "Duplicates" })}: {preview.duplicateCount}
                  <button type="button" className="ml-1 underline" onClick={() => setShowDups(true)}>{t("import_duplicates_review", { defaultValue: "review" })}</button>
                </span>
              )}
              {preview.preset && <span className="text-muted">{t("preset", { defaultValue: "Preset" })}: {preview.preset.display_name}</span>}
            </div>
            {preview.warnings.length > 0 && <p className="text-xs text-warning">{preview.warnings.join(" · ")}</p>}
            <div className="max-h-64 overflow-y-auto rounded-[var(--radius-control)] border border-border">
              <table className="w-full text-sm">
                <tbody>
                  {preview.rows.slice(0, 100).map((r) => (
                    <tr key={r.index} className={cn("border-b border-border last:border-0", !include.has(r.index) && "opacity-40")}>
                      <td className="px-3 py-1.5 text-muted">{r.date}</td>
                      <td className="px-3 py-1.5 truncate">{r.note}</td>
                      <td className={cn("num px-3 py-1.5 text-right", r.direction === "in" ? "text-positive" : "text-foreground")}>{r.direction === "in" ? "+" : "−"}{formatMoney(r.amount, r.currency ?? "", i18n.resolvedLanguage).replace(/[^\d.,\s-]/g, "").trim() || r.amount}</td>
                      <td className="px-2 py-1.5 text-xs text-muted-2">{r.isDuplicate ? t("dup", { defaultValue: "dup" }) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button disabled={include.size === 0 || (!creatingNew && !sourceId) || commit.isPending} onClick={doImport}>
              {t("import_confirm_btn", { defaultValue: "Import" })} {include.size}
            </Button>
            {!sourceId && <p className="text-xs text-muted">{t("import_no_source_selected", { defaultValue: "Select a source or create a new one" })}</p>}
          </>
        )}

        {result && (
          <div className={cn("text-sm", result.ok ? "text-positive" : "text-negative")}>
            {result.text}
            {result.ok && result.createdIds && result.createdIds.length > 0 && (
              <Button size="sm" variant="outline" className="ml-2" disabled={undo.isPending} onClick={() => doUndo(result.createdIds!)}>
                <Undo2 className="h-3.5 w-3.5" /> {t("import_undo_btn", { defaultValue: "Undo import" })}
              </Button>
            )}
          </div>
        )}
      </CardContent>

      {showMapping && preview && <MappingModal headers={preview.headers} onApply={applyMapping} onClose={() => setShowMapping(false)} />}
      {showDups && preview && <DuplicatesModal preview={preview} selected={include} onConfirm={(sel) => { setInclude(sel); setShowDups(false); }} onClose={() => setShowDups(false)} />}
    </Card>
  );
}

/**
 * Security: enable at-rest AES-256-GCM encryption by setting a password, change
 * it, or remove it. Mirrors routers/settings.py password lifecycle. Setting or
 * changing a password arms the close-hook re-encrypt (armEncryptionForSession),
 * so the still-plaintext DB is encrypted on the next clean close (gap 1/2/4).
 */
function SecurityCard() {
  const { t } = useTranslation();
  const errText = useErrorText();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"set" | "change" | "remove" | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const refresh = () => { isPasswordSet().then(setHasPassword).catch(() => setHasPassword(false)); };
  useEffect(refresh, []);

  const reset = () => { setMode(null); setCurrent(""); setNext(""); setConfirm(""); };

  // The user may choose any non-empty password — no length/complexity limits.
  const validateNew = (): string | null => {
    if (!next) return t("password_empty", { defaultValue: "Please enter a password." });
    if (next !== confirm) return t("passwords_dont_match", { defaultValue: "Passwords do not match." });
    return null;
  };

  const doSet = async () => {
    const err = validateNew();
    if (err) { setMsg({ ok: false, text: err }); return; }
    setBusy(true); setMsg(undefined);
    try {
      await setAppPassword(next);
      await armEncryptionForSession(next); // encrypt on next clean close (gap 4)
      setMsg({ ok: true, text: t("password_set_success", { defaultValue: "Password set successfully. Restart to activate encryption." }) });
      reset(); refresh();
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(false); }
  };

  const doChange = async () => {
    if (!current) { setMsg({ ok: false, text: t("enter_current_password", { defaultValue: "Please enter your current password." }) }); return; }
    const err = validateNew();
    if (err) { setMsg({ ok: false, text: err }); return; }
    setBusy(true); setMsg(undefined);
    try {
      const ok = await changeAppPassword(current, next);
      if (!ok) { setMsg({ ok: false, text: t("login_wrong_password", { defaultValue: "Incorrect password." }) }); return; }
      await armEncryptionForSession(next); // rotate key on next clean close (gap 4)
      setMsg({ ok: true, text: t("password_changed_success", { defaultValue: "Password changed successfully." }) });
      reset(); refresh();
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(false); }
  };

  const doRemove = async () => {
    if (!current) { setMsg({ ok: false, text: t("enter_current_password", { defaultValue: "Please enter your current password." }) }); return; }
    setBusy(true); setMsg(undefined);
    try {
      const ok = await removeAppPassword(current);
      if (!ok) { setMsg({ ok: false, text: t("login_wrong_password", { defaultValue: "Incorrect password." }) }); return; }
      setRuntimePassword(null); // no longer encrypt on close
      setMsg({ ok: true, text: t("password_removed_success", { defaultValue: "Password removed. Database is no longer encrypted." }) });
      reset(); refresh();
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(false); }
  };

  // Revoke-sessions analog for the desktop model (gap 6): re-lock now — flush
  // the runtime password and re-encrypt by closing the window. Only meaningful
  // when a password is set and we're running natively.
  const lockNow = async () => {
    setBusy(true);
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close(); // triggers the onCloseRequested re-encrypt
    } catch (e) { setMsg({ ok: false, text: errText(e) }); setBusy(false); }
  };

  const newPwFields = (
    <div className="space-y-3">
      <Field label={t("new_password", { defaultValue: "New password" })} htmlFor="sec-new">
        <Input id="sec-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label={t("confirm_password", { defaultValue: "Confirm password" })} htmlFor="sec-confirm">
        <Input id="sec-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
    </div>
  );

  return (
    <Card>
      <CardHeader title={t("security", { defaultValue: "Security" })} subtitle={hasPassword
        ? t("password_active_desc", { defaultValue: "Your database is encrypted and access requires authentication." })
        : t("password_not_set_desc", { defaultValue: "Set a password to encrypt your database and protect access to Yfine." })} />
      <CardContent className="space-y-3 pt-3">
        <div className="flex items-center gap-2 text-sm">
          {hasPassword
            ? <><ShieldCheck className="h-4 w-4 text-positive" /> <span className="text-foreground">{t("password_active", { defaultValue: "Password protection is active" })}</span></>
            : <><Lock className="h-4 w-4 text-muted" /> <span className="text-muted">{t("password_not_set", { defaultValue: "No password set" })}</span></>}
        </div>

        {!isTauri() && (
          <p className="text-xs text-warning">{t("preview_db_note", { defaultValue: "Browser preview with seeded sample data — changes are in-memory only." })}</p>
        )}

        {/* Idle: action buttons for the current state */}
        {hasPassword === false && mode === null && (
          <Button variant="outline" disabled={!isTauri()} onClick={() => { setMode("set"); setMsg(undefined); }}>
            <Lock className="h-4 w-4" /> {t("set_password", { defaultValue: "Set Password" })}
          </Button>
        )}
        {hasPassword === true && mode === null && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { setMode("change"); setMsg(undefined); }}>
              {t("change_password", { defaultValue: "Change Password" })}
            </Button>
            <Button variant="outline" onClick={() => { setMode("remove"); setMsg(undefined); }}>
              {t("remove_password", { defaultValue: "Remove Password" })}
            </Button>
            {isTauri() && (
              <Button variant="ghost" disabled={busy} onClick={lockNow} title={t("lock_now_desc", { defaultValue: "Lock the app now — you'll need your password to unlock." })}>
                <LogOut className="h-4 w-4" /> {t("lock_now", { defaultValue: "Lock now" })}
              </Button>
            )}
          </div>
        )}

        {/* Set password form */}
        {mode === "set" && (
          <div className="space-y-3 rounded-[var(--radius-control)] border border-border p-3">
            {newPwFields}
            <p className="text-xs text-muted">{t("password_restart_hint", { defaultValue: "Restart the application to activate database encryption." })}</p>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={doSet}>{t("set_password", { defaultValue: "Set Password" })}</Button>
              <Button variant="ghost" disabled={busy} onClick={reset}>{t("cancel", { defaultValue: "Cancel" })}</Button>
            </div>
          </div>
        )}

        {/* Change password form */}
        {mode === "change" && (
          <div className="space-y-3 rounded-[var(--radius-control)] border border-border p-3">
            <Field label={t("current_password", { defaultValue: "Current password" })} htmlFor="sec-current">
              <Input id="sec-current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            {newPwFields}
            <div className="flex gap-2">
              <Button disabled={busy} onClick={doChange}>{t("change_password", { defaultValue: "Change Password" })}</Button>
              <Button variant="ghost" disabled={busy} onClick={reset}>{t("cancel", { defaultValue: "Cancel" })}</Button>
            </div>
          </div>
        )}

        {/* Remove password form */}
        {mode === "remove" && (
          <div className="space-y-3 rounded-[var(--radius-control)] border border-border p-3">
            <p className="text-sm text-warning">{t("remove_password_confirm", { defaultValue: "This will remove encryption and password protection. Are you sure?" })}</p>
            <Field label={t("current_password", { defaultValue: "Current password" })} htmlFor="sec-rm-current">
              <Input id="sec-rm-current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            <div className="flex gap-2">
              <Button variant="danger" disabled={busy} onClick={doRemove}>{t("remove_password", { defaultValue: "Remove Password" })}</Button>
              <Button variant="ghost" disabled={busy} onClick={reset}>{t("cancel", { defaultValue: "Cancel" })}</Button>
            </div>
          </div>
        )}

        {msg && <p className={cn("text-sm", msg.ok ? "text-positive" : "text-negative")}>{msg.text}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Settings sections — vertical sidebar nav, faithful to the original app's
 * settings/index.html (left list-group + right content pane). Same order and
 * icons as the reference: Theme, Language, Portfolios, LAN access, Security,
 * Data, Import, Menu, Hotkeys. Plugins is intentionally omitted (Python-only).
 */
const SETTINGS_SECTIONS: { id: string; labelKey: string; label: string; icon: typeof Palette; iconClass: string; render: () => React.ReactNode }[] = [
  { id: "theme", labelKey: "theme", label: "Theme", icon: Palette, iconClass: "text-primary", render: () => <AppearanceCard /> },
  { id: "language", labelKey: "language", label: "Language", icon: Languages, iconClass: "text-primary", render: () => <LanguageCard /> },
  { id: "portfolios", labelKey: "portfolios", label: "Portfolios", icon: Briefcase, iconClass: "text-primary", render: () => <PortfoliosCard /> },
  { id: "privacy", labelKey: "privacy_mode", label: "Privacy mode", icon: Lock, iconClass: "text-primary", render: () => <PrivacyCard /> },
  { id: "security", labelKey: "security", label: "Security", icon: Shield, iconClass: "text-negative", render: () => <SecurityCard /> },
  { id: "data", labelKey: "data", label: "Data", icon: Database, iconClass: "text-positive", render: () => (<div className="space-y-4"><ExportCard /><RestoreCard /><DangerZoneCard /></div>) },
  { id: "imports", labelKey: "import_from_bank", label: "Import from bank or app", icon: UploadCloud, iconClass: "text-primary", render: () => <ImportCard /> },
  { id: "menu", labelKey: "menu_layout", label: "Sidebar Menu", icon: ListOrdered, iconClass: "text-primary", render: () => <MenuLayoutCard /> },
  { id: "hotkeys", labelKey: "hotkeys", label: "Keyboard Shortcuts", icon: Keyboard, iconClass: "text-muted", render: () => <HotkeysCard /> },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const [active, setActive] = useState(SETTINGS_SECTIONS[0].id);
  const current = SETTINGS_SECTIONS.find((s) => s.id === active) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="space-y-4">
      {isPreviewDb && <div className="rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">{t("preview_db_note", { defaultValue: "Browser preview with seeded sample data — changes are in-memory only." })}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Left: vertical section nav (og settings-nav list-group). */}
        <nav aria-label={t("settings", { defaultValue: "Settings" })}>
          <h2 className="mb-3 text-base font-semibold text-foreground">{t("settings", { defaultValue: "Settings" })}</h2>
          <ul className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:space-y-1">
            {SETTINGS_SECTIONS.map((s) => {
              const Icon = s.icon;
              const selected = s.id === active;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setActive(s.id)}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 border-b border-border px-3 py-2.5 text-left text-sm transition-colors md:rounded-[var(--radius-control)] md:border-0",
                      selected ? "bg-accent-soft font-medium text-primary" : "text-foreground hover:bg-surface-2",
                    )}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", selected ? "text-primary" : s.iconClass)} />
                    <span className="truncate">{t(s.labelKey, { defaultValue: s.label })}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Right: active section content. */}
        <div className="min-w-0 space-y-4">{current.render()}</div>
      </div>
    </div>
  );
}
