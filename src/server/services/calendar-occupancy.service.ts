import "server-only";
import { AppError } from "@/lib/errors";
import { query } from "@/server/db/pool";
import { internalOccupancyPredicate } from "@/server/schedule/scheduling-occupancy.repository";

type ServiceCapacity = { used: number; maximum: number | null; remaining: number | null };
export type CalendarOccupancyDay = {
  date: string;
  uniqueStudents: number;
  appointmentTotal: number;
  laboratory: ServiceCapacity;
  physicalExam: ServiceCapacity;
  externalLaboratory: number;
  heldCapacity: number;
  hiddenCapacityHold: number;
  groups: Array<{ college: string; service: "LABORATORY" | "PHYSICAL_EXAM";
    location: "INTERNAL" | "EXTERNAL"; appointments: number }>;
  reservations: Array<{ service: string; kind: string }>;
  tone: "NONE" | "GREEN" | "RED" | "NEUTRAL";
};
export function occupancyTone(input: {
  laboratory: Pick<ServiceCapacity, "used" | "maximum">;
  physicalExam: Pick<ServiceCapacity, "used" | "maximum">;
  appointmentTotal: number; heldCapacity: number;
}): CalendarOccupancyDay["tone"] {
  const services = [input.laboratory, input.physicalExam];
  if (services.some((service) => service.maximum !== null && service.maximum > 0
    && service.used >= service.maximum)) return "RED";
  if (services.some((service) => service.maximum === null || service.maximum <= 0)) return "NEUTRAL";
  if (input.appointmentTotal || input.heldCapacity) return "GREEN";
  return "NONE";
}

type OccupancyRow = {
  date: string; studentNumber: string; service: "LABORATORY" | "PHYSICAL_EXAM";
  published: boolean; external: boolean; college: string | null;
  ended: boolean | null; capacityConsumes: boolean;
};
export async function annualCalendarOccupancy(year: number) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new AppError("INVALID_CALENDAR_YEAR", "Select a valid calendar year.", 422);
  }
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const [capacityRows, appointmentRows, reservationRows] = await Promise.all([
    query<{ service: string; clinicCode: string; maximum: number }>(
      `SELECT setting.schedule_type AS service,clinic.code AS "clinicCode",
              setting.max_daily_capacity AS maximum
         FROM clinic_capacity_settings setting
         JOIN clinics clinic ON clinic.id=setting.clinic_id
        WHERE setting.is_active=TRUE AND ((clinic.code='KABALAKA_CLINIC' AND setting.schedule_type='LABORATORY')
          OR (clinic.code='CPU_CLINIC' AND setting.schedule_type='PHYSICAL_EXAM'))`,
    ),
    query<OccupancyRow>(
      `SELECT appointment.appointment_date::text AS date,
              appointment.student_number AS "studentNumber",
              appointment.schedule_type AS service,
              appointment.is_published AS published,
              (appointment.schedule_type='LABORATORY' AND appointment.ovpsa_batch_id IS NOT NULL) AS external,
              snapshot.college_name AS college,
              (academic_year.closing_date < (clock_timestamp() AT TIME ZONE 'Asia/Manila')::date) AS ended,
              (${internalOccupancyPredicate("appointment")}) AS "capacityConsumes"
         FROM appointments appointment
         LEFT JOIN academic_years academic_year ON academic_year.start_year=appointment.schedule_cycle_start
         LEFT JOIN student_academic_snapshots snapshot
           ON snapshot.student_number=appointment.student_number
          AND snapshot.academic_year_start=appointment.schedule_cycle_start
        WHERE appointment.appointment_date BETWEEN $1::date AND $2::date
          AND appointment.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
          AND NOT EXISTS (
            SELECT 1 FROM appointments successor
             WHERE successor.rescheduled_from=appointment.id
               AND successor.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW','AWAITING_RESCHEDULE')
          )
        ORDER BY appointment.appointment_date,appointment.id`, [start, end],
    ),
    query<{ date: string; service: string; kind: string }>(
      `SELECT reservation_date::text AS date,schedule_type AS service,reservation_kind AS kind
         FROM ovpsa_first_year_service_reservations
        WHERE reservation_date BETWEEN $1::date AND $2::date AND status='ACTIVE'
        ORDER BY reservation_date,schedule_type`, [start, end],
    ),
  ]);
  if (appointmentRows.rows.some((row) => row.ended === null)) {
    throw new AppError("ACADEMIC_YEAR_MISSING", "A booked appointment has no configured academic year.", 409);
  }
  const maximum = {
    LABORATORY: capacityRows.rows.find((row) => row.service === "LABORATORY")?.maximum ?? null,
    PHYSICAL_EXAM: capacityRows.rows.find((row) => row.service === "PHYSICAL_EXAM")?.maximum ?? null,
  };
  const dates = new Map<string, CalendarOccupancyDay>();
  const studentSets = new Map<string, Set<string>>();
  const groups = new Map<string, Map<string, CalendarOccupancyDay["groups"][number]>>();
  function day(date: string) {
    let value = dates.get(date);
    if (!value) {
      value = { date, uniqueStudents: 0, appointmentTotal: 0,
        laboratory: { used: 0, maximum: maximum.LABORATORY, remaining: maximum.LABORATORY },
        physicalExam: { used: 0, maximum: maximum.PHYSICAL_EXAM, remaining: maximum.PHYSICAL_EXAM },
        externalLaboratory: 0, heldCapacity: 0, hiddenCapacityHold: 0,
        groups: [], reservations: [], tone: "NONE" };
      dates.set(date, value);
    }
    return value;
  }
  for (const row of appointmentRows.rows) {
    const value = day(row.date);
    const service = row.service === "LABORATORY" ? value.laboratory : value.physicalExam;
    if (row.capacityConsumes) service.used++;
    const visible = row.published && !row.ended;
    if (row.capacityConsumes && !row.published) value.heldCapacity++;
    if (row.capacityConsumes && !visible) value.hiddenCapacityHold++;
    if (!visible) continue;
    value.appointmentTotal++;
    let students = studentSets.get(row.date);
    if (!students) { students = new Set(); studentSets.set(row.date, students); }
    students.add(row.studentNumber);
    if (row.external) value.externalLaboratory++;
    const key = `${row.college ?? "Academic snapshot missing"}|${row.service}|${row.external ? "EXTERNAL" : "INTERNAL"}`;
    let byGroup = groups.get(row.date);
    if (!byGroup) { byGroup = new Map(); groups.set(row.date, byGroup); }
    const group = byGroup.get(key) ?? { college: row.college ?? "Academic snapshot missing",
      service: row.service, location: row.external ? "EXTERNAL" as const : "INTERNAL" as const,
      appointments: 0 };
    group.appointments++;
    byGroup.set(key, group);
  }
  for (const reservation of reservationRows.rows) day(reservation.date).reservations.push({
    service: reservation.service, kind: reservation.kind,
  });
  for (const value of dates.values()) {
    value.uniqueStudents = studentSets.get(value.date)?.size ?? 0;
    value.laboratory.remaining = value.laboratory.maximum === null ? null
      : value.laboratory.maximum - value.laboratory.used;
    value.physicalExam.remaining = value.physicalExam.maximum === null ? null
      : value.physicalExam.maximum - value.physicalExam.used;
    value.groups = [...(groups.get(value.date)?.values() ?? [])].sort((a, b) =>
      a.college.localeCompare(b.college) || a.service.localeCompare(b.service));
    value.tone = occupancyTone(value);
  }
  return { year, capacities: maximum, dates: [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
