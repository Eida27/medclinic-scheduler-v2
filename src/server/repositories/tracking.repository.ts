import "server-only";
import {
  parseAppointmentSummarySort,
  type OverallStatus,
} from "@/components/appointments/appointment-summary";
import { query } from "@/server/db/pool";
import type { ClinicCode } from "@/server/clinics";
import type { AttendanceStatus } from "./current-effective-appointments.repository";
import { appointmentSummaryReport } from "./appointment-summary.repository";

const currentOperationalYearPredicate = `make_date(y.start_year, 8, 1) <= (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date
  AND y.closing_date >= (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date`;

export async function complianceReport(filters: {
  clinicCode?: ClinicCode;
  collegeId?: string; programId?: string; physicalExamStatus?: AttendanceStatus;
  laboratoryStatus?: AttendanceStatus; appointmentStatus?: AttendanceStatus; appointmentDate?: string; overallStatus?: OverallStatus;
  search?: string; sort?: string; page: number; limit: number; offset: number;
}) {
  const { appointmentStatus, ...summaryFilters } = filters;
  return appointmentSummaryReport({
    ...summaryFilters,
    latestAppointmentStatus: appointmentStatus,
    sort: parseAppointmentSummarySort(filters.sort),
  });
}

export async function dashboardMetrics(filters: {
  clinicCode?: ClinicCode;
  includeEmailDeliveryIssues?: boolean;
} = {}) {
  const clinicWhere = filters.clinicCode ? " AND c.code=$1" : "";
  const values = filters.clinicCode ? [filters.clinicCode] : [];
  const result = await query<{
    total_students: number; pending_appointments: number; completed_exam: number; completed_lab: number;
    finalized_lab_documents: number;
    no_shows: number; rescheduled: number; over_capacity_dates: number;
    actionable_email_delivery_failures?: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM students WHERE is_active=TRUE) AS total_students,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id JOIN academic_years y ON y.start_year=a.schedule_cycle_start WHERE a.status='PENDING' AND a.is_published=TRUE AND ${currentOperationalYearPredicate}${clinicWhere}) AS pending_appointments,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id JOIN academic_years y ON y.start_year=a.schedule_cycle_start JOIN medical_certificate_revisions certificate ON certificate.appointment_id=a.id AND certificate.status='ISSUED' WHERE a.schedule_type='PHYSICAL_EXAM' AND a.status='COMPLETED' AND a.is_published=TRUE AND ${currentOperationalYearPredicate}${clinicWhere}) AS completed_exam,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id JOIN academic_years y ON y.start_year=a.schedule_cycle_start WHERE a.schedule_type='LABORATORY' AND a.status='COMPLETED' AND a.is_published=TRUE AND ${currentOperationalYearPredicate}${clinicWhere}) AS completed_lab,
      (SELECT COUNT(DISTINCT a.id)::int FROM student_result_submissions submission JOIN appointments a ON a.id=submission.appointment_id JOIN clinics c ON c.id=a.clinic_id JOIN academic_years y ON y.start_year=a.schedule_cycle_start WHERE submission.result_type='LABORATORY' AND submission.status='FINALIZED' AND a.is_published=TRUE AND ${currentOperationalYearPredicate}${clinicWhere}) AS finalized_lab_documents,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id JOIN academic_years y ON y.start_year=a.schedule_cycle_start WHERE a.status='NO_SHOW' AND a.is_published=TRUE AND ${currentOperationalYearPredicate}${clinicWhere}) AS no_shows,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id JOIN academic_years y ON y.start_year=a.schedule_cycle_start WHERE a.status='RESCHEDULED' AND a.is_published=TRUE AND ${currentOperationalYearPredicate}${clinicWhere}) AS rescheduled,
      (SELECT COUNT(*)::int FROM (
        SELECT a.clinic_id,a.appointment_date,a.schedule_type FROM appointments a
        JOIN clinics cl ON cl.id=a.clinic_id
        JOIN academic_years y ON y.start_year=a.schedule_cycle_start
        JOIN clinic_capacity_settings c ON c.clinic_id=a.clinic_id AND c.schedule_type=a.schedule_type
        WHERE a.status='PENDING' AND a.is_published=TRUE AND ${currentOperationalYearPredicate}${filters.clinicCode ? " AND cl.code=$1" : ""}
        GROUP BY a.clinic_id,a.appointment_date,a.schedule_type,c.max_daily_capacity
        HAVING COUNT(*) > c.max_daily_capacity
      ) x) AS over_capacity_dates
      ${filters.includeEmailDeliveryIssues
        ? ", (SELECT COUNT(*)::int FROM email_outbox WHERE status='PERMANENT_FAILURE') AS actionable_email_delivery_failures"
        : ""}
  `, values);
  const row = result.rows[0];
  return {
    totalStudents: row.total_students,
    pendingAppointments: row.pending_appointments,
    completedPhysicalExams: row.completed_exam,
    completedLaboratory: row.completed_lab,
    finalizedLaboratoryDocuments: row.finalized_lab_documents,
    noShows: row.no_shows,
    rescheduled: row.rescheduled,
    capacityConflicts: row.over_capacity_dates,
    ...(filters.includeEmailDeliveryIssues
      ? { actionableEmailDeliveryFailures: row.actionable_email_delivery_failures ?? 0 }
      : {}),
  };
}
