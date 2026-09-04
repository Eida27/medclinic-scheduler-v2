import { describe, expect, it } from "vitest";
import { buildReportSearchParams, reportHref } from "./report-query";

const filters = {
  academicYearStart: 2025,
  search: "Aaron Abad",
  sort: "name_asc" as const,
  page: 1,
  limit: 150 as const,
  offset: 0,
};

describe("report query URLs", () => {
  it("never serializes stale data-quality values", () => {
    const staleFilters = {
      ...filters,
      dataQuality: "MIGRATED_INCOMPLETE",
    };

    expect(buildReportSearchParams(staleFilters).toString())
      .toBe("academicYearStart=2025&search=Aaron+Abad&sort=name_asc");
    expect(reportHref(staleFilters)).toBe("/reports?academicYearStart=2025&search=Aaron+Abad&sort=name_asc");
  });
});
