import * as React from "react";
import { AnimatePresence, motion, type Transition } from "framer-motion";
import { useOnClickOutside } from "usehooks-ts";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface Tab {
  title: string;
  icon: LucideIcon;
  type?: never;
}
interface Separator {
  type: "separator";
  title?: never;
  icon?: never;
}
type TabItem = Tab | Separator;

export type ExpandableTabsSize = "sm" | "md" | "lg";

interface ExpandableTabsProps {
  tabs: TabItem[];
  className?: string;
  activeColor?: string;
  onChange?: (index: number | null) => void;
  /**
   * Optional controlled selection. When provided, the bar reflects this value
   * (e.g. driven by the current route / active category) instead of its own
   * internal state. Internal state is still used as a fallback when omitted.
   */
  selected?: number | null;
  /**
   * When true, every tab renders its icon AND label (no select-only collapse,
   * no width animation) — for wide screens where there's room for full labels.
   * When false/undefined, keeps the framer-motion select-to-expand behavior.
   */
  expanded?: boolean;
  /**
   * Visual scale. "md" (default) is today's look; "sm" is compact; "lg" is
   * noticeably bigger so the bar fills the available space.
   */
  size?: ExpandableTabsSize;
}

// Animated horizontal padding for the select-to-expand (non-expanded) mode,
// scaled per size so a custom `size` still reads on narrow screens. The motion
// inline padding wins over Tailwind classes, so the class padding below is only
// the visual baseline for the expanded path.
const PAD: Record<ExpandableTabsSize, { collapsed: string; expanded: string; gap: string }> = {
  sm: { collapsed: ".375rem", expanded: ".625rem", gap: ".25rem" },
  md: { collapsed: ".5rem", expanded: "1rem", gap: ".5rem" },
  lg: { collapsed: ".625rem", expanded: "1.25rem", gap: ".625rem" },
};

const makeButtonVariants = (size: ExpandableTabsSize) => ({
  initial: { gap: 0, paddingLeft: PAD[size].collapsed, paddingRight: PAD[size].collapsed },
  animate: (isSelected: boolean) => ({
    gap: isSelected ? PAD[size].gap : 0,
    paddingLeft: isSelected ? PAD[size].expanded : PAD[size].collapsed,
    paddingRight: isSelected ? PAD[size].expanded : PAD[size].collapsed,
  }),
});

const spanVariants = {
  initial: { width: 0, opacity: 0 },
  animate: { width: "auto", opacity: 1 },
  exit: { width: 0, opacity: 0 },
};

const transition: Transition = { delay: 0.1, type: "spring", bounce: 0, duration: 0.6 };

// Per-size tokens: container gap/padding, button padding + font, icon px, and
// the separator height. md mirrors the original look exactly.
const SIZES: Record<ExpandableTabsSize, { container: string; button: string; icon: number; sep: string }> = {
  sm: { container: "gap-1 p-0.5", button: "px-2.5 py-1.5 text-xs gap-1", icon: 16, sep: "h-[18px]" },
  md: { container: "gap-2 p-1", button: "px-4 py-2 text-sm gap-2", icon: 20, sep: "h-[24px]" },
  lg: { container: "gap-2.5 p-1.5", button: "px-5 py-3 text-base gap-2.5", icon: 26, sep: "h-[30px]" },
};

export function ExpandableTabs({
  tabs,
  className,
  activeColor = "text-primary",
  onChange,
  selected: controlledSelected,
  expanded = false,
  size = "md",
}: ExpandableTabsProps) {
  const [internalSelected, setInternalSelected] = React.useState<number | null>(null);
  const outsideClickRef = React.useRef<HTMLDivElement>(null);
  const sz = SIZES[size];
  const buttonVariants = React.useMemo(() => makeButtonVariants(size), [size]);

  // Controlled when a `selected` prop is supplied; otherwise drive from internal state.
  const isControlled = controlledSelected !== undefined;
  const selected = isControlled ? controlledSelected : internalSelected;

  // usehooks-ts types the ref as RefObject<HTMLElement> (non-null current),
  // while React 19's useRef(null) yields RefObject<T | null>. The hook only ever
  // reads `.current`, so the cast is safe.
  useOnClickOutside(outsideClickRef as React.RefObject<HTMLDivElement>, () => {
    if (!isControlled) setInternalSelected(null);
    onChange?.(null);
  });

  const handleSelect = (index: number) => {
    if (!isControlled) setInternalSelected(index);
    onChange?.(index);
  };

  const Separator = () => <div className={cn("mx-1 w-[1.2px] bg-border", sz.sep)} aria-hidden="true" />;

  return (
    <div
      ref={outsideClickRef}
      className={cn(
        // Always a single row sized to its content, so the bar uses the
        // available horizontal space; it only scrolls if it ever exceeds the
        // viewport. NB: the bar's fixed + -translate-x-1/2 wrapper is
        // shrink-to-fit, and a `flex-wrap` container there collapses and wraps
        // onto extra rows even when there's plenty of room — so never wrap.
        "flex items-center rounded-2xl border border-border-strong bg-surface-2 shadow-xl max-w-[96vw] overflow-x-auto",
        sz.container,
        className,
      )}
    >
      {tabs.map((tab, index) => {
        if (tab.type === "separator") {
          return <Separator key={`separator-${index}`} />;
        }
        const Icon = tab.icon;
        const isActive = selected === index;

        // Expanded mode: every tab shows icon + label, no width animation.
        if (expanded) {
          return (
            <button
              key={tab.title}
              type="button"
              onClick={() => handleSelect(index)}
              className={cn(
                "relative flex items-center rounded-xl font-medium transition-colors duration-300",
                sz.button,
                isActive
                  ? cn("bg-accent-soft", activeColor)
                  : "text-muted hover:bg-surface hover:text-foreground",
              )}
            >
              <Icon size={sz.icon} />
              <span>{tab.title}</span>
            </button>
          );
        }

        return (
          <motion.button
            key={tab.title}
            variants={buttonVariants}
            initial={false}
            animate="animate"
            custom={isActive}
            onClick={() => handleSelect(index)}
            transition={transition}
            className={cn(
              "relative flex items-center rounded-xl font-medium transition-colors duration-300",
              sz.button,
              isActive
                ? cn("bg-accent-soft", activeColor)
                : "text-muted hover:bg-surface hover:text-foreground",
            )}
          >
            <Icon size={sz.icon} />
            <AnimatePresence initial={false}>
              {isActive && (
                <motion.span
                  variants={spanVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  transition={transition}
                  className="overflow-hidden"
                >
                  {tab.title}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.button>
        );
      })}
    </div>
  );
}
