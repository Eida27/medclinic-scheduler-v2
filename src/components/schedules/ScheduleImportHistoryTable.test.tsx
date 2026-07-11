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
  createdAt: "2026-07-10T08:30:00.000Z",
  updatedAt: "2026-07-10T09:00:00.000Z",
};

describe("ScheduleImportHistoryTable", () => {
  it("renders grouped import totals and a grouped detail action", () => {
    render(<ScheduleImportHistoryTable imports={[scheduleImport]} />);

    const row = screen.getByRole("row", { name: /First Semester Schedules/ });
    expect(within(row).getByText("first-semester.csv")).toBeVisible();
    expect(within(row).getByText("Jul 10, 2026, 4:30 PM")).toBeVisible();
    expect(within(row).getByText("32 matched · 8 created")).toBeVisible();
    expect(within(row).getByRole("cell", { name: "25" })).toBeVisible();
    expect(within(row).getByRole("cell", { name: "30" })).toBeVisible();
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
