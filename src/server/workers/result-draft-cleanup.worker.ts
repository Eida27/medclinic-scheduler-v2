import "server-only";
import type { PoolClient } from "pg";
import { transaction } from "@/server/db/pool";
import {
  deleteRetiredStudentResultDraftIfClean,
  lockExpiredStudentResultDraftForRetirement,
  recordResultFileDeletion,
  retireStudentResultDraft,
} from "@/server/repositories/student-result-submissions.repository";
import { localResultStorage } from "@/server/storage/local-result-storage";
import type { ResultStorage } from "@/server/storage/result-storage";

export const RESULT_DRAFT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RESULT_DRAFT_CLEANUP_RETRY_MS = 5 * 60 * 1000;

type CleanupCandidate = {
  id: string;
  appointmentId: string;
  studentNumber: string;
  resultType: "LABORATORY" | "PHYSICAL_EXAM";
};

async function lockExpiredDrafts(client: PoolClient, now: Date) {
  const result = await client.query<CleanupCandidate>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType"
       FROM student_result_submissions
      WHERE status='DRAFT' AND discarded_at IS NULL
        AND last_activity_at <= $1::timestamptz - INTERVAL '7 days'
      ORDER BY last_activity_at, id
      LIMIT 50`,
    [now],
  );
  return result.rows;
}

export async function cleanupExpiredResultDrafts(
  now = new Date(),
  storage: ResultStorage = localResultStorage,
) {
  const candidates = await transaction((client) => lockExpiredDrafts(client, now));
  for (const candidate of candidates) {
    await transaction(async (client) => {
      const locked = await lockExpiredStudentResultDraftForRetirement(
        client,
        candidate,
        now,
      );
      if (!locked || !await retireStudentResultDraft(client, locked.draft.id)) return;
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
         VALUES (NULL,'STUDENT_RESULT_DRAFT_EXPIRED','student_result_submission',$1,
                  jsonb_build_object('fileCount',$2::int,'totalBytes',$3::bigint))`,
        [
          locked.draft.id,
          locked.files.length,
          locked.files.reduce((sum, file) => sum + file.byteSize, 0),
        ],
      );
    });
  }

  const staged = await transaction(async (client) => {
    const pendingDeletion = await client.query<{
      id: string;
      submissionId: string;
      storageKey: string;
    }>(
      `SELECT file.id, file.submission_id AS "submissionId",
              file.storage_key AS "storageKey"
         FROM student_result_files file
         JOIN student_result_submissions submission ON submission.id=file.submission_id
        WHERE file.storage_delete_pending=TRUE AND file.deleted_at IS NULL
        ORDER BY COALESCE(
                   submission.discarded_at,
                   submission.invalidated_at,
                   submission.last_activity_at
                 ), file.uploaded_at, file.id
        LIMIT 100
        FOR UPDATE OF file SKIP LOCKED`,
    );
    const retiredDrafts = await client.query<{ id: string; expired: boolean }>(
      `SELECT submission.id,
              EXISTS (
                SELECT 1
                  FROM audit_logs audit
                 WHERE audit.action='STUDENT_RESULT_DRAFT_EXPIRED'
                   AND audit.entity_id=submission.id::text
              ) AS expired
         FROM student_result_submissions submission
        WHERE submission.status='DRAFT' AND submission.discarded_at IS NOT NULL
        ORDER BY submission.discarded_at, submission.id
        LIMIT 200`,
    );
    return { pendingDeletion: pendingDeletion.rows, retiredDrafts: retiredDrafts.rows };
  });

  let deletionFailureCount = 0;
  for (const file of staged.pendingDeletion) {
    try {
      await storage.delete(file.storageKey);
      await recordResultFileDeletion(file.id, { success: true });
    } catch (error) {
      deletionFailureCount += 1;
      await recordResultFileDeletion(file.id, {
        success: false,
        error: error instanceof Error ? error.message : "Unknown file deletion error",
      });
    }
  }

  let expiredDraftCount = 0;
  for (const retired of staged.retiredDrafts) {
    if (await deleteRetiredStudentResultDraftIfClean(retired.id) && retired.expired) {
      expiredDraftCount += 1;
    }
  }
  return { expiredDraftCount, deletionFailureCount };
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
