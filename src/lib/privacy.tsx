/**
 * Privacy mode: a global toggle that blurs every monetary/figure value (`.num`)
 * across the whole app (the actual blur lives in globals.css, keyed on the
 * `data-privacy` attribute on <html>). State is kept in localStorage so it
 * survives reloads — it's a local view preference, not synced data.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

const KEY = "yfine.privacy";

interface PrivacyCtx {
  on: boolean;
  toggle: () => void;
}

const Ctx = createContext<PrivacyCtx>({ on: false, toggle: () => {} });

function apply(on: boolean) {
  document.documentElement.dataset.privacy = on ? "on" : "off";
}

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    apply(on);
  }, [on]);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(KEY, next ? "1" : "0");
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
