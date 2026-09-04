// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  buildHistoricalCompliancePdfModel,
  type HistoricalCompliancePdfModel,
  type HistoricalCompliancePdfSource,
} from "@/lib/historical-compliance-pdf";
import {
  renderHistoricalCompliancePdf,
  type HistoricalCompliancePdfDrawEvent,
} from "./historical-compliance-pdf-renderer";

function source(rowCount: number): HistoricalCompliancePdfSource {
  const items = Array.from({ length: rowCount }, (_, index) => ({
    studentNumber: `2025-${String(index + 1).padStart(5, "0")}`,
    studentName: `Ñúñez ${index + 1}, María-José Given Middle Name`,
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

async function renderWithEvents(model: HistoricalCompliancePdfModel) {
  const events: HistoricalCompliancePdfDrawEvent[] = [];
  const pdf = await collect(renderHistoricalCompliancePdf(model, {
    compress: false,
    onDraw: (event) => events.push(event),
  }));
  return { events, pdf, raw: pdf.toString("latin1") };
}

async function extractedPdfText(pdf: Buffer) {
  const document = await getDocument({
    data: new Uint8Array(pdf),
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return pages.join("\n");
  } finally {
    await document.destroy();
  }
}

describe("historical compliance PDF renderer", () => {
  it("finalizes a landscape PDF readable with provenance and every matching row", async () => {
    const model = buildHistoricalCompliancePdfModel(
      source(120),
      { userId: "admin-1", fullName: "Ada Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );

    const { events, pdf, raw } = await renderWithEvents(model);

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(raw).toContain("/MediaBox [0 0 792 612]");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "provenance",
      text: "Central Philippine University MedClinic",
    }));
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("draws every student identifier and all seven ordered detail headers on each detail page", async () => {
    const report = source(120);
    const model = buildHistoricalCompliancePdfModel(
      report,
      { userId: "admin-1", fullName: "Ada Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );
    const { events, pdf, raw } = await renderWithEvents(model);
    const pageCount = raw.split("/Type /Page\n").length - 1;
    const studentDraws = events.filter(({ kind }) => kind === "detail-student");
    const detailHeaders = events.filter(({ kind }) => kind === "detail-header");
    const detailPages = new Set(studentDraws.map(({ page }) => page));
    const detailHeadersByPage = new Map<number, HistoricalCompliancePdfDrawEvent[]>();
    for (const header of detailHeaders) {
      detailHeadersByPage.set(header.page, [
        ...(detailHeadersByPage.get(header.page) ?? []),
        header,
      ]);
    }

    expect(studentDraws).toHaveLength(report.items.length);
    for (const { studentNumber } of report.items) {
      expect(studentDraws.filter(({ text }) => text.includes(studentNumber))).toHaveLength(1);
    }
    expect(new Set(detailHeadersByPage.keys())).toEqual(detailPages);
    for (const page of detailPages) {
      const headers = detailHeadersByPage.get(page)!;
      expect(headers).toHaveLength(7);
      expect(headers.map(({ text, width }) => ({ text, width: width + 6 }))).toEqual([
        { text: "Student", width: 132 },
        { text: "College", width: 98 },
        { text: "Program", width: 154 },
        { text: "Year", width: 40 },
        { text: "Laboratory", width: 92 },
        { text: "Physical Examination", width: 92 },
        { text: "Overall", width: 116 },
      ]);
      expect(headers.reduce((total, { width }) => total + width + 6, 0)).toBe(724);
    }
    expect(await extractedPdfText(pdf)).not.toMatch(
      /Data Quality|Verified Historical|Recovered Historical|Migrated - Incomplete Historical Data|Migrated\/incomplete history/,
    );
    expect(pageCount).toBeGreaterThan(2);
    const footers = events.filter(({ kind }) => kind === "footer");
    expect(footers).toHaveLength(pageCount);
    for (let page = 1; page <= pageCount; page += 1) {
      expect(footers).toContainEqual(expect.objectContaining({
        page,
        text: `Academic Year 2025-2026 | Page ${page} of ${pageCount}`,
      }));
    }
  });

  it("draws authoritative Unicode body text without transliteration", async () => {
    const model = buildHistoricalCompliancePdfModel(
      source(2),
      { userId: "admin-1", fullName: "Adá Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );
    const { events, pdf } = await renderWithEvents(model);

    expect(events).toContainEqual(expect.objectContaining({
      kind: "detail-student",
      text: "Ñúñez 1, María-José Given Middle Name\n2025-00001",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "generated-by",
      text: "By Adá Administrator (admin-1)",
    }));
    const extracted = await extractedPdfText(pdf);
    expect(extracted).toContain("Ñúñez");
    expect(extracted).toContain("María-José");
  });

  it("wraps complete long filter and breakdown values within page boundaries", async () => {
    const longFilter = "María Ñúñez and every matching student in the College of Engineering and Advanced Interdisciplinary Studies with an intentionally complete long normalized search value";
    const longGroup = "BS-LONG - Bachelor of Science in Chemical Engineering and Advanced Interdisciplinary Research with an intentionally complete historical program label that must never be truncated";
    const model = buildHistoricalCompliancePdfModel(
      source(2),
      { userId: "admin-1", fullName: "Ada Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );
    model.appliedFilters[0].value = longFilter;
    model.breakdowns = Array.from({ length: 24 }, (_, index) => ({
      ...model.breakdowns[index % model.breakdowns.length],
      group: `${longGroup} ${index + 1}`,
    }));
    const { events } = await renderWithEvents(model);
    const filter = events.find((event) => event.kind === "filter-value" && event.text === longFilter);
    const groups = events.filter(({ kind }) => kind === "breakdown-group");

    expect(filter).toEqual(expect.objectContaining({ text: longFilter }));
    expect(filter?.height).toBeGreaterThan(18);
    expect(groups).toHaveLength(24);
    groups.forEach((event, index) => {
      expect(event.text).toBe(`${longGroup} ${index + 1}`);
      expect(event.height).toBeGreaterThan(18);
      expect(event.y + event.height).toBeLessThanOrEqual(567);
    });
    expect(new Set(groups.map(({ page }) => page)).size).toBeGreaterThan(1);
  });

  it("left-aligns top-level section headings after multi-column content", async () => {
    const model = buildHistoricalCompliancePdfModel(
      source(2),
      { userId: "admin-1", fullName: "Ada Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );
    const { events } = await renderWithEvents(model);

    expect(events.find(({ kind, text }) => kind === "section-title" && text === "Applied filters")?.x).toBe(34);
    expect(events.find(({ kind, text }) => kind === "section-title" && text === "Executive summary")?.x).toBe(34);
  });
});
