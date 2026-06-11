const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateOnly(value: string): Date {
  if (!DATE_ONLY.test(value)) {
    throw new Error(`Invalid date: ${value}`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function weekdaysInRange(start: string, end: string): string[] {
  const startDate = parseDateOnly(start);
  const endDate = parseDateOnly(end);
  if (endDate < startDate) return [];

  const dates: string[] = [];
  for (const current = new Date(startDate); current <= endDate; current.setUTCDate(current.getUTCDate() + 1)) {
    const day = current.getUTCDay();
    if (day >= 1 && day <= 5) dates.push(formatDateOnly(current));
  }
  return dates;
}

export function formatDisplayDate(value: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parseDateOnly(value));
}
