export type StudentCategory = "REGULAR" | "OJT" | "TOUR" | "SPECIALIZED";

export type SchedulingWindowInput = {
  category: StudentCategory;
  academicYearStart: number;
  preferredMonth: number | null;
  acceptedAt: string;
  timeZone: string;
};

function localIsoDate(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function nextWeekday(date: string) {
  let candidate = date;
  while (true) {
    const weekday = new Date(`${candidate}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return candidate;
    candidate = addCalendarDays(candidate, 1);
  }
}

export function resolveSchedulingWindow(input: SchedulingWindowInput): string {
  const acceptedInstant = new Date(input.acceptedAt);
  if (Number.isNaN(acceptedInstant.getTime())) {
    throw new TypeError("acceptedAt must be a valid timestamp.");
  }
  const preparationDate = addCalendarDays(
    localIsoDate(acceptedInstant, input.timeZone),
    7,
  );

  let categoryStart: string;
  if (input.category === "REGULAR") {
    if (input.preferredMonth !== null) {
      throw new TypeError("Regular scheduling windows do not use a preferred month.");
    }
    categoryStart = `${input.academicYearStart}-08-01`;
  } else {
    if (input.preferredMonth === null || input.preferredMonth < 1 || input.preferredMonth > 12) {
      throw new TypeError("Priority scheduling windows require a preferred month.");
    }
    const year = input.preferredMonth >= 8
      ? input.academicYearStart
      : input.academicYearStart + 1;
    categoryStart = `${year}-${String(input.preferredMonth).padStart(2, "0")}-01`;
  }

  return nextWeekday(preparationDate > categoryStart ? preparationDate : categoryStart);
}
