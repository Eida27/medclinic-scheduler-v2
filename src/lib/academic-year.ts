export type AcademicYearState = "OPEN" | "CLOSING_SOON" | "CLOSED";

export function academicYearLabel(startYear: number) {
  return `${startYear}–${startYear + 1}`;
}

export function manilaCalendarDate(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((part) => part.type === type)?.value ?? ""
  );
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function utcDay(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function academicYearState(closingDate: string, instant: Date = new Date()): AcademicYearState {
  const daysRemaining = Math.round(
    (utcDay(closingDate) - utcDay(manilaCalendarDate(instant))) / 86_400_000,
  );
  if (daysRemaining < 0) return "CLOSED";
  if (daysRemaining <= 14) return "CLOSING_SOON";
  return "OPEN";
}
