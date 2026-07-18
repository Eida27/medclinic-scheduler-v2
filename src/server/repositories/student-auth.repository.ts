import "server-only";
import type { PoolClient } from "pg";

type StudentCredential = {
  studentNumber: string;
  dateOfBirth: string | null;
  isActive: boolean;
};

type LoginAttempt = {
  failedCount: number;
  lastFailedAt: Date | null;
  lockedUntil: Date | null;
};

export function normalizeStudentNumber(value: string) {
  return value.trim().toUpperCase();
}

export async function findStudentCredential(client: PoolClient, studentNumber: string) {
  const result = await client.query<StudentCredential>(
    `SELECT student_number AS "studentNumber",
            date_of_birth::text AS "dateOfBirth",
            is_active AS "isActive"
       FROM students
      WHERE student_number=$1`,
    [studentNumber],
  );
  return result.rows[0] ?? null;
}

export async function lockStudentLoginAttempt(
  client: PoolClient,
  studentNumber: string,
  ipAddress: string,
) {
  await client.query(
    `INSERT INTO student_login_attempts (student_number, ip_address)
     VALUES ($1,$2)
     ON CONFLICT (student_number, ip_address) DO NOTHING`,
    [studentNumber, ipAddress],
  );
  const result = await client.query<LoginAttempt>(
    `SELECT failed_count AS "failedCount", last_failed_at AS "lastFailedAt",
            locked_until AS "lockedUntil"
       FROM student_login_attempts
      WHERE student_number=$1 AND ip_address=$2
      FOR UPDATE`,
    [studentNumber, ipAddress],
  );
  return result.rows[0];
}

export async function recordStudentLoginFailure(
  client: PoolClient,
  studentNumber: string,
  ipAddress: string,
  prior: LoginAttempt,
) {
  const now = new Date();
  const withinWindow = Boolean(
    prior.lastFailedAt && now.getTime() - prior.lastFailedAt.getTime() < 15 * 60 * 1000,
  );
  const failedCount = withinWindow ? prior.failedCount + 1 : 1;
  const locked = failedCount >= 5;
  await client.query(
    `UPDATE student_login_attempts
        SET failed_count=$3,
            first_failed_at=CASE WHEN $4 THEN first_failed_at ELSE NOW() END,
            last_failed_at=NOW(),
            locked_until=CASE WHEN $5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END
      WHERE student_number=$1 AND ip_address=$2`,
    [studentNumber, ipAddress, failedCount, withinWindow, locked],
  );
  return { locked };
}

export async function clearStudentLoginAttempt(
  client: PoolClient,
  studentNumber: string,
  ipAddress: string,
) {
  await client.query(
    "DELETE FROM student_login_attempts WHERE student_number=$1 AND ip_address=$2",
    [studentNumber, ipAddress],
  );
}
