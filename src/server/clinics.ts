import "server-only";

export type ClinicCode = "KABALAKA_CLINIC" | "CPU_CLINIC";
export type AppointmentScheduleType = "PHYSICAL_EXAM" | "LABORATORY";

export type ClinicConfig = {
  code: ClinicCode;
  name: string;
  scheduleType: AppointmentScheduleType;
  routeRoot: "/laboratory" | "/physical-exam";
  dashboardTitle: string;
  dashboardDescription: string;
  serviceLabel: string;
};

export const clinicConfigs = {
  KABALAKA_CLINIC: {
    code: "KABALAKA_CLINIC",
    name: "KABALAKA Clinic",
    scheduleType: "LABORATORY",
    routeRoot: "/laboratory",
    dashboardTitle: "Laboratory Scheduler",
    dashboardDescription: "KABALAKA Clinic laboratory schedules, appointments, and results.",
    serviceLabel: "Laboratory",
  },
  CPU_CLINIC: {
    code: "CPU_CLINIC",
    name: "CPU Clinic",
    scheduleType: "PHYSICAL_EXAM",
    routeRoot: "/physical-exam",
    dashboardTitle: "Physical Examination Scheduler",
    dashboardDescription: "CPU Clinic physical examination schedules, appointments, and results.",
    serviceLabel: "Physical examination",
  },
} as const satisfies Record<ClinicCode, ClinicConfig>;

export const clinicCodeByScheduleType = {
  LABORATORY: "KABALAKA_CLINIC",
  PHYSICAL_EXAM: "CPU_CLINIC",
} as const satisfies Record<AppointmentScheduleType, ClinicCode>;

export function clinicForScheduleType(scheduleType: AppointmentScheduleType): ClinicConfig {
  return clinicConfigs[clinicCodeByScheduleType[scheduleType]];
}

export function clinicConfigForCode(code: ClinicCode): ClinicConfig {
  return clinicConfigs[code];
}

export function isClinicCode(value: unknown): value is ClinicCode {
  return value === "KABALAKA_CLINIC" || value === "CPU_CLINIC";
}
