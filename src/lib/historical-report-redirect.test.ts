import { describe, expect, it } from "vitest";
import { historicalReportRedirectTarget } from "./historical-report-redirect";

describe("historical report redirects", () => {
  it.each(["appointments", "compliance"] as const)(
    "omits valid and stale data-quality values from %s redirects",
    (source) => {
      expect(historicalReportRedirectTarget({
        academicYearStart: "2025",
        dataQuality: "MIGRATED_INCOMPLETE",
        sort: "name_asc",
      }, source)).toBe("/reports?academicYearStart=2025&sort=name_asc");
      expect(historicalReportRedirectTarget({
        academicYearStart: "2025",
        dataQuality: "stale-value",
      }, source)).toBe("/reports?academicYearStart=2025");
    },
  );
});
