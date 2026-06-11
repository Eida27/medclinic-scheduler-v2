import "server-only";
import { weekdaysInRange } from "@/lib/dates";
import { checkCapacity } from "./capacity-rules";
import { sortByPriority } from "./priority-rules";
import type {
  AppointmentScheduleType,
  CapacitySetting,
  DraftAppointment,
  GenerateScheduleInput,
  GenerateScheduleOutput,
  ScheduleItemInput,
} from "./types";

function servicesFor(item: ScheduleItemInput): AppointmentScheduleType[] {
  return item.scheduleType === "BOTH" ? ["PHYSICAL_EXAM", "LABORATORY"] : [item.scheduleType];
}

function loadKey(date: string, scheduleType: AppointmentScheduleType): string {
  return `${date}:${scheduleType}`;
}

function capacityFor(settings: CapacitySetting[], scheduleType: AppointmentScheduleType): CapacitySetting {
  const setting = settings.find((entry) => entry.scheduleType === scheduleType);
  if (!setting) throw new Error(`Missing capacity setting for ${scheduleType}`);
  return setting;
}

function eligibleDates(item: ScheduleItemInput): string[] {
  if (item.targetDate) return [item.targetDate];
  if (item.targetWeekStart && item.targetWeekEnd) {
    return weekdaysInRange(item.targetWeekStart, item.targetWeekEnd);
  }
  return [];
}

export function generateSchedule(input: GenerateScheduleInput): GenerateScheduleOutput {
  const loads = new Map<string, number>();
  for (const entry of input.existingLoad) {
    loads.set(loadKey(entry.date, entry.scheduleType), entry.count);
  }

  const appointments: DraftAppointment[] = [];
  const unscheduledItems: GenerateScheduleOutput["unscheduledItems"] = [];

  for (const item of sortByPriority(input.items)) {
    const dates = eligibleDates(item);
    if (dates.length === 0) {
      unscheduledItems.push({
        scheduleItemId: item.id,
        studentNumber: item.studentNumber,
        code: "NO_ELIGIBLE_DATE",
        message: "The request does not contain an eligible weekday.",
      });
      continue;
    }

    const services = servicesFor(item);
    let selectedDate: string | undefined;

    if (item.targetDate) {
      selectedDate = item.targetDate;
    } else {
      selectedDate = dates
        .filter((date) =>
          services.every((service) => {
            const setting = capacityFor(input.capacities, service);
            return (loads.get(loadKey(date, service)) ?? 0) < setting.maxDailyCapacity;
          }),
        )
        .sort((left, right) => {
          const leftLoad = services.reduce((sum, service) => sum + (loads.get(loadKey(left, service)) ?? 0), 0);
          const rightLoad = services.reduce((sum, service) => sum + (loads.get(loadKey(right, service)) ?? 0), 0);
          return leftLoad - rightLoad || left.localeCompare(right);
        })[0];
    }

    if (!selectedDate) {
      unscheduledItems.push({
        scheduleItemId: item.id,
        studentNumber: item.studentNumber,
        code: "NO_CAPACITY",
        message: "No eligible date remains within the maximum service capacity.",
      });
      continue;
    }

    for (const service of services) {
      appointments.push({
        scheduleItemId: item.id,
        studentNumber: item.studentNumber,
        scheduleType: service,
        appointmentDate: selectedDate,
      });
      const key = loadKey(selectedDate, service);
      loads.set(key, (loads.get(key) ?? 0) + 1);
    }
  }

  const capacityResults = [...loads.entries()]
    .map(([key, count]) => {
      const separator = key.lastIndexOf(":");
      const date = key.slice(0, separator);
      const scheduleType = key.slice(separator + 1) as AppointmentScheduleType;
      return checkCapacity(date, scheduleType, count, capacityFor(input.capacities, scheduleType));
    })
    .sort((left, right) => left.date.localeCompare(right.date) || left.scheduleType.localeCompare(right.scheduleType));

  return { appointments, unscheduledItems, capacityResults };
}
