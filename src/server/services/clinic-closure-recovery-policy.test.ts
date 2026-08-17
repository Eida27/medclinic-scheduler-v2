import { describe, expect, it } from "vitest";

import {
  compareClosureRecoveryQueueEntries,
  evaluateClosureRecoveryPolicy,
  planMinimalClosureRecovery,
} from "./clinic-closure-recovery-policy";

describe("clinic closure recovery policy", () => {
  it.each([
    ["2026-08-14", "2026-08-14", 0, "MANUAL_RESOLUTION_REQUIRED"],
    ["2026-08-14", "2026-08-15", 1, "MANUAL_RESOLUTION_REQUIRED"],
    ["2026-08-14", "2026-09-12", 29, "MANUAL_RESOLUTION_REQUIRED"],
    ["2026-08-14", "2026-09-13", 30, "MANUAL_RESOLUTION_REQUIRED"],
    ["2026-08-14", "2026-09-14", 31, "AUTO_RECOVERY_ELIGIBLE"],
    ["2026-08-14", "2026-10-13", 60, "AUTO_RECOVERY_ELIGIBLE"],
  ] as const)(
    "uses Manila calendar dates for a %i-day notice decision",
    (policyEffectiveDate, appointmentDate, noticeDays, decision) => {
      expect(evaluateClosureRecoveryPolicy({
        category: "CLOSURE",
        policyEffectiveDate,
        affectedAppointmentDate: appointmentDate,
        affectedService: "PHYSICAL_EXAM",
        recoveryMode: "AUTO_ELIGIBLE",
        isOvpsaControlledLaboratory: false,
      })).toMatchObject({ decision, noticeDays });
    },
  );

  it("keeps emergency and OVPSA Laboratory reasons stronger than MANUAL_ALL", () => {
    expect(evaluateClosureRecoveryPolicy({
      category: "EMERGENCY_CLOSURE",
      policyEffectiveDate: "2026-08-14",
      affectedAppointmentDate: "2026-10-13",
      affectedService: "PHYSICAL_EXAM",
      recoveryMode: "MANUAL_ALL",
      isOvpsaControlledLaboratory: false,
    })).toMatchObject({
      decision: "MANUAL_RESOLUTION_REQUIRED",
      reasonCode: "EMERGENCY_CLOSURE",
    });
    expect(evaluateClosureRecoveryPolicy({
      category: "CLOSURE",
      policyEffectiveDate: "2026-08-14",
      affectedAppointmentDate: "2026-10-13",
      affectedService: "LABORATORY",
      recoveryMode: "MANUAL_ALL",
      isOvpsaControlledLaboratory: true,
    })).toMatchObject({
      decision: "MANUAL_RESOLUTION_REQUIRED",
      reasonCode: "OVPSA_LABORATORY_PROTECTED",
    });
  });

  it("applies safety reasons before the administrator batch choice", () => {
    expect(evaluateClosureRecoveryPolicy({
      category: "MAINTENANCE",
      policyEffectiveDate: "2026-08-14",
      affectedAppointmentDate: "2026-10-13",
      affectedService: "LABORATORY",
      recoveryMode: "MANUAL_ALL",
      isOvpsaControlledLaboratory: false,
      safetyReason: {
        reasonCode: "DRAFT_RESULT_FILES_EXIST",
        reasonMessage: "Draft files exist.",
      },
    })).toMatchObject({
      decision: "MANUAL_RESOLUTION_REQUIRED",
      reasonCode: "DRAFT_RESULT_FILES_EXIST",
    });
  });

  it("moves only the affected PE while preserving its valid Laboratory", () => {
    expect(planMinimalClosureRecovery({
      laboratory: { id: "lab", appointmentDate: "2026-09-01", status: "PENDING" },
      physicalExam: { id: "pe", appointmentDate: "2026-09-14", status: "PENDING" },
      affectedServices: new Set(["PHYSICAL_EXAM"]),
    })).toEqual({
      strategy: "MOVE_PHYSICAL_ONLY",
      moveAppointmentIds: ["pe"],
      preservedAppointmentIds: ["lab"],
    });
  });

  it("moves a Laboratory alone when the existing PE remains safely later", () => {
    expect(planMinimalClosureRecovery({
      laboratory: { id: "lab", appointmentDate: "2026-09-14", status: "PENDING" },
      physicalExam: { id: "pe", appointmentDate: "2026-10-20", status: "PENDING" },
      affectedServices: new Set(["LABORATORY"]),
      proposedLaboratoryDate: "2026-09-21",
    })).toEqual({
      strategy: "MOVE_LABORATORY_ONLY",
      moveAppointmentIds: ["lab"],
      preservedAppointmentIds: ["pe"],
    });
  });

  it("orders recovery by affected date, original order, then student number", () => {
    const entries = [
      { affectedAppointmentDate: "2026-10-02", originalCreatedAt: "2026-08-01T00:00:00.000Z", originalOrder: 1, studentNumber: "2026-0001" },
      { affectedAppointmentDate: "2026-10-01", originalCreatedAt: "2026-08-02T00:00:00.000Z", originalOrder: 2, studentNumber: "2026-0003" },
      { affectedAppointmentDate: "2026-10-01", originalCreatedAt: "2026-08-01T00:00:00.000Z", originalOrder: 3, studentNumber: "2026-0002" },
      { affectedAppointmentDate: "2026-10-01", originalCreatedAt: "2026-08-01T00:00:00.000Z", originalOrder: 3, studentNumber: "2026-0001" },
    ];
    expect(entries.sort(compareClosureRecoveryQueueEntries).map((entry) => entry.studentNumber)).toEqual([
      "2026-0001",
      "2026-0002",
      "2026-0003",
      "2026-0001",
    ]);
  });

  it("does not reprioritize active category recoveries", () => {
    const entries = [
      { category: "TOUR", affectedAppointmentDate: "2026-10-01", originalCreatedAt: "2026-08-01T03:00:00.000Z", originalOrder: 3, studentNumber: "2026-0003" },
      { category: "OJT", affectedAppointmentDate: "2026-10-01", originalCreatedAt: "2026-08-01T02:00:00.000Z", originalOrder: 2, studentNumber: "2026-0002" },
      { category: "REGULAR", affectedAppointmentDate: "2026-10-01", originalCreatedAt: "2026-08-01T01:00:00.000Z", originalOrder: 1, studentNumber: "2026-0001" },
    ];
    expect(entries.sort(compareClosureRecoveryQueueEntries).map((entry) => entry.category)).toEqual([
      "REGULAR",
      "OJT",
      "TOUR",
    ]);
  });
});
