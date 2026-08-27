import { describe, expect, it } from "vitest";

import {
  assertLaboratoryCompletionRollbackAllowed,
  assertPhysicalExamCompletionAllowed,
  cancellationTargetsForPair,
  type EffectiveAppointmentPair,
} from "./appointment-pair-integrity";

function appointment(
  id: string,
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM",
  status: "PENDING" | "COMPLETED" | "NO_SHOW" | "CANCELLED",
) {
  return { id, scheduleType, status };
}

function pair(
  laboratoryStatus: "PENDING" | "COMPLETED" | "NO_SHOW" | "CANCELLED" | null,
  physicalExamStatus: "PENDING" | "COMPLETED" | "NO_SHOW" | "CANCELLED" | null = "PENDING",
): EffectiveAppointmentPair {
  return {
    laboratory: laboratoryStatus
      ? appointment("laboratory-id", "LABORATORY", laboratoryStatus)
      : null,
    physicalExam: physicalExamStatus
      ? appointment("physical-id", "PHYSICAL_EXAM", physicalExamStatus)
      : null,
  };
}

describe("appointment pair lifecycle integrity", () => {
  it("allows Physical Examination completion only after Laboratory completion", () => {
    expect(() => assertPhysicalExamCompletionAllowed(
      appointment("physical-id", "PHYSICAL_EXAM", "PENDING"),
      pair("COMPLETED"),
    )).not.toThrow();
  });

  it.each(["PENDING", "NO_SHOW", "CANCELLED", null] as const)(
    "rejects Physical Examination completion when Laboratory is %s",
    (laboratoryStatus) => {
      expect(() => assertPhysicalExamCompletionAllowed(
        appointment("physical-id", "PHYSICAL_EXAM", "PENDING"),
        pair(laboratoryStatus),
      )).toThrow(expect.objectContaining({
        code: "LABORATORY_NOT_COMPLETED",
        status: 409,
      }));
    },
  );

  it("rejects Laboratory completion rollback after Physical Examination completion", () => {
    expect(() => assertLaboratoryCompletionRollbackAllowed(
      appointment("laboratory-id", "LABORATORY", "COMPLETED"),
      pair("COMPLETED", "COMPLETED"),
    )).toThrow(expect.objectContaining({
      code: "PHYSICAL_ALREADY_COMPLETED",
      status: 409,
    }));
  });

  it.each(["PENDING", "NO_SHOW"] as const)(
    "cascades unfinished Laboratory cancellation to a %s Physical Examination",
    (physicalExamStatus) => {
      expect(cancellationTargetsForPair(
        appointment("laboratory-id", "LABORATORY", "PENDING"),
        pair("PENDING", physicalExamStatus),
      )).toEqual([
        appointment("laboratory-id", "LABORATORY", "PENDING"),
        appointment("physical-id", "PHYSICAL_EXAM", physicalExamStatus),
      ]);
    },
  );

  it("keeps Physical Examination cancellation isolated from Laboratory", () => {
    expect(cancellationTargetsForPair(
      appointment("physical-id", "PHYSICAL_EXAM", "PENDING"),
      pair("PENDING", "PENDING"),
    )).toEqual([appointment("physical-id", "PHYSICAL_EXAM", "PENDING")]);
  });

  it("rejects Laboratory cancellation when Physical Examination is already completed", () => {
    expect(() => cancellationTargetsForPair(
      appointment("laboratory-id", "LABORATORY", "PENDING"),
      pair("PENDING", "COMPLETED"),
    )).toThrow(expect.objectContaining({
      code: "PHYSICAL_ALREADY_COMPLETED",
      status: 409,
    }));
  });
});
