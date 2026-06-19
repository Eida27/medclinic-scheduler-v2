import { parse } from "csv-parse/sync";
import { AppError } from "@/lib/errors";

export type CoordinatorScheduleCsvRow = {
  rowNumber: number;
  studentNumber: string;
  fullName: string;
  firstName: string;
  lastName: string;
  collegeName: string;
  courseCode: string;
  yearLevel: number;
  targetDate: string;
  scheduleType: "PHYSICAL_EXAM" | "LABORATORY" | "BOTH";
};

const scheduleTypes = {
  "Physical Examination": "PHYSICAL_EXAM",
  Laboratory: "LABORATORY",
  "Physical + Laboratory": "BOTH",
} as const;

const expectedHeaders = [
  "Student ID",
  "Name",
  "College",
  "Course",
  "Year",
  "Appointment Date",
  "Appointment Type",
] as const;

const headerError = `CSV headers must exactly match: ${expectedHeaders.join(", ")}.`;

function addError(fields: Record<string, string[]>, field: string, message: string) {
  fields[field] = [...(fields[field] ?? []), message];
}

function fail(fields: Record<string, string[]>): never {
  throw new AppError("CSV_IMPORT_INVALID", "Please correct the CSV import errors.", 422, fields);
}

function isoDate(value: string): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) return null;
  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return null;
  return `${year}-${month}-${day}`;
}

export function parseCoordinatorScheduleCsv(contents: string): CoordinatorScheduleCsvRow[] {
  let records: string[][];
  try {
    records = parse(contents, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch {
    fail({ file: ["The file is not valid CSV."] });
  }

  if (records.length < 2) fail({ file: ["CSV file must include the header and at least one data row."] });
  if (
    records[0].length !== expectedHeaders.length
    || records[0].some((header, index) => header !== expectedHeaders[index])
  ) fail({ file: [headerError] });
  if (records.length - 1 > 500) fail({ file: ["CSV files may contain at most 500 data rows."] });

  const fields: Record<string, string[]> = {};
  const rows: CoordinatorScheduleCsvRow[] = [];

  records.slice(1).forEach((record, index) => {
    const rowNumber = index + 2;
    if (record.length !== expectedHeaders.length) {
      addError(fields, `rows.${rowNumber}`, "Row must contain exactly 7 columns.");
      return;
    }

    const [studentNumber, rawFullName, collegeName, courseCode, year, appointmentDate, appointmentType] = record;
    const fullName = rawFullName.replace(/\s+/g, " ").trim();
    const nameSeparator = fullName.indexOf(" ");
    const targetDate = isoDate(appointmentDate);
    const scheduleType = scheduleTypes[appointmentType as keyof typeof scheduleTypes];

    if (studentNumber.length < 3 || studentNumber.length > 20) {
      addError(fields, `rows.${rowNumber}.Student ID`, "Student ID must contain 3 to 20 characters.");
    }
    if (nameSeparator < 1 || !fullName.slice(nameSeparator + 1).trim()) {
      addError(fields, `rows.${rowNumber}.Name`, "Name must contain a first name and last name.");
    }
    if (!collegeName) addError(fields, `rows.${rowNumber}.College`, "College is required.");
    if (!courseCode) addError(fields, `rows.${rowNumber}.Course`, "Course is required.");
    if (!/^[1-6]$/.test(year)) {
      addError(fields, `rows.${rowNumber}.Year`, "Year must be a whole number from 1 to 6.");
    }
    if (!targetDate) {
      addError(fields, `rows.${rowNumber}.Appointment Date`, "Appointment Date must be a valid date in MM-DD-YYYY format.");
    }
    if (!scheduleType) {
      addError(
        fields,
        `rows.${rowNumber}.Appointment Type`,
        "Appointment Type must be Physical Examination, Laboratory, or Physical + Laboratory.",
      );
    }

    if (
      studentNumber.length >= 3
      && studentNumber.length <= 20
      && nameSeparator >= 1
      && fullName.slice(nameSeparator + 1).trim()
      && collegeName
      && courseCode
      && /^[1-6]$/.test(year)
      && targetDate
      && scheduleType
    ) {
      rows.push({
        rowNumber,
        studentNumber,
        fullName,
        firstName: fullName.slice(0, nameSeparator),
        lastName: fullName.slice(nameSeparator + 1),
        collegeName,
        courseCode,
        yearLevel: Number(year),
        targetDate,
        scheduleType,
      });
    }
  });

  const requestedServices = new Map<string, { rowNumber: number; label: string }>();
  for (const row of rows) {
    const services = row.scheduleType === "BOTH" ? ["PHYSICAL_EXAM", "LABORATORY"] as const : [row.scheduleType];
    for (const service of services) {
      const key = `${row.studentNumber.toLocaleUpperCase()}:${service}`;
      const existing = requestedServices.get(key);
      if (existing) {
        const label = service === "PHYSICAL_EXAM" ? "physical examination" : "laboratory";
        addError(
          fields,
          `rows.${row.rowNumber}.Appointment Type`,
          `This student already has a ${label} request in row ${existing.rowNumber}.`,
        );
      } else {
        requestedServices.set(key, { rowNumber: row.rowNumber, label: service });
      }
    }
  }

  if (Object.keys(fields).length) fail(fields);
  return rows;
}
