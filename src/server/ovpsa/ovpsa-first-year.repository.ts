import "server-only";
import type { PoolClient } from "pg";

import { AppError } from "@/lib/errors";
import { studentDisplayNameSql } from "@/server/students/student-display-name";
import type { OvpsaPlanningStudent } from "./ovpsa-first-year-planner";

export type StoredOvpsaBatch = {
  batchId: string;
  scheduleCycleStart: number;
  closingDate: string;
  collegeId: string;
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

export type OvpsaExistingAppointment = {
  id: string;
  studentNumber: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  appointmentDate: string;
  status: string;
  schedulePairId: string | null;
  isManuallyLocked: boolean;
  ovpsaBatchId: string | null;
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
    college_id: string;
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
            batch.college_id::text,college.name AS college_name,batch.status,
            batch.optimistic_token::text,revision.id::text AS revision_id,
            revision.revision_number,revision.status AS revision_status,
            revision.laboratory_date::text,revision.physical_exam_date::text,
            revision.physical_exam_exception_reason
       FROM ovpsa_first_year_batches batch
       LEFT JOIN academic_years academic_year
         ON academic_year.start_year=batch.schedule_cycle_start
       JOIN colleges college ON college.id=batch.college_id
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

export async function loadEligibleFirstYearStudents(
  client: PoolClient,
  input: { collegeId: string },
): Promise<OvpsaPlanningStudent[]> {
  const result = await client.query<{
    student_number: string;
    student_name: string;
    college_id: string;
    college_name: string;
    program_id: string;
    program_code: string;
    program_name: string;
    year_level: number | null;
    is_active: boolean;
  }>(
    `SELECT student.student_number,
            ${studentDisplayNameSql("student")} AS student_name,
            student.college_id::text,college.name AS college_name,
            student.program_id::text,program.code AS program_code,
            program.name AS program_name,student.year_level,student.is_active
       FROM students student
       JOIN colleges college ON college.id=student.college_id
       JOIN programs program ON program.id=student.program_id
      WHERE student.college_id=$1
      ORDER BY student.last_name,student.first_name,student.student_number`,
    [input.collegeId],
  );
  return result.rows.map((row) => ({
    studentNumber: row.student_number,
    studentName: row.student_name,
    collegeId: row.college_id,
    collegeName: row.college_name,
    programId: row.program_id,
    programCode: row.program_code,
    programName: row.program_name,
    yearLevel: row.year_level,
    isActive: row.is_active,
  }));
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

export async function loadCurrentMemberAppointments(
  client: PoolClient,
  input: { studentNumbers: string[]; scheduleCycleStart: number; forUpdate?: boolean },
): Promise<OvpsaExistingAppointment[]> {
  if (!input.studentNumbers.length) return [];
  const result = await client.query<{
    id: string;
    student_number: string;
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    appointment_date: string;
    status: string;
    schedule_pair_id: string | null;
    is_manually_locked: boolean;
    ovpsa_batch_id: string | null;
  }>(
    `SELECT appointment.id::text,appointment.student_number,
            appointment.schedule_type,appointment.appointment_date::text,
            appointment.status,appointment.schedule_pair_id::text,
            appointment.is_manually_locked,appointment.ovpsa_batch_id::text
       FROM appointments appointment
      WHERE appointment.student_number=ANY($1::varchar[])
        AND appointment.schedule_cycle_start=$2
        AND appointment.is_published=TRUE
        AND appointment.status NOT IN ('RESCHEDULED','CANCELLED','AWAITING_RESCHEDULE')
        AND NOT EXISTS (
          SELECT 1 FROM appointments replacement
           WHERE replacement.rescheduled_from=appointment.id
             AND replacement.is_published=TRUE
             AND replacement.status NOT IN ('RESCHEDULED','CANCELLED','AWAITING_RESCHEDULE')
        )
      ORDER BY appointment.student_number,appointment.schedule_type,appointment.id
      ${input.forUpdate ? "FOR UPDATE OF appointment" : ""}`,
    [input.studentNumbers, input.scheduleCycleStart],
  );
  return result.rows.map((row) => ({
    id: row.id,
    studentNumber: row.student_number,
    scheduleType: row.schedule_type,
    appointmentDate: row.appointment_date,
    status: row.status,
    schedulePairId: row.schedule_pair_id,
    isManuallyLocked: row.is_manually_locked,
    ovpsaBatchId: row.ovpsa_batch_id,
  }));
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
