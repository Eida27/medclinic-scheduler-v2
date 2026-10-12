import type { AppointmentStatus } from "./schedule-notifications";

export type OjtExternalXrayContext = {
  laboratoryAppointmentId: string;
  laboratoryDate: string | null;
  status: AppointmentStatus;
  clinicCode: string;
  yearLevel: number | null;
  schedulingCategory: string | null;
  hasOvpsaProvenance: boolean;
};

export type OjtExternalXraySchedule = {
  anchorLaboratoryAppointmentId: string;
  laboratoryDate: string | null;
  xrayDate: string | null;
  provider: "Iloilo Mission Hospital";
  offsetCalendarDays: 7;
};

export function deriveOjtExternalXraySchedule(
  context: OjtExternalXrayContext,
): OjtExternalXraySchedule | null {
  if (context.clinicCode !== "KABALAKA_CLINIC"
    || context.yearLevel !== 4
    || context.schedulingCategory !== "OJT"
    || context.hasOvpsaProvenance
    || !["PENDING", "COMPLETED", "NO_SHOW", "AWAITING_RESCHEDULE"].includes(context.status)) {
    return null;
  }
  const detail: OjtExternalXraySchedule = {
    anchorLaboratoryAppointmentId: context.laboratoryAppointmentId,
    laboratoryDate: null,
    xrayDate: null,
    provider: "Iloilo Mission Hospital",
    offsetCalendarDays: 7,
  };
  if (context.status === "AWAITING_RESCHEDULE" || !context.laboratoryDate) return detail;
  const components = /^(\d{4})-(\d{2})-(\d{2})$/.exec(context.laboratoryDate);
  if (!components) return detail;
  const date = new Date(`${context.laboratoryDate}T00:00:00.000Z`);
  if (date.getUTCFullYear() !== Number(components[1])
    || date.getUTCMonth() + 1 !== Number(components[2])
    || date.getUTCDate() !== Number(components[3])) return detail;
  date.setUTCDate(date.getUTCDate() - 7);
  return { ...detail, laboratoryDate: context.laboratoryDate, xrayDate: date.toISOString().slice(0, 10) };
}
