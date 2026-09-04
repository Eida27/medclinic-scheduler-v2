import { describe, expect, it } from "vitest";
import {
  REPORT_PAGE_SIZE,
  classifyHistoricalCompliance,
  historicalComplianceLabel,
  parseHistoricalReportQuery,
} from "./historical-compliance-report";

describe("historical report query parser", () => {
  it("normalizes the complete supported query", () => {
    expect(parseHistoricalReportQuery({
      academicYearStart: "2025",
      search: "  23-0001 Smith  ",
      overallStatus: "DID_NOT_COMPLY",
      laboratoryStatus: "NO_SHOW",
      physicalExamStatus: "UNSCHEDULED",
      collegeId: "10000000-0000-4000-8000-000000000003",
      programId: "20000000-0000-4000-8000-000000000003",
      yearLevel: "4",
      dataQuality: "RECOVERED_HISTORICAL",
      sort: "program_desc",
      page: "3",
    })).toEqual({
      academicYearStart: 2025,
      search: "23-0001 Smith",
      overallStatus: "DID_NOT_COMPLY",
      laboratoryStatus: "NO_SHOW",
      physicalExamStatus: "UNSCHEDULED",
      collegeId: "10000000-0000-4000-8000-000000000003",
      programId: "20000000-0000-4000-8000-000000000003",
      yearLevel: 4,
      sort: "program_desc",
      page: 3,
      limit: REPORT_PAGE_SIZE,
      offset: 300,
    });
  });

  it("silently ignores valid and stale data-quality query values", () => {
    for (const dataQuality of ["RECOVERED_HISTORICAL", "MIGRATED_INCOMPLETE", "stale-value"]) {
      expect(parseHistoricalReportQuery({ academicYearStart: "2025", dataQuality }))
        .toEqual({
          academicYearStart: 2025,
          sort: "college_asc",
          page: 1,
          limit: REPORT_PAGE_SIZE,
          offset: 0,
        });
    }
  });

  it("safely defaults invalid optional values and preserves a missing required year", () => {
    expect(parseHistoricalReportQuery({
      academicYearStart: "not-a-year",
      search: "   ",
      overallStatus: "INCOMPLETE",
      laboratoryStatus: "DRAFT",
      physicalExamStatus: ["COMPLETED"],
      collegeId: "not-a-uuid",
      programId: "",
      yearLevel: "7",
      dataQuality: "CURRENT",
      sort: "newest",
      page: "0",
      ignored: "value",
    })).toEqual({
      academicYearStart: null,
      sort: "college_asc",
      page: 1,
      limit: 150,
      offset: 0,
    });
  });
});

describe("historical compliance classification", () => {
  it.each([
    ["OPEN", "COMPLETED", "COMPLETED", "COMPLIED"],
    ["OPEN", "PENDING", "COMPLETED", "PENDING_COMPLIANCE"],
    ["CLOSING_SOON", "COMPLETED", "UNSCHEDULED", "PENDING_COMPLIANCE"],
    ["CLOSED", "COMPLETED", "COMPLETED", "COMPLIED"],
    ["CLOSED", "PENDING", "COMPLETED", "DID_NOT_COMPLY_LABORATORY"],
    ["CLOSED", "COMPLETED", "NO_SHOW", "DID_NOT_COMPLY_PHYSICAL_EXAM"],
    ["CLOSED", "UNSCHEDULED", "CANCELLED", "DID_NOT_COMPLY_BOTH"],
  ] as const)(
    "classifies %s with laboratory %s and physical exam %s as %s",
    (state, laboratory, physicalExam, expected) => {
      expect(classifyHistoricalCompliance(state, laboratory, physicalExam)).toBe(expected);
    },
  );
});

describe("historical report labels", () => {
  it.each([
    ["COMPLIED", "Complied"],
    ["PENDING_COMPLIANCE", "Pending Compliance"],
    ["DID_NOT_COMPLY_LABORATORY", "Did Not Comply - Laboratory"],
    ["DID_NOT_COMPLY_PHYSICAL_EXAM", "Did Not Comply - Physical Examination"],
    ["DID_NOT_COMPLY_BOTH", "Did Not Comply - Both Requirements"],
  ] as const)("labels compliance %s", (value, label) => {
    expect(historicalComplianceLabel(value)).toBe(label);
  });

});
