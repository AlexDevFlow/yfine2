import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "./button";

export interface ConfirmOptions {
  /** Heading; defaults to a generic "Are you sure?". */
  title?: string;
  /** Body text explaining the consequence. */
  message: ReactNode;
  /** Confirm button label; defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label; defaults to "Cancel". */
  cancelLabel?: string;
  /** "danger" renders a red confirm button (destructive actions). */
  tone?: "default" | "danger";
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Imperative, themed replacement for window.confirm(). Returns a promise that
 * resolves true on confirm, false on cancel/dismiss:
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ message: "Delete this?", tone: "danger" })) del.mutate(id);
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Keep the latest resolver in a ref so close handlers always settle the promise.
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setPending(null);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal
        open={pending != null}
        onClose={() => settle(false)}
        title={pending?.title ?? t("confirm_title", { defaultValue: "Are you sure?" })}
        footer={
          <>
            <Button variant="ghost" onClick={() => settle(false)}>
              {pending?.cancelLabel ?? t("cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              variant={pending?.tone === "danger" ? "danger" : "primary"}
              autoFocus
              onClick={() => settle(true)}
            >
              {pending?.confirmLabel ?? t("confirm", { defaultValue: "Confirm" })}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">{pending?.message}</p>
      </Modal>
    </ConfirmContext.Provider>
  );
}
