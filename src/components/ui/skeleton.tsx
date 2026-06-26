import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * A single shimmering placeholder block. Compose these to mirror the shape of
 * the content that's loading (see DashboardSkeleton) so the bloom reveals the
 * app's real structure, not a blank "Loading…" card. The shimmer is disabled
 * automatically under prefers-reduced-motion (global rule in globals.css).
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("skeleton rounded-[var(--radius-control)]", className)}
      {...props}
    />
  );
}
