import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportBreakdowns } from "./ReportBreakdowns";

const computerCollegeId = "11111111-1111-4111-8111-111111111111";
const computerProgramId = "22222222-2222-4222-8222-222222222222";
const engineeringCollegeId = "33333333-3333-4333-8333-333333333333";

describe("ReportBreakdowns", () => {
  it("preserves a program-only filter for its college and drops it for another college", () => {
    render(<ReportBreakdowns
      state="CLOSED"
      filters={{
        academicYearStart: 2025,
        programId: computerProgramId,
        sort: "name_asc",
        page: 2,
        limit: 150,
        offset: 150,
      }}
      programs={[{ id: computerProgramId, collegeId: computerCollegeId }]}
      breakdowns={{
        colleges: [
          { collegeId: computerCollegeId, collegeName: "Computer Studies", totalStudents: 4, fullyComplied: 3, attentionStudents: 1, complianceRate: 75 },
          { collegeId: engineeringCollegeId, collegeName: "Engineering", totalStudents: 5, fullyComplied: 4, attentionStudents: 1, complianceRate: 80 },
        ],
        programs: [],
        yearLevels: [],
      }}
    />);

    const compatible = new URL(screen.getByRole("link", { name: "Filter by Computer Studies" }).getAttribute("href")!, "http://localhost");
    expect(compatible.searchParams.get("programId")).toBe(computerProgramId);
    expect(compatible.searchParams.has("page")).toBe(false);

    const incompatible = new URL(screen.getByRole("link", { name: "Filter by Engineering" }).getAttribute("href")!, "http://localhost");
    expect(incompatible.searchParams.has("programId")).toBe(false);
  });
});
