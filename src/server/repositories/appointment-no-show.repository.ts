import "server-only";
import { AUTOMATIC_NO_SHOW_NOTE } from "@/server/appointments/automatic-no-show";
import { query, transaction } from "@/server/db/pool";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";

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
    const candidates = await client.query<{ id: string; studentNumber: string; scheduleType: string }>(
      `SELECT appointment.id::text,appointment.student_number AS "studentNumber",
              appointment.schedule_type AS "scheduleType"
           FROM appointments appointment
           JOIN academic_years academic_year ON academic_year.start_year=appointment.schedule_cycle_start
          WHERE appointment.is_published=TRUE
            AND appointment.status='PENDING'
            AND appointment.schedule_type IN ('LABORATORY','PHYSICAL_EXAM')
            AND NOT (
              appointment.ovpsa_batch_id IS NOT NULL
              AND appointment.schedule_type='LABORATORY'
            )
            AND (appointment.schedule_type<>'LABORATORY' OR NOT EXISTS (
              SELECT 1 FROM laboratory_checklist_appointments link
              JOIN laboratory_checklist_items item ON item.checklist_id=link.checklist_id
              WHERE link.appointment_id=appointment.id AND item.verified_at IS NOT NULL
            ))
            AND ((appointment.appointment_date + 1)::timestamp AT TIME ZONE $2)
                <= $1::timestamptz
          ORDER BY appointment.student_number,appointment.schedule_type,appointment.id`,
      [now, timeZone],
    );
    await lockEffectiveAppointmentScopes(client, candidates.rows.map((candidate) => ({
      studentNumber: candidate.studentNumber, scheduleType: candidate.scheduleType,
    })));
    const appointmentIds: string[] = [];
    for (const candidate of candidates.rows) {
      const locked = await client.query<{ id: string }>(
        `SELECT id::text FROM appointments
          WHERE id=$1 AND is_published=TRUE AND status='PENDING'
            AND ((appointment_date + 1)::timestamp AT TIME ZONE $3) <= $2::timestamptz
          FOR UPDATE SKIP LOCKED`, [candidate.id, now, timeZone],
      );
      if (!locked.rowCount) continue;
      const progress = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM laboratory_checklist_appointments link
         JOIN laboratory_checklist_items item ON item.checklist_id=link.checklist_id
        WHERE link.appointment_id=$1 AND item.verified_at IS NOT NULL`, [candidate.id],
      );
      if (progress.rows[0].count) continue;
      await client.query("UPDATE appointments SET status='NO_SHOW',updated_by=NULL WHERE id=$1", [candidate.id]);
      await client.query(`INSERT INTO appointment_status_logs
        (appointment_id,old_status,new_status,notes,changed_by)
        VALUES ($1,'PENDING','NO_SHOW',$2,NULL)`, [candidate.id, AUTOMATIC_NO_SHOW_NOTE]);
      appointmentIds.push(candidate.id);
    }
    return {
      count: appointmentIds.length,
      appointmentIds,
    };
  });
}
