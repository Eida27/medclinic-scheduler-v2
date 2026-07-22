import "server-only";
import {
  parseAppointmentSummarySort,
  type OverallStatus,
} from "@/components/appointments/appointment-summary";
import { query } from "@/server/db/pool";
import type { ClinicCode } from "@/server/clinics";
import { appointmentSummaryReport } from "./appointment-summary.repository";

export async function complianceReport(filters: {
  clinicCode?: ClinicCode;
  collegeId?: string; programId?: string; priorityGroupId?: string; physicalExamStatus?: string;
  laboratoryStatus?: string; appointmentStatus?: string; appointmentDate?: string; overallStatus?: OverallStatus;
  search?: string; sort?: string; page: number; limit: number; offset: number;
}) {
  const { appointmentStatus, ...summaryFilters } = filters;
  return appointmentSummaryReport({
    ...summaryFilters,
    legacyAppointmentStatus: appointmentStatus,
    sort: parseAppointmentSummarySort(filters.sort),
  });
}

export async function dashboardMetrics(filters: { clinicCode?: ClinicCode } = {}) {
  const clinicWhere = filters.clinicCode ? " AND c.code=$1" : "";
  const values = filters.clinicCode ? [filters.clinicCode] : [];
  const result = await query<{
    total_students: number; pending_appointments: number; completed_exam: number; completed_lab: number;
    no_shows: number; rescheduled: number; over_capacity_dates: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM students WHERE is_active=TRUE) AS total_students,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='PENDING' AND a.is_published=TRUE${clinicWhere}) AS pending_appointments,
      (SELECT COUNT(*)::int FROM exam_results r JOIN appointments a ON a.id=r.appointment_id JOIN clinics c ON c.id=a.clinic_id WHERE r.result_status='COMPLETED' AND a.is_published=TRUE${clinicWhere}) AS completed_exam,
      (SELECT COUNT(*)::int FROM laboratory_results r JOIN appointments a ON a.id=r.appointment_id JOIN clinics c ON c.id=a.clinic_id WHERE r.result_status='COMPLETED' AND a.is_published=TRUE${clinicWhere}) AS completed_lab,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='NO_SHOW' AND a.is_published=TRUE${clinicWhere}) AS no_shows,
      (SELECT COUNT(*)::int FROM appointments a JOIN clinics c ON c.id=a.clinic_id WHERE a.status='RESCHEDULED' AND a.is_published=TRUE${clinicWhere}) AS rescheduled,
      (SELECT COUNT(*)::int FROM (
        SELECT a.clinic_id,a.appointment_date,a.schedule_type FROM appointments a
        JOIN clinics cl ON cl.id=a.clinic_id
        JOIN clinic_capacity_settings c ON c.clinic_id=a.clinic_id AND c.schedule_type=a.schedule_type
        WHERE a.status='PENDING' AND a.is_published=TRUE${filters.clinicCode ? " AND cl.code=$1" : ""}
        GROUP BY a.clinic_id,a.appointment_date,a.schedule_type,c.safe_daily_capacity
        HAVING COUNT(*) > c.safe_daily_capacity
      ) x) AS over_capacity_dates
  `, values);
  const row = result.rows[0];
  return { totalStudents: row.total_students, pendingAppointments: row.pending_appointments, completedPhysicalExams: row.completed_exam, completedLaboratory: row.completed_lab, noShows: row.no_shows, rescheduled: row.rescheduled, overCapacityWarnings: row.over_capacity_dates };
}
