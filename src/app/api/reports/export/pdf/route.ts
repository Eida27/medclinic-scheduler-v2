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

type PdfExportAuditContext = {
  actorUserId: string;
  academicYearStart: number;
  academicYearLabel: string;
  filters: Record<string, unknown>;
  sort: string;
  rowCount: number;
  generatedAt: Date;
  startedAt: number;
};

type PdfExportAuditOutcome =
  | { outcome: "SUCCESS" }
  | {
      outcome: "FAILURE";
      failureStage: "RENDER_SETUP" | "STREAM" | "CLIENT";
      failureCode: "PDF_RENDER_SETUP_ERROR" | "PDF_STREAM_ERROR" | "CLIENT_CANCELLED";
    };

async function writePdfExportAudit(
  context: PdfExportAuditContext,
  outcome: PdfExportAuditOutcome,
) {
  try {
    await writeAudit(
      context.actorUserId,
      "HISTORICAL_COMPLIANCE_PDF_EXPORTED",
      "academic_year",
      String(context.academicYearStart),
      {
        academicYearStart: context.academicYearStart,
        academicYearLabel: context.academicYearLabel,
        filters: context.filters,
        sort: context.sort,
        rowCount: context.rowCount,
        generatedAt: context.generatedAt.toISOString(),
        generationDurationMs: Date.now() - context.startedAt,
        ...outcome,
      },
    );
  } catch (error) {
    // The PDF outcome has already occurred. Audit storage must not turn a
    // complete download into a truncated one or replace the source stream error.
    console.error("Historical compliance PDF audit write failed.", error);
  }
}

function pdfChunk(value: unknown): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("PDF stream emitted an unsupported chunk.");
}

function completionAwarePdfStream(
  source: Readable,
  audit: (outcome: PdfExportAuditOutcome) => Promise<void>,
) {
  const iterator = source[Symbol.asyncIterator]();
  let settled = false;
  const settle = async (outcome: PdfExportAuditOutcome) => {
    if (settled) return;
    settled = true;
    await audit(outcome);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          await settle({ outcome: "SUCCESS" });
          controller.close();
          return;
        }
        controller.enqueue(pdfChunk(next.value));
      } catch (error) {
        await settle({
          outcome: "FAILURE",
          failureStage: "STREAM",
          failureCode: "PDF_STREAM_ERROR",
        });
        controller.error(error);
      }
    },
    async cancel() {
      try {
        await iterator.return?.();
      } catch {
        // Cancellation owns the final outcome even if stream cleanup also errors.
      } finally {
        if (!source.destroyed) source.destroy();
      }
      await settle({
        outcome: "FAILURE",
        failureStage: "CLIENT",
        failureCode: "CLIENT_CANCELLED",
      });
    },
  });
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
    const auditContext: PdfExportAuditContext = {
      actorUserId: actor.userId,
      academicYearStart: report.academicYear.startYear,
      academicYearLabel: report.academicYear.label,
      filters: auditFilters(report.filters),
      sort: report.filters.sort,
      rowCount: report.items.length,
      generatedAt,
      startedAt,
    };
    let pdf: Readable;
    try {
      pdf = renderHistoricalCompliancePdf(model);
    } catch (error) {
      await writePdfExportAudit(auditContext, {
        outcome: "FAILURE",
        failureStage: "RENDER_SETUP",
        failureCode: "PDF_RENDER_SETUP_ERROR",
      });
      throw error;
    }

    const body = completionAwarePdfStream(
      pdf,
      (outcome) => writePdfExportAudit(auditContext, outcome),
    );
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
