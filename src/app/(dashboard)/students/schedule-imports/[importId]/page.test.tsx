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
      conflictCount: 0,
      capacityResults: [{
        clinicId: `${id}-clinic`,
        date: targetDate,
        scheduleType,
        count: 1,
        maxCapacity: 150,
        status: "VALID",
        message: "This date is within the maximum daily capacity.",
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
      studentCategory: "SPECIALIZED",
      academicYearStart: 2026,
      preferredMonth: 12,
      acceptedAt: "2026-07-11T06:30:00.000Z",
      skippedStudentCount: 0,
      generatedRange: { startDate: "2026-12-01", endDate: "2026-12-11" },
      overflow: { pairCountBeyondPreferredWindow: 0, unscheduledStudentCount: 0 },
      displacementTotal: 0,
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
    expect(screen.getByText("System Admin")).toBeVisible();
    expect(screen.getByText("SPECIALIZED")).toBeVisible();
    expect(screen.getByText("2026–2027")).toBeVisible();
    expect(screen.getByText("Students")).toBeVisible();
    expect(screen.getByText("3", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("1 inserted · 2 updated · 0 skipped")).toBeVisible();
    expect(screen.getByText("Published pairs")).toBeVisible();
    expect(screen.getByText("Grouped actions for import-1 in GENERATED as ADMIN")).toBeVisible();
    expect(screen.getByRole("region", { name: "Laboratory schedule review" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Physical examination schedule review" })).toBeVisible();
    expect(screen.getAllByText("Draft — not published")).toHaveLength(2);
  });

  it("renders the dedicated published First Year allocation and lineage summary", async () => {
    requireUser.mockResolvedValue(admin);
    getScheduleImport.mockResolvedValue({
      importId: "import-1",
      importName: "First Year 2026-2027",
      sourceFilename: "first-year.csv",
      totalRows: 280,
      createdStudentCount: 280,
      matchedStudentCount: 0,
      createdByName: "System Admin",
      laboratoryItemCount: 280,
      physicalExaminationItemCount: 280,
      status: "PUBLISHED",
      importMode: "FIRST_YEAR_OVPSA",
      studentCategory: "REGULAR",
      academicYearStart: 2026,
      acceptedAt: "2026-08-13T06:30:00.000Z",
      skippedStudentCount: 0,
      generatedRange: { startDate: "2026-09-22", endDate: "2026-09-30" },
      overflow: { pairCountBeyondPreferredWindow: 0, unscheduledStudentCount: 0 },
      displacementTotal: 4,
      firstYearSummary: {
        laboratory: { date: "2026-09-22", locationName: "Iloilo Mission Hospital" },
        firstPhysicalExamCandidate: "2026-09-29",
        physicalExamMaximumCapacity: 150,
        allocations: [
          { date: "2026-09-29", studentCount: 150, capacity: 150 },
          { date: "2026-09-30", studentCount: 130, capacity: 150 },
        ],
        skippedDates: [{ date: "2026-09-28", reasons: ["PROTECTED_APPOINTMENT_CONFLICT"] }],
        displacementTotal: 4,
        appointmentCount: 560,
        batchId: "ovpsa-batch",
        revisionId: "ovpsa-revision",
      },
      childBatches: [],
    });

    render(await ScheduleImportDetailPage({
      params: Promise.resolve({ importId: "import-1" }),
    }));

    expect(screen.getByText("First Year", { selector: "dd" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "First Year publication" })).toBeVisible();
    expect(screen.getByText("2026-09-22 at Iloilo Mission Hospital")).toBeVisible();
    expect(screen.getByText("150 / 150 students")).toBeVisible();
    expect(screen.getByText("130 / 150 students")).toBeVisible();
    expect(screen.getByText(/2026-09-28.*Protected appointment conflict/)).toBeVisible();
    expect(screen.getByText("560 appointments")).toBeVisible();
    expect(screen.getByText(/ovpsa-batch \/ ovpsa-revision/)).toBeVisible();
    expect(screen.getAllByText("PUBLISHED").length).toBeGreaterThan(0);
  });
});
