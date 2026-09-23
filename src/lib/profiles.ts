/**
 * Multi-profile bridge. Profiles are fully separate data universes (own DB,
 * own password/encryption, own settings) managed by the Rust side; switching
 * works like switching a Google account: persist the new active id, then
 * reload the webview so the whole boot flow (crash recovery → lock screen →
 * DB open) re-runs against the new profile's directory.
 *
 * In the browser preview (no Tauri) the profile LIST is kept in localStorage
 * so the switcher stays usable — every preview profile opens the same
 * in-memory seeded DB, since nothing persists there anyway.
 */
import { isTauri } from "./tauri";
import i18n from "@/i18n";
import { encryptForProfileSwitch } from "./auth-bridge";

export interface Profile {
  id: string;
  name: string;
  color: string;
  created_at: number;
  has_password: boolean;
}
export interface ProfilesState {
  active: string;
  profiles: Profile[];
}

export const DEFAULT_PROFILE_ID = "default";

/** Avatar palette offered when creating/editing a profile. */
export const PROFILE_COLORS = [
  "#4f46e5", // indigo (brand)
  "#0891b2", // cyan
  "#059669", // emerald
  "#d97706", // amber
  "#dc2626", // red
  "#db2777", // pink
  "#7c3aed", // violet
  "#475569", // slate
] as const;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

function defaultName(): string {
  return i18n.t("profile_default_name", { defaultValue: "Personal" });
}

/* ---- browser-preview fallback (localStorage) ---- */
const PREVIEW_KEY = "yfine.preview.profiles";
function previewRead(): ProfilesState {
  try {
    const raw = localStorage.getItem(PREVIEW_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProfilesState;
      if (parsed.profiles?.length) return parsed;
    }
  } catch {
    /* fall through to default */
  }
  return {
    active: DEFAULT_PROFILE_ID,
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        name: defaultName(),
        color: PROFILE_COLORS[0],
        created_at: Math.floor(Date.now() / 1000),
        has_password: false,
      },
    ],
  };
}
function previewWrite(state: ProfilesState): void {
  try {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(state));
  } catch {
    /* private mode etc. — the switcher just won't persist */
  }
}

/* ---- public API ---- */

export async function getProfiles(): Promise<ProfilesState> {
  if (!isTauri()) return previewRead();
  return invoke<ProfilesState>("profiles_get", { defaultName: defaultName() });
}

export async function createProfile(name: string, color: string): Promise<Profile> {
  if (!isTauri()) {
    const state = previewRead();
    const profile: Profile = {
      id: `p${Date.now().toString(36)}`,
      name: name.trim(),
      color,
      created_at: Math.floor(Date.now() / 1000),
      has_password: false,
    };
    state.profiles.push(profile);
    previewWrite(state);
    return profile;
  }
  return invoke<Profile>("profile_create", { name, color });
}

export async function updateProfile(
  id: string,
  patch: { name?: string; color?: string },
): Promise<void> {
  if (!isTauri()) {
    const state = previewRead();
    const p = state.profiles.find((x) => x.id === id);
    if (p) {
      if (patch.name !== undefined) p.name = patch.name.trim();
      if (patch.color !== undefined) p.color = patch.color;
      previewWrite(state);
    }
    return;
  }
  return invoke<void>("profile_update", { id, name: patch.name, color: patch.color });
}

export async function deleteProfile(id: string): Promise<void> {
  if (!isTauri()) {
    const state = previewRead();
    if (state.active === id) throw new Error("cannot delete the active profile");
    state.profiles = state.profiles.filter((x) => x.id !== id);
    previewWrite(state);
    return;
  }
  return invoke<void>("profile_delete", { id });
}

/**
 * Switch the active profile. If the current profile holds a runtime password
 * its plaintext DB is re-encrypted FIRST (same guarantee as closing the app),
 * then the active id is persisted and the webview reloads: boot re-runs
 * against the new profile (its own lock screen, its own DB).
 */
export async function switchProfile(id: string): Promise<void> {
  if (isTauri()) {
    // Encryption failing ABORTS the switch (the user was told; the database
    // was reopened): this profile's data must never be left plaintext behind.
    await encryptForProfileSwitch();
    try {
      await invoke<void>("profile_set_active", { id });
    } catch (err) {
      // The current profile's database may already be encrypted and its pools
      // closed, so staying here is not an option: reload so boot re-runs
      // against whichever profile is active (this one, via its lock screen).
      console.error("[yfine] profile switch failed after encryption:", err);
      window.location.reload();
      throw err;
    }
  } else {
    const state = previewRead();
    if (state.profiles.some((x) => x.id === id)) {
      state.active = id;
      previewWrite(state);
    }
  }
  window.location.reload();
}

/**
 * The active profile's id, path-safe. Anything that stores per-profile files
 * (the DB path below, the attachments dir in db/repo/attachments.ts) MUST
 * derive its location from this so all of a profile's data moves together.
 * Ids are server-generated hex, but never interpolate anything else into a
 * path — a non-conforming id collapses to the default profile.
 */
export async function getActiveProfileId(): Promise<string> {
  const { active } = await getProfiles();
  return /^[a-z0-9-]+$/i.test(active) ? active : DEFAULT_PROFILE_ID;
}

/**
 * plugin-sql connection string for the active profile. Relative `sqlite:`
 * paths resolve against the app config dir — the default profile's DB sits at
 * its root (pre-profiles layout), every other profile under profiles/<id>/.
 */
export async function getActiveDbPath(): Promise<string> {
  const active = await getActiveProfileId();
  if (active === DEFAULT_PROFILE_ID) return "sqlite:yfine.db";
  return `sqlite:profiles/${active}/yfine.db`;
}
