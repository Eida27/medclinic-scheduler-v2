import { describe, expect, it } from "vitest";
import {
  buildHistoricalCompliancePdfFilename,
  buildHistoricalCompliancePdfModel,
} from "./historical-compliance-pdf";

const report = {
  academicYear: {
    startYear: 2025,
    label: "2025–2026",
    closingDate: "2026-07-31",
    state: "CLOSED" as const,
  },
  filters: {
    academicYearStart: 2025,
    search: "  María Ñúñez  ",
    overallStatus: "DID_NOT_COMPLY" as const,
    laboratoryStatus: "NO_SHOW" as const,
    collegeId: "10000000-0000-4000-8000-000000000001",
    programId: "20000000-0000-4000-8000-000000000001",
    yearLevel: 4,
    dataQuality: "MIGRATED_INCOMPLETE" as const,
    sort: "name_asc" as const,
    page: 3,
    limit: 150 as const,
    offset: 300,
  },
  total: 1,
  summary: {
    totalStudents: 1,
    fullyComplied: 0,
    pendingCompliance: 0,
    didNotComply: 1,
    complianceRate: 0,
    laboratoryIncomplete: 1,
    physicalExamIncomplete: 0,
    bothIncomplete: 0,
    migratedIncomplete: 1,
  },
  breakdowns: {
    colleges: [{
      collegeId: "10000000-0000-4000-8000-000000000001",
      collegeName: "College of Engineering",
      totalStudents: 1,
      fullyComplied: 0,
      attentionStudents: 1,
      complianceRate: 0,
    }],
    programs: [{
      collegeId: "10000000-0000-4000-8000-000000000001",
      collegeName: "College of Engineering",
      programId: "20000000-0000-4000-8000-000000000001",
      programCode: "BSChE",
      programName: "Bachelor of Science in Chemical Engineering",
      totalStudents: 1,
      fullyComplied: 0,
      attentionStudents: 1,
      complianceRate: 0,
    }],
    yearLevels: [{
      yearLevel: 4,
      totalStudents: 1,
      fullyComplied: 0,
      attentionStudents: 1,
      complianceRate: 0,
    }],
  },
  dimensions: {
    colleges: [{ id: "10000000-0000-4000-8000-000000000001", name: "College of Engineering" }],
    programs: [{
      id: "20000000-0000-4000-8000-000000000001",
      collegeId: "10000000-0000-4000-8000-000000000001",
      code: "BSChE",
      name: "Bachelor of Science in Chemical Engineering",
    }],
    yearLevels: [4],
  },
  items: [{
    studentNumber: "2025-00001",
    studentName: "Dela Cruz, María",
    collegeId: "10000000-0000-4000-8000-000000000001",
    collegeName: "College of Engineering",
    programId: "20000000-0000-4000-8000-000000000001",
    programCode: "BSChE",
    programName: "Bachelor of Science in Chemical Engineering",
    yearLevel: 4,
    laboratoryAppointmentId: "30000000-0000-4000-8000-000000000001",
    laboratoryAppointmentDate: "2026-07-01",
    laboratoryStatus: "NO_SHOW" as const,
    physicalExamAppointmentId: "40000000-0000-4000-8000-000000000001",
    physicalExamAppointmentDate: "2026-07-02",
    physicalExamStatus: "COMPLETED" as const,
    overallStatus: "DID_NOT_COMPLY_LABORATORY" as const,
    dataQuality: "MIGRATED_INCOMPLETE" as const,
  }],
};

describe("historical compliance PDF document model", () => {
  it("builds an ASCII-safe dated filename with the selected year and main status", () => {
    expect(buildHistoricalCompliancePdfFilename({
      academicYearLabel: "2025–2026",
      overallStatus: "DID_NOT_COMPLY",
      generatedAt: new Date("2026-08-02T02:03:04.000Z"),
    })).toBe("cpu-medclinic-compliance-report-2025-2026-did-not-comply-2026-08-02.pdf");
  });

  it("dates the filename using the MedClinic Manila calendar day", () => {
    expect(buildHistoricalCompliancePdfFilename({
      academicYearLabel: "2025–2026",
      generatedAt: new Date("2026-08-01T16:30:00.000Z"),
    })).toBe("cpu-medclinic-compliance-report-2025-2026-2026-08-02.pdf");
  });

  it("derives provenance, normalized filter labels, all breakdowns, and every detail field", () => {
    const model = buildHistoricalCompliancePdfModel(
      report,
      { userId: "admin-1", fullName: "Adá Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );

    expect(model.provenance).toBe("Central Philippine University MedClinic");
    expect(model.academicYear).toEqual({
      startYear: 2025,
      label: "2025–2026",
      closingDate: "July 31, 2026",
      state: "Closed",
    });
    expect(model.generated).toEqual({
      at: "August 2, 2026 at 10:03 AM",
      iso: "2026-08-02T02:03:04.000Z",
      by: "Adá Administrator (admin-1)",
    });
    expect(model.appliedFilters).toEqual([
      { label: "Student", value: "María Ñúñez" },
      { label: "Overall", value: "Did Not Comply" },
      { label: "Laboratory", value: "No Show" },
      { label: "Physical Examination", value: "All" },
      { label: "College", value: "College of Engineering" },
      { label: "Program", value: "BSChE - Bachelor of Science in Chemical Engineering" },
      { label: "Year Level", value: "4" },
      { label: "Data Quality", value: "Migrated - Incomplete Historical Data" },
      { label: "Sort", value: "Student name (A-Z)" },
    ]);
    expect(model.summary).toEqual(report.summary);
    expect(model.breakdowns.map(({ level, group }) => `${level}:${group}`)).toEqual([
      "College:College of Engineering",
      "Program:BSChE - Bachelor of Science in Chemical Engineering",
      "Year Level:Year 4",
    ]);
    expect(model.details).toEqual([expect.objectContaining({
      student: "Dela Cruz, María\n2025-00001",
      college: "College of Engineering",
      program: "BSChE - Bachelor of Science in Chemical Engineering",
      yearLevel: "4",
      laboratory: "July 1, 2026\nNo Show",
      physicalExam: "July 2, 2026\nCompleted",
      overall: "Did Not Comply - Laboratory",
      dataQuality: "Migrated - Incomplete Historical Data",
    })]);
  });

  it("labels a reassigned program from the selected historical college tuple", () => {
    const model = buildHistoricalCompliancePdfModel(
      {
        ...report,
        dimensions: {
          ...report.dimensions,
          programs: [
            {
              id: report.filters.programId,
              collegeId: "10000000-0000-4000-8000-000000000099",
              code: "OLD",
              name: "Former Program",
            },
            ...report.dimensions.programs,
          ],
        },
      },
      { userId: "admin-1", fullName: "Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );

    expect(model.appliedFilters.find((filter) => filter.label === "Program")).toEqual({
      label: "Program",
      value: "BSChE - Bachelor of Science in Chemical Engineering",
    });
  });

  it("combines every deterministic program and college label variant from the selected historical tuple", () => {
    const selectedCollegeId = report.filters.collegeId;
    const selectedProgramId = report.filters.programId;
    const model = buildHistoricalCompliancePdfModel(
      {
        ...report,
        dimensions: {
          ...report.dimensions,
          colleges: [
            { id: selectedCollegeId, name: "School of Engineering" },
            ...report.dimensions.colleges,
          ],
          programs: [
            {
              id: selectedProgramId,
              collegeId: selectedCollegeId,
              code: "ChE",
              name: "Chemical Engineering",
            },
            {
              id: selectedProgramId,
              collegeId: selectedCollegeId,
              code: "ChE",
              name: "Chemical Engineering",
            },
            {
              id: selectedProgramId,
              collegeId: "10000000-0000-4000-8000-000000000099",
              code: "OLD",
              name: "Former Program",
            },
            ...report.dimensions.programs,
          ],
        },
      },
      { userId: "admin-1", fullName: "Administrator" },
      new Date("2026-08-02T02:03:04.000Z"),
    );

    expect(model.appliedFilters.find((filter) => filter.label === "College")).toEqual({
      label: "College",
      value: "College of Engineering / School of Engineering",
    });
    expect(model.appliedFilters.find((filter) => filter.label === "Program")).toEqual({
      label: "Program",
      value: "BSChE - Bachelor of Science in Chemical Engineering / ChE - Chemical Engineering",
    });
  });
});
