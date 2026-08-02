// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildHistoricalCompliancePdfModel,
  type HistoricalCompliancePdfSource,
} from "@/lib/historical-compliance-pdf";
import { renderHistoricalCompliancePdf } from "./historical-compliance-pdf-renderer";

function source(rowCount: number): HistoricalCompliancePdfSource {
  const items = Array.from({ length: rowCount }, (_, index) => ({
    studentNumber: `2025-${String(index + 1).padStart(5, "0")}`,
    studentName: `Student with a deliberately long surname ${index + 1}, Given Middle Name`,
    collegeId: null,
    collegeName: "College of Engineering and Advanced Interdisciplinary Studies",
    programId: null,
    programCode: "BS-LONG",
    programName: "Bachelor of Science in a Program with a Long Descriptive Name",
    yearLevel: 4,
    laboratoryAppointmentId: null,
    laboratoryAppointmentDate: "2026-07-01",
    laboratoryStatus: index % 2 ? "COMPLETED" as const : "NO_SHOW" as const,
    physicalExamAppointmentId: null,
    physicalExamAppointmentDate: "2026-07-02",
    physicalExamStatus: "COMPLETED" as const,
    overallStatus: index % 2 ? "COMPLIED" as const : "DID_NOT_COMPLY_LABORATORY" as const,
    dataQuality: index % 3 ? "VERIFIED_HISTORICAL" as const : "MIGRATED_INCOMPLETE" as const,
  }));
  return {
    academicYear: {
      startYear: 2025,
      label: "2025–2026",
      closingDate: "2026-07-31",
      state: "CLOSED",
    },
    filters: {
      academicYearStart: 2025,
      overallStatus: "DID_NOT_COMPLY",
      sort: "name_asc",
      page: 1,
      limit: 150,
      offset: 0,
    },
    total: rowCount,
    summary: {
      totalStudents: rowCount,
      fullyComplied: Math.floor(rowCount / 2),
      pendingCompliance: 0,
      didNotComply: Math.ceil(rowCount / 2),
      complianceRate: 50,
      laboratoryIncomplete: Math.ceil(rowCount / 2),
      physicalExamIncomplete: 0,
      bothIncomplete: 0,
      migratedIncomplete: Math.ceil(rowCount / 3),
    },
    breakdowns: {
      colleges: [{ collegeId: null, collegeName: "College of Engineering", totalStudents: rowCount, fullyComplied: Math.floor(rowCount / 2), attentionStudents: Math.ceil(rowCount / 2), complianceRate: 50 }],
      programs: [{ collegeId: null, collegeName: "College of Engineering", programId: null, programCode: "BS-LONG", programName: "Long Program", totalStudents: rowCount, fullyComplied: Math.floor(rowCount / 2), attentionStudents: Math.ceil(rowCount / 2), complianceRate: 50 }],
      yearLevels: [{ yearLevel: 4, totalStudents: rowCount, fullyComplied: Math.floor(rowCount / 2), attentionStudents: Math.ceil(rowCount / 2), complianceRate: 50 }],
    },
    dimensions: { colleges: [], programs: [], yearLevels: [4] },
    items,
  };
}

function collect(stream: NodeJS.ReadableStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

function renderedText(raw: string) {
  return [...raw.matchAll(/\[([^\]]+)] TJ/g)].map((operation) => (
    [...operation[1].matchAll(/<([0-9a-f]+)>/gi)]
      .map((segment) => Buffer.from(segment[1], "hex").toString("latin1"))
      .join("")
  ));
}

function textPositions(raw: string) {
  return [...raw.matchAll(/BT\s+1 0 0 1 ([\d.]+) ([\d.]+) Tm\s+\/F\d+ [\d.]+ Tf\s+\[([^\]]+)] TJ\s+ET/g)].map((operation) => ({
    x: Number(operation[1]),
    y: Number(operation[2]),
    text: [...operation[3].matchAll(/<([0-9a-f]+)>/gi)]
      .map((segment) => Buffer.from(segment[1], "hex").toString("latin1"))
      .join(""),
  }));
}

describe("historical compliance PDF renderer", () => {
  it("finalizes a landscape PDF readable with provenance and every matching row", async () => {
    const model = buildHistoricalCompliancePdfModel(
      source(120),
      { userId: "admin-1", fullName: "Ada Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );

    const pdf = await collect(renderHistoricalCompliancePdf(model, { compress: false }));
    const raw = pdf.toString("latin1");
    const text = renderedText(raw);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(raw).toContain("/MediaBox [0 0 792 612]");
    expect(text).toContain("Central Philippine University MedClinic");
    expect(text).toContain("2025-00001");
    expect(text).toContain("2025-00120");
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("repeats detail headers on continuation pages and numbers every buffered page", async () => {
    const model = buildHistoricalCompliancePdfModel(
      source(120),
      { userId: "admin-1", fullName: "Ada Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );
    const raw = (await collect(renderHistoricalCompliancePdf(model, { compress: false }))).toString("latin1");
    const text = renderedText(raw);
    const headerOccurrences = text.filter((value) => value === "Student").length;
    const pageCount = raw.split("/Type /Page\n").length - 1;

    expect(headerOccurrences).toBeGreaterThan(1);
    expect(pageCount).toBeGreaterThan(2);
    for (let page = 1; page <= pageCount; page += 1) {
      expect(text).toContain(`Academic Year 2025-2026 | Page ${page} of ${pageCount}`);
    }
  });

  it("left-aligns top-level section headings after multi-column content", async () => {
    const model = buildHistoricalCompliancePdfModel(
      source(2),
      { userId: "admin-1", fullName: "Ada Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );
    const raw = (await collect(renderHistoricalCompliancePdf(model, { compress: false }))).toString("latin1");
    const positions = textPositions(raw);

    expect(positions.find(({ text }) => text === "Applied filters")?.x).toBe(34);
    expect(positions.find(({ text }) => text === "Executive summary")?.x).toBe(34);
  });
});
