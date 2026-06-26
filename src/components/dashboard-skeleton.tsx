import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Empty structure of the dashboard, shown while useDashboard() resolves. It
 * matches the real grid (net-worth hero + chart + this-month stats, monthly
 * flow, upcoming, recent movements) so the login bloom dissolves onto the
 * app's actual shape — then the real cards fade/roll in over the top.
 */
export function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      {/* Quick-action row */}
      <div className="flex gap-2">
        {[88, 96, 84, 116].map((w, i) => (
          <Skeleton key={i} className="h-9" style={{ width: w }} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Net worth */}
        <Card className="lg:col-span-12">
          <div className="flex items-start justify-between gap-3 p-5 pb-0">
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-8 w-8 rounded-[var(--radius-control)]" />
          </div>
          <CardContent className="pt-4">
            <div className="grid gap-6 lg:grid-cols-3">
              {/* Left: hero value + chart */}
              <div className="lg:col-span-2">
                <Skeleton className="h-10 w-56" />
                <div className="mt-4 flex items-center justify-between">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-5 w-28" />
                </div>
                <Skeleton className="mt-3 h-[158px] w-full rounded-[var(--radius-card)]" />
              </div>
              {/* Right: this month + forecast */}
              <div className="flex flex-col gap-4 lg:border-l lg:border-border lg:pl-6">
                <Skeleton className="h-3 w-24" />
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-9 w-9 rounded-[var(--radius-control)]" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-14" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                  </div>
                ))}
                <Skeleton className="mt-1 h-16 w-full rounded-[var(--radius-card)]" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Monthly flow */}
        <Card className="lg:col-span-7">
          <div className="flex items-start justify-between gap-3 p-5 pb-0">
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-36" />
            </div>
            <Skeleton className="h-5 w-24" />
          </div>
          <CardContent className="pt-4">
            <div className="flex h-40 items-end justify-between gap-3">
              {[55, 80, 40, 95, 65, 72].map((h, i) => (
                <div key={i} className="flex flex-1 items-end justify-center gap-1">
                  <Skeleton className="w-1/2 rounded-t" style={{ height: `${h}%` }} />
                  <Skeleton className="w-1/2 rounded-t" style={{ height: `${Math.max(20, h - 25)}%` }} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Upcoming */}
        <Card className="lg:col-span-5">
          <div className="flex items-start justify-between gap-3 p-5 pb-0">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-4" />
          </div>
          <CardContent className="space-y-3 pt-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Recent movements */}
        <Card className="lg:col-span-12">
          <div className="flex items-start justify-between gap-3 p-5 pb-0">
            <div className="space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <CardContent className="space-y-3 pt-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="h-6 w-6 rounded-full" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
                <Skeleton className="h-3.5 w-16" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
