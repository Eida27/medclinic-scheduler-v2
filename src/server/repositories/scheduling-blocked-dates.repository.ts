import "server-only";
import type { PoolClient } from "pg";

export type SchedulingBlockedDates = {
  laboratoryDates: string[];
  physicalExamDates: string[];
};

export async function loadSchedulingBlockedDates(
  client: Pick<PoolClient, "query">,
  input: {
    startDate: string;
    endDate: string;
    excludeOvpsaBatchId?: string | null;
  },
): Promise<SchedulingBlockedDates> {
  const result = await client.query<{
    schedule_type: "LABORATORY" | "PHYSICAL_EXAM";
    date: string;
  }>(
    `WITH globally_closed AS (
       SELECT service.schedule_type,unavailable.blocked_date::text AS date
         FROM clinic_unavailable_dates unavailable
         CROSS JOIN (VALUES ('LABORATORY'),('PHYSICAL_EXAM'))
           AS service(schedule_type)
        WHERE unavailable.blocked_date BETWEEN $1::date AND $2::date
          AND unavailable.reopened_at IS NULL
     ),
     service_reserved AS (
       SELECT reservation.schedule_type,reservation.reservation_date::text AS date
         FROM ovpsa_first_year_service_reservations reservation
        WHERE reservation.reservation_date BETWEEN $1::date AND $2::date
          AND reservation.status IN ('ACTIVE','INVALIDATED')
          AND reservation.reservation_kind='EXCLUSIVE'
          AND ($3::uuid IS NULL OR reservation.batch_id<>$3::uuid)
     )
     SELECT DISTINCT schedule_type,date
       FROM (
         SELECT * FROM globally_closed
         UNION ALL
         SELECT * FROM service_reserved
       ) blocked
      ORDER BY schedule_type,date`,
    [input.startDate, input.endDate, input.excludeOvpsaBatchId ?? null],
  );
  const forService = (scheduleType: "LABORATORY" | "PHYSICAL_EXAM") => (
    result.rows
      .filter((row) => row.schedule_type === scheduleType)
      .map((row) => row.date)
  );
  return {
    laboratoryDates: forService("LABORATORY"),
    physicalExamDates: forService("PHYSICAL_EXAM"),
  };
}

export async function isSchedulingDateBlocked(
  client: Pick<PoolClient, "query">,
  input: {
    scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
    date: string;
    excludeOvpsaBatchId?: string | null;
  },
) {
  const blocked = await loadSchedulingBlockedDates(client, {
    startDate: input.date,
    endDate: input.date,
    excludeOvpsaBatchId: input.excludeOvpsaBatchId,
  });
  return input.scheduleType === "LABORATORY"
    ? blocked.laboratoryDates.includes(input.date)
    : blocked.physicalExamDates.includes(input.date);
}
