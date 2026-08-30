import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScheduleImportClinicPanel } from "./ScheduleImportClinicPanel";

const laboratoryBatch = {
  id: "laboratory-batch",
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
  status: "GENERATED",
  validationSummary: {
    totalItems: 2,
    validCount: 1,
    conflictCount: 1,
    capacityResults: [{
      clinicId: "clinic-1",
      date: "2026-12-10",
      scheduleType: "LABORATORY",
      count: 130,
      maxCapacity: 150,
      status: "VALID",
      message: "This date is within the maximum daily capacity.",
    }],
  },
  items: [{
    id: "item-1",
    studentNumber: "2026-0001",
    studentName: "Draft Reviewer",
    scheduleType: "LABORATORY",
    targetDate: "2026-12-10",
    targetWeekStart: null,
    targetWeekEnd: null,
    status: "CONFLICT",
    validationIssues: [{
      severity: "CONFLICT",
      message: "Student already has an active laboratory appointment.",
    }],
  }],
  appointments: [{
    id: "appointment-1",
    batchId: "laboratory-batch",
    studentNumber: "2026-0001",
    studentName: "Draft Reviewer",
    scheduleType: "LABORATORY",
    appointmentDate: "2026-12-10",
    status: "DRAFT",
    isPublished: false,
    notes: null,
  }],
};

describe("ScheduleImportClinicPanel", () => {
  it("shows generated appointments without retired priority labels and keeps issues collapsed", () => {
    render(<ScheduleImportClinicPanel batch={laboratoryBatch} />);

    const section = screen.getByRole("region", { name: "Laboratory schedule review" });
    expect(within(section).getByText("KABALAKA Clinic")).toBeVisible();
    expect(within(section).getByText("GENERATED")).toBeVisible();
    expect(within(section).getByText("2", { selector: "dd" })).toBeVisible();
    expect(within(section).getByText("1 conflict")).toBeVisible();
    expect(within(section).getByText("130 scheduled / 150 maximum")).toBeVisible();
    expect(within(section).getByText("This date is within the maximum daily capacity.")).toBeVisible();
    expect(within(section).queryByText(/warning|safe|recommended/i)).not.toBeInTheDocument();
    expect(within(section).queryByRole("heading", { name: "Schedule requests" })).not.toBeInTheDocument();

    const generatedHeading = within(section).getByRole("heading", { name: "Generated appointments" });
    const generatedSection = generatedHeading.closest("section");
    expect(generatedSection).not.toBeNull();
    const appointmentsTable = within(generatedSection as HTMLElement).getByRole("table");
    expect(within(appointmentsTable).queryByRole("columnheader", { name: "Priority" })).not.toBeInTheDocument();
    expect(within(section).queryByText(/priority:/i)).not.toBeInTheDocument();

    const exceptionSummary = within(section).getByText("Review exceptions (1 issue)");
    const conflict = within(section).getByText("Student already has an active laboratory appointment.");
    expect(conflict).not.toBeVisible();
    fireEvent.click(exceptionSummary);
    expect(conflict).toBeVisible();
    expect(within(section).getByText("Draft — not published")).toBeVisible();
    expect(within(section).getAllByText("2026-12-10")).toHaveLength(2);
  });

  it("explains read-only historical states without lifecycle-action copy", () => {
    render(<ScheduleImportClinicPanel batch={{
      ...laboratoryBatch,
      clinicCode: "CPU_CLINIC",
      clinicName: "CPU Clinic",
      status: "DRAFT",
      validationSummary: null,
      items: [{
        ...laboratoryBatch.items[0],
        id: "item-2",
        scheduleType: "PHYSICAL_EXAM",
        targetDate: "2026-12-11",
        validationIssues: [],
        status: "PENDING",
      }],
      appointments: [],
    }} />);

    const section = screen.getByRole("region", { name: "Physical examination schedule review" });
    expect(within(section).getByText("Validation totals are not available for this historical import.")).toBeVisible();
    expect(within(section).queryByText(/Review exceptions/)).not.toBeInTheDocument();
    expect(within(section).getByText("No appointments are recorded for this clinic batch.")).toBeVisible();
  });
});
