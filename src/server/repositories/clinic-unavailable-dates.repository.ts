import type { PoolClient } from "pg";
import type {
  ClinicCalendarBlockChange,
  ClinicCalendarCategory,
  ClinicUnavailableDateDto,
} from "@/types/clinic-calendar";
import { query } from "@/server/db/pool";

export type ClinicUnavailableDateInput = {
  clinicId: string;
  startDate: string;
  endDate: string;
  category: ClinicCalendarCategory;
  reason: string;
};

export type ClinicUnavailableDateRecord = ClinicUnavailableDateDto;

export type LockedClinicUnavailableDate = {
  id: string;
  clinicId: string;
  startDate: string;
  endDate: string;
  category: ClinicCalendarCategory;
  reason: string;
  createdBy: string;
  createdBatchId: string | null;
  updatedAt: string;
};

type ClinicUnavailableDateRow = {
  id: string;
  clinic_id: string;
  clinic_code: string;
  clinic_name: string;
  start_date: string;
  end_date: string;
  category: ClinicCalendarCategory;
  reason: string;
  created_by_name: string;
  created_at: Date;
  updated_at: string;
};

type LockedClinicUnavailableDateRow = {
  id: string;
  clinic_id: string;
  start_date: string;
  end_date: string;
  category: ClinicCalendarCategory;
  reason: string;
  created_by: string;
  created_batch_id: string | null;
  updated_at: string;
};

export async function listClinicOptions() {
  const result = await query<{ id: string; name: string }>(
    `SELECT id, name FROM clinics
      WHERE code IN ('KABALAKA_CLINIC','CPU_CLINIC') ORDER BY name`,
  );
  return result.rows;
}

export async function listActiveClinicUnavailableDateRecords(): Promise<ClinicUnavailableDateRecord[]> {
  const result = await query<ClinicUnavailableDateRow>(
    `SELECT unavailable.id, unavailable.clinic_id, clinic.code AS clinic_code,
            clinic.name AS clinic_name, unavailable.start_date::text,
            unavailable.end_date::text, unavailable.category, unavailable.reason,
            creator.full_name AS created_by_name, unavailable.created_at,
            to_char(
              unavailable.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS updated_at
       FROM clinic_unavailable_dates unavailable
       JOIN clinics clinic ON clinic.id=unavailable.clinic_id
       JOIN users creator ON creator.id=unavailable.created_by
      WHERE unavailable.unblocked_at IS NULL
      ORDER BY unavailable.start_date DESC, unavailable.created_at DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    clinicId: row.clinic_id,
    clinicCode: row.clinic_code,
    clinicName: row.clinic_name,
    startDate: row.start_date,
    endDate: row.end_date,
    category: row.category,
    reason: row.reason,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at,
  }));
}

// Compatibility alias while older read paths migrate to the active-only name.
export const listClinicUnavailableDateRecords = listActiveClinicUnavailableDateRecords;

export async function hasOverlappingClinicUnavailableDate(
  client: PoolClient,
  input: ClinicUnavailableDateInput,
) {
  const result = await client.query(
    `SELECT 1 FROM clinic_unavailable_dates
      WHERE clinic_id=$1
        AND unblocked_at IS NULL
        AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
      FOR UPDATE`,
    [input.clinicId, input.startDate, input.endDate],
  );
  return Boolean(result.rowCount);
}

export async function insertClinicUnavailableDateRecord(
  client: PoolClient,
  input: ClinicUnavailableDateInput,
  actorUserId: string,
) {
  const result = await client.query<{ id: string; updated_at: string }>(
    `INSERT INTO clinic_unavailable_dates (
       clinic_id, start_date, end_date, category, reason, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id::text,
               to_char(
                 updated_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
               ) AS updated_at`,
    [input.clinicId, input.startDate, input.endDate, input.category, input.reason, actorUserId],
  );
  return { id: result.rows[0].id, updatedAt: result.rows[0].updated_at };
}

export async function lockActiveClinicUnavailableDates(
  client: PoolClient,
  ids: string[],
): Promise<LockedClinicUnavailableDate[]> {
  if (!ids.length) return [];
  const result = await client.query<LockedClinicUnavailableDateRow>(
    `SELECT unavailable.id::text, unavailable.clinic_id::text,
            unavailable.start_date::text, unavailable.end_date::text,
            unavailable.category, unavailable.reason, unavailable.created_by::text,
            unavailable.created_batch_id::text,
            to_char(
              unavailable.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS updated_at
       FROM clinic_unavailable_dates unavailable
      WHERE unavailable.id=ANY($1::uuid[])
        AND unavailable.unblocked_at IS NULL
      ORDER BY unavailable.id
      FOR UPDATE`,
    [ids],
  );
  return result.rows.map((row) => ({
    id: row.id,
    clinicId: row.clinic_id,
    startDate: row.start_date,
    endDate: row.end_date,
    category: row.category,
    reason: row.reason,
    createdBy: row.created_by,
    createdBatchId: row.created_batch_id,
    updatedAt: row.updated_at,
  }));
}

export async function insertClinicUnavailableDate(
  client: PoolClient,
  input: ClinicCalendarBlockChange,
  actorUserId: string,
  batchId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO clinic_unavailable_dates (
       clinic_id, start_date, end_date, category, reason, created_by, created_batch_id
     ) VALUES ($1,$2,$2,$3,$4,$5,$6) RETURNING id::text`,
    [input.clinicId, input.date, input.category, input.reason, actorUserId, batchId],
  );
  return result.rows[0].id;
}

export async function softUnblockClinicUnavailableDate(
  client: PoolClient,
  input: {
    id: string;
    expectedUpdatedAt: string;
    actorUserId: string;
    batchId: string;
  },
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `UPDATE clinic_unavailable_dates
        SET unblocked_at=NOW(),
            unblocked_by=$3,
            unblocked_batch_id=$4,
            updated_at=NOW()
      WHERE id=$1
        AND unblocked_at IS NULL
        AND updated_at=$2::timestamptz
      RETURNING id`,
    [input.id, input.expectedUpdatedAt, input.actorUserId, input.batchId],
  );
  return result.rowCount === 1;
}
