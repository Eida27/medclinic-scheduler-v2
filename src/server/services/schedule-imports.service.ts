import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  createScheduleImport,
  deriveScheduleImportStatus,
  getScheduleImportGroup,
  listScheduleImportGroups,
  touchScheduleImportGroup,
  withLockedScheduleImport,
  type LockedImportChild,
  type ScheduleImportDetail,
  type ScheduleImportListItem,
  type ScheduleImportResult,
} from "@/server/repositories/schedule-imports.repository";
import type { SessionUser } from "@/types/roles";
import { isImportOperatorRole } from "@/types/roles";
import { publishScheduleBatchWithClient } from "./appointments.service";
import {
  generateBatchAppointmentsWithClient,
  validateBatchWithClient,
} from "./coordinator-schedules.service";
import {
  parseStudentImportCsv,
  STUDENT_IMPORT_MAXIMUM_BYTES,
} from "./student-import-csv";

const importMetadataSchema = z.object({
  studentCategory: z.enum(["REGULAR", "OJT", "TOUR", "SPECIALIZED"]),
  academicYearStart: z.coerce.number().int().min(2020).max(2100),
  preferredMonth: z.preprocess(
    (value) => value === "" || value === null || value === undefined ? null : value,
    z.union([z.coerce.number().int().min(1).max(12), z.null()]),
  ),
}).superRefine((value, context) => {
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
const importIdSchema = z.string().uuid();
const overrideReasonSchema = z.string().trim().max(500).optional()
  .transform((value) => value || undefined);

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

export async function importStudentScheduleCsv(
  raw: unknown,
  actor: SessionUser,
): Promise<ScheduleImportResult> {
  assertImportOperator(actor);
  const file = validatedFile(raw);
  const metadata = importMetadataSchema.parse(raw);
  const result = await createScheduleImport({
    ...metadata,
    sourceFilename: file.fileName,
    rows: parseStudentImportCsv(file.contents),
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

type ValidationClinicResult = {
  batchId: string;
  summary: unknown;
  items: unknown;
  preview: unknown;
};

export type ScheduleImportValidationResult = {
  importId: string;
  status: "VALIDATED";
  totals: {
    items: number;
    valid: number;
    warnings: number;
    conflicts: number;
  };
  clinics: {
    laboratory?: ValidationClinicResult;
    physicalExamination?: ValidationClinicResult;
  };
};

export type ScheduleImportGenerationResult = {
  importId: string;
  status: "GENERATED";
  batchIds: string[];
  appointmentCount: number;
};

export type ScheduleImportPublicationResult = {
  importId: string;
  status: "PUBLISHED";
  batchIds: string[];
  publishedAppointmentCount: number;
};

function synchronizedChildStatus(children: LockedImportChild[]) {
  const status = deriveScheduleImportStatus(children.map((child) => child.status));
  if (status === "NEEDS_REVIEW") {
    throw new AppError(
      "SCHEDULE_IMPORT_NEEDS_REVIEW",
      "Schedule import child batches are not synchronized.",
      409,
    );
  }
  return status;
}

function invalidImportStatus(message: string) {
  return new AppError("SCHEDULE_IMPORT_INVALID_STATUS", message, 409);
}

function clinicResultKey(clinicCode: LockedImportChild["clinicCode"]) {
  return clinicCode === "KABALAKA_CLINIC"
    ? "laboratory" as const
    : "physicalExamination" as const;
}

function scheduleImportNotFound() {
  return new AppError(
    "SCHEDULE_IMPORT_NOT_FOUND",
    "Schedule import not found.",
    404,
  );
}

export async function validateScheduleImport(
  importId: string,
  actor: SessionUser,
): Promise<ScheduleImportValidationResult> {
  assertImportOperator(actor);
  const validImportId = importIdSchema.parse(importId);
  const result = await withLockedScheduleImport(validImportId, async (client, children) => {
    const status = synchronizedChildStatus(children);
    if (status !== "DRAFT" && status !== "VALIDATED") {
      throw invalidImportStatus("Only draft or validated schedule imports can be validated.");
    }

    const totals = { items: 0, valid: 0, warnings: 0, conflicts: 0 };
    const clinics: ScheduleImportValidationResult["clinics"] = {};
    for (const child of children) {
      const validation = await validateBatchWithClient(
        child.id,
        actor.userId,
        client,
        true,
      );
      totals.items += validation.summary.totalItems;
      totals.valid += validation.summary.validCount;
      totals.warnings += validation.summary.warningCount;
      totals.conflicts += validation.summary.conflictCount;
      clinics[clinicResultKey(child.clinicCode)] = {
        batchId: child.id,
        summary: validation.summary,
        items: validation.items,
        preview: validation.preview,
      };
    }

    const batchIds = children.map((child) => child.id);
    await writeAudit(
      actor.userId,
      "SCHEDULE_IMPORT_VALIDATED",
      "schedule_import_group",
      validImportId,
      { batchIds, totals },
      client,
    );
    await touchScheduleImportGroup(validImportId, client);
    return { importId: validImportId, status: "VALIDATED" as const, totals, clinics };
  });
  if (!result) throw scheduleImportNotFound();
  return result;
}

export async function generateScheduleImport(
  importId: string,
  actor: SessionUser,
  overrideReason?: string,
): Promise<ScheduleImportGenerationResult> {
  assertImportOperator(actor);
  const validImportId = importIdSchema.parse(importId);
  const validOverrideReason = overrideReasonSchema.parse(overrideReason);
  const result = await withLockedScheduleImport(validImportId, async (client, children) => {
    if (synchronizedChildStatus(children) !== "VALIDATED") {
      throw invalidImportStatus("Only validated schedule imports can generate appointments.");
    }

    let appointmentCount = 0;
    let appliedOverrideReason: string | null = null;
    for (const child of children) {
      const generated = await generateBatchAppointmentsWithClient(
        child.id,
        actor,
        validOverrideReason,
        client,
        true,
      );
      appointmentCount += generated.appointmentCount;
      appliedOverrideReason ??= generated.appliedOverrideReason;
    }

    const batchIds = children.map((child) => child.id);
    await writeAudit(
      actor.userId,
      "SCHEDULE_IMPORT_GENERATED",
      "schedule_import_group",
      validImportId,
      { batchIds, appointmentCount, overrideReason: appliedOverrideReason },
      client,
    );
    await touchScheduleImportGroup(validImportId, client);
    return {
      importId: validImportId,
      status: "GENERATED" as const,
      batchIds,
      appointmentCount,
    };
  });
  if (!result) throw scheduleImportNotFound();
  return result;
}

export async function publishScheduleImport(
  importId: string,
  actor: SessionUser,
): Promise<ScheduleImportPublicationResult> {
  assertImportOperator(actor);
  const validImportId = importIdSchema.parse(importId);
  const result = await withLockedScheduleImport(validImportId, async (client, children) => {
    if (synchronizedChildStatus(children) !== "GENERATED") {
      throw invalidImportStatus("Only generated schedule imports can be published.");
    }

    let publishedAppointmentCount = 0;
    for (const child of children) {
      const published = await publishScheduleBatchWithClient(
        child.id,
        actor.userId,
        client,
        true,
      );
      publishedAppointmentCount += published.count;
    }

    const batchIds = children.map((child) => child.id);
    await writeAudit(
      actor.userId,
      "SCHEDULE_IMPORT_PUBLISHED",
      "schedule_import_group",
      validImportId,
      { batchIds, publishedAppointmentCount },
      client,
    );
    await touchScheduleImportGroup(validImportId, client);
    return {
      importId: validImportId,
      status: "PUBLISHED" as const,
      batchIds,
      publishedAppointmentCount,
    };
  });
  if (!result) throw scheduleImportNotFound();
  return result;
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
  return importStudentScheduleCsv(raw, actor);
}

export const importAndPublishStudentScheduleCsv = acceptAndScheduleImport;
