import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Brand } from "@/components/layout/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { authLogin } from "@/lib/auth-bridge";

// Mirror security.py's per-IP login limiter (5 attempts / 300s sliding window),
// adapted to the single-process desktop model as an in-memory backoff: only
// wrong-password attempts count, a success clears the bucket, and decrypt
// failures do NOT count (matching which outcomes the original throttled).
const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 300;

// How long the unlock screen takes to fade out once auth succeeds. Kept short
// and in step with the app's modal/overlay motion; the dashboard skeleton is
// already mounted behind, so this just dissolves the gate to reveal it.
const LEAVE_MS = 280;

export function LoginScreen({
  onAuthenticated,
  onTransitionEnd,
}: {
  /** Auth succeeded — the host may now mount the app behind the overlay. */
  onAuthenticated: (password: string) => void;
  /** The fade-out finished — the host may unmount this overlay. */
  onTransitionEnd: () => void;
}) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Timestamps (ms) of recent wrong-password attempts within the window.
  const attempts = useRef<number[]>([]);
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const leaveTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  // Tick once a second only while locked, so the "try again in Ns" message counts down.
  useEffect(() => {
    if (lockUntil === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockUntil]);

  const remaining = lockUntil !== null ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0;
  const locked = remaining > 0;

  const recordWrong = () => {
    const t0 = Date.now();
    attempts.current = attempts.current.filter((ts) => t0 - ts < WINDOW_SECONDS * 1000);
    attempts.current.push(t0);
    if (attempts.current.length >= MAX_ATTEMPTS) {
      setLockUntil(t0 + WINDOW_SECONDS * 1000);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (locked || busy || leaving) return;
    setBusy(true);
    setError(undefined);
    try {
      const ok = await authLogin(pw);
      if (ok) {
        attempts.current = []; // success clears the bucket
        setLockUntil(null);
        onAuthenticated(pw); // mount the app behind us…
        setLeaving(true); // …and fade the gate out to reveal it
        leaveTimer.current = window.setTimeout(onTransitionEnd, LEAVE_MS);
      } else {
        recordWrong(); // only wrong-password counts toward the limit
        setError(t("login_wrong_password", { defaultValue: "Incorrect password." }));
        setBusy(false);
      }
    } catch {
      // Decrypt failure — distinct from a wrong password and NOT rate-limited.
      setError(t("login_decrypt_failed", { defaultValue: "Couldn't unlock the database." }));
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 grid place-items-center bg-background p-4 transition-opacity duration-300",
        leaving ? "yn-fade-in pointer-events-none opacity-0" : "yn-fade-in opacity-100",
      )}
    >
      <form
        onSubmit={submit}
        className={cn(
          "relative w-full max-w-sm overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-[var(--shadow-card)] transition-all duration-300",
          leaving ? "-translate-y-1 scale-[0.99] opacity-0" : "yn-slide-down translate-y-0 scale-100 opacity-100",
        )}
      >
        {/* Indeterminate sweep while verifying + decrypting (no measurable %). */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden transition-opacity duration-200",
            busy ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="yn-progress h-full w-1/3 rounded-full bg-primary" />
        </div>

        <div className="flex justify-center">
          <Brand />
        </div>

        <p className="mt-4 flex items-start gap-2 text-sm text-muted">
          <Lock className={cn("mt-0.5 h-4 w-4 shrink-0", busy && "animate-pulse text-primary")} />
          {busy
            ? t("decrypting", { defaultValue: "Decrypting your data…" })
            : t("vault_locked", {
                defaultValue: "Your data is encrypted. Enter your password to unlock.",
              })}
        </p>

        <div className="relative mt-5">
          <Input
            type={show ? "text" : "password"}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t("password", { defaultValue: "Password" })}
            autoFocus
            disabled={locked || busy || leaving}
            autoComplete="current-password"
            className="pr-10"
          />
          {pw.length > 0 && (
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              tabIndex={-1}
              aria-label={
                show
                  ? t("hide_password", { defaultValue: "Hide password" })
                  : t("show_password", { defaultValue: "Show password" })
              }
              className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-[var(--radius-control)] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          )}
        </div>

        {locked ? (
          <p className="mt-3 text-sm text-warning">
            {t("login_too_many", {
              defaultValue: "Too many login attempts. Try again in {{n}}s.",
              n: remaining,
            })}
          </p>
        ) : error ? (
          <p className="mt-3 text-sm text-negative">{error}</p>
        ) : null}

        <Button type="submit" className="mt-5 w-full" disabled={busy || leaving || !pw || locked}>
          {busy || leaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("unlocking", { defaultValue: "Unlocking…" })}
            </>
          ) : (
            t("unlock", { defaultValue: "Unlock" })
          )}
        </Button>
      </form>
    </div>
  );
}
