import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "yfine.theme";

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system",
  );
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    theme === "system" ? systemTheme() : theme,
  );

  const firstRun = useRef(true);
  const resolvedRef = useRef(resolved);
  useEffect(() => {
    const apply = () => {
      const r = theme === "system" ? systemTheme() : theme;
      // Fade colours ONLY across a real light<->dark switch: add the transient
      // `theme-transition` class for ~320ms so globals.css's universal colour
      // transition is active just for the switch, never permanently (a permanent
      // `* { transition }` makes scrolling/hover janky in the webview). Skip the
      // first paint and no-op theme changes (e.g. system→explicit, same value).
      if (!firstRun.current && r !== resolvedRef.current) {
        const el = document.documentElement;
        el.classList.add("theme-transition");
        window.setTimeout(() => el.classList.remove("theme-transition"), 320);
      }
      firstRun.current = false;
      resolvedRef.current = r;
      setResolved(r);
      document.documentElement.setAttribute("data-theme", r);
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  const value = useMemo(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
