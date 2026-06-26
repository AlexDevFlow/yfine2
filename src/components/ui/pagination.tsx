import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, type ButtonProps } from "@/components/ui/button";
import { usePagination } from "@/components/hooks/use-pagination";
import { cn } from "@/lib/cn";

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      role="navigation"
      aria-label="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul className={cn("flex flex-row items-center gap-1", className)} {...props} />;
}

function PaginationItem({ ...props }: React.ComponentProps<"li">) {
  return <li {...props} />;
}

type PaginationLinkProps = {
  isActive?: boolean;
  size?: ButtonProps["size"];
} & React.ComponentProps<"button">;

/**
 * A page-number control. Reuses yfine2's Button: `outline` when active,
 * `ghost` otherwise — no shadcn buttonVariants / cva.
 */
function PaginationLink({ className, isActive, size = "icon", ...props }: PaginationLinkProps) {
  return (
    <Button
      type="button"
      aria-current={isActive ? "page" : undefined}
      variant={isActive ? "outline" : "ghost"}
      size={size}
      className={className}
      {...props}
    />
  );
}

function PaginationPrevious({
  className,
  children,
  ...props
}: React.ComponentProps<typeof PaginationLink>) {
  return (
    <PaginationLink
      aria-label="Go to previous page"
      size="md"
      className={cn("gap-1 px-2.5", className)}
      {...props}
    >
      <ChevronLeftIcon className="h-4 w-4" />
      {children}
    </PaginationLink>
  );
}

function PaginationNext({
  className,
  children,
  ...props
}: React.ComponentProps<typeof PaginationLink>) {
  return (
    <PaginationLink
      aria-label="Go to next page"
      size="md"
      className={cn("gap-1 px-2.5", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="h-4 w-4" />
    </PaginationLink>
  );
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      className={cn("flex h-9 w-9 items-center justify-center text-muted", className)}
      {...props}
    >
      <MoreHorizontalIcon className="h-4 w-4" />
      <span className="sr-only">More pages</span>
    </span>
  );
}

/**
 * Ready-to-use numbered pagination wired to {@link usePagination}. 1-based:
 * `page` and `onPageChange` both speak 1-based page numbers. Pages that store a
 * 0-based offset should convert at the call site (page+1 in, page-1 out).
 */
function NumberedPagination({
  page,
  totalPages,
  onPageChange,
  itemsToDisplay = 7,
  className,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  itemsToDisplay?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const { pages, showLeftEllipsis, showRightEllipsis } = usePagination({
    currentPage: page,
    totalPages,
    paginationItemsToDisplay: itemsToDisplay,
  });

  return (
    <Pagination className={cn("w-auto", className)}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            <span className="hidden sm:inline">{t("previous", { defaultValue: "Previous" })}</span>
          </PaginationPrevious>
        </PaginationItem>

        {showLeftEllipsis && (
          <PaginationItem>
            <PaginationEllipsis />
          </PaginationItem>
        )}

        {pages.map((p) => (
          <PaginationItem key={p}>
            <PaginationLink isActive={p === page} onClick={() => onPageChange(p)}>
              {p}
            </PaginationLink>
          </PaginationItem>
        ))}

        {showRightEllipsis && (
          <PaginationItem>
            <PaginationEllipsis />
          </PaginationItem>
        )}

        <PaginationItem>
          <PaginationNext
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          >
            <span className="hidden sm:inline">{t("next", { defaultValue: "Next" })}</span>
          </PaginationNext>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

export {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationEllipsis,
  PaginationPrevious,
  PaginationNext,
  NumberedPagination,
};
