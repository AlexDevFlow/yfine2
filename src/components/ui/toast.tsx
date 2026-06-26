import { X } from "lucide-react";
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
import { cn } from "@/lib/cn";

export type ToastTone = "info" | "alert" | "warning" | "success";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  /** Optional stable id; supplying it de-dupes (a second push is ignored). */
  id?: string | number;
  title: string;
  body?: string;
  tone?: ToastTone;
  /** Auto-dismiss after this many ms (default 8000, matching the legacy 8s). */
  duration?: number;
  action?: ToastAction;
}

interface ToastItem extends ToastInput {
  id: string | number;
  tone: ToastTone;
}

interface ToastContextValue {
  push: (t: ToastInput) => void;
  dismiss: (id: string | number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Imperatively raise toasts from any descendant of {@link ToastProvider}. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const TONE: Record<ToastTone, string> = {
  info: "border-l-primary",
  alert: "border-l-negative",
  warning: "border-l-warning",
  success: "border-l-positive",
};

const MAX_VISIBLE = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: string | number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((t: ToastInput) => {
    setToasts((prev) => {
      const id = t.id ?? `t${seq.current++}`;
      if (prev.some((x) => x.id === id)) return prev; // de-dupe by id
      const next = [...prev, { ...t, id, tone: t.tone ?? "info" }];
      // Cap visible toasts; drop the oldest, like the legacy 5-toast host.
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });
  }, []);

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  // Keep the latest onDismiss in a ref so the auto-dismiss timer is armed ONCE per
  // toast. `onDismiss` is a fresh inline closure on every provider render; depending
  // on it directly would clear and restart the timeout on each render (a toast could
  // then outlive its duration or never auto-dismiss under sustained activity).
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const ms = toast.duration ?? 8000;
    const timer = setTimeout(() => dismissRef.current(), ms);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration]);

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-[var(--radius-card)] border border-border border-l-2 bg-surface p-3 shadow-[var(--shadow-pop)]",
        TONE[toast.tone],
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{toast.title}</p>
        {toast.body && <p className="mt-0.5 truncate text-sm text-muted">{toast.body}</p>}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            className="mt-1.5 text-xs font-medium text-primary hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Close"
        className="shrink-0 rounded-md p-0.5 text-muted transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
