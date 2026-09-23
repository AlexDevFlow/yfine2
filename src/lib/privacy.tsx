/**
 * Privacy mode: a global toggle that blurs every monetary/figure value (`.num`)
 * across the whole app (the actual blur lives in globals.css, keyed on the
 * `data-privacy` attribute on <html>). State is kept in localStorage so it
 * survives reloads — it's a local view preference, not synced data.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getActiveProfileId } from "./profiles";

const KEY = "yfine.privacy";

interface PrivacyCtx {
  on: boolean;
  toggle: () => void;
}

const Ctx = createContext<PrivacyCtx>({ on: false, toggle: () => {} });

function apply(on: boolean) {
  document.documentElement.dataset.privacy = on ? "on" : "off";
}

function readFlag(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v == null ? null : v === "1";
  } catch {
    return null;
  }
}

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(() => readFlag(KEY) ?? false);
  // The reveal state is kept PER PROFILE: the unlock code that gates revealing
  // is a per-profile setting, so one shared flag would let a profile without a
  // code reveal the amounts of a profile that has one. Until the profile id is
  // known the legacy shared flag applies (and seeds a profile's first value).
  const storageKey = useRef(KEY);
  useEffect(() => {
    let cancelled = false;
    getActiveProfileId()
      .then((id) => {
        if (cancelled) return;
        storageKey.current = `${KEY}.${id}`;
        setOn(readFlag(storageKey.current) ?? readFlag(KEY) ?? false);
      })
      .catch(() => {
        /* keep the shared flag */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    apply(on);
  }, [on]);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey.current, next ? "1" : "0");
      } catch {
        /* private mode / quota — non-fatal */
      }
      return next;
    });
  }, []);

  return <Ctx.Provider value={{ on, toggle }}>{children}</Ctx.Provider>;
}

export function usePrivacy(): PrivacyCtx {
  return useContext(Ctx);
}
