import "server-only";
import type {
  AppointmentSummarySort,
  OverallStatus,
} from "@/components/appointments/appointment-summary";
import type { ClinicCode } from "@/server/clinics";
import { query } from "@/server/db/pool";
import {
  CURRENT_EFFECTIVE_APPOINTMENTS_CTE,
  type AttendanceStatus,
} from "@/server/repositories/current-effective-appointments.repository";
import { studentDisplayNameSql } from "@/server/students/student-display-name";

export type AppointmentSummaryItem = {
  studentNumber: string;
  studentName: string;
  collegeName: string;
  programName: string;
  appointmentStatus: string;
  physicalExamStatus: AttendanceStatus;
  laboratoryStatus: AttendanceStatus;
  physicalExamAppointmentId: string | null;
  physicalExamAppointmentDate: string | null;
  physicalExamAppointmentStatus: string | null;
  laboratoryAppointmentId: string | null;
  laboratoryAppointmentDate: string | null;
  laboratoryAppointmentStatus: string | null;
  nextSchedule: string | null;
  overallStatus: "COMPLETE" | "INCOMPLETE";
};

export type AppointmentSummaryFilters = {
  clinicCode?: ClinicCode;
  search?: string;
  appointmentDate?: string;
  appointmentStatus?: string;
  legacyAppointmentStatus?: string;
  collegeId?: string;
  programId?: string;
  priorityGroupId?: string;
  physicalExamStatus?: string;
  laboratoryStatus?: string;
  overallStatus?: OverallStatus;
  sort: AppointmentSummarySort;
  page: number;
  limit: number;
  offset: number;
};

const summaryRowsCte = `
  WITH ${CURRENT_EFFECTIVE_APPOINTMENTS_CTE},
  summary_rows AS (
    SELECT
      s.student_number AS "studentNumber",
      ${studentDisplayNameSql("s")} AS "studentName",
      CONCAT_WS(' ', BTRIM(s.first_name), BTRIM(s.last_name)) AS "legacyStudentName",
      CONCAT_WS(
        ' ', BTRIM(s.first_name), NULLIF(BTRIM(s.middle_name), ''),
        BTRIM(s.last_name), NULLIF(BTRIM(s.suffix), '')
      ) AS "legacyStudentFullName",
      s.first_name AS "firstName",
      s.last_name AS "lastName",
      s.college_id AS "collegeId",
      s.program_id AS "programId",
      c.name AS "collegeName",
      p.name AS "programName",
      latest_item.priority_group_id AS "priorityGroupId",
      COALESCE(latest_appointment.status, 'UNSCHEDULED') AS "appointmentStatus",
      latest_appointment.clinic_code AS "latestAppointmentClinicCode",
      COALESCE(physical.status, 'UNSCHEDULED') AS "physicalExamStatus",
      COALESCE(laboratory.status, 'UNSCHEDULED') AS "laboratoryStatus",
      physical.id AS "physicalExamAppointmentId",
      physical.appointment_date AS "physicalExamAppointmentDate",
      physical.status AS "physicalExamAppointmentStatus",
      laboratory.id AS "laboratoryAppointmentId",
      laboratory.appointment_date AS "laboratoryAppointmentDate",
      laboratory.status AS "laboratoryAppointmentStatus",
      LEAST(
        CASE WHEN physical.status='PENDING' AND physical.appointment_date >= CURRENT_DATE
             THEN physical.appointment_date END,
        CASE WHEN laboratory.status='PENDING' AND laboratory.appointment_date >= CURRENT_DATE
             THEN laboratory.appointment_date END
      ) AS "nextSchedule",
      CASE
        WHEN physical.status='COMPLETED' AND laboratory.status='COMPLETED'
        THEN 'COMPLETE'
        ELSE 'INCOMPLETE'
      END AS "overallStatus"
    FROM students s
    JOIN colleges c ON c.id=s.college_id
    JOIN programs p ON p.id=s.program_id
    LEFT JOIN current_effective_appointments physical
      ON physical."studentNumber"=s.student_number
     AND physical."scheduleType"='PHYSICAL_EXAM'
    LEFT JOIN current_effective_appointments laboratory
      ON laboratory."studentNumber"=s.student_number
     AND laboratory."scheduleType"='LABORATORY'
    LEFT JOIN LATERAL (
      SELECT resolved.status, clinic.code AS clinic_code
      FROM current_effective_appointments resolved
      JOIN appointments source_appointment ON source_appointment.id=resolved.id
      JOIN clinics clinic ON clinic.id=source_appointment.clinic_id
      WHERE resolved.id IN (physical.id, laboratory.id)
      ORDER BY resolved.appointment_date DESC, resolved.created_at DESC, resolved.id DESC
      LIMIT 1
    ) latest_appointment ON TRUE
    LEFT JOIN LATERAL (
      SELECT item.priority_group_id
      FROM coordinator_schedule_items item
      WHERE item.student_number=s.student_number
        AND EXISTS (
          SELECT 1
          FROM appointments item_appointment
          WHERE item_appointment.schedule_item_id=item.id
            AND item_appointment.is_published=TRUE
            AND item_appointment.id IN (physical.id, laboratory.id)
        )
      ORDER BY item.created_at DESC
      LIMIT 1
    ) latest_item ON TRUE
    WHERE s.is_active=TRUE
  )`;

const itemColumns = `
  summary_rows."studentNumber",
  summary_rows."studentName",
  summary_rows."collegeName",
  summary_rows."programName",
  summary_rows."appointmentStatus",
  summary_rows."physicalExamStatus",
  summary_rows."laboratoryStatus",
  summary_rows."physicalExamAppointmentId",
  summary_rows."physicalExamAppointmentDate"::text AS "physicalExamAppointmentDate",
  summary_rows."physicalExamAppointmentStatus",
  summary_rows."laboratoryAppointmentId",
  summary_rows."laboratoryAppointmentDate"::text AS "laboratoryAppointmentDate",
  summary_rows."laboratoryAppointmentStatus",
  summary_rows."nextSchedule"::text AS "nextSchedule",
  summary_rows."overallStatus"`;

const orderBy: Record<AppointmentSummarySort, string> = {
  upcoming_asc: `summary_rows."nextSchedule" ASC NULLS LAST,
    summary_rows."lastName" ASC, summary_rows."firstName" ASC, summary_rows."studentNumber" ASC`,
  upcoming_desc: `summary_rows."nextSchedule" DESC NULLS LAST,
    summary_rows."lastName" ASC, summary_rows."firstName" ASC, summary_rows."studentNumber" ASC`,
  name_asc: `summary_rows."lastName" ASC, summary_rows."firstName" ASC, summary_rows."studentNumber" ASC`,
  name_desc: `summary_rows."lastName" DESC, summary_rows."firstName" DESC, summary_rows."studentNumber" DESC`,
  attention_first: `CASE summary_rows."overallStatus" WHEN 'INCOMPLETE' THEN 0 ELSE 1 END,
    summary_rows."nextSchedule" ASC NULLS LAST,
    summary_rows."lastName" ASC, summary_rows."firstName" ASC, summary_rows."studentNumber" ASC`,
  completed_first: `CASE summary_rows."overallStatus" WHEN 'COMPLETE' THEN 0 WHEN 'INCOMPLETE' THEN 1 ELSE 2 END,
    summary_rows."nextSchedule" ASC NULLS LAST,
    summary_rows."lastName" ASC, summary_rows."firstName" ASC, summary_rows."studentNumber" ASC`,
};

export async function appointmentSummaryReport(filters: AppointmentSummaryFilters) {
  const clauses = ["TRUE"];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    clauses.push(sql.replaceAll("?", `$${values.length}`));
  };

  if (filters.search) {
    add(
      `(summary_rows."studentNumber" ILIKE ?
        OR summary_rows."studentName" ILIKE ?
        OR summary_rows."legacyStudentName" ILIKE ?
        OR summary_rows."legacyStudentFullName" ILIKE ?)`,
      `%${filters.search}%`,
    );
  }
  if (filters.appointmentDate) {
    add(
      `(summary_rows."laboratoryAppointmentDate"=?::date
        OR summary_rows."physicalExamAppointmentDate"=?::date)`,
      filters.appointmentDate,
    );
  }
  if (filters.appointmentStatus) {
    add(
      `(summary_rows."laboratoryAppointmentStatus"=?
        OR summary_rows."physicalExamAppointmentStatus"=?)`,
      filters.appointmentStatus,
    );
  }
  if (filters.legacyAppointmentStatus) {
    add(`summary_rows."appointmentStatus"=?`, filters.legacyAppointmentStatus);
  }
  if (filters.collegeId) add(`summary_rows."collegeId"=?::uuid`, filters.collegeId);
  if (filters.programId) add(`summary_rows."programId"=?::uuid`, filters.programId);
  if (filters.priorityGroupId) add(`summary_rows."priorityGroupId"=?::uuid`, filters.priorityGroupId);
  if (filters.physicalExamStatus) {
    add(`summary_rows."physicalExamStatus"=?`, filters.physicalExamStatus);
  }
  if (filters.laboratoryStatus) {
    add(`summary_rows."laboratoryStatus"=?`, filters.laboratoryStatus);
  }
  if (filters.overallStatus) add(`summary_rows."overallStatus"=?`, filters.overallStatus);
  if (filters.clinicCode) {
    add(`summary_rows."latestAppointmentClinicCode"=?`, filters.clinicCode);
  }

  const where = clauses.join(" AND ");
  const itemValues = [...values, filters.limit, filters.offset];
  const [items, summary] = await Promise.all([
    query<AppointmentSummaryItem>(
      `${summaryRowsCte}
       SELECT ${itemColumns}
       FROM summary_rows
       WHERE ${where}
       ORDER BY ${orderBy[filters.sort]}
       LIMIT $${itemValues.length - 1} OFFSET $${itemValues.length}`,
      itemValues,
    ),
    query<{
      total: number;
      physical_completed: number;
      laboratory_completed: number;
      pending_any: number;
    }>(
      `${summaryRowsCte}
       SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE summary_rows."physicalExamStatus"='COMPLETED')::int AS physical_completed,
         COUNT(*) FILTER (WHERE summary_rows."laboratoryStatus"='COMPLETED')::int AS laboratory_completed,
         COUNT(*) FILTER (WHERE summary_rows."overallStatus"='INCOMPLETE')::int AS pending_any
       FROM summary_rows
       WHERE ${where}`,
      values,
    ),
  ]);
  const totals = summary.rows[0];

  return {
    items: items.rows,
    total: totals.total,
    summary: {
      totalStudents: totals.total,
      physicalCompleted: totals.physical_completed,
      laboratoryCompleted: totals.laboratory_completed,
      pendingAny: totals.pending_any,
    },
  };
}
