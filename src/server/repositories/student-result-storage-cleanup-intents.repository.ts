import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/server/db/pool";

export const RESULT_STORAGE_CLEANUP_INTENT_DELAY_MS = 15 * 60 * 1000;
export const RESULT_STORAGE_CLEANUP_CLAIM_LEASE_MS = 5 * 60 * 1000;
const RESULT_STORAGE_CLEANUP_CLAIM_LIMIT = 100;

export async function createStudentResultStorageCleanupIntents(
  storageKeys: string[],
) {
  if (!storageKeys.length) return;
  await query(
    `INSERT INTO student_result_storage_cleanup_intents (storage_key, not_before)
     SELECT storage_key,
            clock_timestamp() + ($2::double precision * INTERVAL '1 millisecond')
       FROM UNNEST($1::text[]) AS storage_key`,
    [storageKeys, RESULT_STORAGE_CLEANUP_INTENT_DELAY_MS],
  );
}

export async function lockStudentResultStorageCleanupIntentsForWrite(
  client: PoolClient,
  storageKeys: string[],
) {
  const locked = await client.query<{ storageKey: string; claimToken: string | null }>(
    `SELECT storage_key AS "storageKey", claim_token::text AS "claimToken"
       FROM student_result_storage_cleanup_intents
      WHERE storage_key = ANY($1::text[])
      ORDER BY storage_key
      FOR UPDATE`,
    [storageKeys],
  );
  if (
    locked.rowCount !== storageKeys.length
    || locked.rows.some((intent) => intent.claimToken !== null)
  ) {
    throw new Error("Result storage cleanup intent is unavailable for writing.");
  }
}

export async function disarmStudentResultStorageCleanupIntents(
  client: PoolClient,
  storageKeys: string[],
) {
  const deleted = await client.query(
    `DELETE FROM student_result_storage_cleanup_intents
      WHERE storage_key = ANY($1::text[])
        AND claim_token IS NULL`,
    [storageKeys],
  );
  if (deleted.rowCount !== storageKeys.length) {
    throw new Error("Result storage cleanup intents could not be disarmed.");
  }
}

export async function deleteUnclaimedStudentResultStorageCleanupIntent(storageKey: string) {
  await query(
    `DELETE FROM student_result_storage_cleanup_intents
      WHERE storage_key=$1 AND claim_token IS NULL`,
    [storageKey],
  );
}

export async function claimStudentResultStorageCleanupIntentForEagerDeletion(
  storageKey: string,
) {
  const claimToken = randomUUID();
  const claimed = await transaction((client) => client.query<{ storageKey: string }>(
    `WITH cleanup_clock AS MATERIALIZED (
       SELECT clock_timestamp() AS now
     ),
     claimable AS (
       SELECT intent.storage_key
         FROM student_result_storage_cleanup_intents intent
        WHERE intent.storage_key=$1
          AND intent.claim_token IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM student_result_files file
             WHERE file.storage_key=intent.storage_key
               AND file.deleted_at IS NULL
          )
        FOR UPDATE OF intent
     )
     UPDATE student_result_storage_cleanup_intents intent
        SET claim_token=$2,
            claim_expires_at=cleanup_clock.now
              + ($3::double precision * INTERVAL '1 millisecond'),
            attempt_count=intent.attempt_count + 1,
            delete_error=NULL,
            updated_at=cleanup_clock.now
       FROM claimable, cleanup_clock
      WHERE intent.storage_key=claimable.storage_key
     RETURNING intent.storage_key AS "storageKey"`,
    [storageKey, claimToken, RESULT_STORAGE_CLEANUP_CLAIM_LEASE_MS],
  ));
  return claimed.rows[0] ? { storageKey: claimed.rows[0].storageKey, claimToken } : null;
}

export async function claimDueStudentResultStorageCleanupIntents() {
  return transaction(async (client) => {
    await client.query(
      `WITH committed AS (
         SELECT intent.storage_key
           FROM student_result_storage_cleanup_intents intent
           JOIN student_result_files file ON file.storage_key=intent.storage_key
          WHERE file.deleted_at IS NULL
          FOR UPDATE OF intent SKIP LOCKED
       )
       DELETE FROM student_result_storage_cleanup_intents intent
        USING committed
        WHERE intent.storage_key=committed.storage_key`,
    );

    const claimToken = randomUUID();
    const claimed = await client.query<{ storageKey: string }>(
      `WITH cleanup_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS now
       ),
       due AS (
         SELECT intent.storage_key
           FROM student_result_storage_cleanup_intents intent, cleanup_clock
          WHERE intent.not_before <= cleanup_clock.now
            AND (
              intent.claim_expires_at IS NULL
              OR intent.claim_expires_at <= cleanup_clock.now
            )
          ORDER BY intent.not_before, intent.storage_key
          LIMIT $1
          FOR UPDATE OF intent SKIP LOCKED
       )
       UPDATE student_result_storage_cleanup_intents intent
          SET claim_token=$2,
              claim_expires_at=cleanup_clock.now
                + ($3::double precision * INTERVAL '1 millisecond'),
              attempt_count=intent.attempt_count + 1,
              delete_error=NULL,
              updated_at=cleanup_clock.now
         FROM due, cleanup_clock
        WHERE intent.storage_key=due.storage_key
       RETURNING intent.storage_key AS "storageKey"`,
      [RESULT_STORAGE_CLEANUP_CLAIM_LIMIT, claimToken, RESULT_STORAGE_CLEANUP_CLAIM_LEASE_MS],
    );
    return claimed.rows.map((intent) => ({ ...intent, claimToken }));
  });
}

export async function completeStudentResultStorageCleanupIntent(
  storageKey: string,
  claimToken: string,
) {
  await query(
    `DELETE FROM student_result_storage_cleanup_intents
      WHERE storage_key=$1 AND claim_token=$2`,
    [storageKey, claimToken],
  );
}

export async function failStudentResultStorageCleanupIntent(
  storageKey: string,
  claimToken: string,
  error: string,
) {
  await query(
    `UPDATE student_result_storage_cleanup_intents
        SET claim_token=NULL,
            claim_expires_at=NULL,
            delete_error=$3,
            updated_at=clock_timestamp()
      WHERE storage_key=$1 AND claim_token=$2`,
    [storageKey, claimToken, error.slice(0, 2000)],
  );
}
