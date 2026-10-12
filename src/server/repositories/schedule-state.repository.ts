import "server-only";
import type { PoolClient } from "pg";
import {
  authoritativeScheduleLocationSql,
  authoritativeScheduleDateSql,
  currentPublishedSchedulePredicate,
} from "@/server/schedule/schedule-state-sql";
import type {
  AuthoritativeScheduleAppointment,
  AuthoritativeScheduleState,
} from "@/server/schedule/schedule-notifications";
import { studentDisplayNameSql } from "@/server/students/student-display-name";
import { deriveOjtExternalXraySchedule } from "@/server/schedule/ojt-external-xray";

type ScheduleStateRow = {
  studentNumber: string;
  studentName: string;
  appointmentId: string | null;
  scheduleType: AuthoritativeScheduleAppointment["scheduleType"] | null;
  status: AuthoritativeScheduleAppointment["status"] | null;
  date: string | null;
  affectedDate: string | null;
  location: string | null;
  openManualResolutionIds: string[];
  clinicCode: string | null;
  yearLevel: number | null;
  schedulingCategory: string | null;
  hasOvpsaProvenance: boolean;
};

export async function loadAuthoritativeScheduleState(
  client: PoolClient,
  studentNumber: string,
): Promise<AuthoritativeScheduleState | null> {
  const result = await client.query<ScheduleStateRow>(
    `WITH ranked_current AS (
       SELECT appointment.id,appointment.student_number,appointment.schedule_type,
              appointment.status,appointment.appointment_date,appointment.ovpsa_batch_id,
              appointment.ovpsa_revision_id,appointment.ovpsa_service_reservation_id,
              appointment.schedule_cycle_start,appointment.scheduling_category,
              clinic.code AS clinic_code,
              ${authoritativeScheduleLocationSql("appointment", "clinic")} AS location,
              ROW_NUMBER() OVER (
                PARTITION BY appointment.student_number,appointment.schedule_type
                ORDER BY appointment.appointment_date DESC,appointment.created_at DESC,
                         appointment.id DESC
              ) AS schedule_rank
         FROM appointments appointment
         JOIN clinics clinic ON clinic.id=appointment.clinic_id
        WHERE appointment.student_number=$1
          AND ${currentPublishedSchedulePredicate("appointment")}
          AND NOT EXISTS (
            SELECT 1 FROM appointments replacement
             WHERE replacement.rescheduled_from=appointment.id
               AND ${currentPublishedSchedulePredicate("replacement")}
          )
     )
     SELECT student.student_number AS "studentNumber",
            ${studentDisplayNameSql("student")} AS "studentName",
            appointment.id::text AS "appointmentId",
            appointment.schedule_type AS "scheduleType",appointment.status,
            ${authoritativeScheduleDateSql("appointment")} AS date,
            CASE WHEN appointment.status='AWAITING_RESCHEDULE'
                 THEN appointment.appointment_date::text ELSE NULL END AS "affectedDate",
            appointment.location,
            appointment.clinic_code AS "clinicCode",
            checklist.year_level_snapshot AS "yearLevel",
            checklist.scheduling_category_snapshot AS "schedulingCategory",
            (appointment.ovpsa_batch_id IS NOT NULL
             OR appointment.ovpsa_revision_id IS NOT NULL
             OR appointment.ovpsa_service_reservation_id IS NOT NULL) AS "hasOvpsaProvenance",
            ARRAY(
              SELECT candidate.id::text
                FROM clinic_closure_manual_cases candidate
               WHERE candidate.student_number=student.student_number
                 AND candidate.status='OPEN'
               ORDER BY candidate.id::text
            ) AS "openManualResolutionIds"
       FROM students student
       LEFT JOIN ranked_current appointment
         ON appointment.student_number=student.student_number AND appointment.schedule_rank=1
       LEFT JOIN laboratory_checklist_appointments link
         ON link.appointment_id=appointment.id AND appointment.schedule_type='LABORATORY'
       LEFT JOIN laboratory_checklists checklist
         ON checklist.id=link.checklist_id AND checklist.student_number=appointment.student_number
        AND checklist.academic_year_start=appointment.schedule_cycle_start
        AND checklist.scheduling_category_snapshot=appointment.scheduling_category
      WHERE student.student_number=$1 AND student.is_active=TRUE
      ORDER BY appointment.schedule_type`,
    [studentNumber],
  );
  if (!result.rows.length) return null;
  const appointment = (row: ScheduleStateRow): AuthoritativeScheduleAppointment | null => (
    row.appointmentId && row.scheduleType && row.status && row.location
      ? {
          id: row.appointmentId,
          scheduleType: row.scheduleType,
          status: row.status,
          date: row.date,
          affectedDate: row.affectedDate,
          location: row.location,
        }
      : null
  );
  const first = result.rows[0];
  const laboratoryRow = result.rows.find((row) => row.scheduleType === "LABORATORY");
  const physicalExamRow = result.rows.find((row) => row.scheduleType === "PHYSICAL_EXAM");
  const externalXraySchedule = laboratoryRow?.appointmentId && laboratoryRow.status && laboratoryRow.clinicCode
    ? deriveOjtExternalXraySchedule({
        laboratoryAppointmentId: laboratoryRow.appointmentId,
        laboratoryDate: laboratoryRow.date,
        status: laboratoryRow.status,
        clinicCode: laboratoryRow.clinicCode,
        yearLevel: laboratoryRow.yearLevel,
        schedulingCategory: laboratoryRow.schedulingCategory,
        hasOvpsaProvenance: laboratoryRow.hasOvpsaProvenance,
      })
    : null;
  return {
    studentNumber: first.studentNumber,
    studentName: first.studentName,
    laboratory: laboratoryRow ? appointment(laboratoryRow) : null,
    physicalExam: physicalExamRow ? appointment(physicalExamRow) : null,
    openManualResolutionIds: first.openManualResolutionIds,
    ...(externalXraySchedule ? { externalXraySchedule } : {}),
  };
}
