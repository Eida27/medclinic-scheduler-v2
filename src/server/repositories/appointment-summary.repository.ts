import "server-only";
import type {
  AppointmentSummarySort,
  OverallStatus,
} from "@/components/appointments/appointment-summary";
import type { ClinicCode } from "@/server/clinics";
import { query } from "@/server/db/pool";
import { studentDisplayNameSql } from "@/server/students/student-display-name";

export type AppointmentSummaryItem = {
  studentNumber: string;
  studentName: string;
  collegeName: string;
  programName: string;
  appointmentStatus: string;
  physicalExamStatus: string;
  laboratoryStatus: string;
  physicalExamAppointmentId: string | null;
  physicalExamAppointmentDate: string | null;
  physicalExamAppointmentStatus: string | null;
  laboratoryAppointmentId: string | null;
  laboratoryAppointmentDate: string | null;
  laboratoryAppointmentStatus: string | null;
  nextSchedule: string | null;
  overallStatus: OverallStatus;
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
  WITH summary_rows AS (
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
      COALESCE(exam.result_status, 'PENDING_UPLOAD') AS "physicalExamStatus",
      COALESCE(lab.result_status, 'PENDING_UPLOAD') AS "laboratoryStatus",
      physical_appointment.id AS "physicalExamAppointmentId",
      physical_appointment.appointment_date AS "physicalExamAppointmentDate",
      physical_appointment.status AS "physicalExamAppointmentStatus",
      physical_appointment.clinic_code AS "physicalExamClinicCode",
      laboratory_appointment.id AS "laboratoryAppointmentId",
      laboratory_appointment.appointment_date AS "laboratoryAppointmentDate",
      laboratory_appointment.status AS "laboratoryAppointmentStatus",
      laboratory_appointment.clinic_code AS "laboratoryClinicCode",
      LEAST(
        CASE
          WHEN physical_appointment.status='PENDING'
            AND physical_appointment.appointment_date >= CURRENT_DATE
          THEN physical_appointment.appointment_date
        END,
        CASE
          WHEN laboratory_appointment.status='PENDING'
            AND laboratory_appointment.appointment_date >= CURRENT_DATE
          THEN laboratory_appointment.appointment_date
        END
      ) AS "nextSchedule",
      CASE
        WHEN COALESCE(exam.result_status, 'PENDING_UPLOAD')='REQUIRES_FOLLOW_UP'
          OR COALESCE(lab.result_status, 'PENDING_UPLOAD')='REQUIRES_FOLLOW_UP'
        THEN 'FOLLOW_UP'
        WHEN COALESCE(exam.result_status, 'PENDING_UPLOAD')='COMPLETED'
          AND COALESCE(lab.result_status, 'PENDING_UPLOAD')='COMPLETED'
        THEN 'COMPLETE'
        ELSE 'INCOMPLETE'
      END AS "overallStatus"
    FROM students s
    JOIN colleges c ON c.id=s.college_id
    JOIN programs p ON p.id=s.program_id
    LEFT JOIN LATERAL (
      SELECT result.result_status
      FROM exam_results result
      LEFT JOIN appointments result_appointment ON result_appointment.id=result.appointment_id
      WHERE result.student_number=s.student_number
        AND (
          result.appointment_id IS NULL
          OR (
            result_appointment.is_published=TRUE
            AND result_appointment.status IN ('PENDING','COMPLETED','NO_SHOW')
          )
        )
      ORDER BY result.updated_at DESC, result.created_at DESC, result.id
      LIMIT 1
    ) exam ON TRUE
    LEFT JOIN LATERAL (
      SELECT result.result_status
      FROM laboratory_results result
      LEFT JOIN appointments result_appointment ON result_appointment.id=result.appointment_id
      WHERE result.student_number=s.student_number
        AND (
          result.appointment_id IS NULL
          OR (
            result_appointment.is_published=TRUE
            AND result_appointment.status IN ('PENDING','COMPLETED','NO_SHOW')
          )
        )
      ORDER BY result.updated_at DESC, result.created_at DESC, result.id
      LIMIT 1
    ) lab ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.id, a.appointment_date, a.status, clinic.code AS clinic_code
      FROM appointments a
      JOIN clinics clinic ON clinic.id=a.clinic_id
      WHERE a.student_number=s.student_number
        AND a.schedule_type='PHYSICAL_EXAM'
        AND a.is_published=TRUE
        AND a.status IN ('PENDING','COMPLETED','NO_SHOW')
      ORDER BY
        CASE WHEN a.status='PENDING' THEN 0 ELSE 1 END,
        CASE WHEN a.status='PENDING' THEN a.appointment_date END,
        CASE WHEN a.status<>'PENDING' THEN a.appointment_date END DESC,
        a.created_at DESC,
        a.id
      LIMIT 1
    ) physical_appointment ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.id, a.appointment_date, a.status, clinic.code AS clinic_code
      FROM appointments a
      JOIN clinics clinic ON clinic.id=a.clinic_id
      WHERE a.student_number=s.student_number
        AND a.schedule_type='LABORATORY'
        AND a.is_published=TRUE
        AND a.status IN ('PENDING','COMPLETED','NO_SHOW')
      ORDER BY
        CASE WHEN a.status='PENDING' THEN 0 ELSE 1 END,
        CASE WHEN a.status='PENDING' THEN a.appointment_date END,
        CASE WHEN a.status<>'PENDING' THEN a.appointment_date END DESC,
        a.created_at DESC,
        a.id
      LIMIT 1
    ) laboratory_appointment ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.status, clinic.code AS clinic_code
      FROM appointments a
      JOIN clinics clinic ON clinic.id=a.clinic_id
      WHERE a.student_number=s.student_number
        AND a.is_published=TRUE
        AND a.status NOT IN ('RESCHEDULED','CANCELLED')
      ORDER BY a.appointment_date DESC, a.created_at DESC
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
  attention_first: `CASE summary_rows."overallStatus" WHEN 'FOLLOW_UP' THEN 0 WHEN 'INCOMPLETE' THEN 1 ELSE 2 END,
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
  if (filters.physicalExamStatus) add(`summary_rows."physicalExamStatus"=?`, filters.physicalExamStatus);
  if (filters.laboratoryStatus) add(`summary_rows."laboratoryStatus"=?`, filters.laboratoryStatus);
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
         COUNT(*) FILTER (WHERE summary_rows."overallStatus"<>'COMPLETE')::int AS pending_any
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
