import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ReportFilters } from "./ReportFilters";

const collegeId = "11111111-1111-4111-8111-111111111111";
const engineeringId = "33333333-3333-4333-8333-333333333333";
const computerScienceId = "22222222-2222-4222-8222-222222222222";
const civilEngineeringId = "44444444-4444-4444-8444-444444444444";

const filters = {
  academicYearStart: 2025,
  programId: civilEngineeringId,
  sort: "college_asc" as const,
  page: 4,
  limit: 150 as const,
  offset: 450,
};
const dimensions = {
  colleges: [
    { id: collegeId, name: "College of Computer Studies" },
    { id: engineeringId, name: "College of Engineering" },
  ],
  programs: [
    { id: computerScienceId, collegeId, code: "BSCS", name: "Computer Science" },
    { id: civilEngineeringId, collegeId: engineeringId, code: "BSCE", name: "Civil Engineering" },
  ],
  yearLevels: [1, 2, 3, 4],
};

describe("ReportFilters", () => {
  it("preserves a compatible program-only filter and clears it when college becomes incompatible", async () => {
    render(<ReportFilters
      years={[{ startYear: 2025, label: "2025–2026" }]}
      filters={filters}
      dimensions={dimensions}
    />);
    const college = screen.getByRole("combobox", { name: "College" });
    const program = screen.getByRole("combobox", { name: "Program" });

    expect(program).toHaveValue(civilEngineeringId);
    await userEvent.selectOptions(college, engineeringId);
    expect(program).toHaveValue(civilEngineeringId);
    expect(within(program).getByRole("option", { name: "BSCE — Civil Engineering" })).toBeVisible();

    await userEvent.selectOptions(college, collegeId);
    expect(program).toHaveValue("");
    expect(within(program).queryByRole("option", { name: "BSCE — Civil Engineering" })).not.toBeInTheDocument();
    expect(within(program).getByRole("option", { name: "BSCS — Computer Science" })).toBeVisible();
  });
});
