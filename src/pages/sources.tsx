import { Link, getRouteApi } from "@tanstack/react-router";
import { ArrowLeftRight, Eye, EyeOff, GitMerge, Pencil, Percent, Plus, Sparkles, Trash2, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { LineChart } from "@/components/ui/line-chart";
import { Modal } from "@/components/ui/modal";
import { isPreviewDb } from "@/db/connection";
import { useErrorText } from "@/lib/use-error-text";
import {
  useCreateSource,
  useDeleteSource,
  useMergeSources,
  useMovementCounts,
  useSetFundVisibility,
  useSourceDependencies,
  useSourceHistory,
  useSources,
  useUpdateSource,
  type SourceWithBalance,
} from "@/db/queries";
import type { DeleteAction } from "@/db/repo/sources";
import { cn } from "@/lib/cn";
import { dayLabel } from "@/lib/date";
import { formatMoney } from "@/lib/format";

const sourcesRouteApi = getRouteApi("/sources");

export interface FormValues {
  name: string;
  currency: string;
  starting_balance: number;
  yield_rate: number;
  yield_period_months: number;
}

export function SourceForm({
  initial,
  onCancel,
  onSubmit,
  pending,
  error,
}: {
  initial?: SourceWithBalance;
  onCancel: () => void;
  onSubmit: (v: FormValues) => void;
  pending: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "EUR");
  const [starting, setStarting] = useState(String(initial?.starting_balance ?? 0));
  const [earns, setEarns] = useState((initial?.yield_rate ?? 0) > 0);
  const [rate, setRate] = useState(String(initial?.yield_rate ?? 0));
  const [period, setPeriod] = useState(String(initial?.yield_period_months ?? 12));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: name.trim(),
      currency: currency.trim().toUpperCase(),
      starting_balance: Number(starting) || 0,
      yield_rate: earns ? Number(rate) || 0 : 0,
      yield_period_months: Number(period) || 12,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={t("name", { defaultValue: "Name" })} htmlFor="src-name">
        <Input id="src-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("currency", { defaultValue: "Currency" })} htmlFor="src-ccy">
          <Input
            id="src-ccy"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={5}
            required
          />
        </Field>
        <Field label={t("starting_balance", { defaultValue: "Starting balance" })} htmlFor="src-bal">
          <Input
            id="src-bal"
            type="number"
            step="0.01"
            value={starting}
            onChange={(e) => setStarting(e.target.value)}
            className="num"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={earns} onChange={(e) => setEarns(e.target.checked)} />
        {t("earns_interest", { defaultValue: "Earns periodic interest" })}
      </label>
      {earns && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("yield_rate_label", { defaultValue: "Rate % per period" })} htmlFor="src-rate">
            <Input id="src-rate" type="number" step="0.01" min="0" max="1000" value={rate} onChange={(e) => setRate(e.target.value)} className="num" />
          </Field>
          <Field label={t("yield_period_label", { defaultValue: "Period (months)" })} htmlFor="src-period">
            <Input id="src-period" type="number" min="1" max="120" value={period} onChange={(e) => setPeriod(e.target.value)} className="num" />
          </Field>
        </div>
      )}

      {error ? <p className="text-sm text-negative">{error}</p> : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel", { defaultValue: "Cancel" })}
        </Button>
        <Button type="submit" disabled={pending || !name.trim() || !currency.trim()}>
          {t("save", { defaultValue: "Save" })}
        </Button>
      </div>
    </form>
  );
}

function DeleteDialog({
  source,
  others,
  onClose,
}: {
  source: SourceWithBalance;
  others: SourceWithBalance[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const errText = useErrorText();
  const del = useDeleteSource();
  const { data: deps } = useSourceDependencies(source.id);
  const hasPortfolios = (deps?.portfolios ?? 0) > 0;
  const [mode, setMode] = useState<DeleteAction["kind"]>("delete_all");
  const moveTargets = others.filter((s) => s.currency === source.currency && s.is_savings_fund === 0);
  const [targetId, setTargetId] = useState<number | undefined>(moveTargets[0]?.id);
  const [error, setError] = useState<string>();

  const confirm = () => {
    setError(undefined);
    const action: DeleteAction =
      mode === "move_to"
        ? { kind: "move_to", targetId: targetId! }
        : mode === "make_external"
          ? { kind: "make_external" }
          : { kind: "delete_all" };
    del.mutate(
      { id: source.id, action },
      { onSuccess: onClose, onError: (e) => setError(errText(e)) },
    );
  };

  const opt = (kind: DeleteAction["kind"], label: string, desc: string, disabled = false) => (
    <label className={cn(
      "flex gap-3 rounded-[var(--radius-control)] border p-3",
      disabled ? "cursor-not-allowed border-border opacity-50" : "cursor-pointer",
      mode === kind && !disabled ? "border-primary bg-accent-soft" : "border-border",
    )}>
      <input type="radio" name="delmode" className="mt-0.5" checked={mode === kind} disabled={disabled} onChange={() => setMode(kind)} />
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted">{desc}</span>
      </span>
    </label>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t("delete", { defaultValue: "Delete" })} · ${source.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("cancel", { defaultValue: "Cancel" })}</Button>
          <Button variant="danger" onClick={confirm} disabled={del.isPending || (mode === "move_to" && !targetId)}>
            {t("delete", { defaultValue: "Delete" })}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {deps && (
          <p className="text-xs text-muted">
            {t("source_dependencies", {
              defaultValue: "{{name}} has {{movements}} movements and {{recurring}} recurring rules.",
              name: source.name,
              movements: deps.movements,
              recurring: deps.recurring,
            })}
          </p>
        )}
        {opt("delete_all", t("del_all", { defaultValue: "Delete everything" }), t("del_all_desc", { defaultValue: "Remove this source and all its movements." }))}
        {moveTargets.length > 0 &&
          opt("move_to", t("del_move", { defaultValue: "Move movements" }), t("del_move_desc", { defaultValue: "Reassign its movements to another account." }))}
        {mode === "move_to" && (
          <Select value={targetId} onChange={(e) => setTargetId(Number(e.target.value))} className="ml-9 w-[calc(100%-2.25rem)]">
            {moveTargets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        )}
        {opt("make_external", t("del_external", { defaultValue: "Make external" }), t("del_external_desc", { defaultValue: "Keep movements but detach them from any account." }), hasPortfolios)}
        {hasPortfolios && (
          <p className="text-xs text-warning">{t("cannot_make_external_with_portfolios", { defaultValue: "You cannot make a source external while it contains portfolios." })}</p>
        )}
        {error ? <p className="text-sm text-negative">{error}</p> : null}
      </div>
    </Modal>
  );
}

/** Merge this source into another same-currency, non-fund account. */
function MergeDialog({
  source,
  others,
  onClose,
}: {
  source: SourceWithBalance;
  others: SourceWithBalance[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const errText = useErrorText();
  const merge = useMergeSources();
  const targets = others.filter((s) => s.currency === source.currency && s.is_savings_fund === 0);
  const [targetId, setTargetId] = useState<number | undefined>(targets[0]?.id);
  const [error, setError] = useState<string>();

  const confirm = () => {
    if (targetId == null) return;
    setError(undefined);
    merge.mutate(
      { fromId: source.id, toId: targetId },
      { onSuccess: onClose, onError: (e) => setError(errText(e)) },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t("merge", { defaultValue: "Merge" })} · ${source.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("cancel", { defaultValue: "Cancel" })}</Button>
          <Button onClick={confirm} disabled={merge.isPending || targetId == null}>
            {t("merge", { defaultValue: "Merge" })}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {targets.length === 0 ? (
          <p className="text-sm text-muted">{t("merge_no_targets", { defaultValue: "No other accounts in this currency to merge into." })}</p>
        ) : (
          <>
            <p className="text-sm text-muted">{t("merge_hint", { defaultValue: "Move everything from this account into the chosen one, then delete it." })}</p>
            <Field label={t("merge_into", { defaultValue: "Merge into" })} htmlFor="merge-target">
              <Select id="merge-target" value={targetId} onChange={(e) => setTargetId(Number(e.target.value))}>
                {targets.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} · {formatMoney(s.balance, s.currency)}</option>
                ))}
              </Select>
            </Field>
          </>
        )}
        {error ? <p className="text-sm text-negative">{error}</p> : null}
      </div>
    </Modal>
  );
}

/**
 * Always-visible interactive sparkline for a source card. Lazily fetches the
 * balance history (shares the cache with the source-detail chart) and renders a
 * compact area line coloured by the current balance sign — green up, red down —
 * mirroring the canvas sparkline in templates/sources/index.html. Hover/touch
 * reads the date + balance at the nearest point. A fixed-height placeholder is
 * kept when there isn't enough history so every card lines up.
 */
function SourceSparkline({ sourceId, balance, currency, locale }: {
  sourceId: number;
  balance: number;
  currency: string;
  locale?: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useSourceHistory(sourceId);
  const points = useMemo(() => (data ?? []).slice(-90), [data]);
  if (!isLoading && points.length < 2) {
    return (
      <div className="grid h-[72px] place-items-center text-[11px] text-muted-2">
        {t("not_enough_history", { defaultValue: "Not enough history to chart yet." })}
      </div>
    );
  }
  return (
    <LineChart
      points={points}
      height={72}
      color={balance >= 0 ? "var(--positive)" : "var(--negative)"}
      format={(n) => formatMoney(n, currency, locale)}
      formatDate={(d) => dayLabel(d, locale)}
    />
  );
}

/** Square account card (og parity): name, big balance, meta row, sparkline, action footer. */
function SourceCard({
  source,
  locale,
  count,
  onEdit,
  onMerge,
  onDelete,
}: {
  source: SourceWithBalance;
  locale?: string;
  count: number;
  onEdit: () => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <Link
            to="/sources/$id"
            params={{ id: String(source.id) }}
            className="min-w-0 truncate font-semibold text-foreground hover:text-primary hover:underline"
          >
            {source.name}
          </Link>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-control)] bg-accent-soft text-primary">
            <Wallet className="h-4 w-4" />
          </span>
        </div>

        <div className="mt-2 flex items-baseline gap-1.5">
          <span className={cn("num text-2xl font-bold", source.balance < 0 ? "text-negative" : "text-positive")}>
            {formatMoney(source.balance, source.currency, locale)}
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
          <span className="truncate">
            {t("starting_balance", { defaultValue: "Starting balance" })}: {formatMoney(source.starting_balance, source.currency, locale)}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {source.yield_rate > 0 && (
              <Badge tone="positive" title={t("yield_settings", { defaultValue: "Yield" })}>
                <Percent className="h-3 w-3" />{source.yield_rate}%
              </Badge>
            )}
            <span className="flex items-center gap-1"><ArrowLeftRight className="h-3 w-3" />{count}</span>
          </span>
        </div>

        <div className="mt-auto pt-3">
          <SourceSparkline sourceId={source.id} balance={source.balance} currency={source.currency} locale={locale} />
        </div>
      </div>

      <div className="flex items-center justify-end gap-1 border-t border-border px-2 py-1.5">
        <Link to="/sources/$id" params={{ id: String(source.id) }} aria-label={t("view_all", { defaultValue: "View all" })} title={t("view_all", { defaultValue: "View all" })} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-primary">
          <Eye className="h-4 w-4" />
        </Link>
        <Link to="/movements" search={{ create: "movement", source_id: source.id }} aria-label={t("new_movement", { defaultValue: "New movement" })} title={t("new_movement", { defaultValue: "New movement" })} className="rounded-md p-2 text-muted hover:bg-positive-soft hover:text-positive">
          <Plus className="h-4 w-4" />
        </Link>
        <button onClick={onEdit} aria-label={t("edit", { defaultValue: "Edit" })} title={t("edit", { defaultValue: "Edit" })} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground">
          <Pencil className="h-4 w-4" />
        </button>
        <button onClick={onMerge} aria-label={t("merge", { defaultValue: "Merge" })} title={t("merge", { defaultValue: "Merge" })} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground">
          <GitMerge className="h-4 w-4" />
        </button>
        <button onClick={onDelete} aria-label={t("delete", { defaultValue: "Delete" })} title={t("delete", { defaultValue: "Delete" })} className="rounded-md p-2 text-muted hover:bg-negative-soft hover:text-negative">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </Card>
  );
}

export function SourcesPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { data: sources, isLoading, error } = useSources();
  const { data: counts } = useMovementCounts();
  const create = useCreateSource();
  const update = useUpdateSource();
  const setVisibility = useSetFundVisibility();
  const errText = useErrorText();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SourceWithBalance | undefined>();
  const [deleting, setDeleting] = useState<SourceWithBalance | undefined>();
  const [merging, setMerging] = useState<SourceWithBalance | undefined>();
  const [formError, setFormError] = useState<string>();

  // Dashboard quick action: open the New Source form when ?create arrives.
  const { create: createParam } = sourcesRouteApi.useSearch();
  const navigate = sourcesRouteApi.useNavigate();
  useEffect(() => {
    if (!createParam) return;
    setEditing(undefined);
    setFormOpen(true);
    void navigate({ to: "/sources", search: {}, replace: true });
  }, [createParam, navigate]);

  const { groups, funds } = useMemo(() => {
    const list = sources ?? [];
    const regular = list.filter((s) => s.is_savings_fund === 0);
    // Group regular accounts by currency, preserving first-seen order, and carry
    // a per-currency total — mirrors the currency sections in og's sources page.
    const byCcy = new Map<string, SourceWithBalance[]>();
    for (const s of regular) {
      const arr = byCcy.get(s.currency) ?? [];
      arr.push(s);
      byCcy.set(s.currency, arr);
    }
    const groups = [...byCcy.entries()].map(([currency, items]) => ({
      currency,
      items,
      total: items.reduce((sum, s) => sum + s.balance, 0),
    }));
    return { groups, funds: list.filter((s) => s.is_savings_fund === 1) };
  }, [sources]);

  const openNew = () => {
    setEditing(undefined);
    setFormError(undefined);
    setFormOpen(true);
  };
  const openEdit = (s: SourceWithBalance) => {
    setEditing(s);
    setFormError(undefined);
    setFormOpen(true);
  };

  const submitForm = (v: FormValues) => {
    setFormError(undefined);
    if (editing) {
      const patch: Parameters<typeof update.mutate>[0]["patch"] = {
        name: v.name,
        currency: v.currency,
        starting_balance: v.starting_balance,
      };
      // Only touch yield fields when they actually changed (preserves the schedule).
      if (v.yield_rate !== editing.yield_rate) patch.yield_rate = v.yield_rate;
      if (v.yield_period_months !== editing.yield_period_months)
        patch.yield_period_months = v.yield_period_months;
      update.mutate(
        { id: editing.id, patch },
        { onSuccess: () => setFormOpen(false), onError: (e) => setFormError(errText(e)) },
      );
    } else {
      create.mutate(
        {
          name: v.name,
          currency: v.currency,
          starting_balance: v.starting_balance,
          yield_rate: v.yield_rate,
          yield_period_months: v.yield_period_months,
        },
        { onSuccess: () => setFormOpen(false), onError: (e) => setFormError(errText(e)) },
      );
    }
  };

  return (
    <div className="space-y-5">
      {isPreviewDb && (
        <div className="rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">
          {t("preview_db_note", {
            defaultValue: "Browser preview with seeded sample data (in-memory). The packaged app uses your real database.",
          })}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {t("sources_subtitle", { defaultValue: "Your accounts — balances are computed from movements." })}
        </p>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> {t("new_source", { defaultValue: "New Source" })}
        </Button>
      </div>

      {isLoading && <Card className="p-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</Card>}
      {error && <Card className="p-8 text-center text-sm text-negative">{errText(error)}</Card>}

      {sources && (
        <>
          {groups.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted">
              {t("no_sources", { defaultValue: "No accounts yet. Create your first one." })}
            </Card>
          ) : (
            groups.map((g) => (
              <div key={g.currency} className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge tone="primary">{g.currency}</Badge>
                    <span className="text-xs text-muted">({g.items.length})</span>
                  </div>
                  <span className={cn("num text-sm font-semibold", g.total < 0 ? "text-negative" : "text-positive")}>
                    {formatMoney(g.total, g.currency, locale)}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((s) => (
                    <SourceCard
                      key={s.id}
                      source={s}
                      locale={locale}
                      count={counts?.[s.id] ?? 0}
                      onEdit={() => openEdit(s)}
                      onMerge={() => setMerging(s)}
                      onDelete={() => setDeleting(s)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}

          {funds.length > 0 && (
            <div className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Sparkles className="h-4 w-4 text-primary" />
                {t("savings_funds", { defaultValue: "Savings funds" })}
              </h2>
              {funds.map((f) => (
                <Card key={f.id} className="flex items-center justify-between gap-4 p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] bg-positive-soft text-positive">
                      <Sparkles className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{f.name}</p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <Badge tone="positive">{f.currency}</Badge>
                        {f.hidden_from_sources === 1 && (
                          <Badge>{t("hidden", { defaultValue: "Hidden" })}</Badge>
                        )}
                        <span className="text-xs text-muted">{t("n_movements", { defaultValue: "{{count}} movements", count: counts?.[f.id] ?? 0 })}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="num text-lg font-semibold text-foreground">
                      {formatMoney(f.balance, f.currency, locale)}
                    </span>
                    <button
                      onClick={() => setVisibility.mutate({ id: f.id, hidden: f.hidden_from_sources === 0 })}
                      aria-label="Toggle visibility"
                      className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground"
                    >
                      {f.hidden_from_sources === 1 ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? t("edit_source", { defaultValue: "Edit Source" }) : t("new_source", { defaultValue: "New Source" })}
      >
        <SourceForm
          initial={editing}
          pending={create.isPending || update.isPending}
          error={formError}
          onCancel={() => setFormOpen(false)}
          onSubmit={submitForm}
        />
      </Modal>

      {deleting && (
        <DeleteDialog
          source={deleting}
          others={(sources ?? []).filter((s) => s.id !== deleting.id)}
          onClose={() => setDeleting(undefined)}
        />
      )}

      {merging && (
        <MergeDialog
          source={merging}
          others={(sources ?? []).filter((s) => s.id !== merging.id)}
          onClose={() => setMerging(undefined)}
        />
      )}
    </div>
  );
}
