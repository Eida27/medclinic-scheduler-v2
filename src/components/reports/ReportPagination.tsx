import Link from "next/link";
import { REPORT_PAGE_SIZE, type HistoricalReportFilters } from "@/lib/historical-compliance-report";
import { reportHref } from "./report-query";

export function ReportPagination({
  filters,
  total,
}: {
  filters: HistoricalReportFilters;
  total: number;
}) {
  const totalPages = Math.ceil(total / REPORT_PAGE_SIZE);
  if (totalPages <= 1) return null;
  const linkClass = "inline-flex h-10 items-center justify-center rounded-xl border border-line bg-surface px-4 text-sm font-bold text-cpu-navy transition hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy";
  return (
    <nav aria-label="Report pagination" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm font-semibold text-muted">Page {filters.page} of {totalPages}</p>
      <div className="flex gap-2">
        {filters.page > 1 ? (
          <Link className={linkClass} href={reportHref(filters, { page: filters.page - 1 })}>Previous page</Link>
        ) : null}
        {filters.page < totalPages ? (
          <Link className={linkClass} href={reportHref(filters, { page: filters.page + 1 })}>Next page</Link>
        ) : null}
      </div>
    </nav>
  );
}
