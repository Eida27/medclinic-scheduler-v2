import "server-only";
import type { PoolClient } from "pg";
import { AppError } from "@/lib/errors";
import { parseHistoricalReportQuery } from "@/lib/historical-compliance-report";
import { academicYearLabel, academicYearState } from "@/lib/academic-year";
import { getAcademicYearRecord } from "@/server/repositories/academic-years.repository";
import { historicalComplianceReportRepository } from "@/server/repositories/historical-compliance-report.repository";

export const HISTORICAL_REPORT_EXPORT_MAX_ROWS = 10_000;

async function executeHistoricalComplianceReport(
  raw: Record<string, unknown>,
  now: Date,
  options: { limit?: number; offset?: number; client?: PoolClient },
) {
  const filters = parseHistoricalReportQuery(raw);
  if (filters.academicYearStart === null) {
    throw new AppError(
      "ACADEMIC_YEAR_REQUIRED",
      "Select a configured academic year to generate the report.",
      400,
    );
  }
  const academicYear = await getAcademicYearRecord(filters.academicYearStart, options.client);
  if (!academicYear) {
    throw new AppError("ACADEMIC_YEAR_NOT_FOUND", "Academic year not found.", 404);
  }
  const state = academicYearState(academicYear.closingDate, now);
  const report = await historicalComplianceReportRepository(
    { ...filters, academicYearStart: filters.academicYearStart },
    state,
    options,
  );
  return {
    academicYear: {
      startYear: academicYear.startYear,
      label: academicYearLabel(academicYear.startYear),
      closingDate: academicYear.closingDate,
      state,
    },
    filters,
    ...report,
  };
}

export async function getHistoricalComplianceReport(
  raw: Record<string, unknown>,
  now: Date = new Date(),
  client?: PoolClient,
) {
  return executeHistoricalComplianceReport(raw, now, { client });
}

export async function getHistoricalComplianceExportData(
  raw: Record<string, unknown>,
  options: { now?: Date; maxRows?: number; client?: PoolClient } = {},
) {
  const requestedLimit = options.maxRows ?? HISTORICAL_REPORT_EXPORT_MAX_ROWS;
  const maxRows = Math.min(
    HISTORICAL_REPORT_EXPORT_MAX_ROWS,
    Math.max(1, Math.trunc(requestedLimit)),
  );
  const report = await executeHistoricalComplianceReport(raw, options.now ?? new Date(), {
    client: options.client,
    limit: maxRows + 1,
    offset: 0,
  });
  if (report.total > maxRows) {
    throw new AppError(
      "REPORT_EXPORT_TOO_LARGE",
      `The report exceeds the ${maxRows.toLocaleString()}-record export limit. Narrow the filters and try again.`,
      422,
      undefined,
      { maxRows, matchingRows: report.total },
    );
  }
  return report;
}
