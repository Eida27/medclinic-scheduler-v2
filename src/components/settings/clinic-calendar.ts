import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";

export type CalendarDay = {
  date: string;
  dayOfMonth: number;
  inCurrentMonth: boolean;
  isWeekend: boolean;
};

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function parseMonth(month: string): { year: number; monthIndex: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) {
    throw new RangeError(`Expected month in YYYY-MM format, received "${month}".`);
  }

  return {
    year: Number(match[1]),
    monthIndex: Number(match[2]) - 1,
  };
}

function utcDate(year: number, monthIndex: number, dayOfMonth: number): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, monthIndex, dayOfMonth);
  return date;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_IN_MILLISECONDS);
}

function formatDateOnly(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function parseDateOnly(value: string): Date {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) {
    throw new RangeError(`Expected date in YYYY-MM-DD format, received "${value}".`);
  }

  const date = utcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (formatDateOnly(date) !== value) {
    throw new RangeError(`Expected a valid date in YYYY-MM-DD format, received "${value}".`);
  }
  return date;
}

export function buildMonthGrid(month: string): CalendarDay[] {
  const { year, monthIndex } = parseMonth(month);
  const firstOfMonth = utcDate(year, monthIndex, 1);
  const gridStart = addUtcDays(firstOfMonth, -firstOfMonth.getUTCDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = addUtcDays(gridStart, index);
    const dayOfWeek = date.getUTCDay();
    return {
      date: formatDateOnly(date),
      dayOfMonth: date.getUTCDate(),
      inCurrentMonth: date.getUTCFullYear() === year && date.getUTCMonth() === monthIndex,
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    };
  });
}

export function expandUnavailableRanges(
  records: ClinicUnavailableDateRecord[],
): Map<string, ClinicUnavailableDateRecord> {
  const dates = new Map<string, ClinicUnavailableDateRecord>();

  for (const record of records) {
    const end = parseDateOnly(record.endDate);
    for (
      let current = parseDateOnly(record.startDate);
      current.getTime() <= end.getTime();
      current = addUtcDays(current, 1)
    ) {
      dates.set(formatDateOnly(current), record);
    }
  }

  return dates;
}

export function shiftMonth(month: string, offset: number): string {
  const { year, monthIndex } = parseMonth(month);
  const shifted = utcDate(year, monthIndex + offset, 1);
  return formatDateOnly(shifted).slice(0, 7);
}

export function manilaToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
