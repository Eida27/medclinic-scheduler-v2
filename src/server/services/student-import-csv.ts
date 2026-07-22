import { parse } from "csv-parse/sync";
import { AppError } from "@/lib/errors";

export type ImportedStudentRow = {
  rowNumber: number;
  studentNumber: string;
  surname: string;
  firstName: string;
  middleInitial: string | null;
  suffix: string | null;
  collegeName: string;
  courseCode: string;
  yearLevel: number;
  dateOfBirth: string;
};

export const STUDENT_IMPORT_MAXIMUM_BYTES = 1024 * 1024;
export const STUDENT_IMPORT_MAXIMUM_ROWS = 3_000;
export const STUDENT_IMPORT_HEADERS = [
  "Student ID",
  "Surname",
  "First Name",
  "MI",
  "Suffix",
  "College",
  "Course",
  "Year",
  "Date of Birth",
] as const;

const headerError = `CSV headers must exactly match: ${STUDENT_IMPORT_HEADERS.join(",")}.`;

function addError(fields: Record<string, string[]>, field: string, message: string) {
  fields[field] = [...(fields[field] ?? []), message];
}

function fail(fields: Record<string, string[]>): never {
  throw new AppError("CSV_IMPORT_INVALID", "Please correct the CSV import errors.", 422, fields);
}

function decodeInput(input: string | ArrayBuffer | Uint8Array): string {
  if (typeof input === "string") return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function normalizeRecord(record: string[]): string[] {
  const cells = record.map((cell) => cell.trim());
  while (cells.length > STUDENT_IMPORT_HEADERS.length && cells.at(-1) === "") cells.pop();
  return cells;
}

function characterCount(value: string) {
  return Array.from(value).length;
}

function manilaTodayIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function birthDateIso(value: string): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) return null;
  const [, month, day, year] = match;
  const numericYear = Number(year);
  if (numericYear < 1900) return null;

  const date = new Date(0);
  date.setUTCFullYear(numericYear, Number(month) - 1, Number(day));
  if (
    date.getUTCFullYear() !== numericYear
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return null;

  const iso = `${year}-${month}-${day}`;
  return iso <= manilaTodayIso() ? iso : null;
}

export function parseStudentImportCsv(
  input: string | ArrayBuffer | Uint8Array,
): ImportedStudentRow[] {
  const contents = decodeInput(input);
  let parsedRecords: string[][];
  try {
    parsedRecords = parse(contents, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch {
    fail({ file: ["The file is not valid CSV."] });
  }

  const records = parsedRecords.map(normalizeRecord);
  if (records.length < 2) {
    fail({ file: ["CSV file must include the header and at least one data row."] });
  }
  const headers = records[0];
  if (
    headers.length !== STUDENT_IMPORT_HEADERS.length
    || headers.some((value, index) => value !== STUDENT_IMPORT_HEADERS[index])
  ) fail({ file: [headerError] });
  if (records.length - 1 > STUDENT_IMPORT_MAXIMUM_ROWS) {
    fail({ file: ["CSV files may contain at most 3,000 data rows."] });
  }

  const fields: Record<string, string[]> = {};
  const rows: ImportedStudentRow[] = [];
  const rowNumbersByStudentId = new Map<string, number[]>();

  for (const [index, record] of records.slice(1).entries()) {
    const rowNumber = index + 2;
    if (record.length !== STUDENT_IMPORT_HEADERS.length) {
      addError(fields, `rows.${rowNumber}`, "Row must contain exactly 9 columns.");
      continue;
    }

    const [
      studentNumber,
      surname,
      firstName,
      middleInitialValue,
      suffixValue,
      collegeName,
      courseCode,
      year,
      dateOfBirthValue,
    ] = record;
    const middleInitial = middleInitialValue || null;
    const suffix = suffixValue || null;
    const dateOfBirth = birthDateIso(dateOfBirthValue);
    let valid = true;
    const rowError = (field: string, message: string) => {
      addError(fields, `rows.${rowNumber}.${field}`, message);
      valid = false;
    };

    if (!/^\d{2}-\d{4}-\d{2}$/.test(studentNumber)) {
      rowError("Student ID", "Student ID must use the NN-NNNN-NN format.");
    } else {
      rowNumbersByStudentId.set(studentNumber, [
        ...(rowNumbersByStudentId.get(studentNumber) ?? []),
        rowNumber,
      ]);
    }

    const requiredText = (
      field: "Surname" | "First Name" | "College" | "Course",
      value: string,
      maximum: number,
    ) => {
      if (!value) rowError(field, `${field} is required.`);
      else if (characterCount(value) > maximum) {
        rowError(field, `${field} must contain at most ${maximum} characters.`);
      }
    };
    requiredText("Surname", surname, 100);
    requiredText("First Name", firstName, 100);
    requiredText("College", collegeName, 150);
    requiredText("Course", courseCode, 50);
    if (middleInitial && characterCount(middleInitial) > 100) {
      rowError("MI", "MI must contain at most 100 characters.");
    }
    if (suffix && characterCount(suffix) > 50) {
      rowError("Suffix", "Suffix must contain at most 50 characters.");
    }
    if (!/^[1-6]$/.test(year)) {
      rowError("Year", "Year must be a whole number from 1 to 6.");
    }
    if (!dateOfBirth) {
      rowError(
        "Date of Birth",
        "Date of Birth must be a valid past or present date in MM-DD-YYYY format.",
      );
    }

    if (valid && dateOfBirth) {
      rows.push({
        rowNumber,
        studentNumber,
        surname,
        firstName,
        middleInitial,
        suffix,
        collegeName,
        courseCode,
        yearLevel: Number(year),
        dateOfBirth,
      });
    }
  }

  for (const rowNumbers of rowNumbersByStudentId.values()) {
    if (rowNumbers.length < 2) continue;
    for (const rowNumber of rowNumbers) {
      const otherRows = rowNumbers.filter((candidate) => candidate !== rowNumber);
      addError(
        fields,
        `rows.${rowNumber}.Student ID`,
        `This student ID also appears in row${otherRows.length === 1 ? "" : "s"} ${otherRows.join(", ")}.`,
      );
    }
  }

  if (Object.keys(fields).length) fail(fields);
  return rows;
}
