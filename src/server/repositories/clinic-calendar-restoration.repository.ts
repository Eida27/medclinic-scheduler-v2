import "server-only";
import type { PoolClient } from "pg";

export type LockedClosureRestorationEvent = {
  id: string;
  studentNumber: string;
  closureGroupId: string;
  strategy: "MOVE_COMPLETE_PAIR" | "MOVE_PHYSICAL_ONLY" | "MANUAL_RESOLUTION_REQUIRED";
  outcome: string;
  oldLaboratoryAppointmentId: string | null;
  newLaboratoryAppointmentId: string | null;
  oldPhysicalExamAppointmentId: string | null;
  newPhysicalExamAppointmentId: string | null;
  triggeringDateIds: string[];
};

export async function lockRestorationEventsForUnavailableDates(
  client: PoolClient,
  unavailableDateIds: string[],
): Promise<LockedClosureRestorationEvent[]> {
  if (!unavailableDateIds.length) return [];
  const result = await client.query<{
    id: string;
    student_number: string;
    closure_group_id: string;
    strategy: LockedClosureRestorationEvent["strategy"];
    outcome: string;
    old_laboratory_appointment_id: string | null;
    new_laboratory_appointment_id: string | null;
    old_physical_exam_appointment_id: string | null;
    new_physical_exam_appointment_id: string | null;
    triggering_date_ids: string[];
  }>(
    `SELECT event.id::text,event.student_number,event.closure_group_id::text,
            event.strategy,event.outcome,
            event.old_laboratory_appointment_id::text,
            event.new_laboratory_appointment_id::text,
            event.old_physical_exam_appointment_id::text,
            event.new_physical_exam_appointment_id::text,
            ARRAY_AGG(link.unavailable_date_id::text ORDER BY link.unavailable_date_id) AS triggering_date_ids
       FROM appointment_reschedule_events event
       JOIN appointment_reschedule_event_unavailable_dates link ON link.event_id=event.id
      WHERE link.unavailable_date_id=ANY($1::uuid[])
        AND event.restored_at IS NULL
      GROUP BY event.id
      ORDER BY event.student_number,event.schedule_cycle_start,event.id
      FOR UPDATE OF event`,
    [unavailableDateIds],
  );
  return result.rows.map((row) => ({
    id: row.id,
    studentNumber: row.student_number,
    closureGroupId: row.closure_group_id,
    strategy: row.strategy,
    outcome: row.outcome,
    oldLaboratoryAppointmentId: row.old_laboratory_appointment_id,
    newLaboratoryAppointmentId: row.new_laboratory_appointment_id,
    oldPhysicalExamAppointmentId: row.old_physical_exam_appointment_id,
    newPhysicalExamAppointmentId: row.new_physical_exam_appointment_id,
    triggeringDateIds: row.triggering_date_ids,
  }));
}
