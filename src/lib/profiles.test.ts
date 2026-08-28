/**
 * Profile bridge, browser-preview path (node env → isTauri() is false). The
 * Tauri path is the same public API backed by the Rust commands (unit-tested
 * in src-tauri/src/profiles.rs); here we verify the state machine the switcher
 * UI drives: default state, create/update/delete, active switching, and the
 * per-profile DB path mapping.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProfile,
  DEFAULT_PROFILE_ID,
  deleteProfile,
  getActiveDbPath,
  getProfiles,
  PROFILE_COLORS,
  switchProfile,
  updateProfile,
} from "./profiles";

// Minimal localStorage + window.location.reload for the preview code paths.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("window", { location: { reload: vi.fn() } });
});

describe("profiles (preview bridge)", () => {
  it("starts with a single default profile and the root DB path", async () => {
    const state = await getProfiles();
    expect(state.active).toBe(DEFAULT_PROFILE_ID);
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0].id).toBe(DEFAULT_PROFILE_ID);
    expect(state.profiles[0].has_password).toBe(false);
    await expect(getActiveDbPath()).resolves.toBe("sqlite:yfine.db");
  });

  it("creates a profile and switching makes it active with its own DB path", async () => {
    const p = await createProfile("Work", PROFILE_COLORS[2]);
    expect((await getProfiles()).profiles).toHaveLength(2);

    await switchProfile(p.id);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    const state = await getProfiles();
    expect(state.active).toBe(p.id);
    await expect(getActiveDbPath()).resolves.toBe(`sqlite:profiles/${p.id}/yfine.db`);
  });

  it("renames and recolors a profile", async () => {
    const p = await createProfile("Work", PROFILE_COLORS[2]);
    await updateProfile(p.id, { name: "Business", color: PROFILE_COLORS[4] });
    const found = (await getProfiles()).profiles.find((x) => x.id === p.id);
    expect(found?.name).toBe("Business");
    expect(found?.color).toBe(PROFILE_COLORS[4]);
  });

  it("deletes a non-active profile but refuses the active one", async () => {
    const p = await createProfile("Work", PROFILE_COLORS[2]);
    await expect(deleteProfile(DEFAULT_PROFILE_ID)).rejects.toThrow();
    await deleteProfile(p.id);
    const state = await getProfiles();
    expect(state.profiles).toHaveLength(1);
    expect(state.active).toBe(DEFAULT_PROFILE_ID);
  });

  it("never interpolates an unsafe active id into the DB path", async () => {
    // Corrupt state written by hand: the path helper must fall back to the root DB.
    localStorage.setItem(
      "yfine.preview.profiles",
      JSON.stringify({
        active: "../escape",
        profiles: [{ id: "../escape", name: "x", color: "#000", created_at: 0, has_password: false }],
      }),
    );
    await expect(getActiveDbPath()).resolves.toBe("sqlite:yfine.db");
  });
});
