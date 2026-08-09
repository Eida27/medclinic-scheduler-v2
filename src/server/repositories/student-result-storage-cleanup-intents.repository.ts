import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/server/db/pool";

export const RESULT_STORAGE_CLEANUP_INTENT_DELAY_MS = 15 * 60 * 1000;
export const RESULT_STORAGE_CLEANUP_CLAIM_LEASE_MS = 5 * 60 * 1000;
const RESULT_STORAGE_CLEANUP_CLAIM_LIMIT = 100;

export async function createStudentResultStorageCleanupIntents(
  storageKeys: string[],
  notBefore: Date,
) {
  if (!storageKeys.length) return;
  await query(
    `INSERT INTO student_result_storage_cleanup_intents (storage_key, not_before)
     SELECT storage_key, $2::timestamptz
       FROM UNNEST($1::text[]) AS storage_key`,
    [storageKeys, notBefore],
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

export async function recordStudentResultStorageCleanupIntentFailure(
  storageKey: string,
  error: string,
) {
  await query(
    `UPDATE student_result_storage_cleanup_intents
        SET delete_error=$2, updated_at=NOW()
      WHERE storage_key=$1 AND claim_token IS NULL`,
    [storageKey, error.slice(0, 2000)],
  );
}

export async function claimDueStudentResultStorageCleanupIntents(now: Date) {
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
    const claimExpiresAt = new Date(now.getTime() + RESULT_STORAGE_CLEANUP_CLAIM_LEASE_MS);
    const claimed = await client.query<{ storageKey: string }>(
      `WITH due AS (
         SELECT storage_key
           FROM student_result_storage_cleanup_intents
          WHERE not_before <= $1
            AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
          ORDER BY not_before, storage_key
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE student_result_storage_cleanup_intents intent
          SET claim_token=$3,
              claim_expires_at=$4,
              attempt_count=intent.attempt_count + 1,
              delete_error=NULL,
              updated_at=$1
         FROM due
        WHERE intent.storage_key=due.storage_key
       RETURNING intent.storage_key AS "storageKey"`,
      [now, RESULT_STORAGE_CLEANUP_CLAIM_LIMIT, claimToken, claimExpiresAt],
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
  now: Date,
) {
  await query(
    `UPDATE student_result_storage_cleanup_intents
        SET claim_token=NULL,
            claim_expires_at=NULL,
            delete_error=$3,
            updated_at=$4
      WHERE storage_key=$1 AND claim_token=$2`,
    [storageKey, claimToken, error.slice(0, 2000), now],
  );
}
