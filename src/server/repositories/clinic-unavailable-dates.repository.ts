import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";

export type ClinicUnavailableDateInput = {
  clinicId: string;
  startDate: string;
  endDate: string;
  category: "HOLIDAY" | "CLOSURE" | "MAINTENANCE" | "STAFF_UNAVAILABILITY";
  reason: string;
};

export type ClinicUnavailableDateRecord = {
  id: string;
  clinicId: string;
  clinicCode: string;
  clinicName: string;
  startDate: string;
  endDate: string;
  category: ClinicUnavailableDateInput["category"];
  reason: string;
  createdByName: string;
  createdAt: string;
};

type ClinicUnavailableDateRow = {
  id: string;
  clinic_id: string;
  clinic_code: string;
  clinic_name: string;
  start_date: string;
  end_date: string;
  category: ClinicUnavailableDateInput["category"];
  reason: string;
  created_by_name: string;
  created_at: Date;
};

export async function listClinicOptions() {
  const result = await query<{ id: string; name: string }>(
    `SELECT id, name FROM clinics
      WHERE code IN ('KABALAKA_CLINIC','CPU_CLINIC') ORDER BY name`,
  );
  return result.rows;
}

export async function listClinicUnavailableDateRecords(): Promise<ClinicUnavailableDateRecord[]> {
  const result = await query<ClinicUnavailableDateRow>(
    `SELECT unavailable.id, unavailable.clinic_id, clinic.code AS clinic_code,
            clinic.name AS clinic_name, unavailable.start_date::text,
            unavailable.end_date::text, unavailable.category, unavailable.reason,
            creator.full_name AS created_by_name, unavailable.created_at
       FROM clinic_unavailable_dates unavailable
       JOIN clinics clinic ON clinic.id=unavailable.clinic_id
       JOIN users creator ON creator.id=unavailable.created_by
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
  }));
}

export async function hasOverlappingClinicUnavailableDate(
  client: PoolClient,
  input: ClinicUnavailableDateInput,
) {
  const result = await client.query(
    `SELECT 1 FROM clinic_unavailable_dates
      WHERE clinic_id=$1
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
  const result = await client.query<{ id: string }>(
    `INSERT INTO clinic_unavailable_dates (
       clinic_id, start_date, end_date, category, reason, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.clinicId, input.startDate, input.endDate, input.category, input.reason, actorUserId],
  );
  return result.rows[0].id;
}
