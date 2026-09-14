import "server-only";
import type { PoolClient } from "pg";

import { AppError } from "@/lib/errors";

export type StoredOvpsaBatch = {
  batchId: string;
  scheduleCycleStart: number;
  closingDate: string;
  collegeId: string | null;
  collegeName: string;
  status: "DRAFT" | "PUBLISHED" | "RESCHEDULE_REQUIRED" | "CANCELLED";
  optimisticToken: string;
  revisionId: string;
  revisionNumber: number;
  revisionStatus: "DRAFT" | "VALIDATED" | "PUBLISHED" | "SUPERSEDED" | "CANCELLED";
  laboratoryDate: string;
  physicalExamDate: string;
  physicalExamExceptionReason: string | null;
};

export async function loadOvpsaBatchWithCurrentRevision(
  client: PoolClient,
  batchId: string,
  forUpdate = false,
): Promise<StoredOvpsaBatch | null> {
  const result = await client.query<{
    batch_id: string;
    schedule_cycle_start: number;
    closing_date: string | null;
    college_id: string | null;
    college_name: string;
    status: StoredOvpsaBatch["status"];
    optimistic_token: string;
    revision_id: string;
    revision_number: number;
    revision_status: StoredOvpsaBatch["revisionStatus"];
    laboratory_date: string;
    physical_exam_date: string;
    physical_exam_exception_reason: string | null;
  }>(
    `SELECT batch.id::text AS batch_id,batch.schedule_cycle_start,
            academic_year.closing_date::text,
            batch.college_id::text,COALESCE(college.name,'All Colleges') AS college_name,
            batch.status,
            batch.optimistic_token::text,revision.id::text AS revision_id,
            revision.revision_number,revision.status AS revision_status,
            revision.laboratory_date::text,revision.physical_exam_date::text,
            revision.physical_exam_exception_reason
       FROM ovpsa_first_year_batches batch
       LEFT JOIN academic_years academic_year
         ON academic_year.start_year=batch.schedule_cycle_start
       LEFT JOIN colleges college ON college.id=batch.college_id
       JOIN ovpsa_first_year_batch_revisions revision
         ON revision.id=batch.current_revision_id
      WHERE batch.id=$1
      ${forUpdate ? "FOR UPDATE OF batch,revision" : ""}`,
    [batchId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const authoritativeCycle = forUpdate
    ? await client.query<{ closing_date: string }>(
        `SELECT closing_date::text
           FROM academic_years
          WHERE start_year=$1
          FOR KEY SHARE`,
        [row.schedule_cycle_start],
      )
    : null;
  const closingDate = authoritativeCycle?.rows[0]?.closing_date ?? row.closing_date;
  if (!closingDate) {
    throw new AppError(
      "OVPSA_SCHEDULING_CYCLE_NOT_CONFIGURED",
      "The First Year batch scheduling cycle is not configured.",
      409,
    );
  }
  return {
    batchId: row.batch_id,
    scheduleCycleStart: row.schedule_cycle_start,
    closingDate,
    collegeId: row.college_id,
    collegeName: row.college_name,
    status: row.status,
    optimisticToken: row.optimistic_token,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    revisionStatus: row.revision_status,
    laboratoryDate: row.laboratory_date,
    physicalExamDate: row.physical_exam_date,
    physicalExamExceptionReason: row.physical_exam_exception_reason,
  };
}

export async function loadCpuPhysicalExamMaximumCapacity(client: PoolClient) {
  const result = await client.query<{ max_daily_capacity: number }>(
    `SELECT setting.max_daily_capacity
       FROM clinic_capacity_settings setting
       JOIN clinics clinic ON clinic.id=setting.clinic_id
      WHERE clinic.code='CPU_CLINIC'
        AND setting.schedule_type='PHYSICAL_EXAM'
        AND setting.is_active=TRUE`,
  );
  return result.rows[0]?.max_daily_capacity ?? null;
}

export async function loadOvpsaClinicIds(client: PoolClient) {
  const result = await client.query<{
    id: string;
    code: "KABALAKA_CLINIC" | "CPU_CLINIC";
  }>(
    `SELECT id::text,code FROM clinics
      WHERE code IN ('KABALAKA_CLINIC','CPU_CLINIC')`,
  );
  return new Map(result.rows.map((row) => [row.code, row.id]));
}
