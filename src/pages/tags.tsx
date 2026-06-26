import { GitMerge, Pencil, Plus, Smile, Tag as TagIcon, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm";
import { isPreviewDb } from "@/db/connection";
import { useCreateTag, useDeleteTag, useMergeTags, useTagsWithUsage, useUpdateTag } from "@/db/queries";
import { isValidHex, type TagWithUsage } from "@/db/repo/tags";
import { cn } from "@/lib/cn";
import { useErrorText } from "@/lib/use-error-text";

function MergeDialog({ tag, others, onClose }: { tag: TagWithUsage; others: TagWithUsage[]; onClose: () => void }) {
  const { t } = useTranslation();
  const errText = useErrorText();
  const merge = useMergeTags();
  const [intoId, setIntoId] = useState(String(others[0]?.id ?? ""));
  const [error, setError] = useState<string>();
  return (
    <Modal
      open
      onClose={onClose}
      title={`${t("merge_tag", { defaultValue: "Merge tag" })}: ${tag.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("cancel", { defaultValue: "Cancel" })}</Button>
          <Button variant="danger" disabled={merge.isPending || !intoId} onClick={() => merge.mutate({ fromId: tag.id, intoId: Number(intoId) }, { onSuccess: onClose, onError: (e) => setError(errText(e)) })}>
            {t("merge", { defaultValue: "Merge" })}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {t("merge_tag_hint", { defaultValue: "Move all {{n}} movements onto the target tag, then delete \"{{name}}\". This can't be undone.", n: tag.movement_count, name: tag.name })}
        </p>
        <Field label={t("merge_into", { defaultValue: "Merge into" })} htmlFor="merge-target">
          <Select id="merge-target" value={intoId} onChange={(e) => setIntoId(e.target.value)}>
            {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </Field>
        {error ? <p className="text-sm text-negative">{error}</p> : null}
      </div>
    </Modal>
  );
}

// The original's 18-swatch palette (templates/tags/index.html COLOR_PALETTE).
const PRESETS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
  "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#6b7280",
];

// A small curated emoji grid — a lightweight stand-in for the original's full
// searchable picker (no heavy dependency), covering the common tag glyphs.
const EMOJIS = [
  "🍔", "🍕", "🍎", "🍺", "☕", "🛒", "🏠", "🚗", "✈️", "⛽",
  "💡", "📱", "💻", "🎮", "🎬", "🎵", "📚", "👕", "💊", "🏥",
  "💰", "💳", "🎁", "🐶", "🐱", "🌱", "🏋️", "✂️", "🔧", "📦",
  "💼", "🎓", "🍼", "🎉", "❤️", "⭐", "🔥", "✅",
];

function TagForm({ initial, onCancel, onSubmit, pending, error }: {
  initial?: TagWithUsage;
  onCancel: () => void;
  onSubmit: (v: { name: string; color: string | null }) => void;
  pending: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [hex, setHex] = useState(initial?.color ?? "");
  const [showEmoji, setShowEmoji] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Insert an emoji at the name input's caret (mirrors the original onEmojiClick).
  const insertEmoji = (emoji: string) => {
    const el = nameRef.current;
    const start = el?.selectionStart ?? name.length;
    const end = el?.selectionEnd ?? name.length;
    const next = (name.slice(0, start) + emoji + name.slice(end)).slice(0, 60);
    setName(next);
    setShowEmoji(false);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + emoji.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  // Apply a swatch / native-picker color, keeping the hex text field in sync.
  const applyColor = (c: string | null) => {
    setColor(c);
    setHex(c ?? "");
  };

  // Live-validate the typed hex; only commit the color when it parses.
  const onHexChange = (v: string) => {
    setHex(v);
    const trimmed = v.trim();
    if (!trimmed) setColor(null);
    else if (isValidHex(trimmed)) setColor(trimmed);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ name: name.trim(), color });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={t("name", { defaultValue: "Name" })} htmlFor="tag-name">
        <div className="flex items-start gap-2">
          <Input ref={nameRef} id="tag-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={60} className="flex-1" />
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowEmoji((s) => !s)}
              aria-label={t("pick_emoji", { defaultValue: "Pick emoji" })}
              aria-expanded={showEmoji}
              className="grid h-10 w-10 place-items-center rounded-[var(--radius-control)] border border-border text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <Smile className="h-4 w-4" />
            </button>
            {showEmoji && (
              <div className="absolute right-0 z-50 mt-1 grid w-64 grid-cols-8 gap-0.5 rounded-[var(--radius-control)] border border-border bg-surface p-2 shadow-lg">
                {EMOJIS.map((emoji) => (
                  <button
                    type="button"
                    key={emoji}
                    onClick={() => insertEmoji(emoji)}
                    className="grid h-7 w-7 place-items-center rounded text-lg hover:bg-surface-2"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Field>
      <div>
        <p className="mb-1.5 text-sm font-medium text-foreground">{t("color", { defaultValue: "Color" })}</p>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((c) => (
            <button
              type="button"
              key={c}
              aria-label={c}
              onClick={() => applyColor(c)}
              className={cn(
                "h-7 w-7 rounded-full border-2 transition-transform hover:scale-110",
                color?.toLowerCase() === c ? "border-foreground" : "border-transparent",
              )}
              style={{ background: c }}
            />
          ))}
          <label className="grid h-7 w-7 cursor-pointer place-items-center rounded-full border border-dashed border-border-strong text-xs text-muted">
            <input
              type="color"
              className="sr-only"
              value={color ?? "#6366f1"}
              onChange={(e) => applyColor(e.target.value)}
            />
            +
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={hex}
            onChange={(e) => onHexChange(e.target.value)}
            placeholder="#RRGGBB"
            maxLength={9}
            aria-label={t("custom_color", { defaultValue: "Custom color" })}
            className={cn("h-9 max-w-[10rem] font-mono", hex.trim() && !isValidHex(hex) && "border-negative focus:border-negative")}
          />
          {color && (
            <button type="button" onClick={() => applyColor(null)} className="text-xs text-muted hover:text-foreground">
              {t("clear_color", { defaultValue: "Clear color" })}
            </button>
          )}
        </div>
      </div>
      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel", { defaultValue: "Cancel" })}</Button>
        <Button type="submit" disabled={pending || !name.trim()}>{t("save", { defaultValue: "Save" })}</Button>
      </div>
    </form>
  );
}

export function TagsPage() {
  const { t } = useTranslation();
  const errText = useErrorText();
  const { data: tags, isLoading } = useTagsWithUsage();
  const create = useCreateTag();
  const update = useUpdateTag();
  const del = useDeleteTag();
  const askConfirm = useConfirm();

  const [form, setForm] = useState<{ open: boolean; editing?: TagWithUsage }>({ open: false });
  const [formError, setFormError] = useState<string>();
  const [merging, setMerging] = useState<TagWithUsage>();

  const submit = (v: { name: string; color: string | null }) => {
    setFormError(undefined);
    const onErr = (e: unknown) => setFormError(errText(e));
    const done = () => setForm({ open: false });
    if (form.editing) update.mutate({ id: form.editing.id, patch: v }, { onSuccess: done, onError: onErr });
    else create.mutate(v, { onSuccess: done, onError: onErr });
  };

  const remove = (tag: TagWithUsage) => {
    const used = tag.movement_count + tag.budget_count;
    const msg = used
      ? t("delete_tag_used_confirm", {
          defaultValue:
            "Delete \"{{name}}\"? It's on {{movements}} movement(s) and {{budgets}} budget(s) — those budgets will be removed and the tag dropped from every movement.",
          name: tag.name,
          movements: tag.movement_count,
          budgets: tag.budget_count,
        })
      : t("delete_tag_confirm", { defaultValue: "Delete \"{{name}}\"?", name: tag.name });
    void askConfirm({ message: msg, tone: "danger" }).then((ok) => { if (ok) del.mutate(tag.id); });
  };

  return (
    <div className="space-y-4">
      {isPreviewDb && (
        <div className="rounded-[var(--radius-control)] border border-border bg-warning-soft px-3 py-2 text-xs text-warning">
          {t("preview_db_note", { defaultValue: "Browser preview with seeded sample data." })}
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{t("tags_subtitle", { defaultValue: "Label movements to power budgets, filters, and reports." })}</p>
        <Button onClick={() => { setFormError(undefined); setForm({ open: true }); }}>
          <Plus className="h-4 w-4" /> {t("new_tag", { defaultValue: "New Tag" })}
        </Button>
      </div>

      {isLoading && <Card className="p-8 text-center text-sm text-muted">{t("loading", { defaultValue: "Loading…" })}</Card>}
      {tags && tags.length === 0 && (
        <Card className="p-10 text-center text-sm text-muted">{t("no_tags", { defaultValue: "No tags yet. Create your first tag." })}</Card>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(tags ?? []).map((tag) => (
          <Card key={tag.id} className="flex items-center justify-between gap-3 p-3.5">
            <Link
              to="/movements"
              search={{ tagIds: [tag.id] }}
              title={t("view_movements", { defaultValue: "View movements" })}
              className="-m-3.5 flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-control)] p-3.5 transition-colors hover:bg-surface-2"
            >
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
                style={{ background: tag.color ? `${tag.color}22` : "var(--surface-2)", color: tag.color ?? "var(--muted)" }}
              >
                <TagIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{tag.name}</p>
                <p className="text-xs text-muted">
                  {t("tag_movement_count", { defaultValue: "{{count}} movements", count: tag.movement_count })}
                  {tag.budget_count > 0 && ` · ${t("tag_budget_count", { defaultValue: "{{count}} budgets", count: tag.budget_count })}`}
                </p>
              </div>
            </Link>
            <div className="flex shrink-0 items-center gap-1">
              {(tags?.length ?? 0) > 1 && (
                <button onClick={() => setMerging(tag)} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-foreground" aria-label={t("merge", { defaultValue: "Merge" })}>
                  <GitMerge className="h-4 w-4" />
                </button>
              )}
              <button onClick={() => { setFormError(undefined); setForm({ open: true, editing: tag }); }} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-foreground" aria-label={t("edit", { defaultValue: "Edit" })}>
                <Pencil className="h-4 w-4" />
              </button>
              <button onClick={() => remove(tag)} className="rounded-md p-1.5 text-muted hover:bg-negative-soft hover:text-negative" aria-label={t("delete", { defaultValue: "Delete" })}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </Card>
        ))}
      </div>

      <Modal open={form.open} onClose={() => setForm({ open: false })} title={form.editing ? t("edit_tag", { defaultValue: "Edit Tag" }) : t("new_tag", { defaultValue: "New Tag" })}>
        <TagForm initial={form.editing} pending={create.isPending || update.isPending} error={formError} onCancel={() => setForm({ open: false })} onSubmit={submit} />
      </Modal>

      {merging && (
        <MergeDialog tag={merging} others={(tags ?? []).filter((x) => x.id !== merging.id)} onClose={() => setMerging(undefined)} />
      )}
    </div>
  );
}
