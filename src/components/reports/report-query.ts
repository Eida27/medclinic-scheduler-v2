import type { HistoricalReportFilters } from "@/lib/historical-compliance-report";

type ReportQueryOverrides = Partial<Omit<HistoricalReportFilters, "limit" | "offset">>;

export function buildReportSearchParams(
  filters: HistoricalReportFilters,
  overrides: ReportQueryOverrides = {},
) {
  const next = { ...filters, ...overrides };
  const query = new URLSearchParams();
  if (next.academicYearStart !== null) {
    query.set("academicYearStart", String(next.academicYearStart));
  }
  if (next.search) query.set("search", next.search);
  if (next.overallStatus) query.set("overallStatus", next.overallStatus);
  if (next.laboratoryStatus) query.set("laboratoryStatus", next.laboratoryStatus);
  if (next.physicalExamStatus) query.set("physicalExamStatus", next.physicalExamStatus);
  if (next.collegeId) query.set("collegeId", next.collegeId);
  if (next.programId) query.set("programId", next.programId);
  if (next.yearLevel) query.set("yearLevel", String(next.yearLevel));
  if (next.dataQuality) query.set("dataQuality", next.dataQuality);
  query.set("sort", next.sort);
  if (next.page > 1) query.set("page", String(next.page));
  return query;
}

export function reportHref(
  filters: HistoricalReportFilters,
  overrides: ReportQueryOverrides = {},
) {
  const query = buildReportSearchParams(filters, overrides);
  return `/reports${query.size ? `?${query.toString()}` : ""}`;
}
