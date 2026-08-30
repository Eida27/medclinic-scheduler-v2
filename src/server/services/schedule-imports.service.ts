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
import { isImportOperatorRole } from "@/types/roles";
import {
  parseStudentImportCsv,
  STUDENT_IMPORT_MAXIMUM_BYTES,
} from "./student-import-csv";
import {
  publishFirstYearScheduleImport,
  reviewFirstYearScheduleImportPlan,
  type FirstYearScheduleImportReview,
} from "./first-year-schedule-import.service";
import { validateScheduleImportYearCategory } from "./schedule-import-year-category-policy";

const importMetadataSchema = z.object({
  importMode: z.enum(["STANDARD", "FIRST_YEAR_OVPSA"]).default("STANDARD"),
  studentCategory: z.enum(["REGULAR", "OJT", "TOUR"]),
  academicYearStart: z.coerce.number().int().min(2020).max(2100),
  preferredMonth: z.preprocess(
    (value) => value === "" || value === null || value === undefined ? null : value,
    z.union([z.coerce.number().int().min(1).max(12), z.null()]),
  ),
  firstYearLaboratoryDate: z.preprocess(
    (value) => value === "" || value === null || value === undefined ? null : value,
    z.union([z.iso.date(), z.null()]),
  ).default(null),
}).superRefine((value, context) => {
  if (value.importMode === "FIRST_YEAR_OVPSA") {
    if (value.studentCategory !== "REGULAR") {
      context.addIssue({
        code: "custom",
        path: ["studentCategory"],
        message: "First Year imports use the Regular compatibility category.",
      });
    }
    if (value.preferredMonth !== null) {
      context.addIssue({
        code: "custom",
        path: ["preferredMonth"],
        message: "First Year imports do not use a preferred month.",
      });
    }
    if (value.firstYearLaboratoryDate === null) {
      context.addIssue({
        code: "custom",
        path: ["firstYearLaboratoryDate"],
        message: "Choose the First Year Laboratory date.",
      });
    }
    return;
  }
  if (value.firstYearLaboratoryDate !== null) {
    context.addIssue({
      code: "custom",
      path: ["firstYearLaboratoryDate"],
      message: "Standard imports do not use a First Year Laboratory date.",
    });
  }
  if (value.studentCategory === "REGULAR" && value.preferredMonth !== null) {
    context.addIssue({
      code: "custom",
      path: ["preferredMonth"],
      message: "Regular imports do not use a preferred month.",
    });
  }
  if (value.studentCategory !== "REGULAR" && value.preferredMonth === null) {
    context.addIssue({
      code: "custom",
      path: ["preferredMonth"],
      message: "Choose a preferred month for this student category.",
    });
  }
});
type CsvContents = string | ArrayBuffer | Uint8Array;

function assertImportOperator(actor: SessionUser) {
  if (!isImportOperatorRole(actor.role)) {
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
  } else if (declaredSize > STUDENT_IMPORT_MAXIMUM_BYTES) {
    addError("CSV files may not exceed 1 MB.");
  }

  const contents = candidate.contents;
  if (!isCsvContents(contents)) {
    addError("CSV file contents are required.");
  } else {
    const bytes = actualByteLength(contents);
    if (bytes === 0) addError("CSV files must not be empty.");
    if (bytes > STUDENT_IMPORT_MAXIMUM_BYTES) addError("CSV files may not exceed 1 MB.");
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

function prepareScheduleImportRequest(raw: unknown) {
  const file = validatedFile(raw);
  const metadata = importMetadataSchema.parse(raw);
  const rows = parseStudentImportCsv(file.contents);
  validateScheduleImportYearCategory({
    rows,
    importMode: metadata.importMode,
    studentCategory: metadata.studentCategory,
  });
  return { file, metadata, rows };
}

export async function preflightScheduleImport(
  raw: unknown,
  actor: SessionUser,
): Promise<{ valid: true }> {
  assertImportOperator(actor);
  prepareScheduleImportRequest(raw);
  return { valid: true };
}

export async function reviewFirstYearScheduleImport(
  raw: unknown,
  actor: SessionUser,
): Promise<FirstYearScheduleImportReview> {
  assertImportOperator(actor);
  const { file, metadata, rows } = prepareScheduleImportRequest(raw);
  if (metadata.importMode !== "FIRST_YEAR_OVPSA" || !metadata.firstYearLaboratoryDate) {
    throw new AppError(
      "FIRST_YEAR_IMPORT_REQUIRED",
      "First Year review requires the First Year import mode and Laboratory date.",
      422,
    );
  }
  return reviewFirstYearScheduleImportPlan({
    sourceFilename: file.fileName,
    academicYearStart: metadata.academicYearStart,
    laboratoryDate: metadata.firstYearLaboratoryDate,
    rows,
  });
}

export async function listScheduleImports(
  actor: SessionUser,
): Promise<ScheduleImportListItem[]> {
  assertImportOperator(actor);
  return listScheduleImportGroups();
}

export async function getScheduleImport(
  importId: string,
  actor: SessionUser,
): Promise<ScheduleImportDetail> {
  assertImportOperator(actor);
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

export function importNameFromFileName(fileName: string): string {
  const normalized = fileName
    .trim()
    .replace(/\.csv$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (Array.from(normalized).length < 3) return "Schedule import";
  return Array.from(normalized).slice(0, 150).join("");
}

export async function acceptAndScheduleImport(
  raw: unknown,
  actor: SessionUser,
): Promise<ScheduleImportResult> {
  assertImportOperator(actor);
  const { file, metadata, rows } = prepareScheduleImportRequest(raw);
  if (metadata.importMode === "FIRST_YEAR_OVPSA") {
    return publishFirstYearScheduleImport({
      sourceFilename: file.fileName,
      academicYearStart: metadata.academicYearStart,
      laboratoryDate: metadata.firstYearLaboratoryDate!,
      rows,
    }, actor.userId);
  }
  const result = await createScheduleImport({
    studentCategory: metadata.studentCategory,
    academicYearStart: metadata.academicYearStart,
    preferredMonth: metadata.preferredMonth,
    sourceFilename: file.fileName,
    rows,
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
