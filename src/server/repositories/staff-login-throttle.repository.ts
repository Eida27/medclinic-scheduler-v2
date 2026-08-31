import "server-only";
import type { PoolClient } from "pg";

export const STAFF_LOGIN_WINDOW_SECONDS = 15 * 60;
export const STAFF_LOGIN_EMAIL_FAILURE_LIMIT = 5;
export const STAFF_LOGIN_IP_FAILURE_LIMIT = 25;
export const STAFF_LOGIN_RETENTION_HOURS = 24;

type Queryable = Pick<PoolClient, "query">;

export type StaffLoginThrottle = {
  throttled: boolean;
  emailFailureCount: number;
  ipFailureCount: number;
  retryAfterSeconds: number;
};

type ThrottleRow = {
  emailFailureCount: number;
  ipFailureCount: number;
  throttled: boolean;
  retryAfterSeconds: number;
};

export function normalizeStaffLoginEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function lockStaffLoginBuckets(
  client: PoolClient,
  normalizedEmail: string,
  ipAddress: string,
) {
  const lockNames = [
    `medclinic:staff-login:email:v1:${normalizedEmail}`,
    `medclinic:staff-login:ip:v1:${ipAddress}`,
  ].sort();

  for (const lockName of lockNames) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [lockName],
    );
  }
}

export async function getStaffLoginThrottle(
  client: Queryable,
  normalizedEmail: string,
  ipAddress: string,
): Promise<StaffLoginThrottle> {
  const result = await client.query<ThrottleRow>(
    `WITH bucket_limits(scope,bucket_key,failure_limit) AS (
       VALUES
         ('EMAIL'::varchar,$1::varchar,$4::integer),
         ('IP'::varchar,$2::varchar,$5::integer)
     ), ranked_failures AS (
       SELECT bucket_limits.scope,
              bucket_limits.failure_limit,
              failures.occurred_at,
              COUNT(failures.id) OVER (PARTITION BY bucket_limits.scope) AS failure_count,
              ROW_NUMBER() OVER (
                PARTITION BY bucket_limits.scope
                ORDER BY failures.occurred_at,failures.id
              ) AS failure_rank
         FROM bucket_limits
         LEFT JOIN staff_login_failures failures
           ON failures.scope=bucket_limits.scope
          AND failures.bucket_key=bucket_limits.bucket_key
          AND failures.occurred_at>clock_timestamp()-make_interval(secs => $3::integer)
     ), bucket_state AS (
       SELECT scope,
              MAX(failure_limit) AS failure_limit,
              MAX(failure_count)::integer AS failure_count,
              MIN(occurred_at) FILTER (
                WHERE failure_rank=failure_count-failure_limit+1
              ) AS threshold_drop_at
         FROM ranked_failures
        GROUP BY scope
     )
     SELECT
       MAX(failure_count) FILTER (WHERE scope='EMAIL')::integer AS "emailFailureCount",
       MAX(failure_count) FILTER (WHERE scope='IP')::integer AS "ipFailureCount",
       BOOL_OR(failure_count>=failure_limit) AS throttled,
       CASE
         WHEN BOOL_OR(failure_count>=failure_limit) THEN LEAST(
           $3::integer,
           GREATEST(
             1,
             CEIL(EXTRACT(EPOCH FROM (
               MAX(threshold_drop_at)+make_interval(secs => $3::integer)-clock_timestamp()
             )))::integer
           )
         )
         ELSE 0
       END::integer AS "retryAfterSeconds"
       FROM bucket_state`,
    [
      normalizedEmail,
      ipAddress,
      STAFF_LOGIN_WINDOW_SECONDS,
      STAFF_LOGIN_EMAIL_FAILURE_LIMIT,
      STAFF_LOGIN_IP_FAILURE_LIMIT,
    ],
  );

  return result.rows[0];
}

export async function recordStaffLoginFailure(
  client: PoolClient,
  normalizedEmail: string,
  ipAddress: string,
) {
  await client.query(
    `INSERT INTO staff_login_failures (scope,bucket_key)
     VALUES ('EMAIL',$1),('IP',$2)`,
    [normalizedEmail, ipAddress],
  );
}

export async function clearStaffEmailFailures(client: PoolClient, normalizedEmail: string) {
  await client.query(
    "DELETE FROM staff_login_failures WHERE scope='EMAIL' AND bucket_key=$1",
    [normalizedEmail],
  );
}

export async function pruneExpiredStaffLoginFailures(client: Queryable) {
  await client.query(
    "DELETE FROM staff_login_failures WHERE occurred_at<clock_timestamp()-make_interval(hours => $1::integer)",
    [STAFF_LOGIN_RETENTION_HOURS],
  );
}
