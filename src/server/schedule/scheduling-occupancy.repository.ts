import "server-only";
import type { PoolClient } from "pg";

/** Capacity accounting is independent of publication and academic-year display filters. */
export function internalOccupancyPredicate(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid appointment SQL alias");
  return `${alias}.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW')
    AND NOT (${alias}.schedule_type='LABORATORY' AND ${alias}.ovpsa_batch_id IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM appointments occupancy_replacement
      WHERE occupancy_replacement.rescheduled_from=${alias}.id
        AND occupancy_replacement.status IN ('DRAFT','PENDING','COMPLETED','NO_SHOW','AWAITING_RESCHEDULE')
    )`;
}

export async function getInternalOccupancy(
  client: PoolClient,
  date: string,
  clinicId: string,
  service: "LABORATORY" | "PHYSICAL_EXAM",
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(*)::integer AS count FROM appointments appointment
     WHERE appointment.appointment_date=$1::date AND appointment.clinic_id=$2::uuid
       AND appointment.schedule_type=$3 AND ${internalOccupancyPredicate("appointment")}`,
    [date, clinicId, service],
  );
  return result.rows[0].count;
}
