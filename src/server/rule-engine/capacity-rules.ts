import "server-only";
import type { AppointmentScheduleType, CapacityCheckResult, CapacitySetting } from "./types";

export function checkCapacity(
  clinicId: string,
  date: string,
  scheduleType: AppointmentScheduleType,
  count: number,
  setting: CapacitySetting,
): CapacityCheckResult {
  const status = count > setting.maxDailyCapacity ? "CONFLICT" : "VALID";
  const message =
    status === "CONFLICT"
      ? `${count} appointments exceed the maximum capacity of ${setting.maxDailyCapacity}.`
      : "This date is within the maximum daily capacity.";

  return {
    status,
    clinicId,
    date,
    scheduleType,
    count,
    maxCapacity: setting.maxDailyCapacity,
    message,
  };
}
