import "server-only";
import { z } from "zod";
import { weekdaysInRange } from "@/lib/dates";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  activeAppointmentKeys,
  capacitySettings,
  createImportedScheduleBatch,
  createScheduleBatch,
  currentAppointmentLoad,
  getRuleItems,
  getScheduleBatch,
  persistGeneratedAppointments,
  saveValidation,
  updateBatchMetadata,
  type ValidationIssue,
} from "@/server/repositories/coordinator-schedules.repository";
import { generateSchedule } from "@/server/rule-engine";
import { registeredStudentNumbers } from "@/server/repositories/students.repository";
import type { SessionUser } from "@/types/roles";
import { parseCoordinatorScheduleCsv } from "./coordinator-schedule-csv";
import { clinicCodeByScheduleType, isClinicCode, type ClinicCode } from "@/server/clinics";

const blankToNull = z.union([z.string(), z.null(), z.undefined()]).transform((value) => value?.trim() || null);
const dateOrNull = z.union([z.iso.date(), z.literal(""), z.null(), z.undefined()]).transform((value) => value || null);

const itemSchema = z.object({
  studentNumber: z.string().trim().min(3).max(20),
  scheduleType: z.enum(["PHYSICAL_EXAM", "LABORATORY", "BOTH"]),
  priorityGroupId: z.string().uuid(),
  targetDate: dateOrNull,
  targetWeekStart: dateOrNull,
  targetWeekEnd: dateOrNull,
  remarks: blankToNull,
}).superRefine((item, context) => {
  const exact = Boolean(item.targetDate);
  const week = Boolean(item.targetWeekStart && item.targetWeekEnd);
  if (exact === week) context.addIssue({ code: "custom", message: "Choose either one exact date or one complete week range." });
  if (item.targetWeekStart && item.targetWeekEnd && item.targetWeekEnd < item.targetWeekStart) {
    context.addIssue({ code: "custom", message: "Week end must not be before week start." });
  }
});

function expandedRequestKeys(item: z.infer<typeof itemSchema>, clinicCode?: ClinicCode | null) {
  const services = item.scheduleType === "BOTH" ? ["PHYSICAL_EXAM", "LABORATORY"] as const : [item.scheduleType];
  return services.flatMap((service) => {
    const itemClinicCode = clinicCodeByScheduleType[service];
    return clinicCode && itemClinicCode !== clinicCode ? [] : [`${item.studentNumber}:${itemClinicCode}:${service}`];
  });
}

export const createBatchSchema = z.object({
  clinicCode: z.enum(["KABALAKA_CLINIC", "CPU_CLINIC"]).optional().nullable(),
  batchName: z.string().trim().min(3).max(150),
  collegeId: z.union([z.string().uuid(), z.literal(""), z.null(), z.undefined()]).transform((value) => value || null),
  programId: z.union([z.string().uuid(), z.literal(""), z.null(), z.undefined()]).transform((value) => value || null),
  submittedByName: blankToNull,
  description: blankToNull,
  items: z.array(itemSchema).min(1).max(500),
}).superRefine((batch, context) => {
  const seen = new Set<string>();
  batch.items.forEach((item, index) => {
    for (const key of expandedRequestKeys(item, batch.clinicCode)) {
      if (seen.has(key)) context.addIssue({ code: "custom", path: ["items", index], message: "Duplicate student and schedule type in this batch." });
      seen.add(key);
    }
  });
  if (batch.programId && !batch.collegeId) context.addIssue({ code: "custom", path: ["collegeId"], message: "College is required when a program is selected." });
});

const csvImportSchema = z.object({
  clinicCode: z.enum(["KABALAKA_CLINIC", "CPU_CLINIC"]).optional().nullable(),
  fileName: z.string().trim().min(1),
  fileSize: z.number().int().positive(),
  contents: z.string().min(1),
  batchName: z.string().trim().min(3).max(150),
  priorityGroupId: z.string().uuid(),
  submittedByName: blankToNull,
  description: blankToNull,
});

type Actor = string | SessionUser;

function actorUserId(actor: Actor) {
  return typeof actor === "string" ? actor : actor.userId;
}

function scopedInput<T extends { clinicCode?: ClinicCode | null }>(input: T, actor: Actor): T {
  if (typeof actor === "string" || actor.role === "ADMIN") return input;
  if (!actor.clinicCode || !isClinicCode(actor.clinicCode)) {
    throw new AppError("CLINIC_ACCESS_REQUIRED", "Your account is not assigned to a clinic.", 403);
  }
  if (input.clinicCode && input.clinicCode !== actor.clinicCode) {
    throw new AppError("CLINIC_ACCESS_DENIED", "You can only manage your assigned clinic.", 403);
  }
  return { ...input, clinicCode: actor.clinicCode };
}

export async function importCoordinatorScheduleCsv(raw: unknown, actor: Actor) {
  const input = scopedInput(csvImportSchema.parse(raw), actor);
  const userId = actorUserId(actor);
  const fields: Record<string, string[]> = {};
  if (!input.fileName.toLocaleLowerCase().endsWith(".csv")) fields.file = ["Choose a file with a .csv extension."];
  if (input.fileSize > 1024 * 1024 || Buffer.byteLength(input.contents) > 1024 * 1024) {
    fields.file = ["CSV files may not exceed 1 MB."];
  }
  if (Object.keys(fields).length) {
    throw new AppError("CSV_IMPORT_INVALID", "Please correct the CSV import errors.", 422, fields);
  }

  const result = await createImportedScheduleBatch({
    clinicCode: input.clinicCode,
    batchName: input.batchName,
    priorityGroupId: input.priorityGroupId,
    submittedByName: input.submittedByName,
    description: input.description,
    fileName: input.fileName,
    rows: parseCoordinatorScheduleCsv(input.contents),
  }, userId);
  if ("fields" in result) {
    throw new AppError("CSV_IMPORT_INVALID", "Please correct the CSV import errors.", 422, result.fields);
  }
  return result;
}

export async function addScheduleBatch(raw: unknown, actor: Actor) {
  const input = scopedInput(createBatchSchema.parse(raw), actor);
  const userId = actorUserId(actor);
  const registered = await registeredStudentNumbers([...new Set(input.items.map((item) => item.studentNumber))]);
  const fields: Record<string, string[]> = {};
  input.items.forEach((item, index) => {
    if (!registered.has(item.studentNumber)) {
      fields[`items.${index}.studentNumber`] = [`Student number ${item.studentNumber} is not registered.`];
    }
  });
  if (Object.keys(fields).length) {
    throw new AppError(
      "SCHEDULE_STUDENTS_NOT_FOUND",
      "Some students are not registered. Add them before creating the batch, or use CSV import.",
      422,
      fields,
    );
  }
  try {
    const created = await createScheduleBatch(input, userId);
    await writeAudit(userId, "SCHEDULE_BATCH_CREATED", "schedule_batch", created.id, { itemCount: created.itemCount, batchIds: created.batchIds });
    const batch = await getScheduleBatch(created.id);
    return batch ? { ...batch, batchIds: created.batchIds } : batch;
  } catch (error) {
    if (error instanceof Error && error.message === "NO_MATCHING_CLINIC_ITEMS") throw new AppError("NO_MATCHING_CLINIC_ITEMS", "No schedule requests match the selected clinic.", 422);
    if (isPostgresUniqueViolation(error)) throw new AppError("DUPLICATE_SCHEDULE_ITEM", "A student appears more than once for the same service.", 409);
    throw error;
  }
}

function serviceTypes(scheduleType: "PHYSICAL_EXAM" | "LABORATORY" | "BOTH") {
  return scheduleType === "BOTH" ? ["PHYSICAL_EXAM", "LABORATORY"] as const : [scheduleType];
}

function requestedCapacityKeys(items: Array<{
  clinicId: string;
  scheduleType: "PHYSICAL_EXAM" | "LABORATORY" | "BOTH";
  targetDate: string | null;
  targetWeekStart: string | null;
  targetWeekEnd: string | null;
}>) {
  const keys = new Set<string>();
  for (const item of items) {
    const dates = item.targetDate
      ? [item.targetDate]
      : weekdaysInRange(String(item.targetWeekStart), String(item.targetWeekEnd));
    for (const date of dates) {
      for (const service of serviceTypes(item.scheduleType)) keys.add(`${item.clinicId}:${date}:${service}`);
    }
  }
  return keys;
}

export async function validateBatch(batchId: string, actorUserId: string) {
  const batch = await getRuleItems(batchId);
  if (!batch) throw new AppError("BATCH_NOT_FOUND", "Schedule batch not found.", 404);
  if (["GENERATED", "PUBLISHED", "CANCELLED"].includes(batch.status)) {
    throw new AppError("BATCH_IMMUTABLE", "This batch can no longer be validated or edited.", 409);
  }

  const issues = new Map<string, ValidationIssue[]>();
  const addIssue = (itemId: string, issue: ValidationIssue) => issues.set(itemId, [...(issues.get(itemId) ?? []), issue]);
  const activeKeys = await activeAppointmentKeys(batch.items.map((item) => item.studentNumber));

  for (const item of batch.items) {
    if (!item.studentActive) addIssue(item.id, { code: "INACTIVE_STUDENT", message: "Student record is inactive.", severity: "CONFLICT" });
    if (!item.priorityActive) addIssue(item.id, { code: "INACTIVE_PRIORITY", message: "Priority group is inactive.", severity: "CONFLICT" });
    if (batch.collegeId && item.studentCollegeId !== batch.collegeId) addIssue(item.id, { code: "COLLEGE_MISMATCH", message: "Student does not belong to the batch college.", severity: "CONFLICT" });
    if (batch.programId && item.studentProgramId !== batch.programId) addIssue(item.id, { code: "PROGRAM_MISMATCH", message: "Student does not belong to the batch program.", severity: "CONFLICT" });
    if (item.targetWeekStart && item.targetWeekEnd && weekdaysInRange(item.targetWeekStart, item.targetWeekEnd).length === 0) {
      addIssue(item.id, { code: "NO_WEEKDAY", message: "The selected range contains no Monday-Friday clinic dates.", severity: "CONFLICT" });
    }
    for (const service of serviceTypes(item.scheduleType)) {
      if (activeKeys.has(`${item.studentNumber}:${item.clinicId}:${service}`)) addIssue(item.id, { code: "ACTIVE_APPOINTMENT", message: `Student already has an active ${service.replaceAll("_", " ").toLowerCase()} appointment.`, severity: "CONFLICT", scheduleType: service });
    }
  }

  const candidates = batch.items.filter((item) => !(issues.get(item.id) ?? []).some((issue) => issue.severity === "CONFLICT"));
  const [capacities, existingLoad] = await Promise.all([capacitySettings(), currentAppointmentLoad()]);
  const preview = generateSchedule({
    items: candidates.map((item) => ({
      id: item.id, clinicId: item.clinicId, studentNumber: item.studentNumber, scheduleType: item.scheduleType,
      priorityRank: item.priorityRank, targetDate: item.targetDate,
      targetWeekStart: item.targetWeekStart, targetWeekEnd: item.targetWeekEnd,
    })),
    capacities,
    existingLoad,
  });
  const capacityKeys = requestedCapacityKeys(candidates);
  const scopedPreview = {
    ...preview,
    capacityResults: preview.capacityResults.filter((result) => capacityKeys.has(`${result.clinicId}:${result.date}:${result.scheduleType}`)),
  };

  for (const unscheduled of scopedPreview.unscheduledItems) {
    addIssue(unscheduled.scheduleItemId, { code: unscheduled.code, message: unscheduled.message, severity: "CONFLICT" });
  }
  for (const capacity of scopedPreview.capacityResults.filter((result) => result.status !== "VALID")) {
    const severity: "WARNING" | "CONFLICT" = capacity.status === "CONFLICT" ? "CONFLICT" : "WARNING";
    const impacted = scopedPreview.appointments.filter((appointment) => appointment.appointmentDate === capacity.date && appointment.scheduleType === capacity.scheduleType);
    for (const appointment of impacted) {
      const code = capacity.status === "CONFLICT" ? "CAPACITY_CONFLICT" : "CAPACITY_WARNING";
      const existing = issues.get(appointment.scheduleItemId) ?? [];
      if (!existing.some((issue) => issue.code === code && issue.date === capacity.date && issue.scheduleType === capacity.scheduleType)) {
        addIssue(appointment.scheduleItemId, { code, message: capacity.message, severity, date: capacity.date, scheduleType: capacity.scheduleType });
      }
    }
  }

  const itemResults = batch.items.map((item) => {
    const itemIssues = issues.get(item.id) ?? [];
    const status = itemIssues.some((issue) => issue.severity === "CONFLICT") ? "CONFLICT" : itemIssues.length ? "WARNING" : "VALID";
    return { id: item.id, status, issues: itemIssues };
  });
  const summary = {
    totalItems: itemResults.length,
    validCount: itemResults.filter((item) => item.status === "VALID").length,
    warningCount: itemResults.filter((item) => item.status === "WARNING").length,
    conflictCount: itemResults.filter((item) => item.status === "CONFLICT").length,
    capacityResults: scopedPreview.capacityResults,
  };
  await saveValidation(batchId, actorUserId, summary, itemResults);
  await writeAudit(actorUserId, "SCHEDULE_BATCH_VALIDATED", "schedule_batch", batchId, summary);
  return { summary, items: itemResults, preview: scopedPreview };
}

export async function generateBatchAppointments(batchId: string, user: SessionUser, overrideReason?: string) {
  const validation = await validateBatch(batchId, user.userId);
  const conflicts = validation.items.flatMap((item) => item.issues.filter((issue) => issue.severity === "CONFLICT"));
  const nonCapacityConflicts = conflicts.filter((issue) => issue.code !== "CAPACITY_CONFLICT");
  if (nonCapacityConflicts.length) throw new AppError("BATCH_CONFLICTS", "Resolve non-capacity conflicts before generating appointments.", 409);
  if (conflicts.length) {
    if (user.role !== "ADMIN") throw new AppError("ADMIN_OVERRIDE_REQUIRED", "An administrator must approve capacity conflicts.", 403);
    if (!overrideReason?.trim()) throw new AppError("OVERRIDE_REASON_REQUIRED", "Provide a reason for the capacity override.", 422);
  }
  try {
    const result = await persistGeneratedAppointments(
      batchId, user.userId, validation.preview.appointments,
      validation.preview.unscheduledItems.map((item) => item.scheduleItemId),
      conflicts.length ? overrideReason?.trim() : undefined,
    );
    await writeAudit(user.userId, "APPOINTMENTS_GENERATED", "schedule_batch", batchId, { count: validation.preview.appointments.length, overrideReason: conflicts.length ? overrideReason : null });
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "BATCH_ALREADY_GENERATED") throw new AppError("BATCH_ALREADY_GENERATED", "Appointments were already generated for this batch.", 409);
    throw error;
  }
}

export async function editBatch(batchId: string, raw: unknown, actorUserId: string) {
  const input = createBatchSchema.omit({ items: true }).parse(raw);
  if (!(await updateBatchMetadata(batchId, input))) throw new AppError("BATCH_IMMUTABLE", "Only draft or validated batch metadata can be edited.", 409);
  await writeAudit(actorUserId, "SCHEDULE_BATCH_UPDATED", "schedule_batch", batchId);
  return getScheduleBatch(batchId);
}
