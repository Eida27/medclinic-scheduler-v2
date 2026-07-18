import "server-only";
import type { PoolClient } from "pg";
import { transaction } from "@/server/db/pool";
import { localResultStorage } from "@/server/storage/local-result-storage";
import type { ResultStorage } from "@/server/storage/result-storage";

export const RESULT_DRAFT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RESULT_DRAFT_CLEANUP_RETRY_MS = 5 * 60 * 1000;

type CleanupCandidate = { id: string };
type CleanupFile = { id: string; storageKey: string; byteSize: number };

async function lockExpiredDrafts(client: PoolClient, now: Date) {
  const result = await client.query<CleanupCandidate>(
    `SELECT id
       FROM student_result_submissions
      WHERE status='DRAFT' AND last_activity_at <= $1::timestamptz - INTERVAL '7 days'
      ORDER BY last_activity_at, id
      LIMIT 50
      FOR UPDATE SKIP LOCKED`,
    [now],
  );
  return result.rows;
}

export async function cleanupExpiredResultDrafts(
  now = new Date(),
  storage: ResultStorage = localResultStorage,
) {
  return transaction(async (client) => {
    let expiredDraftCount = 0;
    let deletionFailureCount = 0;
    const pendingDeletion = await client.query<{ id: string; storageKey: string }>(
      `SELECT file.id, file.storage_key AS "storageKey"
         FROM student_result_files file
         JOIN student_result_submissions submission ON submission.id=file.submission_id
        WHERE file.storage_delete_pending=TRUE AND file.deleted_at IS NULL
          AND submission.status='INVALIDATED'
        ORDER BY submission.invalidated_at, file.uploaded_at, file.id
        LIMIT 100
        FOR UPDATE OF file SKIP LOCKED`,
    );
    for (const file of pendingDeletion.rows) {
      try {
        await storage.delete(file.storageKey);
        await client.query(
          `UPDATE student_result_files
              SET storage_delete_pending=FALSE, deleted_at=NOW(), delete_error=NULL
            WHERE id=$1`,
          [file.id],
        );
      } catch (error) {
        deletionFailureCount += 1;
        await client.query(
          `UPDATE student_result_files SET delete_error=$2 WHERE id=$1`,
          [
            file.id,
            (error instanceof Error ? error.message : "Unknown file deletion error").slice(0, 2000),
          ],
        );
      }
    }
    const candidates = await lockExpiredDrafts(client, now);
    for (const candidate of candidates) {
      const files = await client.query<{ id: string; storageKey: string; byteSize: string }>(
        `SELECT id, storage_key AS "storageKey", byte_size::text AS "byteSize"
           FROM student_result_files WHERE submission_id=$1
           ORDER BY uploaded_at, id FOR UPDATE`,
        [candidate.id],
      );
      const mappedFiles: CleanupFile[] = files.rows.map((file) => ({
        ...file,
        byteSize: Number(file.byteSize),
      }));
      let deletionError: string | null = null;
      for (const file of mappedFiles) {
        try {
          await storage.delete(file.storageKey);
        } catch (error) {
          deletionError = error instanceof Error ? error.message : "Unknown file deletion error";
          await client.query(
            `UPDATE student_result_files
                SET storage_delete_pending=TRUE, delete_error=$2
              WHERE id=$1`,
            [file.id, deletionError.slice(0, 2000)],
          );
          break;
        }
      }
      if (deletionError) {
        deletionFailureCount += 1;
        continue;
      }
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
         VALUES (NULL,'STUDENT_RESULT_DRAFT_EXPIRED','student_result_submission',$1,
                 jsonb_build_object('fileCount',$2::int,'totalBytes',$3::bigint))`,
        [
          candidate.id,
          mappedFiles.length,
          mappedFiles.reduce((sum, file) => sum + file.byteSize, 0),
        ],
      );
      await client.query("DELETE FROM student_result_submissions WHERE id=$1 AND status='DRAFT'", [candidate.id]);
      expiredDraftCount += 1;
    }
    return { expiredDraftCount, deletionFailureCount };
  });
}

type WorkerDependencies = {
  cleanupDrafts?: () => Promise<unknown>;
  schedule?: (callback: () => void, delayMs: number) => { unref?: () => void };
  reportError?: (message: string, error: unknown) => void;
};

declare global {
  var __medclinicResultDraftCleanupWorkerStarted: boolean | undefined;
}

export function startResultDraftCleanupWorker(dependencies: WorkerDependencies = {}) {
  if (globalThis.__medclinicResultDraftCleanupWorkerStarted) return false;
  globalThis.__medclinicResultDraftCleanupWorkerStarted = true;
  const cleanupDrafts = dependencies.cleanupDrafts ?? (() => cleanupExpiredResultDrafts());
  const schedule = dependencies.schedule ?? setTimeout;
  const reportError = dependencies.reportError ?? console.error;
  const scheduleRun = (delayMs: number) => {
    const timer = schedule(() => void run(), delayMs);
    timer.unref?.();
  };
  const run = async () => {
    try {
      await cleanupDrafts();
      scheduleRun(RESULT_DRAFT_CLEANUP_INTERVAL_MS);
    } catch (error) {
      reportError("Student result draft cleanup failed.", error);
      scheduleRun(RESULT_DRAFT_CLEANUP_RETRY_MS);
    }
  };
  void run();
  return true;
}
