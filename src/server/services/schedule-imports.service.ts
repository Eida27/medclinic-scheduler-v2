import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import {
  createScheduleImport,
  getScheduleImportGroup,
  listScheduleImportGroups,
  type ScheduleImportDetail,
  type ScheduleImportListItem,
  type ScheduleImportResult,
} from "@/server/repositories/schedule-imports.repository";
import type { SessionUser } from "@/types/roles";
import { parseStudentScheduleCsv } from "./student-schedule-import-csv";

const maximumCsvBytes = 1024 * 1024;
const characterCount = (value: string) => Array.from(value).length;
const blankToNull = z.union([z.string(), z.null(), z.undefined()])
  .transform((value) => value?.trim() || null);
const importNameSchema = z.string().trim()
  .refine((value) => characterCount(value) >= 3, {
    message: "Import name must contain at least 3 characters.",
  })
  .refine((value) => characterCount(value) <= 150, {
    message: "Import name must contain at most 150 characters.",
  });
const submittedByNameSchema = blankToNull.refine(
  (value) => value === null || characterCount(value) <= 150,
  { message: "Submitted by name must contain at most 150 characters." },
);

const importMetadataSchema = z.object({
  importName: importNameSchema,
  priorityGroupId: z.string().uuid(),
  submittedByName: submittedByNameSchema,
  description: blankToNull,
});

type CsvContents = string | ArrayBuffer | Uint8Array;

function assertAdmin(actor: SessionUser) {
  if (actor.role !== "ADMIN") {
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      403,
    );
  }
}

function isCsvContents(value: unknown): value is CsvContents {
  return typeof value === "string"
    || value instanceof ArrayBuffer
    || value instanceof Uint8Array;
}

function actualByteLength(contents: CsvContents): number {
  return typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength;
}

function validatedFile(raw: unknown) {
  const candidate = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const errors: string[] = [];
  const addError = (message: string) => {
    if (!errors.includes(message)) errors.push(message);
  };

  const rawFileName = candidate.fileName;
  const fileName = typeof rawFileName === "string" ? rawFileName.trim() : "";
  if (!fileName) {
    addError("Choose a CSV file.");
  } else {
    if (Array.from(fileName).length > 255) addError("File names may contain at most 255 characters.");
    if (!fileName.toLowerCase().endsWith(".csv")) addError("Choose a file with a .csv extension.");
  }

  const declaredSize = candidate.fileSize;
  if (typeof declaredSize !== "number" || !Number.isInteger(declaredSize) || declaredSize < 0) {
    addError("File size must be a non-negative whole number.");
  } else if (declaredSize === 0) {
    addError("CSV files must not be empty.");
  } else if (declaredSize > maximumCsvBytes) {
    addError("CSV files may not exceed 1 MB.");
  }

  const contents = candidate.contents;
  if (!isCsvContents(contents)) {
    addError("CSV file contents are required.");
  } else {
    const bytes = actualByteLength(contents);
    if (bytes === 0) addError("CSV files must not be empty.");
    if (bytes > maximumCsvBytes) addError("CSV files may not exceed 1 MB.");
  }

  if (errors.length || !isCsvContents(contents)) {
    throw new AppError(
      "CSV_IMPORT_INVALID",
      "Please correct the CSV import errors.",
      422,
      { file: errors },
    );
  }
  return { fileName, contents };
}

export async function importStudentScheduleCsv(
  raw: unknown,
  actor: SessionUser,
): Promise<ScheduleImportResult> {
  assertAdmin(actor);
  const file = validatedFile(raw);
  const metadata = importMetadataSchema.parse(raw);
  const result = await createScheduleImport({
    ...metadata,
    sourceFilename: file.fileName,
    rows: parseStudentScheduleCsv(file.contents),
  }, actor.userId);
  if ("fields" in result) {
    throw new AppError(
      "CSV_IMPORT_INVALID",
      "Please correct the CSV import errors.",
      422,
      result.fields,
    );
  }
  return result;
}

export async function listScheduleImports(
  actor: SessionUser,
): Promise<ScheduleImportListItem[]> {
  assertAdmin(actor);
  return listScheduleImportGroups();
}

export async function getScheduleImport(
  importId: string,
  actor: SessionUser,
): Promise<ScheduleImportDetail> {
  assertAdmin(actor);
  const validImportId = z.string().uuid().parse(importId);
  const detail = await getScheduleImportGroup(validImportId);
  if (!detail) {
    throw new AppError(
      "SCHEDULE_IMPORT_NOT_FOUND",
      "Schedule import not found.",
      404,
    );
  }
  return detail;
}
