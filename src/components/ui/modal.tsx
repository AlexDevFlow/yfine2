import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// `full` fills the window: WKWebView keeps the element Fullscreen API switched
// off, so an embedded chart can never go fullscreen by itself — this is the app
// giving it the whole window instead.
const SIZES = { md: "max-w-md", lg: "max-w-lg", xl: "max-w-2xl", full: "max-w-none" } as const;

const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

// Reference-counted scroll lock for the app's scroll container (`<main>`). While a
// modal is open we freeze it so the page can't scroll behind the dialog AND its
// scrollbar disappears — on webkit2gtk (the Linux/Tauri webview) a scroll
// container paints its scrollbar *over* descendant content, so a non-portaled
// modal showed the scrollbar bleeding across it and the scrollbar band even ate
// clicks (e.g. the date-picker calendar felt dead). Padding compensation keeps the
// background from shifting when the scrollbar is removed. The counter lets stacked
// modals (a confirm over a form) unlock only when the last one closes.
let lockCount = 0;
const lockSaved: { el: HTMLElement; overflow: string; paddingRight: string }[] = [];
function lockScroll() {
  if (lockCount++ > 0) return;
  const main = document.querySelector("main");
  const el = main instanceof HTMLElement ? main : document.body;
  const sbw = el === document.body
    ? window.innerWidth - document.documentElement.clientWidth
    : el.offsetWidth - el.clientWidth;
  lockSaved.push({ el, overflow: el.style.overflow, paddingRight: el.style.paddingRight });
  el.style.overflow = "hidden";
  if (sbw > 0) {
    const cur = parseFloat(getComputedStyle(el).paddingRight) || 0;
    el.style.paddingRight = `${cur + sbw}px`;
  }
}
function unlockScroll() {
  if (lockCount === 0 || --lockCount > 0) return;
  for (const s of lockSaved) {
    s.el.style.overflow = s.overflow;
    s.el.style.paddingRight = s.paddingRight;
  }
  lockSaved.length = 0;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  /** Plain text in almost every case; a node when the header needs a control
   *  next to the name (the chart modal's expand toggle). */
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Freeze the page scroll (and hide its scrollbar) for as long as the modal is open.
  useEffect(() => {
    if (!open) return;
    lockScroll();
    return () => unlockScroll();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        dialog.focus();
      }
    }
    return () => {
      previouslyFocused?.focus();
    };
  }, [open]);

  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || !dialog.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last || !dialog.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;
  // Portal to <body> so the dialog escapes `<main>`'s overflow/scroll container.
  // Inside it (the non-portaled original), webkit2gtk painted main's scrollbar over
  // the modal and the scrollbar band intercepted clicks; as a child of <body> the
  // fixed overlay reliably covers the viewport and owns all hit-testing.
  return createPortal(
    <div
      className="yn-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`yn-slide-down flex ${size === "full" ? "h-[calc(100dvh-2rem)]" : "max-h-[calc(100dvh-2rem)]"} w-full ${SIZES[size]} flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-pop)]`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted transition-colors hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
