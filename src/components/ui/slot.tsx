import { useEffect, useRef, useState } from "react";
import { SlotText, type SlotTextProps } from "slot-text/react";
import type { SlotOptions } from "slot-text";

/** Track the OS "reduce motion" preference so rolls can collapse to a swap. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// slot-text animates via the Web Animations API, so the global
// prefers-reduced-motion CSS rule can't reach it — zero the timing here instead.
const STILL: SlotOptions = { duration: 0, stagger: 0, exitOffset: 0 };

/** SlotText that collapses to an instant swap when "reduce motion" is on.
 *  `rollOnMount` makes the value animate in from blank on first paint — used
 *  when data lands after a skeleton, so the figure rolls into place. */
export function Slot({ options, text, rollOnMount = false, ...props }: SlotTextProps & { rollOnMount?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const animateIn = rollOnMount && !reduced;
  // Start blank so the first real value rolls in; non-rollOnMount renders the
  // value immediately (and later changes still animate as before).
  const [shown, setShown] = useState(animateIn ? "" : text);
  useEffect(() => {
    if (!animateIn) {
      setShown(text);
      return;
    }
    // Defer one frame so the empty initial paint commits, then roll to value.
    const id = requestAnimationFrame(() => setShown(text));
    return () => cancelAnimationFrame(id);
  }, [text, animateIn]);
  return <SlotText {...props} text={shown} options={reduced ? { ...options, ...STILL } : options} />;
}

interface SlotMoneyProps {
  /** Numeric basis for the roll direction (rolls up when it grows, down when it shrinks). */
  value: number;
  /** Pre-formatted text to display (e.g. "€1,234.56"). */
  text: string;
  className?: string;
  options?: SlotOptions;
  /** Roll the figure in from blank on first mount (data arriving after a skeleton). */
  rollOnMount?: boolean;
}

/** Animated number/money label: rolls up on an increase, down on a decrease. */
export function SlotMoney({ value, text, className, options, rollOnMount }: SlotMoneyProps) {
  // When rolling in from blank, treat the prior value as 0 so it counts upward.
  const prevRef = useRef(rollOnMount ? 0 : value);
  const direction = value > prevRef.current ? "up" : value < prevRef.current ? "down" : options?.direction ?? "down";
  useEffect(() => {
    prevRef.current = value;
  }, [value]);
  return <Slot className={className} text={text} rollOnMount={rollOnMount} options={{ ...options, direction }} />;
}
