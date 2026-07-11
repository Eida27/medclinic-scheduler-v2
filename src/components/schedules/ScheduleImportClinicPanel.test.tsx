import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScheduleImportClinicPanel } from "./ScheduleImportClinicPanel";

const laboratoryBatch = {
  id: "laboratory-batch",
  clinicCode: "KABALAKA_CLINIC",
  clinicName: "KABALAKA Clinic",
  status: "GENERATED",
  validationSummary: {
    totalItems: 2,
    validCount: 0,
    warningCount: 1,
    conflictCount: 1,
    capacityResults: [{
      clinicId: "clinic-1",
      date: "2026-12-10",
      scheduleType: "LABORATORY",
      count: 121,
      safeCapacity: 120,
      maxCapacity: 150,
      status: "WARNING",
      message: "This date is above the recommended daily capacity.",
    }],
  },
  items: [{
    id: "item-1",
    studentNumber: "2026-0001",
    studentName: "Draft Reviewer",
    scheduleType: "LABORATORY",
    priorityGroupName: "Graduating",
    targetDate: "2026-12-10",
    targetWeekStart: null,
    targetWeekEnd: null,
    status: "WARNING",
    validationIssues: [{
      severity: "WARNING",
      message: "Daily safe capacity would be exceeded.",
    }, {
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
    appointmentTime: null,
    status: "DRAFT",
    isPublished: false,
    notes: null,
  }],
};

describe("ScheduleImportClinicPanel", () => {
  it("shows validation, capacity, issues, requests, and unpublished generated appointments", () => {
    render(<ScheduleImportClinicPanel batch={laboratoryBatch} />);

    const section = screen.getByRole("region", { name: "Laboratory schedule review" });
    expect(within(section).getByText("KABALAKA Clinic")).toBeVisible();
    expect(within(section).getByText("GENERATED")).toBeVisible();
    expect(within(section).getByText("2", { selector: "dd" })).toBeVisible();
    expect(within(section).getByText("1 warning")).toBeVisible();
    expect(within(section).getByText("1 conflict")).toBeVisible();
    expect(within(section).getByText("121 scheduled / 120 safe / 150 maximum")).toBeVisible();
    expect(within(section).getByText("This date is above the recommended daily capacity.")).toBeVisible();
    expect(within(section).getByText("Daily safe capacity would be exceeded.")).toBeVisible();
    expect(within(section).getByText("Student already has an active laboratory appointment.")).toBeVisible();
    expect(within(section).getAllByText("Draft Reviewer")).toHaveLength(2);
    expect(within(section).getByText("Draft — not published")).toBeVisible();
    expect(within(section).getAllByText("2026-12-10")).toHaveLength(3);
  });

  it("explains when generated drafts are not present yet", () => {
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
    expect(within(section).getByText("Validate the import to see validation totals and capacity results.")).toBeVisible();
    expect(within(section).getByText("Draft appointments will appear here after this import is generated.")).toBeVisible();
  });
});
