import "server-only";

import { AppError } from "@/lib/errors";

export type PairAppointmentStatus =
  | "DRAFT"
  | "PENDING"
  | "COMPLETED"
  | "NO_SHOW"
  | "RESCHEDULED"
  | "CANCELLED"
  | "AWAITING_RESCHEDULE";

export type PairAppointment = {
  id: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  status: PairAppointmentStatus;
};

export type EffectiveAppointmentPair<T extends PairAppointment = PairAppointment> = {
  laboratory: T | null;
  physicalExam: T | null;
};

export function assertPhysicalExamCompletionAllowed(
  appointment: PairAppointment,
  pair: EffectiveAppointmentPair,
) {
  if (appointment.scheduleType !== "PHYSICAL_EXAM") return;
  if (pair.laboratory?.status === "COMPLETED") return;
  throw new AppError(
    "LABORATORY_NOT_COMPLETED",
    "Physical Examination cannot be completed until the student's Laboratory appointment is completed.",
    409,
  );
}

export function assertLaboratoryCompletionRollbackAllowed(
  appointment: PairAppointment,
  pair: EffectiveAppointmentPair,
) {
  if (appointment.scheduleType !== "LABORATORY") return;
  if (pair.physicalExam?.status !== "COMPLETED") return;
  throw new AppError(
    "PHYSICAL_ALREADY_COMPLETED",
    "Laboratory completion cannot be reversed because the paired Physical Examination has already been completed.",
    409,
  );
}

export function cancellationTargetsForPair<T extends PairAppointment>(
  appointment: T,
  pair: EffectiveAppointmentPair<T>,
): T[] {
  if (appointment.scheduleType !== "LABORATORY") return [appointment];
  if (pair.physicalExam?.status === "COMPLETED") {
    throw new AppError(
      "PHYSICAL_ALREADY_COMPLETED",
      "Laboratory cannot be cancelled because the paired Physical Examination has already been completed.",
      409,
    );
  }
  if (pair.physicalExam?.status === "PENDING" || pair.physicalExam?.status === "NO_SHOW") {
    return [appointment, pair.physicalExam];
  }
  return [appointment];
}
