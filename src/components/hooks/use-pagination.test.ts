import { describe, it, expect } from "vitest";
import { usePagination } from "./use-pagination";

// usePagination is a pure function (no React state/effects), so it can be unit
// tested directly without rendering.

describe("usePagination — ranges", () => {
  it("returns every page when totalPages <= itemsToDisplay", () => {
    const r = usePagination({ currentPage: 1, totalPages: 5, paginationItemsToDisplay: 7 });
    expect(r.pages).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns exactly itemsToDisplay pages when there are more pages than fit", () => {
    // currentPage in the middle, no edge clamping → both ellipses, so the inner
    // window shrinks by 2 from the 7 slots.
    const r = usePagination({ currentPage: 10, totalPages: 20, paginationItemsToDisplay: 7 });
    expect(r.pages).toEqual([8, 9, 10, 11, 12]);
    expect(r.showLeftEllipsis).toBe(true);
    expect(r.showRightEllipsis).toBe(true);
  });

  it("anchors to the start near page 1 (no left ellipsis)", () => {
    const r = usePagination({ currentPage: 1, totalPages: 20, paginationItemsToDisplay: 7 });
    expect(r.showLeftEllipsis).toBe(false);
    expect(r.showRightEllipsis).toBe(true);
    // start anchored at 1, end trimmed by the right ellipsis (7 - 1 = 6)
    expect(r.pages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.pages[0]).toBe(1);
  });

  it("anchors to the end near the last page (no right ellipsis)", () => {
    const r = usePagination({ currentPage: 20, totalPages: 20, paginationItemsToDisplay: 7 });
    expect(r.showRightEllipsis).toBe(false);
    expect(r.showLeftEllipsis).toBe(true);
    // end anchored at 20, start trimmed by the left ellipsis
    expect(r.pages[r.pages.length - 1]).toBe(20);
    expect(r.pages).toEqual([15, 16, 17, 18, 19, 20]);
  });

  it("handles a single page", () => {
    const r = usePagination({ currentPage: 1, totalPages: 1, paginationItemsToDisplay: 7 });
    expect(r.pages).toEqual([1]);
    expect(r.showLeftEllipsis).toBe(false);
    expect(r.showRightEllipsis).toBe(false);
  });
});

describe("usePagination — ellipsis flags", () => {
  it("returns the full range when all pages fit, regardless of the flag values", () => {
    // When totalPages <= itemsToDisplay the range short-circuits to every page,
    // so the ellipsis flags are moot — the consumer only consults them when the
    // computed range actually omits pages.
    const r = usePagination({ currentPage: 3, totalPages: 7, paginationItemsToDisplay: 7 });
    expect(r.pages).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("shows the left ellipsis once the current page is far enough from the start", () => {
    // currentPage - 1 > 7/2 → 4 > 3.5 → true
    const r = usePagination({ currentPage: 5, totalPages: 20, paginationItemsToDisplay: 7 });
    expect(r.showLeftEllipsis).toBe(true);
  });

  it("shows the right ellipsis when there are enough pages remaining", () => {
    // totalPages - currentPage + 1 > 7/2 → 20 - 5 + 1 = 16 > 3.5 → true
    const r = usePagination({ currentPage: 5, totalPages: 20, paginationItemsToDisplay: 7 });
    expect(r.showRightEllipsis).toBe(true);
  });

  it("hides the right ellipsis when close to the end", () => {
    // totalPages - currentPage + 1 = 20 - 19 + 1 = 2, not > 3.5
    const r = usePagination({ currentPage: 19, totalPages: 20, paginationItemsToDisplay: 7 });
    expect(r.showRightEllipsis).toBe(false);
    expect(r.showLeftEllipsis).toBe(true);
  });
});
