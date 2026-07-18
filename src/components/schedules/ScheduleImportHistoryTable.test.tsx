import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScheduleImportHistoryTable } from "./ScheduleImportHistoryTable";

const scheduleImport = {
  importId: "11111111-1111-4111-8111-111111111111",
  importName: "First Semester Schedules",
  sourceFilename: "first-semester.csv",
  totalRows: 40,
  createdStudentCount: 8,
  matchedStudentCount: 32,
  submittedByName: "Health Services Coordinator",
  description: null,
  createdByName: "System Admin",
  laboratoryItemCount: 25,
  physicalExaminationItemCount: 30,
  status: "NEEDS_REVIEW" as const,
  studentCategory: "REGULAR" as const,
  academicYearStart: 2026,
  preferredMonth: null,
  acceptedAt: "2026-07-10T08:30:00.000Z",
  skippedStudentCount: 0,
  generatedRange: { startDate: "2026-08-03", endDate: "2026-08-07" },
  overflow: { pairCountBeyondPreferredWindow: 0, unscheduledStudentCount: 0 },
  displacementTotal: 0,
  createdAt: "2026-07-10T08:30:00.000Z",
  updatedAt: "2026-07-10T09:00:00.000Z",
};

describe("ScheduleImportHistoryTable", () => {
  it("renders grouped import totals and a grouped detail action", () => {
    render(<ScheduleImportHistoryTable imports={[scheduleImport]} />);

    const row = screen.getByRole("row", { name: /First Semester Schedules/ });
    expect(within(row).getByText("first-semester.csv")).toBeVisible();
    expect(within(row).getByText("Jul 10, 2026, 4:30 PM")).toBeVisible();
    expect(within(row).getByText("8 inserted · 32 updated · 0 skipped")).toBeVisible();
    expect(within(row).getByRole("cell", { name: "25" })).toBeVisible();
    expect(within(row).getByText("NEEDS_REVIEW")).toBeVisible();
    expect(within(row).getByRole("link", { name: "View details" })).toHaveAttribute(
      "href",
      `/students/schedule-imports/${scheduleImport.importId}`,
    );
  });

  it("renders the exact empty state", () => {
    render(<ScheduleImportHistoryTable imports={[]} />);

    expect(screen.getByText("No schedule CSV files have been imported yet.")).toBeVisible();
  });
});
