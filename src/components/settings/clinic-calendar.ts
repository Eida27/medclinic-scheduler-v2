import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";

export type CalendarBlankCell = { kind: "blank"; key: string };
export type CalendarDateCell = {
  kind: "date";
  key: string;
  date: string;
  dayOfMonth: number;
  isWeekend: boolean;
};
export type CalendarCell = CalendarBlankCell | CalendarDateCell;

function parseMonth(month: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new RangeError(`Expected month in YYYY-MM format, received "${month}".`);
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 };
}

function utcDate(year: number, monthIndex: number, day: number) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function formatDateOnly(date: Date) {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function buildMonthGrid(month: string): CalendarCell[] {
  const { year, monthIndex } = parseMonth(month);
  const leading = utcDate(year, monthIndex, 1).getUTCDay();
  const days = utcDate(year, monthIndex + 1, 0).getUTCDate();
  const total = Math.ceil((leading + days) / 7) * 7;
  return Array.from({ length: total }, (_, index): CalendarCell => {
    const day = index - leading + 1;
    if (day < 1 || day > days) return { kind: "blank", key: `${month}-blank-${index}` };
    const date = utcDate(year, monthIndex, day);
    const value = formatDateOnly(date);
    return {
      kind: "date",
      key: value,
      date: value,
      dayOfMonth: day,
      isWeekend: date.getUTCDay() === 0 || date.getUTCDay() === 6,
    };
  });
}

export function buildAnnualCalendar(year: number) {
  if (!Number.isInteger(year) || year < 1 || year > 2100) throw new RangeError("Invalid calendar year.");
  return Array.from({ length: 12 }, (_, monthIndex) => {
    const month = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
    return {
      month,
      name: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })
        .format(utcDate(year, monthIndex, 1)),
      cells: buildMonthGrid(month),
    };
  });
}

export function expandUnavailableRanges(records: ClinicUnavailableDateRecord[]) {
  return new Map(records.map((record) => [record.blockedDate, record]));
}

export function shiftMonth(month: string, offset: number) {
  const { year, monthIndex } = parseMonth(month);
  return formatDateOnly(utcDate(year, monthIndex + offset, 1)).slice(0, 7);
}

export function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
