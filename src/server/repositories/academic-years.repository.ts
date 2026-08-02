import "server-only";
import type { PoolClient, QueryResultRow } from "pg";
import { query } from "@/server/db/pool";

export type AcademicYearRecord = {
  startYear: number;
  closingDate: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  linkedSnapshotCount: number;
};

function run<T extends QueryResultRow>(
  client: PoolClient | undefined,
  sql: string,
  values: unknown[] = [],
) {
  return client ? client.query<T>(sql, values) : query<T>(sql, values);
}

const projection = `year.start_year AS "startYear",
  year.closing_date::text AS "closingDate",
  year.created_by AS "createdBy",year.updated_by AS "updatedBy",
  year.created_at AS "createdAt",year.updated_at AS "updatedAt"`;

export async function listAcademicYearRecords(
  client?: PoolClient,
): Promise<AcademicYearRecord[]> {
  const result = await run<AcademicYearRecord>(
    client,
    `SELECT ${projection},COUNT(snapshot.id)::integer AS "linkedSnapshotCount"
       FROM academic_years year
       LEFT JOIN student_academic_snapshots snapshot
         ON snapshot.academic_year_start=year.start_year
      GROUP BY year.start_year,year.closing_date,year.created_by,year.updated_by,
               year.created_at,year.updated_at
      ORDER BY year.start_year DESC`,
  );
  return result.rows;
}

export async function createAcademicYearWithClient(
  client: PoolClient,
  input: { startYear: number; closingDate: string; actorUserId: string },
): Promise<AcademicYearRecord> {
  const result = await client.query<AcademicYearRecord>(
    `INSERT INTO academic_years (start_year,closing_date,created_by,updated_by)
     VALUES ($1,$2,$3,$3)
     RETURNING start_year AS "startYear",closing_date::text AS "closingDate",
               created_by AS "createdBy",updated_by AS "updatedBy",
               created_at AS "createdAt",updated_at AS "updatedAt",
               0::integer AS "linkedSnapshotCount"`,
    [input.startYear, input.closingDate, input.actorUserId],
  );
  return result.rows[0];
}

export async function lockAcademicYearWithSnapshotCount(
  client: PoolClient,
  startYear: number,
): Promise<AcademicYearRecord | undefined> {
  const result = await client.query<AcademicYearRecord>(
    `SELECT ${projection},
            (SELECT COUNT(*)::integer FROM student_academic_snapshots snapshot
              WHERE snapshot.academic_year_start=year.start_year) AS "linkedSnapshotCount"
       FROM academic_years year
      WHERE year.start_year=$1
      FOR UPDATE`,
    [startYear],
  );
  return result.rows[0];
}

export async function updateAcademicYearClosingDateWithClient(
  client: PoolClient,
  input: { startYear: number; closingDate: string; actorUserId: string },
): Promise<AcademicYearRecord | undefined> {
  const result = await client.query<AcademicYearRecord>(
    `UPDATE academic_years year
        SET closing_date=$2,updated_by=$3
      WHERE start_year=$1
      RETURNING year.start_year AS "startYear",year.closing_date::text AS "closingDate",
                year.created_by AS "createdBy",year.updated_by AS "updatedBy",
                year.created_at AS "createdAt",year.updated_at AS "updatedAt",
                (SELECT COUNT(*)::integer FROM student_academic_snapshots snapshot
                  WHERE snapshot.academic_year_start=year.start_year) AS "linkedSnapshotCount"`,
    [input.startYear, input.closingDate, input.actorUserId],
  );
  return result.rows[0];
}

export async function deleteAcademicYearWithClient(
  client: PoolClient,
  startYear: number,
): Promise<AcademicYearRecord | undefined> {
  const result = await client.query<AcademicYearRecord>(
    `DELETE FROM academic_years year
      WHERE start_year=$1
      RETURNING year.start_year AS "startYear",year.closing_date::text AS "closingDate",
                year.created_by AS "createdBy",year.updated_by AS "updatedBy",
                year.created_at AS "createdAt",year.updated_at AS "updatedAt",
                0::integer AS "linkedSnapshotCount"`,
    [startYear],
  );
  return result.rows[0];
}
