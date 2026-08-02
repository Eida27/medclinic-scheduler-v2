import { Readable } from "node:stream";
import { errorResponse } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import {
  buildHistoricalCompliancePdfFilename,
  buildHistoricalCompliancePdfModel,
} from "@/lib/historical-compliance-pdf";
import { requireUser } from "@/server/auth/current-user";
import { writeAudit } from "@/server/repositories/audit.repository";
import { renderHistoricalCompliancePdf } from "@/server/reports/historical-compliance-pdf-renderer";
import { getHistoricalComplianceExportData } from "@/server/services/historical-compliance-report.service";

export const runtime = "nodejs";

function reportQuery(searchParams: URLSearchParams) {
  return Object.fromEntries(searchParams.entries());
}

function auditFilters(filters: Record<string, unknown>) {
  const exportContext = new Set(["academicYearStart", "sort", "page", "limit", "offset"]);
  return Object.fromEntries(Object.entries(filters).filter(([key]) => !exportContext.has(key)));
}

export async function GET(request: Request) {
  try {
    const actor = await requireUser(["ADMIN"]);
    const startedAt = Date.now();
    const generatedAt = new Date();
    const report = await getHistoricalComplianceExportData(
      reportQuery(new URL(request.url).searchParams),
      { now: generatedAt },
    );
    if (report.total === 0 || report.items.length === 0) {
      throw new AppError(
        "REPORT_EXPORT_EMPTY",
        "No historical compliance records match the selected filters.",
        422,
      );
    }

    const model = buildHistoricalCompliancePdfModel(report, actor, generatedAt);
    const filename = buildHistoricalCompliancePdfFilename({
      academicYearLabel: report.academicYear.label,
      overallStatus: report.filters.overallStatus,
      generatedAt,
    });
    const pdf = renderHistoricalCompliancePdf(model);

    await writeAudit(
      actor.userId,
      "HISTORICAL_COMPLIANCE_PDF_EXPORTED",
      "academic_year",
      String(report.academicYear.startYear),
      {
        academicYearStart: report.academicYear.startYear,
        academicYearLabel: report.academicYear.label,
        filters: auditFilters(report.filters),
        sort: report.filters.sort,
        rowCount: report.items.length,
        generatedAt: generatedAt.toISOString(),
        generationDurationMs: Date.now() - startedAt,
      },
    );

    const body = Readable.toWeb(pdf) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=${filename}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
