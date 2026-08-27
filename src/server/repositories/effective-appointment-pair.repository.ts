import "server-only";

import type { PoolClient } from "pg";

import type {
  EffectiveAppointmentPair,
  PairAppointment,
  PairAppointmentStatus,
} from "@/server/appointments/appointment-pair-integrity";

export type EffectivePairAnchor = {
  id: string;
  studentNumber: string;
  scheduleType: string;
  schedulePairId: string | null;
  scheduleCycleStart: number;
};

export type EffectivePairAppointment = PairAppointment & {
  studentNumber: string;
  appointmentDate: string;
  clinicId: string;
  clinicCode: "KABALAKA_CLINIC" | "CPU_CLINIC";
  schedulePairId: string | null;
  scheduleCycleStart: number;
};

export async function resolveEffectiveAppointmentPair(
  client: PoolClient,
  anchor: EffectivePairAnchor,
): Promise<EffectiveAppointmentPair<EffectivePairAppointment>> {
  const result = await client.query<{
    id: string;
    studentNumber: string;
    scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
    appointmentDate: string;
    status: PairAppointmentStatus;
    clinicId: string;
    clinicCode: "KABALAKA_CLINIC" | "CPU_CLINIC";
    schedulePairId: string | null;
    scheduleCycleStart: number;
  }>(
    `SELECT appointment.id::text,
            appointment.student_number AS "studentNumber",
            appointment.schedule_type AS "scheduleType",
            appointment.appointment_date::text AS "appointmentDate",
            appointment.status,
            appointment.clinic_id::text AS "clinicId",
            clinic.code AS "clinicCode",
            appointment.schedule_pair_id::text AS "schedulePairId",
            appointment.schedule_cycle_start AS "scheduleCycleStart"
       FROM appointments appointment
       JOIN clinics clinic ON clinic.id=appointment.clinic_id
      WHERE appointment.student_number=$1
        AND appointment.schedule_cycle_start=$2
        AND appointment.is_published=TRUE
        AND appointment.status NOT IN ('DRAFT','RESCHEDULED','CANCELLED')
        AND ($3::uuid IS NULL OR appointment.schedule_pair_id=$3::uuid)
      ORDER BY appointment.schedule_type,
               CASE WHEN appointment.id=$4::uuid THEN 0 ELSE 1 END,
               appointment.appointment_date DESC,
               appointment.created_at DESC,
               appointment.id DESC
      FOR UPDATE OF appointment`,
    [anchor.studentNumber, anchor.scheduleCycleStart, anchor.schedulePairId, anchor.id],
  );

  return {
    laboratory: result.rows.find((row) => row.scheduleType === "LABORATORY") ?? null,
    physicalExam: result.rows.find((row) => row.scheduleType === "PHYSICAL_EXAM") ?? null,
  };
}
