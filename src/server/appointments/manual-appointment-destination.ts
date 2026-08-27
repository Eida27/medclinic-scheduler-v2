import { AppError } from "@/lib/errors";
import type { EffectiveAppointmentPair, PairAppointment } from "./appointment-pair-integrity";

type ManualDestinationAppointment = Pick<PairAppointment, "id" | "scheduleType">;

type ManualAppointmentDestinationInput = {
  appointment: ManualDestinationAppointment;
  pair: EffectiveAppointmentPair<PairAppointment & { appointmentDate: string }>;
  destinationDate: string;
  manilaToday: string;
  cycleStartDate: string;
  cycleClosingDate: string;
  isBlocked: boolean;
  usedCapacity: number;
  maxDailyCapacity: number;
};

function isWeekday(date: string) {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

export function assertManualAppointmentDestination(
  input: ManualAppointmentDestinationInput,
) {
  if (input.destinationDate <= input.manilaToday) {
    throw new AppError(
      "APPOINTMENT_DATE_IN_PAST",
      "The replacement date must be after today in Manila.",
      422,
    );
  }
  if (!isWeekday(input.destinationDate)) {
    throw new AppError(
      "APPOINTMENT_DATE_BLOCKED",
      "The replacement date must be a clinic weekday.",
      422,
    );
  }
  if (input.isBlocked) {
    throw new AppError(
      "APPOINTMENT_DATE_BLOCKED",
      "The replacement date is closed or reserved for this service.",
      409,
    );
  }
  if (
    input.destinationDate < input.cycleStartDate
    || input.destinationDate > input.cycleClosingDate
  ) {
    throw new AppError(
      "OUTSIDE_SCHEDULING_CYCLE",
      "The replacement date must remain inside the appointment's scheduling cycle.",
      422,
    );
  }

  const counterpart = input.appointment.scheduleType === "LABORATORY"
    ? input.pair.physicalExam
    : input.pair.laboratory;
  const violatesPairOrder = counterpart && (
    input.appointment.scheduleType === "LABORATORY"
      ? input.destinationDate >= counterpart.appointmentDate
      : input.destinationDate <= counterpart.appointmentDate
  );
  if (violatesPairOrder) {
    throw new AppError(
      "PAIR_ORDER_VIOLATION",
      "Laboratory must remain strictly before Physical Examination.",
      409,
    );
  }
  if (input.usedCapacity >= input.maxDailyCapacity) {
    throw new AppError(
      "DAILY_CAPACITY_EXCEEDED",
      "The selected service has reached its daily appointment capacity.",
      409,
    );
  }
}
