// @vitest-environment node
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { getHistoricalComplianceExportData, renderHistoricalCompliancePdf, requireUser, writeAudit } = vi.hoisted(() => ({
  getHistoricalComplianceExportData: vi.fn(),
  renderHistoricalCompliancePdf: vi.fn(),
  requireUser: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/historical-compliance-report.service", () => ({
  getHistoricalComplianceExportData,
}));
vi.mock("@/server/reports/historical-compliance-pdf-renderer", () => ({
  renderHistoricalCompliancePdf,
}));
vi.mock("@/server/repositories/audit.repository", () => ({ writeAudit }));

import { GET, runtime } from "./route";

const actor = {
  userId: "admin-1",
  fullName: "Ada Administrator",
  email: "ada@example.test",
  role: "ADMIN" as const,
  clinicId: null,
  clinicCode: null,
  clinicName: null,
};

function report(items = [
  {
    studentNumber: "2025-00001",
    studentName: "Alpha, Ana",
    collegeId: null,
    collegeName: "College One",
    programId: null,
    programCode: "BS1",
    programName: "Program One",
    yearLevel: 1,
    laboratoryAppointmentId: null,
    laboratoryAppointmentDate: "2026-07-01",
    laboratoryStatus: "COMPLETED" as const,
    physicalExamAppointmentId: null,
    physicalExamAppointmentDate: "2026-07-02",
    physicalExamStatus: "COMPLETED" as const,
    overallStatus: "COMPLIED" as const,
  },
  {
    studentNumber: "2025-00151",
    studentName: "Zulu, Zoe",
    collegeId: null,
    collegeName: "College Two",
    programId: null,
    programCode: "BS2",
    programName: "Program Two",
    yearLevel: 2,
    laboratoryAppointmentId: null,
    laboratoryAppointmentDate: null,
    laboratoryStatus: "UNSCHEDULED" as const,
    physicalExamAppointmentId: null,
    physicalExamAppointmentDate: "2026-07-02",
    physicalExamStatus: "COMPLETED" as const,
    overallStatus: "DID_NOT_COMPLY_LABORATORY" as const,
  },
]) {
  return {
    academicYear: { startYear: 2025, label: "2025–2026", closingDate: "2026-07-31", state: "CLOSED" as const },
    filters: {
      academicYearStart: 2025,
      search: "Ada",
      overallStatus: "DID_NOT_COMPLY" as const,
      sort: "name_asc" as const,
      page: 7,
      limit: 150 as const,
      offset: 900,
    },
    items,
    total: items.length,
    summary: {
      totalStudents: items.length,
      fullyComplied: 1,
      pendingCompliance: 0,
      didNotComply: 1,
      complianceRate: 50,
      laboratoryIncomplete: 1,
      physicalExamIncomplete: 0,
      bothIncomplete: 0,
    },
    breakdowns: { colleges: [], programs: [], yearLevels: [] },
    dimensions: { colleges: [], programs: [], yearLevels: [] },
  };
}

function request(query = "academicYearStart=2025&search=Ada&overallStatus=DID_NOT_COMPLY&sort=name_asc&page=7") {
  return new Request(`http://localhost/api/reports/export/pdf?${query}`);
}

describe("GET /api/reports/export/pdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T02:03:04.000Z"));
    requireUser.mockResolvedValue(actor);
    getHistoricalComplianceExportData.mockResolvedValue(report());
    renderHistoricalCompliancePdf.mockReturnValue(Readable.from([Buffer.from("%PDF-route")]))
    writeAudit.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("uses Node runtime and streams all bounded export rows with PDF download headers", async () => {
    const response = await GET(request());

    expect(runtime).toBe("nodejs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=cpu-medclinic-compliance-report-2025-2026-did-not-comply-2026-08-02.pdf",
    );
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-route");
    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(getHistoricalComplianceExportData).toHaveBeenCalledWith({
      academicYearStart: "2025",
      search: "Ada",
      overallStatus: "DID_NOT_COMPLY",
      sort: "name_asc",
      page: "7",
    }, { now: new Date("2026-08-02T02:03:04.000Z") });
    const model = renderHistoricalCompliancePdf.mock.calls[0][0];
    expect(model.details.map((row: { student: string }) => row.student)).toEqual([
      "Alpha, Ana\n2025-00001",
      "Zulu, Zoe\n2025-00151",
    ]);
    expect(model.appliedFilters.map((filter: { label: string }) => filter.label)).not.toContain("Data Quality");
    expect(model.details.every((row: object) => !("dataQuality" in row))).toBe(true);
  });

  it("audits a successful finalized export with actor, normalized filters, sort, count, and timing", async () => {
    const source = new Readable({ read() {} });
    renderHistoricalCompliancePdf.mockReturnValue(source);
    const response = await GET(request());

    expect(writeAudit).not.toHaveBeenCalled();
    const consumption = response.arrayBuffer();
    source.push(Buffer.from("%PDF-complete"));
    vi.setSystemTime(new Date("2026-08-02T02:03:04.125Z"));
    source.push(null);
    await consumption;

    expect(writeAudit).toHaveBeenCalledWith(
      "admin-1",
      "HISTORICAL_COMPLIANCE_PDF_EXPORTED",
      "academic_year",
      "2025",
      {
        academicYearStart: 2025,
        academicYearLabel: "2025–2026",
        filters: {
          search: "Ada",
          overallStatus: "DID_NOT_COMPLY",
        },
        sort: "name_asc",
        rowCount: 2,
        generatedAt: "2026-08-02T02:03:04.000Z",
        generationDurationMs: 125,
        outcome: "SUCCESS",
      },
    );
    expect(renderHistoricalCompliancePdf.mock.invocationCallOrder[0])
      .toBeLessThan(writeAudit.mock.invocationCallOrder[0]);
  });

  it("authenticates administrators before report data access", async () => {
    requireUser.mockRejectedValue(new AppError("FORBIDDEN", "You do not have permission to perform this action.", 403));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(getHistoricalComplianceExportData).not.toHaveBeenCalled();
    expect(renderHistoricalCompliancePdf).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["missing year", "sort=name_asc", new AppError("ACADEMIC_YEAR_REQUIRED", "Select a configured academic year to generate the report.", 400), 400],
    ["unknown year", "academicYearStart=2099", new AppError("ACADEMIC_YEAR_NOT_FOUND", "Academic year not found.", 404), 404],
  ])("returns the standard clear response for %s", async (_label, query, error, status) => {
    getHistoricalComplianceExportData.mockRejectedValue(error);

    const response = await GET(request(query));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: { code: error.code, message: error.message },
    });
    expect(renderHistoricalCompliancePdf).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects an empty result before starting the renderer", async () => {
    getHistoricalComplianceExportData.mockResolvedValue(report([]));

    const response = await GET(request());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "REPORT_EXPORT_EMPTY",
        message: "No historical compliance records match the selected filters.",
      },
    });
    expect(renderHistoricalCompliancePdf).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects row 10,001 before starting the renderer or emitting a PDF response", async () => {
    getHistoricalComplianceExportData.mockRejectedValue(new AppError(
      "REPORT_EXPORT_TOO_LARGE",
      "The report exceeds the 10,000-record export limit. Narrow the filters and try again.",
      422,
      undefined,
      { maxRows: 10_000, matchingRows: 10_001 },
    ));

    const response = await GET(request());

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "REPORT_EXPORT_TOO_LARGE",
        message: "The report exceeds the 10,000-record export limit. Narrow the filters and try again.",
        details: { maxRows: 10_000, matchingRows: 10_001 },
      },
    });
    expect(renderHistoricalCompliancePdf).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("does not audit success when PDF render setup fails", async () => {
    renderHistoricalCompliancePdf.mockImplementation(() => {
      throw new Error("font setup failed");
    });

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledWith(
      "admin-1",
      "HISTORICAL_COMPLIANCE_PDF_EXPORTED",
      "academic_year",
      "2025",
      expect.objectContaining({
        outcome: "FAILURE",
        failureStage: "RENDER_SETUP",
        failureCode: "PDF_RENDER_SETUP_ERROR",
      }),
    );
  });

  it("audits an asynchronous PDF source error as failure and never as success", async () => {
    const source = new Readable({ read() {} });
    renderHistoricalCompliancePdf.mockReturnValue(source);
    const response = await GET(request());

    const consumption = response.arrayBuffer();
    source.push(Buffer.from("%PDF-truncated"));
    vi.setSystemTime(new Date("2026-08-02T02:03:04.250Z"));
    source.destroy(new Error("late PDF failure"));

    await expect(consumption).rejects.toThrow("late PDF failure");
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledWith(
      "admin-1",
      "HISTORICAL_COMPLIANCE_PDF_EXPORTED",
      "academic_year",
      "2025",
      expect.objectContaining({
        outcome: "FAILURE",
        failureStage: "STREAM",
        failureCode: "PDF_STREAM_ERROR",
        generationDurationMs: 250,
      }),
    );
    expect(writeAudit.mock.calls.some((call) => call[4]?.outcome === "SUCCESS")).toBe(false);
  });

  it("records client cancellation as failure exactly once", async () => {
    const source = new Readable({ read() {} });
    renderHistoricalCompliancePdf.mockReturnValue(source);
    const response = await GET(request());
    const reader = response.body!.getReader();
    source.push(Buffer.from("%PDF-partial"));
    await reader.read();

    await reader.cancel("download cancelled");

    expect(writeAudit).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledWith(
      "admin-1",
      "HISTORICAL_COMPLIANCE_PDF_EXPORTED",
      "academic_year",
      "2025",
      expect.objectContaining({
        outcome: "FAILURE",
        failureStage: "CLIENT",
        failureCode: "CLIENT_CANCELLED",
      }),
    );
  });

  it("does not corrupt completed PDF bytes when the audit write itself fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    writeAudit.mockRejectedValue(new Error("audit unavailable"));

    const response = await GET(request());

    await expect(response.arrayBuffer()).resolves.toEqual(
      Uint8Array.from(Buffer.from("%PDF-route")).buffer,
    );
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "Historical compliance PDF audit write failed.",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
