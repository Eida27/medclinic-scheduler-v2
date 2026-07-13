export const APPOINTMENT_SUMMARY_SORTS = [
  "upcoming_asc",
  "upcoming_desc",
  "name_asc",
  "name_desc",
  "attention_first",
  "completed_first",
] as const;

export type AppointmentSummarySort = typeof APPOINTMENT_SUMMARY_SORTS[number];
export type OverallStatus = "FOLLOW_UP" | "COMPLETE" | "INCOMPLETE";

export function parseAppointmentSummarySort(value?: string): AppointmentSummarySort {
  return APPOINTMENT_SUMMARY_SORTS.includes(value as AppointmentSummarySort)
    ? value as AppointmentSummarySort
    : "upcoming_asc";
}
