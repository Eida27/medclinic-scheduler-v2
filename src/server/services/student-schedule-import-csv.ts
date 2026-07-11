import { parse } from "csv-parse/sync";
import { AppError } from "@/lib/errors";

export type StudentScheduleCsvRow = {
  rowNumber: number;
  studentNumber: string;
  rawName: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  collegeName: string;
  courseCode: string;
  yearLevel: number;
  laboratoryDate: string | null;
  physicalExaminationDate: string | null;
};

const expectedHeaders = [
  "Student ID",
  "Name",
  "College",
  "Course",
  "Year",
  "Laboratory Schedule",
  "Physical Examination Schedule",
] as const;

const headerError = `CSV headers must exactly match: ${expectedHeaders.join(", ")}.`;

function addError(fields: Record<string, string[]>, field: string, message: string) {
  fields[field] = [...(fields[field] ?? []), message];
}

function fail(fields: Record<string, string[]>): never {
  throw new AppError("CSV_IMPORT_INVALID", "Please correct the CSV import errors.", 422, fields);
}

function decodeInput(input: string | ArrayBuffer | Uint8Array): string {
  if (typeof input === "string") return input;

  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail({ file: ["The file must be valid UTF-8."] });
  }
}

function normalizeRecord(record: string[]): string[] {
  const cells = record.map((cell) => cell.trim());
  while (cells.length > expectedHeaders.length && cells.at(-1) === "") cells.pop();
  return cells;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function isoDate(value: string): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) return null;

  const [, month, day, year] = match;
  const numericYear = Number(year);
  if (numericYear === 0) return null;

  const date = new Date(0);
  date.setUTCFullYear(numericYear, Number(month) - 1, Number(day));
  if (
    date.getUTCFullYear() !== numericYear
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return null;

  return `${year}-${month}-${day}`;
}

function canonicalName(value: string) {
  const rawName = value.replace(/\s+/g, " ").trim();
  const commaIndex = rawName.indexOf(",");
  if (commaIndex < 0) return null;

  const lastName = rawName.slice(0, commaIndex).trim();
  const givenNames = rawName.slice(commaIndex + 1).trim();
  if (!lastName || !givenNames) return null;

  const [firstName, ...middleTokens] = givenNames.split(" ");
  if (!firstName) return null;

  return {
    rawName,
    firstName,
    middleName: middleTokens.length ? middleTokens.join(" ") : null,
    lastName,
  };
}

export function parseStudentScheduleCsv(
  input: string | ArrayBuffer | Uint8Array,
): StudentScheduleCsvRow[] {
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
  if (records.length < 2) fail({ file: ["CSV file must include the header and at least one data row."] });

  const header = records[0];
  if (
    header.length !== expectedHeaders.length
    || header.some((value, index) => value !== expectedHeaders[index])
  ) fail({ file: [headerError] });

  if (records.length - 1 > 500) fail({ file: ["CSV files may contain at most 500 data rows."] });

  const fields: Record<string, string[]> = {};
  const rows: StudentScheduleCsvRow[] = [];
  const firstRowsByStudentId = new Map<string, number>();

  records.slice(1).forEach((record, index) => {
    const rowNumber = index + 2;
    const candidateStudentNumber = record[0] ?? "";
    let duplicateStudentId = false;

    if (candidateStudentNumber) {
      const key = candidateStudentNumber.toUpperCase();
      const firstRow = firstRowsByStudentId.get(key);
      if (firstRow !== undefined) {
        addError(
          fields,
          `rows.${rowNumber}.Student ID`,
          `This student ID already appears in row ${firstRow}.`,
        );
        duplicateStudentId = true;
      } else {
        firstRowsByStudentId.set(key, rowNumber);
      }
    }

    if (record.length !== expectedHeaders.length) {
      addError(fields, `rows.${rowNumber}`, "Row must contain exactly 7 columns.");
      return;
    }

    const [
      studentNumber,
      rawName,
      collegeName,
      courseCode,
      year,
      laboratorySchedule,
      physicalExaminationSchedule,
    ] = record;
    const name = canonicalName(rawName);
    const laboratoryDate = laboratorySchedule ? isoDate(laboratorySchedule) : null;
    const physicalExaminationDate = physicalExaminationSchedule
      ? isoDate(physicalExaminationSchedule)
      : null;
    let valid = !duplicateStudentId;

    const rowError = (field: string, message: string) => {
      addError(fields, `rows.${rowNumber}.${field}`, message);
      valid = false;
    };

    const studentNumberLength = characterCount(studentNumber);
    if (studentNumberLength < 3 || studentNumberLength > 20) {
      rowError("Student ID", "Student ID must contain 3 to 20 characters.");
    }

    if (!name) {
      rowError("Name", 'Name must use "Last, First Middle" format with a surname and given name.');
    } else {
      if (characterCount(name.firstName) > 100) {
        rowError("Name", "First name must contain at most 100 characters.");
      }
      if (name.middleName && characterCount(name.middleName) > 100) {
        rowError("Name", "Middle name must contain at most 100 characters.");
      }
      if (characterCount(name.lastName) > 100) {
        rowError("Name", "Last name must contain at most 100 characters.");
      }
    }

    if (!collegeName) {
      rowError("College", "College is required.");
    } else if (characterCount(collegeName) > 150) {
      rowError("College", "College must contain at most 150 characters.");
    }

    if (!courseCode) {
      rowError("Course", "Course is required.");
    } else if (characterCount(courseCode) > 50) {
      rowError("Course", "Course must contain at most 50 characters.");
    }

    if (!/^[1-6]$/.test(year)) {
      rowError("Year", "Year must be a whole number from 1 to 6.");
    }

    if (laboratorySchedule && !laboratoryDate) {
      rowError(
        "Laboratory Schedule",
        "Laboratory Schedule must be a valid date in MM-DD-YYYY format.",
      );
    }
    if (physicalExaminationSchedule && !physicalExaminationDate) {
      rowError(
        "Physical Examination Schedule",
        "Physical Examination Schedule must be a valid date in MM-DD-YYYY format.",
      );
    }
    if (!laboratorySchedule && !physicalExaminationSchedule) {
      rowError("Laboratory Schedule", "At least one schedule date is required.");
      rowError("Physical Examination Schedule", "At least one schedule date is required.");
    }

    if (valid && name) {
      rows.push({
        rowNumber,
        studentNumber,
        rawName: name.rawName,
        firstName: name.firstName,
        middleName: name.middleName,
        lastName: name.lastName,
        suffix: null,
        collegeName,
        courseCode,
        yearLevel: Number(year),
        laboratoryDate,
        physicalExaminationDate,
      });
    }
  });

  if (Object.keys(fields).length) fail(fields);
  return rows;
}
