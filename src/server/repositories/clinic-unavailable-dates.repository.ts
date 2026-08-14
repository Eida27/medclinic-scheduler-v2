import type { PoolClient, QueryResultRow } from "pg";
import { query } from "@/server/db/pool";
import type {
  ClinicCalendarClosureGroupPreview,
  ClinicClosureRecoveryMode,
  ClinicUnavailableDateDto,
} from "@/types/clinic-calendar";

export type ClinicUnavailableDateRecord = ClinicUnavailableDateDto;

type Queryable = {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
};

type UnavailableDateRow = {
  id: string;
  closure_group_id: string;
  blocked_date: string;
  group_start_date: string;
  group_end_date: string;
  category: ClinicUnavailableDateDto["category"];
  reason: string;
  recovery_mode: ClinicClosureRecoveryMode;
  policy_effective_date: string;
  created_by_name: string;
  created_at: Date;
  updated_at: string;
};

export type LockedUnifiedUnavailableDate = {
  id: string;
  closureGroupId: string;
  blockedDate: string;
  groupStartDate: string;
  groupEndDate: string;
  category: ClinicUnavailableDateDto["category"];
  reason: string;
  updatedAt: string;
};

const activeDateSelect = `
  SELECT unavailable.id::text,
         unavailable.closure_group_id::text,
         unavailable.blocked_date::text,
         closure.start_date::text AS group_start_date,
         closure.end_date::text AS group_end_date,
         closure.category,
         closure.reason,
         closure.recovery_mode,
         closure.policy_effective_date::text,
         creator.full_name AS created_by_name,
         unavailable.created_at,
         to_char(
           unavailable.updated_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS updated_at
    FROM clinic_unavailable_dates unavailable
    JOIN clinic_closure_groups closure ON closure.id=unavailable.closure_group_id
    JOIN users creator ON creator.id=closure.created_by
   WHERE unavailable.reopened_at IS NULL`;

function toDto(row: UnavailableDateRow): ClinicUnavailableDateDto {
  return {
    id: row.id,
    closureGroupId: row.closure_group_id,
    blockedDate: row.blocked_date,
    groupStartDate: row.group_start_date,
    groupEndDate: row.group_end_date,
    category: row.category,
    reason: row.reason,
    recoveryMode: row.recovery_mode,
    policyEffectiveDate: row.policy_effective_date,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at,
  };
}

export async function listActiveClinicUnavailableDateRecords(): Promise<ClinicUnavailableDateRecord[]> {
  const result = await query<UnavailableDateRow>(
    `${activeDateSelect} ORDER BY unavailable.blocked_date, unavailable.id`,
  );
  return result.rows.map(toDto);
}

export const listClinicUnavailableDateRecords = listActiveClinicUnavailableDateRecords;

export async function listActiveUnavailableDatesWithClient(client: PoolClient) {
  const result = await client.query<UnavailableDateRow>(
    `${activeDateSelect} ORDER BY unavailable.blocked_date, unavailable.id`,
  );
  return result.rows.map(toDto);
}

export async function listUnifiedBlockedDateSet(client?: Queryable) {
  const executor: Queryable = client ?? { query };
  const result = await executor.query<{ blocked_date: string }>(
    `SELECT blocked_date::text
       FROM clinic_unavailable_dates
      WHERE reopened_at IS NULL
      ORDER BY blocked_date`,
  );
  return new Set(result.rows.map((row) => row.blocked_date));
}

export async function lockAllActiveUnavailableDates(client: PoolClient) {
  const result = await client.query<UnavailableDateRow>(
    `${activeDateSelect}
     ORDER BY unavailable.blocked_date,unavailable.id
     FOR UPDATE OF unavailable`,
  );
  return result.rows.map(toDto);
}

export async function lockActiveUnavailableDates(
  client: PoolClient,
  ids: string[],
): Promise<LockedUnifiedUnavailableDate[]> {
  if (!ids.length) return [];
  const result = await client.query<{
    id: string;
    closure_group_id: string;
    blocked_date: string;
    group_start_date: string;
    group_end_date: string;
    category: ClinicUnavailableDateDto["category"];
    reason: string;
    recovery_mode: ClinicClosureRecoveryMode;
    policy_effective_date: string;
    updated_at: string;
  }>(
    `SELECT unavailable.id::text,unavailable.closure_group_id::text,
            unavailable.blocked_date::text,
            closure.start_date::text AS group_start_date,
            closure.end_date::text AS group_end_date,
            closure.category,closure.reason,
            closure.recovery_mode,closure.policy_effective_date::text,
            to_char(
              unavailable.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS updated_at
       FROM clinic_unavailable_dates unavailable
       JOIN clinic_closure_groups closure ON closure.id=unavailable.closure_group_id
      WHERE unavailable.id=ANY($1::uuid[])
        AND unavailable.reopened_at IS NULL
      ORDER BY unavailable.id
      FOR UPDATE OF unavailable`,
    [ids],
  );
  return result.rows.map((row) => ({
    id: row.id,
    closureGroupId: row.closure_group_id,
    blockedDate: row.blocked_date,
    groupStartDate: row.group_start_date,
    groupEndDate: row.group_end_date,
    category: row.category,
    reason: row.reason,
    recoveryMode: row.recovery_mode,
    policyEffectiveDate: row.policy_effective_date,
    updatedAt: row.updated_at,
  }));
}

export async function createClosureGroupWithDates(
  client: PoolClient,
  group: ClinicCalendarClosureGroupPreview,
  actorUserId: string,
  batchId: string,
  recoveryMode: ClinicClosureRecoveryMode = "AUTO_ELIGIBLE",
  policyEffectiveDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
) {
  const insertedGroup = await client.query<{ id: string }>(
    `INSERT INTO clinic_closure_groups (
       start_date,end_date,category,reason,created_by,creation_batch_id,
       recovery_mode,policy_effective_date
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
    [
      group.startDate,
      group.endDate,
      group.category,
      group.reason,
      actorUserId,
      batchId,
      recoveryMode,
      policyEffectiveDate,
    ],
  );
  const closureGroupId = insertedGroup.rows[0].id;
  const dates = await client.query<{ id: string; blocked_date: string }>(
    `INSERT INTO clinic_unavailable_dates (closure_group_id,blocked_date)
     SELECT $1,blocked_date
       FROM UNNEST($2::date[]) AS blocked(blocked_date)
     RETURNING id::text,blocked_date::text`,
    [closureGroupId, group.dates],
  );
  return {
    closureGroupId,
    dates: dates.rows.map((row) => ({ id: row.id, date: row.blocked_date })),
  };
}

export async function reopenUnavailableDate(
  client: PoolClient,
  input: {
    id: string;
    expectedUpdatedAt: string;
    actorUserId: string;
    batchId: string;
  },
) {
  const result = await client.query<{ id: string }>(
    `UPDATE clinic_unavailable_dates
        SET reopened_at=NOW(),reopened_by=$3,reopening_batch_id=$4,updated_at=NOW()
      WHERE id=$1
        AND reopened_at IS NULL
        AND updated_at=$2::timestamptz
      RETURNING id::text`,
    [input.id, input.expectedUpdatedAt, input.actorUserId, input.batchId],
  );
  return result.rowCount === 1;
}
