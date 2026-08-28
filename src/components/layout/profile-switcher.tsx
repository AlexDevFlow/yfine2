/**
 * Google-style profile switcher (topbar avatar → menu). Profiles are fully
 * separate data universes (own DB, password, settings); selecting one persists
 * it as active and reloads the webview so the whole boot flow re-runs against
 * that profile. Creating a profile switches to it immediately (like adding a
 * Google account); renaming/recoloring/deleting live in the manage modal.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Lock, Pencil, Plus, Trash2, UserRound, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Field, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  createProfile,
  deleteProfile,
  getProfiles,
  PROFILE_COLORS,
  switchProfile,
  updateProfile,
  type Profile,
} from "@/lib/profiles";
import { useErrorText } from "@/lib/use-error-text";

function Avatar({ profile, size = "md" }: { profile: Profile; size?: "sm" | "md" | "lg" }) {
  const initial = (profile.name.trim()[0] ?? "?").toUpperCase();
  const cls = { sm: "h-6 w-6 text-[11px]", md: "h-8 w-8 text-sm", lg: "h-10 w-10 text-base" }[size];
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white", cls)}
      style={{ backgroundColor: profile.color }}
    >
      {initial}
    </span>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("profile_color", { defaultValue: "Color" })} className="flex flex-wrap gap-2">
      {PROFILE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn(
            "grid h-7 w-7 place-items-center rounded-full transition-transform hover:scale-110",
            value === c && "ring-2 ring-ring ring-offset-2 ring-offset-surface",
          )}
          style={{ backgroundColor: c }}
        >
          {value === c && <Check className="h-3.5 w-3.5 text-white" />}
        </button>
      ))}
    </div>
  );
}

/** Create-profile modal: name + avatar color, then switch straight into it. */
function CreateProfileModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const errText = useErrorText();
  const { push } = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PROFILE_COLORS[1]);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const p = await createProfile(name, color);
      await switchProfile(p.id); // reloads the webview into the new profile
    } catch (e) {
      push({ title: errText(e), tone: "alert" });
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={t("profile_add", { defaultValue: "Add profile" })}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button disabled={busy || !name.trim()} onClick={create}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t("profile_create", { defaultValue: "Create profile" })}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <p className="text-sm text-muted">
          {t("profile_separate_note", {
            defaultValue:
              "Each profile keeps its own separate database, password and settings — nothing is shared between profiles.",
          })}
        </p>
        <Field label={t("profile_name", { defaultValue: "Profile name" })} htmlFor="profile-new-name">
          <Input
            id="profile-new-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={40}
            placeholder={t("profile_name_placeholder", { defaultValue: "e.g. Work, Family…" })}
          />
        </Field>
        <Field label={t("profile_color", { defaultValue: "Color" })}>
          <ColorPicker value={color} onChange={setColor} />
        </Field>
      </form>
    </Modal>
  );
}

/** Manage modal: rename, recolor, delete (never the active profile). */
function ManageProfilesModal({
  profiles,
  activeId,
  onClose,
}: {
  profiles: Profile[];
  activeId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const errText = useErrorText();
  const { push } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["profiles"] });

  const startEdit = (p: Profile) => {
    setEditing(p.id);
    setName(p.name);
    setColor(p.color);
  };

  const save = async (id: string) => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await updateProfile(id, { name, color });
      setEditing(null);
      await refresh();
    } catch (e) {
      push({ title: errText(e), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Profile) => {
    const ok = await confirm({
      title: t("profile_delete_title", { defaultValue: "Delete profile?" }),
      message: t("profile_delete_confirm", {
        defaultValue:
          "Delete “{{name}}” and ALL of its data (movements, sources, settings)? This cannot be undone.",
        name: p.name,
      }),
      confirmLabel: t("delete", { defaultValue: "Delete" }),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteProfile(p.id);
      push({ title: t("profile_deleted", { defaultValue: "Profile deleted." }), tone: "success" });
      await refresh();
    } catch (e) {
      push({ title: errText(e), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t("profile_manage", { defaultValue: "Manage profiles" })}>
      <ul className="space-y-2">
        {profiles.map((p) => (
          <li key={p.id} className="rounded-[var(--radius-control)] border border-border p-3">
            {editing === p.id ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Avatar profile={{ ...p, name, color }} />
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={40}
                    autoFocus
                    aria-label={t("profile_name", { defaultValue: "Profile name" })}
                  />
                </div>
                <ColorPicker value={color} onChange={setColor} />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || !name.trim()} onClick={() => save(p.id)}>
                    {t("save", { defaultValue: "Save" })}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                    {t("cancel", { defaultValue: "Cancel" })}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Avatar profile={p} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                    {p.name}
                    {p.has_password && (
                      <Lock aria-label={t("profile_locked_hint", { defaultValue: "Password protected" })} className="h-3.5 w-3.5 shrink-0 text-muted" />
                    )}
                  </p>
                  {p.id === activeId && (
                    <p className="text-xs text-primary">{t("profile_active", { defaultValue: "Active" })}</p>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("edit", { defaultValue: "Edit" })}
                  disabled={busy}
                  onClick={() => startEdit(p)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("delete", { defaultValue: "Delete" })}
                  disabled={busy || p.id === activeId}
                  title={
                    p.id === activeId
                      ? t("profile_delete_active", { defaultValue: "Switch to another profile first to delete this one." })
                      : undefined
                  }
                  onClick={() => remove(p)}
                  className={cn(p.id !== activeId && "hover:bg-negative-soft hover:text-negative")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function ProfileSwitcher() {
  const { t } = useTranslation();
  const errText = useErrorText();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<"create" | "manage" | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({ queryKey: ["profiles"], queryFn: getProfiles, staleTime: 5_000 });
  const profiles = data?.profiles ?? [];
  const active = profiles.find((p) => p.id === data?.active);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const doSwitch = async (p: Profile) => {
    if (switchingTo || p.id === data?.active) {
      setOpen(false);
      return;
    }
    setSwitchingTo(p.id);
    try {
      await switchProfile(p.id); // reloads the webview on success
    } catch (e) {
      push({ title: errText(e), tone: "alert" });
      setSwitchingTo(null);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("profile_switch", { defaultValue: "Switch profile" })}
        title={active?.name}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] transition-colors hover:bg-surface-2"
      >
        {active ? (
          <Avatar profile={active} />
        ) : (
          <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-muted">
            <UserRound className="h-4 w-4" />
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-40 w-72 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-pop)]"
        >
          {active && (
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Avatar profile={active} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{active.name}</p>
                <p className="text-xs text-muted">{t("profile_active", { defaultValue: "Active" })}</p>
              </div>
            </div>
          )}

          <ul className="max-h-64 overflow-y-auto py-1">
            {profiles
              .filter((p) => p.id !== data?.active)
              .map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={switchingTo !== null}
                    onClick={() => doSwitch(p)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-60"
                  >
                    <Avatar profile={p} />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{p.name}</span>
                    {p.has_password && (
                      <Lock aria-label={t("profile_locked_hint", { defaultValue: "Password protected" })} className="h-3.5 w-3.5 shrink-0 text-muted" />
                    )}
                    {switchingTo === p.id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}
                  </button>
                </li>
              ))}
          </ul>

          <div className="border-t border-border py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setModal("create");
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-2"
            >
              <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-muted">
                <Plus className="h-4 w-4" />
              </span>
              {t("profile_add", { defaultValue: "Add profile" })}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setModal("manage");
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-2"
            >
              <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-muted">
                <Users className="h-4 w-4" />
              </span>
              {t("profile_manage", { defaultValue: "Manage profiles" })}
            </button>
          </div>
        </div>
      )}

      {modal === "create" && <CreateProfileModal onClose={() => setModal(null)} />}
      {modal === "manage" && data && (
        <ManageProfilesModal profiles={profiles} activeId={data.active} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
