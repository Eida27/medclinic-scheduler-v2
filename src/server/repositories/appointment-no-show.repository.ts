import "server-only";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import { query, transaction } from "@/server/db/pool";

export async function getNextNoShowSweepAt(now: Date, timeZone: string) {
  const result = await query<{ nextSweepAt: Date }>(
    `SELECT (((($1::timestamptz AT TIME ZONE $2)::date + 1)::timestamp
              AT TIME ZONE $2)) AS "nextSweepAt"`,
    [now, timeZone],
  );
  return result.rows[0].nextSweepAt;
}

export async function markOverdueAppointmentsNoShow(now: Date, timeZone: string) {
  return transaction(async (client) => {
    const result = await client.query<{ appointmentId: string }>(
      `WITH overdue AS (
         SELECT appointment.id
           FROM appointments appointment
          WHERE appointment.is_published=TRUE
            AND appointment.status='PENDING'
            AND appointment.schedule_type IN ('LABORATORY','PHYSICAL_EXAM')
            AND ((appointment.appointment_date + 1)::timestamp AT TIME ZONE $2)
                <= $1::timestamptz
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
