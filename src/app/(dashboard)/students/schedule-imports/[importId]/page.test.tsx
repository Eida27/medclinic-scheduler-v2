import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { admin, getScheduleImport, requireUser } = vi.hoisted(() => ({
  admin: {
    userId: "admin-1",
    fullName: "System Admin",
    email: "admin@medclinic.local",
    role: "ADMIN" as const,
  },
  getScheduleImport: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/schedule-imports.service", () => ({ getScheduleImport }));
vi.mock("@/components/schedules/ScheduleImportActions", () => ({
  ScheduleImportActions: ({ importId, status, actorRole }: { importId: string; status: string; actorRole: string }) => (
    <div>Grouped actions for {importId} in {status} as {actorRole}</div>
  ),
}));

import ScheduleImportDetailPage from "./page";

function childBatch({
  id,
  clinicCode,
  clinicName,
  scheduleType,
  targetDate,
}: {
  id: string;
  clinicCode: string;
  clinicName: string;
  scheduleType: string;
  targetDate: string;
}) {
  return {
    id,
    clinicCode,
    clinicName,
    status: "GENERATED",
    validationSummary: {
      totalItems: 1,
      validCount: 1,
      warningCount: 0,
      conflictCount: 0,
      capacityResults: [{
        clinicId: `${id}-clinic`,
        date: targetDate,
        scheduleType,
        count: 1,
        safeCapacity: 120,
        maxCapacity: 150,
        status: "VALID",
        message: "This date is within the recommended daily capacity.",
      }],
    },
    items: [{
      id: `${id}-item`,
      studentNumber: "2026-0001",
      studentName: "Review Student",
      scheduleType,
      priorityGroupName: "Regular",
      targetDate,
      targetWeekStart: null,
      targetWeekEnd: null,
      status: "SCHEDULED",
      validationIssues: [],
    }],
    appointments: [{
      id: `${id}-appointment`,
      batchId: id,
      studentNumber: "2026-0001",
      studentName: "Review Student",
      scheduleType,
      appointmentDate: targetDate,
      appointmentTime: null,
      status: "DRAFT",
      isPublished: false,
      notes: null,
    }],
  };
}

describe("ScheduleImportDetailPage", () => {
  it("does not load grouped detail when import-operator authorization fails", async () => {
    requireUser.mockRejectedValueOnce(new Error("forbidden"));

    await expect(ScheduleImportDetailPage({
      params: Promise.resolve({ importId: "import-1" }),
    })).rejects.toThrow("forbidden");
    expect(getScheduleImport).not.toHaveBeenCalled();
  });

  it("allows administrators and coordinators and passes the role to grouped actions", async () => {
    requireUser.mockResolvedValue(admin);
    getScheduleImport.mockResolvedValue({
      importId: "import-1",
      importName: "December graduation schedules",
      sourceFilename: "graduation-schedules.csv",
      totalRows: 3,
      createdStudentCount: 1,
      matchedStudentCount: 2,
      submittedByName: "Registrar Office",
      description: "Graduating student clinic schedule",
      createdByName: "System Admin",
      laboratoryItemCount: 2,
      physicalExaminationItemCount: 1,
      status: "GENERATED",
      createdAt: "2026-07-11T06:30:00.000Z",
      updatedAt: "2026-07-11T06:35:00.000Z",
      childBatches: [
        childBatch({
          id: "laboratory-batch",
          clinicCode: "KABALAKA_CLINIC",
          clinicName: "KABALAKA Clinic",
          scheduleType: "LABORATORY",
          targetDate: "2026-12-10",
        }),
        childBatch({
          id: "physical-batch",
          clinicCode: "CPU_CLINIC",
          clinicName: "CPU Clinic",
          scheduleType: "PHYSICAL_EXAM",
          targetDate: "2026-12-11",
        }),
      ],
    });

    render(await ScheduleImportDetailPage({
      params: Promise.resolve({ importId: "import-1" }),
    }));

    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "COORDINATOR"]);
    expect(getScheduleImport).toHaveBeenCalledWith("import-1", admin);
    expect(screen.getByRole("heading", { name: "December graduation schedules", level: 1 })).toBeVisible();
    expect(screen.getByText("graduation-schedules.csv")).toBeVisible();
    expect(screen.getByText("Imported by System Admin")).toBeVisible();
    expect(screen.getByText("Submitted by Registrar Office")).toBeVisible();
    expect(screen.getByText("Graduating student clinic schedule")).toBeVisible();
    expect(screen.getByText("Total students")).toBeVisible();
    expect(screen.getByText("3", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("2 matched", { exact: false })).toBeVisible();
    expect(screen.getByText("1 created", { exact: false })).toBeVisible();
    expect(screen.getByText("2 Laboratory requests")).toBeVisible();
    expect(screen.getByText("1 Physical examination request")).toBeVisible();
    expect(screen.getByText("Grouped actions for import-1 in GENERATED as ADMIN")).toBeVisible();
    expect(screen.getByRole("region", { name: "Laboratory schedule review" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Physical examination schedule review" })).toBeVisible();
    expect(screen.getAllByText("Draft — not published")).toHaveLength(2);
  });
});
