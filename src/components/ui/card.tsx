import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // Neutral hairline (derived from fg/bg) instead of the distinct --border
        // token, so cards don't get a lighter "halo" outline against the page.
        "rounded-[var(--radius-card)] border border-black/[0.06] bg-surface shadow-[var(--shadow-card)] dark:border-white/[0.06]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 p-5 pb-0", className)}>
      <div className="min-w-0">
        {title ? (
          <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
        ) : null}
        {subtitle ? (
          <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}
