import "server-only";
import type { AppointmentScheduleType, CapacityCheckResult, CapacitySetting } from "./types";

export function checkCapacity(
  date: string,
  scheduleType: AppointmentScheduleType,
  count: number,
  setting: CapacitySetting,
): CapacityCheckResult {
  const status = count > setting.maxDailyCapacity ? "CONFLICT" : count > setting.safeDailyCapacity ? "WARNING" : "VALID";
  const message =
    status === "CONFLICT"
      ? `${count} appointments exceed the maximum capacity of ${setting.maxDailyCapacity}.`
      : status === "WARNING"
        ? `${count} appointments are above the recommended capacity of ${setting.safeDailyCapacity}.`
        : "This date is within the recommended daily capacity.";

  return {
    status,
    date,
    scheduleType,
    count,
    safeCapacity: setting.safeDailyCapacity,
    maxCapacity: setting.maxDailyCapacity,
    message,
  };
}
