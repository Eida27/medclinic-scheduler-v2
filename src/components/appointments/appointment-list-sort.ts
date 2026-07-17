export const APPOINTMENT_LIST_SORTS = [
  "surname_asc",
  "surname_desc",
  "soonest",
  "latest",
] as const;

export type AppointmentListSort = typeof APPOINTMENT_LIST_SORTS[number];

export function parseAppointmentListSort(value?: string): AppointmentListSort {
  return APPOINTMENT_LIST_SORTS.includes(value as AppointmentListSort)
    ? value as AppointmentListSort
    : "soonest";
}
