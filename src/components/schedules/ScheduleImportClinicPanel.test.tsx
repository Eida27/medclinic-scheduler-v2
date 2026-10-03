import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScheduleImportClinicPanel } from "./ScheduleImportClinicPanel";

const laboratoryBatch = {
  id: "laboratory-batch",
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
  status: "PUBLISHED",
  validationSummary: {
    totalItems: 2,
    validCount: 2,
    conflictCount: 0,
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
    status: "SCHEDULED",
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
    status: "PENDING",
    isPublished: true,
    notes: null,
  }],
};

describe("ScheduleImportClinicPanel", () => {
  it("shows published appointments and successful validation without retired manual diagnostics", () => {
    render(<ScheduleImportClinicPanel batch={laboratoryBatch} />);

    const section = screen.getByRole("region", { name: "Laboratory schedule review" });
    expect(within(section).getByText("KABALAKA Clinic")).toBeVisible();
    expect(within(section).getByText("PUBLISHED")).toBeVisible();
    expect(within(section).getAllByText("2", { selector: "dd" })).toHaveLength(2);
    expect(within(section).getByText("0 conflicts")).toBeVisible();
    expect(within(section).queryByRole("heading", { name: "Capacity results" })).not.toBeInTheDocument();
    expect(within(section).queryByText("This date is within the maximum daily capacity.")).not.toBeInTheDocument();
    expect(within(section).queryByText(/warning|safe|recommended/i)).not.toBeInTheDocument();
    expect(within(section).queryByRole("heading", { name: "Schedule requests" })).not.toBeInTheDocument();

    const generatedHeading = within(section).getByRole("heading", { name: "Generated appointments" });
    const generatedSection = generatedHeading.closest("section");
    expect(generatedSection).not.toBeNull();
    const appointmentsTable = within(generatedSection as HTMLElement).getByRole("table");
    expect(within(appointmentsTable).queryByRole("columnheader", { name: "Priority" })).not.toBeInTheDocument();
    expect(within(section).queryByText(/priority:/i)).not.toBeInTheDocument();

    expect(within(section).queryByText(/Review exceptions/)).not.toBeInTheDocument();
    expect(within(section).queryByText("Student already has an active laboratory appointment.")).not.toBeInTheDocument();
    expect(within(section).getByText("Published")).toBeVisible();
    expect(within(section).getAllByText("2026-12-10")).toHaveLength(1);
  });

  it("explains read-only historical states without lifecycle-action copy", () => {
    render(<ScheduleImportClinicPanel batch={{
      ...laboratoryBatch,
      clinicCode: "CPU_CLINIC",
      clinicName: "CPU Clinic",
      status: "CANCELLED",
      validationSummary: null,
      appointments: [],
    }} />);

    const section = screen.getByRole("region", { name: "Physical examination schedule review" });
    expect(within(section).getByText("Validation totals are not available for this historical import.")).toBeVisible();
    expect(within(section).queryByText(/Review exceptions/)).not.toBeInTheDocument();
    expect(within(section).getByText("No appointments are recorded for this clinic batch.")).toBeVisible();
  });

  it("retains defensive unpublished appointment presentation", () => {
    render(<ScheduleImportClinicPanel batch={{
      ...laboratoryBatch,
      appointments: [{ ...laboratoryBatch.appointments[0], status: "DRAFT", isPublished: false }],
    }} />);
    expect(screen.getByText("Draft — not published")).toBeVisible();
  });
});
