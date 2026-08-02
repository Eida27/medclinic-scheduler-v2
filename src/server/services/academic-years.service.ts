import "server-only";
import { z } from "zod";
import { academicYearLabel, academicYearState } from "@/lib/academic-year";
import { AppError, isPostgresUniqueViolation } from "@/lib/errors";
import { transaction } from "@/server/db/pool";
import { writeAudit } from "@/server/repositories/audit.repository";
import {
  createAcademicYearWithClient,
  deleteAcademicYearWithClient,
  listAcademicYearRecords,
  lockAcademicYearWithSnapshotCount,
  updateAcademicYearClosingDateWithClient,
  type AcademicYearRecord,
} from "@/server/repositories/academic-years.repository";

const startYearSchema = z.coerce.number().int().min(2020).max(2100);

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

const mutationSchema = z.object({
  startYear: startYearSchema,
  closingDate: z.string(),
}).superRefine((value, context) => {
  const first = `${value.startYear}-08-01`;
  const last = `${value.startYear + 1}-07-31`;
  if (!isCalendarDate(value.closingDate)
    || value.closingDate < first
    || value.closingDate > last) {
    context.addIssue({
      code: "custom",
      path: ["closingDate"],
      message: `Closing date must be from ${first} through ${last}.`,
    });
  }
});

const deleteSchema = z.object({ startYear: startYearSchema });

function present(record: AcademicYearRecord, now: Date) {
  return {
    ...record,
    label: academicYearLabel(record.startYear),
    state: academicYearState(record.closingDate, now),
  };
}

function notFound() {
  return new AppError("ACADEMIC_YEAR_NOT_FOUND", "Academic year not found.", 404);
}

export async function listAcademicYears(now: Date = new Date()) {
  const records = await listAcademicYearRecords();
  return records.map((record) => present(record, now));
}

export async function createAcademicYear(raw: unknown, actorUserId: string) {
  const input = mutationSchema.parse(raw);
  try {
    const record = await transaction(async (client) => {
      const created = await createAcademicYearWithClient(client, { ...input, actorUserId });
      await writeAudit(
        actorUserId,
        "ACADEMIC_YEAR_CREATED",
        "academic_year",
        String(input.startYear),
        {
          startYear: input.startYear,
          label: academicYearLabel(input.startYear),
          closingDate: input.closingDate,
        },
        client,
      );
      return created;
    });
    return present(record, new Date());
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new AppError(
        "ACADEMIC_YEAR_EXISTS",
        "That academic year already exists.",
        409,
      );
    }
    throw error;
  }
}

export async function updateAcademicYear(raw: unknown, actorUserId: string) {
  const input = mutationSchema.parse(raw);
  const record = await transaction(async (client) => {
    const existing = await lockAcademicYearWithSnapshotCount(client, input.startYear);
    if (!existing) throw notFound();
    const updated = await updateAcademicYearClosingDateWithClient(client, {
      ...input,
      actorUserId,
    });
    if (!updated) throw notFound();
    await writeAudit(
      actorUserId,
      "ACADEMIC_YEAR_CLOSING_DATE_UPDATED",
      "academic_year",
      String(input.startYear),
      { oldClosingDate: existing.closingDate, newClosingDate: input.closingDate },
      client,
    );
    return updated;
  });
  return present(record, new Date());
}

export async function deleteAcademicYear(raw: unknown, actorUserId: string) {
  const { startYear } = deleteSchema.parse(raw);
  return transaction(async (client) => {
    const existing = await lockAcademicYearWithSnapshotCount(client, startYear);
    if (!existing) throw notFound();
    if (existing.linkedSnapshotCount > 0) {
      throw new AppError(
        "ACADEMIC_YEAR_IN_USE",
        "This academic year has linked historical records and cannot be deleted.",
        409,
        undefined,
        { linkedSnapshotCount: existing.linkedSnapshotCount },
      );
    }
    const deleted = await deleteAcademicYearWithClient(client, startYear);
    if (!deleted) throw notFound();
    await writeAudit(
      actorUserId,
      "ACADEMIC_YEAR_DELETED",
      "academic_year",
      String(startYear),
      {
        startYear,
        label: academicYearLabel(startYear),
        closingDate: existing.closingDate,
      },
      client,
    );
    return { success: true as const };
  });
}
