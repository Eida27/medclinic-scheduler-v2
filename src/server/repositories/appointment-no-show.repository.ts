import "server-only";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import { transaction } from "@/server/db/pool";

export async function markOverdueAppointmentsNoShow(now: Date, timeZone: string) {
  return transaction(async (client) => {
    const result = await client.query<{ appointmentId: string }>(
      `WITH overdue AS (
         SELECT appointment.id
           FROM appointments appointment
          WHERE appointment.is_published=TRUE
            AND appointment.status='PENDING'
            AND appointment.schedule_type IN ('LABORATORY','PHYSICAL_EXAM')
            AND CASE
                  WHEN appointment.appointment_time IS NULL THEN
                    ((appointment.appointment_date + 2)::timestamp AT TIME ZONE $2)
                  ELSE
                    ((appointment.appointment_date + appointment.appointment_time)
                      AT TIME ZONE $2) + INTERVAL '24 hours'
                END <= $1::timestamptz
          FOR UPDATE SKIP LOCKED
       ), changed AS (
         UPDATE appointments appointment
            SET status='NO_SHOW', updated_by=NULL
           FROM overdue
          WHERE appointment.id=overdue.id
            AND appointment.is_published=TRUE
            AND appointment.status='PENDING'
          RETURNING appointment.id
       )
       INSERT INTO appointment_status_logs (
         appointment_id, old_status, new_status, notes, changed_by
       )
       SELECT changed.id, 'PENDING', 'NO_SHOW', $3, NULL
         FROM changed
       RETURNING appointment_id AS "appointmentId"`,
      [now, timeZone, AUTOMATIC_NO_SHOW_NOTE],
    );

    return {
      count: result.rowCount ?? 0,
      appointmentIds: result.rows.map((row) => row.appointmentId),
    };
  });
}
