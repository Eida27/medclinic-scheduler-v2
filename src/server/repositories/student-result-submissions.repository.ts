import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";
import { lockEffectiveAppointmentScopes } from "@/server/repositories/effective-appointment-scope-lock.repository";
import { AppError } from "@/lib/errors";
import {
  CURRENT_EFFECTIVE_APPOINTMENTS_CTE,
  type AttendanceStatus,
  type ScheduleType,
} from "@/server/repositories/current-effective-appointments.repository";
import {
  combinedSubmissionProgress,
  currentSubmissionState,
  type AdminResultSubmission,
  type AdminStudentResultListItem,
  type AdminStudentResultProfile,
} from "@/server/student-results/admin-student-result-profile";
import { studentDisplayNameSql } from "@/server/students/student-display-name";
import {
  getAppointmentResultProtectionState,
  type AppointmentResultProtectionState,
  type AppointmentResultTable,
} from "@/server/appointments/appointment-result-protection";

export type AppointmentResultCorrectionState =
  | { type: "CLEAR" }
  | {
    type: "PENDING_PLACEHOLDER";
    resultId: string;
    table: "laboratory_results" | "exam_results";
  }
  | {
    type: "PROTECTED";
    reason: "FINALIZED_SUBMISSION" | "UPLOADED_FILES" | "VERIFIED_RESULT";
  };

export type StudentResultFileMetadata = {
  id: string;
  submissionId: string;
  storageKey: string;
  originalFilename: string;
  detectedMimeType: string;
  extension: string;
  byteSize: number;
  checksumSha256: string;
  uploadedAt: Date;
};

export type StudentResultSubmission = {
  id: string;
  appointmentId: string;
  studentNumber: string;
  resultType: "LABORATORY" | "PHYSICAL_EXAM";
  status: "DRAFT" | "FINALIZED";
  basedOnSubmissionId: string | null;
  administratorReplacementReason: string | null;
  lastActivityAt: Date;
  files: StudentResultFileMetadata[];
  fileCount: number;
  totalBytes: number;
};

type DraftRow = {
  id: string;
  appointmentId: string;
  studentNumber: string;
  resultType: "LABORATORY" | "PHYSICAL_EXAM";
  status: "DRAFT";
  basedOnSubmissionId: string | null;
  lastActivityAt: Date;
};

type FinalizedRow = {
  id: string;
  appointmentId: string;
  studentNumber: string;
  resultType: "LABORATORY" | "PHYSICAL_EXAM";
  status: "FINALIZED";
};

type LockedResultAppointment = {
  id: string;
  status: string;
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
};

type AppointmentResultProtectionRow = {
  appointmentId: string;
  scheduleType: ScheduleType;
  finalizedSubmissionId: string | null;
  activeDraftSubmissionId: string | null;
  activeDraftFileCount: number;
  laboratoryResultId: string | null;
  laboratoryResultStatus: string | null;
  examResultId: string | null;
  examResultStatus: string | null;
};

export async function loadAppointmentResultProtectionStates(
  client: PoolClient,
  appointmentIds: string[],
): Promise<Map<string, AppointmentResultProtectionState>> {
  const uniqueIds = [...new Set(appointmentIds)];
  const states = new Map<string, AppointmentResultProtectionState>(
    uniqueIds.map((appointmentId) => [appointmentId, { type: "CLEAR" }]),
  );
  if (uniqueIds.length === 0) return states;

  const result = await client.query<AppointmentResultProtectionRow>(
    `WITH target AS (
       SELECT UNNEST($1::uuid[]) AS id
     )
     SELECT appointment.id AS "appointmentId",
            appointment.schedule_type AS "scheduleType",
            finalized.id::text AS "finalizedSubmissionId",
            draft.submission_id::text AS "activeDraftSubmissionId",
            COALESCE(draft.active_file_count, 0)::int AS "activeDraftFileCount",
            laboratory.id::text AS "laboratoryResultId",
            laboratory.result_status AS "laboratoryResultStatus",
            exam.id::text AS "examResultId",
            exam.result_status AS "examResultStatus"
       FROM target
       JOIN appointments appointment ON appointment.id=target.id
       LEFT JOIN LATERAL (
         SELECT submission.id
           FROM student_result_submissions submission
          WHERE submission.appointment_id=appointment.id
            AND submission.status='FINALIZED'
          ORDER BY submission.finalized_at DESC NULLS LAST, submission.id DESC
          LIMIT 1
       ) finalized ON TRUE
       LEFT JOIN LATERAL (
         SELECT (ARRAY_AGG(submission.id ORDER BY submission.last_activity_at DESC, submission.id DESC))[1]
                  AS submission_id,
                COUNT(file.id)::int AS active_file_count
           FROM student_result_submissions submission
           JOIN student_result_files file ON file.submission_id=submission.id
           WHERE submission.appointment_id=appointment.id
             AND submission.status='DRAFT'
             AND submission.discarded_at IS NULL
             AND file.deleted_at IS NULL
            AND file.storage_delete_pending=FALSE
       ) draft ON TRUE
       LEFT JOIN laboratory_results laboratory
         ON laboratory.appointment_id=appointment.id
        AND appointment.schedule_type='LABORATORY'
       LEFT JOIN exam_results exam
         ON exam.appointment_id=appointment.id
        AND appointment.schedule_type='PHYSICAL_EXAM'`,
    [uniqueIds],
  );

  for (const row of result.rows) {
    const resultId = row.scheduleType === "LABORATORY"
      ? row.laboratoryResultId
      : row.examResultId;
    const resultStatus = row.scheduleType === "LABORATORY"
      ? row.laboratoryResultStatus
      : row.examResultStatus;
    const resultTable: AppointmentResultTable = row.scheduleType === "LABORATORY"
      ? "laboratory_results"
      : "exam_results";

    states.set(row.appointmentId, getAppointmentResultProtectionState({
      finalizedSubmissionId: row.finalizedSubmissionId,
      activeDraftSubmissionId: row.activeDraftSubmissionId,
      activeDraftFileCount: row.activeDraftFileCount,
      verifiedResult: resultId && resultStatus && resultStatus !== "PENDING_UPLOAD"
        ? { resultId, resultTable }
        : null,
      pendingPlaceholder: resultId && resultStatus === "PENDING_UPLOAD"
        ? { resultId, resultTable }
        : null,
    }));
  }

  return states;
}

export async function getAppointmentResultCorrectionState(
  client: PoolClient,
  appointment: { id: string; scheduleType: string },
): Promise<AppointmentResultCorrectionState> {
  await client.query(
    `SELECT id
       FROM student_result_submissions
      WHERE appointment_id=$1
      FOR UPDATE`,
    [appointment.id],
  );
  await client.query(
    appointment.scheduleType === "LABORATORY"
      ? `SELECT id
           FROM laboratory_results
          WHERE appointment_id=$1
          FOR UPDATE`
      : `SELECT id
           FROM exam_results
          WHERE appointment_id=$1
          FOR UPDATE`,
    [appointment.id],
  );

  const state = (await loadAppointmentResultProtectionStates(client, [appointment.id]))
    .get(appointment.id) ?? { type: "CLEAR" };
  if (state.type === "PENDING_PLACEHOLDER") {
    return {
      type: "PENDING_PLACEHOLDER",
      resultId: state.resultId,
      table: state.resultTable,
    };
  }
  if (state.type === "PROTECTED") {
    return {
      type: "PROTECTED",
      reason: state.reason === "FINALIZED_RESULT_SUBMISSION"
        ? "FINALIZED_SUBMISSION"
        : state.reason === "DRAFT_RESULT_FILES_EXIST"
          ? "UPLOADED_FILES"
          : "VERIFIED_RESULT",
    };
  }
  return state;
}

export async function deletePendingResultPlaceholder(
  client: PoolClient,
  state: Extract<AppointmentResultCorrectionState, { type: "PENDING_PLACEHOLDER" }>,
): Promise<void> {
  const deleted = state.table === "laboratory_results"
    ? await client.query(
      "DELETE FROM laboratory_results WHERE id=$1 AND result_status='PENDING_UPLOAD' RETURNING id",
      [state.resultId],
    )
    : await client.query(
      "DELETE FROM exam_results WHERE id=$1 AND result_status='PENDING_UPLOAD' RETURNING id",
      [state.resultId],
    );
  if (deleted.rowCount !== 1) {
    throw new AppError(
      "APPOINTMENT_RESULT_CONFLICT",
      "The appointment result changed. Refresh and try again.",
      409,
    );
  }
}

export async function ensurePendingUploadResult(
  client: PoolClient,
  appointment: { id: string; studentNumber: string; scheduleType: string },
) {
  const table = appointment.scheduleType === "LABORATORY" ? "laboratory_results" : "exam_results";
  await client.query(
    `INSERT INTO ${table} (student_number, appointment_id, result_status, encoded_by)
     VALUES ($1,$2,'PENDING_UPLOAD',NULL)
     ON CONFLICT (appointment_id) DO NOTHING`,
    [appointment.studentNumber, appointment.id],
  );
}

export async function lockOrCreateStudentResultDraft(
  client: PoolClient,
  studentNumber: string,
  appointmentId: string,
) {
  const appointment = await lockOwnedResultAppointment(
    client,
    studentNumber,
    appointmentId,
  );
  if (!appointment) return { type: "not_found" as const };
  if (appointment.status !== "COMPLETED") return { type: "unavailable" as const };
  const finalized = await client.query<{ id: string }>(
    `SELECT id FROM student_result_submissions
      WHERE appointment_id=$1 AND status='FINALIZED'
      FOR UPDATE`,
    [appointmentId],
  );
  const existing = await lockActiveStudentResultDraft(client, studentNumber, appointmentId);
  if (existing) return { type: "draft" as const, draft: existing };
  if (finalized.rowCount) return { type: "finalized" as const };
  const resultTable = appointment.scheduleType === "LABORATORY"
    ? "laboratory_results"
    : "exam_results";
  const resultStatus = await client.query<{ resultStatus: string }>(
    `SELECT result_status AS "resultStatus" FROM ${resultTable} WHERE appointment_id=$1`,
    [appointmentId],
  );
  if (resultStatus.rowCount && resultStatus.rows[0].resultStatus !== "PENDING_UPLOAD") {
    return { type: "unavailable" as const };
  }
  const inserted = await client.query<DraftRow>(
    `INSERT INTO student_result_submissions (
       appointment_id, student_number, result_type
     ) VALUES ($1,$2,$3)
     RETURNING id, appointment_id AS "appointmentId", student_number AS "studentNumber",
               result_type AS "resultType", status,
               based_on_submission_id::text AS "basedOnSubmissionId",
               last_activity_at AS "lastActivityAt"`,
    [appointmentId, studentNumber, appointment.scheduleType],
  );
  return { type: "draft" as const, draft: inserted.rows[0] };
}

async function lockOwnedResultAppointment(
  client: PoolClient,
  studentNumber: string,
  appointmentId: string,
): Promise<LockedResultAppointment | null> {
  const scope = await client.query<{ scheduleType: "LABORATORY" | "PHYSICAL_EXAM" }>(
    `SELECT schedule_type AS "scheduleType"
       FROM appointments
      WHERE id=$1 AND student_number=$2 AND is_published=TRUE`,
    [appointmentId, studentNumber],
  );
  if (!scope.rowCount) return null;
  await lockEffectiveAppointmentScopes(client, [{
    studentNumber,
    scheduleType: scope.rows[0].scheduleType,
  }]);
  const appointment = await client.query<LockedResultAppointment>(
    `SELECT id, status, schedule_type AS "scheduleType"
       FROM appointments
      WHERE id=$1 AND student_number=$2 AND is_published=TRUE
      FOR UPDATE`,
    [appointmentId, studentNumber],
  );
  return appointment.rows[0] ?? null;
}

async function lockActiveStudentResultDraft(
  client: PoolClient,
  studentNumber: string,
  appointmentId: string,
) {
  const existing = await client.query<DraftRow>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType", status,
            based_on_submission_id::text AS "basedOnSubmissionId",
            last_activity_at AS "lastActivityAt"
       FROM student_result_submissions
      WHERE appointment_id=$1 AND student_number=$2
        AND status='DRAFT' AND discarded_at IS NULL
      FOR UPDATE`,
    [appointmentId, studentNumber],
  );
  return existing.rows[0] ?? null;
}

export async function lockOrCreateStudentResultEditDraft(
  client: PoolClient,
  studentNumber: string,
  appointmentId: string,
  candidateDraftId: string,
) {
  const appointment = await lockOwnedResultAppointment(
    client,
    studentNumber,
    appointmentId,
  );
  if (!appointment) return { type: "not_found" as const };
  if (appointment.status !== "COMPLETED") return { type: "unavailable" as const };

  const official = await client.query<FinalizedRow>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType", status
       FROM student_result_submissions
      WHERE appointment_id=$1 AND student_number=$2 AND status='FINALIZED'
      FOR UPDATE`,
    [appointmentId, studentNumber],
  );
  const currentOfficial = official.rows[0] ?? null;
  const activeDraft = await lockActiveStudentResultDraft(client, studentNumber, appointmentId);
  const officialFiles = currentOfficial
    ? await listDraftFilesForUpdate(client, currentOfficial.id)
    : [];

  if (activeDraft) {
    if (currentOfficial && activeDraft.basedOnSubmissionId === currentOfficial.id) {
      return {
        type: "edit" as const,
        created: false,
        draft: activeDraft,
        official: currentOfficial,
        officialFiles,
      };
    }
    return { type: "conflict" as const };
  }
  if (!currentOfficial) return { type: "no_official" as const };

  const inserted = await client.query<DraftRow>(
    `INSERT INTO student_result_submissions (
       id, appointment_id, student_number, result_type, based_on_submission_id
     ) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, appointment_id AS "appointmentId", student_number AS "studentNumber",
               result_type AS "resultType", status,
               based_on_submission_id::text AS "basedOnSubmissionId",
               last_activity_at AS "lastActivityAt"`,
    [candidateDraftId, appointmentId, studentNumber, appointment.scheduleType, currentOfficial.id],
  );
  return {
    type: "edit" as const,
    created: true,
    draft: inserted.rows[0],
    official: currentOfficial,
    officialFiles,
  };
}

export async function lockExpectedStudentResultDraft(
  client: PoolClient,
  studentNumber: string,
  appointmentId: string,
  submissionId: string,
) {
  const appointment = await lockOwnedResultAppointment(
    client,
    studentNumber,
    appointmentId,
  );
  if (!appointment) return { type: "not_found" as const };
  if (appointment.status !== "COMPLETED") return { type: "unavailable" as const };

  const finalized = await client.query<{ id: string }>(
    `SELECT id FROM student_result_submissions
      WHERE appointment_id=$1 AND status='FINALIZED'
      FOR UPDATE`,
    [appointmentId],
  );
  const currentOfficial = finalized.rows[0] ?? null;
  const draft = await lockActiveStudentResultDraft(client, studentNumber, appointmentId);
  if (!draft || draft.id !== submissionId) return { type: "stale" as const };

  if (!finalized.rowCount) {
    const resultTable = appointment.scheduleType === "LABORATORY"
      ? "laboratory_results"
      : "exam_results";
    const resultStatus = await client.query<{ resultStatus: string }>(
      `SELECT result_status AS "resultStatus" FROM ${resultTable} WHERE appointment_id=$1`,
      [appointmentId],
    );
    if (resultStatus.rowCount && resultStatus.rows[0].resultStatus !== "PENDING_UPLOAD") {
      return { type: "unavailable" as const };
    }
  }

  return { type: "draft" as const, draft, currentOfficial };
}

export async function listDraftFilesForUpdate(client: PoolClient, submissionId: string) {
  const result = await client.query<{
    id: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    extension: string;
    byteSize: string;
    checksumSha256: string;
  }>(
    `SELECT id, storage_key AS "storageKey", original_filename AS "originalFilename",
            detected_mime_type AS "detectedMimeType", extension,
            byte_size::text AS "byteSize", checksum_sha256 AS "checksumSha256"
       FROM student_result_files
      WHERE submission_id=$1 AND deleted_at IS NULL AND storage_delete_pending=FALSE
      ORDER BY uploaded_at, id
      FOR UPDATE`,
    [submissionId],
  );
  return result.rows.map((row) => ({ ...row, byteSize: Number(row.byteSize) }));
}

export async function listResultFilesForCleanupForUpdate(
  client: PoolClient,
  submissionId: string,
) {
  const result = await client.query<{
    id: string;
    storageKey: string;
    byteSize: string;
  }>(
    `SELECT id, storage_key AS "storageKey", byte_size::text AS "byteSize"
       FROM student_result_files
      WHERE submission_id=$1 AND deleted_at IS NULL
      ORDER BY uploaded_at, id
      FOR UPDATE`,
    [submissionId],
  );
  return result.rows.map((row) => ({ ...row, byteSize: Number(row.byteSize) }));
}

export async function retireStudentResultDraft(
  client: PoolClient,
  submissionId: string,
) {
  const retired = await client.query(
    `UPDATE student_result_submissions
        SET discarded_at=NOW()
      WHERE id=$1 AND status='DRAFT' AND discarded_at IS NULL
      RETURNING id`,
    [submissionId],
  );
  if (!retired.rowCount) return false;
  await client.query(
    `UPDATE student_result_files
        SET storage_delete_pending=TRUE, delete_error=NULL
      WHERE submission_id=$1 AND deleted_at IS NULL`,
    [submissionId],
  );
  return true;
}

export async function deleteRetiredStudentResultDraftIfClean(submissionId: string) {
  const deleted = await query(
    `DELETE FROM student_result_submissions submission
      WHERE submission.id=$1
        AND submission.status='DRAFT'
        AND submission.discarded_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM student_result_files file
           WHERE file.submission_id=submission.id
             AND file.deleted_at IS NULL
        )
      RETURNING submission.id`,
    [submissionId],
  );
  return deleted.rowCount === 1;
}

export async function lockExpiredStudentResultDraftForRetirement(
  client: PoolClient,
  candidate: {
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: "LABORATORY" | "PHYSICAL_EXAM";
  },
  now: Date,
) {
  await lockEffectiveAppointmentScopes(client, [{
    studentNumber: candidate.studentNumber,
    scheduleType: candidate.resultType,
  }]);
  const appointment = await client.query<{ id: string }>(
    `SELECT id
       FROM appointments
      WHERE id=$1 AND student_number=$2 AND schedule_type=$3
      FOR UPDATE`,
    [candidate.appointmentId, candidate.studentNumber, candidate.resultType],
  );
  if (!appointment.rowCount) return null;
  await client.query(
    `SELECT id
       FROM student_result_submissions
      WHERE appointment_id=$1 AND status='FINALIZED'
      FOR UPDATE`,
    [candidate.appointmentId],
  );
  const activeDraft = await client.query<DraftRow>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType", status,
            based_on_submission_id::text AS "basedOnSubmissionId",
            last_activity_at AS "lastActivityAt"
       FROM student_result_submissions
      WHERE appointment_id=$1 AND student_number=$2
        AND status='DRAFT' AND discarded_at IS NULL
        AND last_activity_at <= $3::timestamptz - INTERVAL '7 days'
      FOR UPDATE`,
    [candidate.appointmentId, candidate.studentNumber, now],
  );
  const draft = activeDraft.rows[0];
  if (!draft || draft.id !== candidate.id) return null;
  const files = await listResultFilesForCleanupForUpdate(client, draft.id);
  return { draft, files };
}

export async function insertStudentResultFiles(
  client: PoolClient,
  inputs: Array<{
    submissionId: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    extension: string;
    byteSize: number;
    checksumSha256: string;
  }>,
) {
  await client.query(
    `INSERT INTO student_result_files (
       submission_id, storage_key, original_filename, detected_mime_type,
       extension, byte_size, checksum_sha256
     )
     SELECT *
       FROM UNNEST(
         $1::uuid[], $2::text[], $3::text[], $4::text[],
         $5::text[], $6::bigint[], $7::text[]
       )`,
    [
      inputs.map((input) => input.submissionId),
      inputs.map((input) => input.storageKey),
      inputs.map((input) => input.originalFilename),
      inputs.map((input) => input.detectedMimeType),
      inputs.map((input) => input.extension),
      inputs.map((input) => input.byteSize),
      inputs.map((input) => input.checksumSha256),
    ],
  );
  await client.query(
    "UPDATE student_result_submissions SET last_activity_at=NOW() WHERE id=$1",
    [inputs[0].submissionId],
  );
}

export async function getStudentResultSubmissionRow(
  studentNumber: string,
  appointmentId: string,
  client?: PoolClient,
) {
  const submissionSql =
    `SELECT submission.id, submission.appointment_id AS "appointmentId",
            submission.student_number AS "studentNumber", submission.result_type AS "resultType",
            submission.status,
            submission.based_on_submission_id::text AS "basedOnSubmissionId",
            CASE
              WHEN submission.status='DRAFT' AND submission.based_on_submission_id IS NULL
              THEN (
                SELECT invalidated.invalidation_reason
                  FROM student_result_submissions invalidated
                 WHERE invalidated.appointment_id=submission.appointment_id
                   AND invalidated.student_number=submission.student_number
                   AND invalidated.result_type=submission.result_type
                   AND invalidated.status='INVALIDATED'
                 ORDER BY invalidated.invalidated_at DESC NULLS LAST,
                          invalidated.created_at DESC, invalidated.id DESC
                 LIMIT 1
              )
              ELSE NULL
            END AS "administratorReplacementReason",
            submission.last_activity_at AS "lastActivityAt"
       FROM student_result_submissions submission
      WHERE submission.appointment_id=$1 AND submission.student_number=$2
        AND submission.discarded_at IS NULL
        AND submission.status IN ('DRAFT','FINALIZED')
      ORDER BY CASE WHEN submission.status='DRAFT' THEN 0 ELSE 1 END, submission.created_at DESC
      LIMIT 1`;
  type SubmissionRow = {
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: "LABORATORY" | "PHYSICAL_EXAM";
    status: "DRAFT" | "FINALIZED";
    basedOnSubmissionId: string | null;
    administratorReplacementReason: string | null;
    lastActivityAt: Date;
  };
  const submission = client
    ? await client.query<SubmissionRow>(submissionSql, [appointmentId, studentNumber])
    : await query<SubmissionRow>(submissionSql, [appointmentId, studentNumber]);
  if (!submission.rowCount) return null;
  const filesSql =
    `SELECT id, submission_id AS "submissionId", storage_key AS "storageKey",
            original_filename AS "originalFilename", detected_mime_type AS "detectedMimeType",
            extension, byte_size::text AS "byteSize", checksum_sha256 AS "checksumSha256",
            uploaded_at AS "uploadedAt"
       FROM student_result_files
      WHERE submission_id=$1 AND deleted_at IS NULL AND storage_delete_pending=FALSE
      ORDER BY uploaded_at, id`;
  type FileRow = {
    id: string;
    submissionId: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    extension: string;
    byteSize: string;
    checksumSha256: string;
    uploadedAt: Date;
  };
  const files = client
    ? await client.query<FileRow>(filesSql, [submission.rows[0].id])
    : await query<FileRow>(filesSql, [submission.rows[0].id]);
  const mappedFiles = files.rows.map((file) => ({ ...file, byteSize: Number(file.byteSize) }));
  return {
    ...submission.rows[0],
    files: mappedFiles,
    fileCount: mappedFiles.length,
    totalBytes: mappedFiles.reduce((sum, file) => sum + file.byteSize, 0),
  } satisfies StudentResultSubmission;
}

export async function markStudentResultFileForDeletion(
  client: PoolClient,
  fileId: string,
  submissionId: string,
) {
  await client.query(
    `UPDATE student_result_files
        SET storage_delete_pending=TRUE, delete_error=NULL
      WHERE id=$1 AND deleted_at IS NULL`,
    [fileId],
  );
  await client.query(
    "UPDATE student_result_submissions SET last_activity_at=NOW() WHERE id=$1",
    [submissionId],
  );
}

export async function finalizeStudentResultDraft(
  client: PoolClient,
  submission: { id: string; appointmentId: string; studentNumber: string; resultType: string },
  fileCount: number,
  totalBytes: number,
) {
  await client.query(
    `UPDATE student_result_submissions
        SET status='FINALIZED', finalized_at=NOW(), last_activity_at=NOW()
      WHERE id=$1 AND status='DRAFT'`,
    [submission.id],
  );
  const resultTable = submission.resultType === "LABORATORY" ? "laboratory_results" : "exam_results";
  const changed = await client.query(
    `INSERT INTO ${resultTable} (
       student_number, appointment_id, result_status, completed_at, encoded_by
     ) VALUES ($1,$2,'COMPLETED',(NOW() AT TIME ZONE 'Asia/Manila')::date,NULL)
     ON CONFLICT (appointment_id) DO UPDATE
       SET result_status='COMPLETED',
           completed_at=(NOW() AT TIME ZONE 'Asia/Manila')::date,
           encoded_by=NULL
       WHERE ${resultTable}.result_status='PENDING_UPLOAD'
     RETURNING id`,
    [submission.studentNumber, submission.appointmentId],
  );
  if (!changed.rowCount) throw new Error("Result status is no longer available for student finalization.");
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     VALUES (NULL,'STUDENT_RESULT_SUBMISSION_FINALIZED','student_result_submission',$1,
             jsonb_build_object('appointmentId',$2::text,'fileCount',$3::int,'totalBytes',$4::bigint))`,
    [submission.id, submission.appointmentId, fileCount, totalBytes],
  );
}

export async function promoteStudentResultEditDraft(
  client: PoolClient,
  draft: DraftRow,
  previousSubmissionId: string,
  fileCount: number,
  totalBytes: number,
) {
  const superseded = await client.query(
    `UPDATE student_result_submissions
        SET status='SUPERSEDED', superseded_at=NOW(),
            superseded_by_submission_id=$2
      WHERE id=$1 AND status='FINALIZED'
      RETURNING id`,
    [previousSubmissionId, draft.id],
  );
  if (superseded.rowCount !== 1) {
    throw new AppError(
      "RESULT_EDIT_STALE",
      "This result draft changed. Refresh and try again.",
      409,
    );
  }
  const promoted = await client.query(
    `UPDATE student_result_submissions
        SET status='FINALIZED', finalized_at=NOW(), last_activity_at=NOW(),
            based_on_submission_id=NULL
      WHERE id=$1 AND status='DRAFT' AND discarded_at IS NULL
        AND based_on_submission_id=$2
      RETURNING id`,
    [draft.id, previousSubmissionId],
  );
  if (promoted.rowCount !== 1) {
    throw new AppError(
      "RESULT_EDIT_STALE",
      "This result draft changed. Refresh and try again.",
      409,
    );
  }
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
     VALUES (NULL,'STUDENT_RESULT_SUBMISSION_REPLACED','student_result_submission',$1,
             jsonb_build_object(
               'appointmentId',$2::text,
               'previousSubmissionId',$3::text,
               'resultType',$4::text,
               'fileCount',$5::int,
               'totalBytes',$6::bigint
             ))`,
    [
      draft.id,
      draft.appointmentId,
      previousSubmissionId,
      draft.resultType,
      fileCount,
      totalBytes,
    ],
  );
}

export async function getAccessibleStudentResultFileRow(
  fileId: string,
  studentNumber: string,
) {
  const result = await query<{
    id: string;
    submissionId: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    byteSize: string;
    checksumSha256: string;
  }>(
    `SELECT file.id, file.submission_id AS "submissionId", file.storage_key AS "storageKey",
            file.original_filename AS "originalFilename",
            file.detected_mime_type AS "detectedMimeType", file.byte_size::text AS "byteSize",
            file.checksum_sha256 AS "checksumSha256"
       FROM student_result_files file
       JOIN student_result_submissions submission ON submission.id=file.submission_id
      WHERE file.id=$1 AND submission.status='FINALIZED'
        AND submission.student_number=$2
        AND file.deleted_at IS NULL AND file.storage_delete_pending=FALSE
    `,
    [fileId, studentNumber],
  );
  const row = result.rows[0];
  return row ? { ...row, byteSize: Number(row.byteSize) } : null;
}

export async function getAccessibleAdminResultFileRow(
  fileId: string,
  submissionId?: string,
) {
  const values: unknown[] = [fileId];
  const submissionClause = submissionId ? `AND submission.id=$${values.push(submissionId)}::uuid` : "";
  const result = await query<{
    id: string;
    submissionId: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    byteSize: string;
    checksumSha256: string;
  }>(
    `SELECT file.id, file.submission_id AS "submissionId", file.storage_key AS "storageKey",
            file.original_filename AS "originalFilename",
            file.detected_mime_type AS "detectedMimeType", file.byte_size::text AS "byteSize",
            file.checksum_sha256 AS "checksumSha256"
       FROM student_result_files file
       JOIN student_result_submissions submission ON submission.id=file.submission_id
      WHERE file.id=$1
        AND submission.status IN ('FINALIZED','INVALIDATED','SUPERSEDED')
        AND file.deleted_at IS NULL AND file.storage_delete_pending=FALSE
        ${submissionClause}`,
    values,
  );
  const row = result.rows[0];
  return row ? { ...row, byteSize: Number(row.byteSize) } : null;
}

export async function getAdminSubmissionFileRows(submissionId: string) {
  const result = await query<{
    id: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    byteSize: string;
    checksumSha256: string;
  }>(
    `SELECT file.id, file.storage_key AS "storageKey",
            file.original_filename AS "originalFilename",
            file.detected_mime_type AS "detectedMimeType", file.byte_size::text AS "byteSize",
            file.checksum_sha256 AS "checksumSha256"
       FROM student_result_files file
       JOIN student_result_submissions submission ON submission.id=file.submission_id
      WHERE submission.id=$1
        AND submission.status IN ('FINALIZED','INVALIDATED','SUPERSEDED')
        AND file.deleted_at IS NULL AND file.storage_delete_pending=FALSE
      ORDER BY file.uploaded_at, file.id`,
    [submissionId],
  );
  return result.rows.map((row) => ({ ...row, byteSize: Number(row.byteSize) }));
}

export async function getFinalizedSubmissionFileRows(submissionId: string) {
  const result = await query<{
    id: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    byteSize: string;
    checksumSha256: string;
  }>(
    `SELECT file.id, file.storage_key AS "storageKey",
            file.original_filename AS "originalFilename",
            file.detected_mime_type AS "detectedMimeType", file.byte_size::text AS "byteSize",
            file.checksum_sha256 AS "checksumSha256"
       FROM student_result_files file
       JOIN student_result_submissions submission ON submission.id=file.submission_id
      WHERE submission.id=$1 AND submission.status='FINALIZED'
        AND file.deleted_at IS NULL AND file.storage_delete_pending=FALSE
      ORDER BY file.uploaded_at, file.id`,
    [submissionId],
  );
  return result.rows.map((row) => ({ ...row, byteSize: Number(row.byteSize) }));
}

type AdminProfileListRow = {
  studentNumber: string;
  studentName: string;
  collegeName: string;
  programName: string;
  latestActivityAt: Date;
  laboratorySubmissionStatus: "FINALIZED" | "INVALIDATED" | null;
  laboratoryFileCount: number | null;
  physicalExamSubmissionStatus: "FINALIZED" | "INVALIDATED" | null;
  physicalExamFileCount: number | null;
};

export async function listAdminStudentResultProfileRows(input: {
  limit: number;
  offset: number;
}): Promise<{ items: AdminStudentResultListItem[]; total: number }> {
  const result = await query<AdminProfileListRow & { total: number }>(
    `WITH ${CURRENT_EFFECTIVE_APPOINTMENTS_CTE},
     submission_students AS (
       SELECT submission.student_number,
              MAX(GREATEST(
                COALESCE(submission.invalidated_at, '-infinity'::timestamptz),
                COALESCE(submission.finalized_at, '-infinity'::timestamptz),
                submission.last_activity_at
              )) AS latest_activity_at
         FROM student_result_submissions submission
        WHERE submission.status IN ('FINALIZED','INVALIDATED')
        GROUP BY submission.student_number
     ),
     profile_rows AS (
       SELECT student.student_number AS "studentNumber",
              ${studentDisplayNameSql("student")} AS "studentName",
              college.name AS "collegeName", program.name AS "programName",
              activity.latest_activity_at AS "latestActivityAt",
              laboratory_submission.status AS "laboratorySubmissionStatus",
              laboratory_submission.file_count AS "laboratoryFileCount",
              physical_submission.status AS "physicalExamSubmissionStatus",
              physical_submission.file_count AS "physicalExamFileCount"
         FROM submission_students activity
         JOIN students student ON student.student_number=activity.student_number
         JOIN colleges college ON college.id=student.college_id
         JOIN programs program ON program.id=student.program_id
         LEFT JOIN current_effective_appointments laboratory_appointment
           ON laboratory_appointment."studentNumber"=student.student_number
          AND laboratory_appointment."scheduleType"='LABORATORY'
         LEFT JOIN current_effective_appointments physical_appointment
           ON physical_appointment."studentNumber"=student.student_number
          AND physical_appointment."scheduleType"='PHYSICAL_EXAM'
         LEFT JOIN LATERAL (
           SELECT submission.id, submission.status,
                  COUNT(file.id) FILTER (
                    WHERE submission.status='INVALIDATED'
                       OR (file.deleted_at IS NULL AND file.storage_delete_pending=FALSE)
                  )::int AS file_count
             FROM student_result_submissions submission
             LEFT JOIN student_result_files file ON file.submission_id=submission.id
            WHERE submission.appointment_id=laboratory_appointment.id
              AND submission.status IN ('FINALIZED','INVALIDATED')
            GROUP BY submission.id
            ORDER BY GREATEST(
                       COALESCE(submission.invalidated_at, '-infinity'::timestamptz),
                       COALESCE(submission.finalized_at, '-infinity'::timestamptz),
                       submission.last_activity_at
                     ) DESC,
                     submission.created_at DESC,
                     submission.id DESC
            LIMIT 1
         ) laboratory_submission ON TRUE
         LEFT JOIN LATERAL (
           SELECT submission.id, submission.status,
                  COUNT(file.id) FILTER (
                    WHERE submission.status='INVALIDATED'
                       OR (file.deleted_at IS NULL AND file.storage_delete_pending=FALSE)
                  )::int AS file_count
             FROM student_result_submissions submission
             LEFT JOIN student_result_files file ON file.submission_id=submission.id
            WHERE submission.appointment_id=physical_appointment.id
              AND submission.status IN ('FINALIZED','INVALIDATED')
            GROUP BY submission.id
            ORDER BY GREATEST(
                       COALESCE(submission.invalidated_at, '-infinity'::timestamptz),
                       COALESCE(submission.finalized_at, '-infinity'::timestamptz),
                       submission.last_activity_at
                     ) DESC,
                     submission.created_at DESC,
                     submission.id DESC
            LIMIT 1
         ) physical_submission ON TRUE
     )
     SELECT profile_rows.*, COUNT(*) OVER()::int AS total
       FROM profile_rows
      ORDER BY "latestActivityAt" DESC, "studentName", "studentNumber"
      LIMIT $1 OFFSET $2`,
    [input.limit, input.offset],
  );

  let total = result.rows[0]?.total;
  if (total === undefined) {
    const count = await query<{ total: number }>(
      `WITH submission_students AS (
         SELECT student_number
           FROM student_result_submissions
          WHERE status IN ('FINALIZED','INVALIDATED')
          GROUP BY student_number
       )
       SELECT COUNT(*)::int AS total FROM submission_students`,
    );
    total = count.rows[0].total;
  }

  return {
    total,
    items: result.rows.map((row) => {
      const laboratoryState = currentSubmissionState(
        row.laboratorySubmissionStatus
          ? { status: row.laboratorySubmissionStatus }
          : null,
      );
      const physicalExamState = currentSubmissionState(
        row.physicalExamSubmissionStatus
          ? { status: row.physicalExamSubmissionStatus }
          : null,
      );
      return {
        studentNumber: row.studentNumber,
        studentName: row.studentName,
        collegeName: row.collegeName,
        programName: row.programName,
        progress: combinedSubmissionProgress(laboratoryState, physicalExamState),
        latestActivityAt: row.latestActivityAt,
        laboratory: {
          state: laboratoryState,
          fileCount: row.laboratoryFileCount ?? 0,
        },
        physicalExam: {
          state: physicalExamState,
          fileCount: row.physicalExamFileCount ?? 0,
        },
      };
    }),
  };
}

type AdminProfileDetailRow = {
  studentNumber: string;
  studentName: string;
  collegeName: string;
  programName: string;
  laboratoryAppointmentId: string | null;
  laboratoryAppointmentDate: string | null;
  laboratoryAppointmentStatus: Exclude<AttendanceStatus, "UNSCHEDULED"> | null;
  physicalExamAppointmentId: string | null;
  physicalExamAppointmentDate: string | null;
  physicalExamAppointmentStatus: Exclude<AttendanceStatus, "UNSCHEDULED"> | null;
  submissionId: string | null;
  submissionAppointmentId: string | null;
  submissionAppointmentDate: string | null;
  submissionResultType: ScheduleType | null;
  submissionStatus: "FINALIZED" | "INVALIDATED" | "SUPERSEDED" | null;
  submissionFinalizedAt: Date | null;
  submissionInvalidatedAt: Date | null;
  submissionInvalidationReason: string | null;
  submissionSupersededAt: Date | null;
  submissionSupersededBySubmissionId: string | null;
  submissionEditingInProgress: boolean;
  submissionLastActivityAt: Date | null;
  submissionCreatedAt: Date | null;
  fileId: string | null;
  fileOriginalFilename: string | null;
  fileDetectedMimeType: string | null;
  fileByteSize: string | null;
  fileDeletedAt: Date | null;
  fileStorageDeletePending: boolean | null;
};

function activityTime(submission: AdminResultSubmission) {
  return Math.max(
    submission.invalidatedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    submission.supersededAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    submission.finalizedAt.getTime(),
    submission.lastActivityAt.getTime(),
  );
}

export async function getAdminStudentResultProfileRow(
  studentNumber: string,
): Promise<AdminStudentResultProfile | null> {
  const result = await query<AdminProfileDetailRow>(
    `WITH ${CURRENT_EFFECTIVE_APPOINTMENTS_CTE}
     SELECT student.student_number AS "studentNumber",
            ${studentDisplayNameSql("student")} AS "studentName",
            college.name AS "collegeName", program.name AS "programName",
            laboratory_appointment.id AS "laboratoryAppointmentId",
            laboratory_appointment.appointment_date::text AS "laboratoryAppointmentDate",
            laboratory_appointment.status AS "laboratoryAppointmentStatus",
            physical_appointment.id AS "physicalExamAppointmentId",
            physical_appointment.appointment_date::text AS "physicalExamAppointmentDate",
            physical_appointment.status AS "physicalExamAppointmentStatus",
            submission.id AS "submissionId",
            submission.appointment_id AS "submissionAppointmentId",
            submission_appointment.appointment_date::text AS "submissionAppointmentDate",
            submission.result_type AS "submissionResultType",
            submission.status AS "submissionStatus",
            submission.finalized_at AS "submissionFinalizedAt",
            submission.invalidated_at AS "submissionInvalidatedAt",
            submission.invalidation_reason AS "submissionInvalidationReason",
            submission.superseded_at AS "submissionSupersededAt",
            submission.superseded_by_submission_id::text AS "submissionSupersededBySubmissionId",
            EXISTS (
              SELECT 1
                FROM student_result_submissions edit
               WHERE edit.appointment_id=submission.appointment_id
                 AND edit.student_number=submission.student_number
                 AND edit.result_type=submission.result_type
                 AND edit.status='DRAFT'
                 AND edit.discarded_at IS NULL
                 AND edit.based_on_submission_id=submission.id
            ) AS "submissionEditingInProgress",
            submission.last_activity_at AS "submissionLastActivityAt",
            submission.created_at AS "submissionCreatedAt",
            file.id AS "fileId", file.original_filename AS "fileOriginalFilename",
            file.detected_mime_type AS "fileDetectedMimeType",
            file.byte_size::text AS "fileByteSize", file.deleted_at AS "fileDeletedAt",
            file.storage_delete_pending AS "fileStorageDeletePending"
       FROM students student
       JOIN colleges college ON college.id=student.college_id
       JOIN programs program ON program.id=student.program_id
       LEFT JOIN current_effective_appointments laboratory_appointment
         ON laboratory_appointment."studentNumber"=student.student_number
        AND laboratory_appointment."scheduleType"='LABORATORY'
       LEFT JOIN current_effective_appointments physical_appointment
         ON physical_appointment."studentNumber"=student.student_number
        AND physical_appointment."scheduleType"='PHYSICAL_EXAM'
       LEFT JOIN student_result_submissions submission
         ON submission.student_number=student.student_number
        AND submission.status IN ('FINALIZED','INVALIDATED','SUPERSEDED')
       LEFT JOIN appointments submission_appointment
         ON submission_appointment.id=submission.appointment_id
       LEFT JOIN student_result_files file ON file.submission_id=submission.id
      WHERE student.student_number=$1
      ORDER BY GREATEST(
                 COALESCE(submission.invalidated_at, '-infinity'::timestamptz),
                 COALESCE(submission.superseded_at, '-infinity'::timestamptz),
                 COALESCE(submission.finalized_at, '-infinity'::timestamptz),
                 submission.last_activity_at
               ) DESC NULLS LAST,
               submission.created_at DESC NULLS LAST,
               submission.id DESC NULLS LAST,
               file.uploaded_at,
               file.id`,
    [studentNumber],
  );
  if (!result.rowCount) return null;

  const first = result.rows[0];
  const grouped = new Map<string, {
    submission: AdminResultSubmission;
    createdAt: Date;
    editingInProgress: boolean;
  }>();
  for (const row of result.rows) {
    if (
      !row.submissionId
      || !row.submissionAppointmentId
      || !row.submissionAppointmentDate
      || !row.submissionResultType
      || !row.submissionStatus
      || !row.submissionFinalizedAt
      || !row.submissionLastActivityAt
      || !row.submissionCreatedAt
    ) continue;

    let current = grouped.get(row.submissionId);
    if (!current) {
      current = {
        createdAt: row.submissionCreatedAt,
        editingInProgress: row.submissionEditingInProgress,
        submission: {
          id: row.submissionId,
          appointmentId: row.submissionAppointmentId,
          appointmentDate: row.submissionAppointmentDate,
          resultType: row.submissionResultType,
          status: row.submissionStatus,
          finalizedAt: row.submissionFinalizedAt,
          invalidatedAt: row.submissionInvalidatedAt,
          invalidationReason: row.submissionInvalidationReason,
          supersededAt: row.submissionSupersededAt,
          supersededBySubmissionId: row.submissionSupersededBySubmissionId,
          lastActivityAt: row.submissionLastActivityAt,
          fileCount: 0,
          totalBytes: 0,
          files: [],
        },
      };
      grouped.set(row.submissionId, current);
    }

    if (row.fileId && row.fileByteSize !== null) {
      const byteSize = Number(row.fileByteSize);
      const exposeFile = current.submission.status !== "INVALIDATED"
        && row.fileDeletedAt === null
        && row.fileStorageDeletePending === false;
      if (current.submission.status === "INVALIDATED" || exposeFile) {
        current.submission.fileCount += 1;
        current.submission.totalBytes += byteSize;
      }
      if (
        exposeFile
        && row.fileOriginalFilename
        && row.fileDetectedMimeType
      ) {
        current.submission.files.push({
          id: row.fileId,
          originalFilename: row.fileOriginalFilename,
          detectedMimeType: row.fileDetectedMimeType,
          byteSize,
        });
      }
    }
  }

  const submissionEntries = [...grouped.values()]
    .sort((left, right) => (
      activityTime(right.submission) - activityTime(left.submission)
      || right.createdAt.getTime() - left.createdAt.getTime()
      || right.submission.id.localeCompare(left.submission.id)
    ));
  const submissions = submissionEntries.map(({ submission }) => submission);
  const laboratoryAppointment = first.laboratoryAppointmentId
    && first.laboratoryAppointmentDate
    && first.laboratoryAppointmentStatus
    ? {
      id: first.laboratoryAppointmentId,
      appointmentDate: first.laboratoryAppointmentDate,
      status: first.laboratoryAppointmentStatus,
    }
    : null;
  const physicalExamAppointment = first.physicalExamAppointmentId
    && first.physicalExamAppointmentDate
    && first.physicalExamAppointmentStatus
    ? {
      id: first.physicalExamAppointmentId,
      appointmentDate: first.physicalExamAppointmentDate,
      status: first.physicalExamAppointmentStatus,
    }
    : null;
  const currentSubmission = (appointmentId: string | undefined) => (
    appointmentId
      ? submissionEntries.find(({ submission }) => (
        submission.appointmentId === appointmentId
        && submission.status === "FINALIZED"
      )) ?? null
      : null
  );
  const currentInvalidatedSubmission = (appointmentId: string | undefined) => (
    appointmentId
      ? submissions.find((submission) => (
        submission.appointmentId === appointmentId
        && submission.status === "INVALIDATED"
      )) ?? null
      : null
  );
  const laboratoryCurrent = currentSubmission(laboratoryAppointment?.id);
  const physicalExamCurrent = currentSubmission(physicalExamAppointment?.id);
  const laboratorySubmission = laboratoryCurrent?.submission ?? null;
  const physicalExamSubmission = physicalExamCurrent?.submission ?? null;
  const laboratoryState = currentSubmissionState(
    laboratorySubmission ?? currentInvalidatedSubmission(laboratoryAppointment?.id),
  );
  const physicalExamState = currentSubmissionState(
    physicalExamSubmission ?? currentInvalidatedSubmission(physicalExamAppointment?.id),
  );
  const currentIds = new Set(
    [laboratorySubmission?.id, physicalExamSubmission?.id].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const history = submissions
    .filter((submission) => !currentIds.has(submission.id));

  return {
    studentNumber: first.studentNumber,
    studentName: first.studentName,
    collegeName: first.collegeName,
    programName: first.programName,
    progress: combinedSubmissionProgress(laboratoryState, physicalExamState),
    latestActivityAt: submissions[0]
      ? new Date(activityTime(submissions[0]))
      : null,
    laboratory: {
      resultType: "LABORATORY",
      appointment: laboratoryAppointment,
      state: laboratoryState,
      submission: laboratorySubmission,
      editingInProgress: laboratoryCurrent?.editingInProgress ?? false,
    },
    physicalExam: {
      resultType: "PHYSICAL_EXAM",
      appointment: physicalExamAppointment,
      state: physicalExamState,
      submission: physicalExamSubmission,
      editingInProgress: physicalExamCurrent?.editingInProgress ?? false,
    },
    history,
  };
}

export async function getStudentNumberForSubmission(submissionId: string) {
  const result = await query<{ studentNumber: string }>(
    `SELECT student_number AS "studentNumber"
       FROM student_result_submissions
      WHERE id=$1`,
    [submissionId],
  );
  return result.rows[0]?.studentNumber ?? null;
}

export async function listAdminStudentResultSubmissionRows() {
  const result = await query<{
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: string;
    status: string;
    finalizedAt: Date | null;
    fileCount: number;
    totalBytes: string;
  }>(
    `SELECT submission.id, submission.appointment_id AS "appointmentId",
            submission.student_number AS "studentNumber", submission.result_type AS "resultType",
            submission.status, submission.finalized_at AS "finalizedAt",
            COUNT(file.id)::int AS "fileCount", COALESCE(SUM(file.byte_size),0)::text AS "totalBytes"
       FROM student_result_submissions submission
       LEFT JOIN student_result_files file ON file.submission_id=submission.id AND file.deleted_at IS NULL
      WHERE submission.status IN ('FINALIZED','INVALIDATED')
      GROUP BY submission.id
      ORDER BY submission.finalized_at DESC, submission.id DESC`,
  );
  return result.rows.map((row) => ({ ...row, totalBytes: Number(row.totalBytes) }));
}

export async function getAdminStudentResultSubmissionRow(submissionId: string) {
  const result = await query<{
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: string;
    status: string;
    finalizedAt: Date | null;
    invalidatedAt: Date | null;
    invalidationReason: string | null;
  }>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType", status, finalized_at AS "finalizedAt",
            invalidated_at AS "invalidatedAt", invalidation_reason AS "invalidationReason"
       FROM student_result_submissions WHERE id=$1`,
    [submissionId],
  );
  if (!result.rowCount) return null;
  const files = result.rows[0].status === "FINALIZED"
    ? await getFinalizedSubmissionFileRows(submissionId)
    : [];
  return {
    ...result.rows[0],
    files: files.map((file) => ({
      id: file.id,
      originalFilename: file.originalFilename,
      detectedMimeType: file.detectedMimeType,
      byteSize: file.byteSize,
    })),
  };
}

export async function lockFinalizedSubmissionForInvalidation(client: PoolClient, submissionId: string) {
  const submission = await client.query<{
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: "LABORATORY" | "PHYSICAL_EXAM";
  }>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType"
       FROM student_result_submissions
      WHERE id=$1 AND status='FINALIZED'
      FOR UPDATE`,
    [submissionId],
  );
  if (!submission.rowCount) return null;
  const files = await client.query<{ id: string; storageKey: string }>(
    `SELECT id, storage_key AS "storageKey"
       FROM student_result_files WHERE submission_id=$1 AND deleted_at IS NULL FOR UPDATE`,
    [submissionId],
  );
  return { ...submission.rows[0], files: files.rows };
}

export async function lockCurrentFinalizedSubmissionForInvalidation(
  client: PoolClient,
  submissionId: string,
) {
  const identity = await client.query<{
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: "LABORATORY" | "PHYSICAL_EXAM";
  }>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType"
       FROM student_result_submissions
      WHERE id=$1`,
    [submissionId],
  );
  if (!identity.rowCount) return { type: "not_found" as const };
  await lockEffectiveAppointmentScopes(client, [{
    studentNumber: identity.rows[0].studentNumber,
    scheduleType: identity.rows[0].resultType,
  }]);
  const appointment = await client.query<{ id: string }>(
    `SELECT id
       FROM appointments
      WHERE id=$1 AND student_number=$2 AND schedule_type=$3
      FOR UPDATE`,
    [
      identity.rows[0].appointmentId,
      identity.rows[0].studentNumber,
      identity.rows[0].resultType,
    ],
  );
  if (!appointment.rowCount) return { type: "conflict" as const };

  const submission = await client.query<{
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: "LABORATORY" | "PHYSICAL_EXAM";
    status: "DRAFT" | "FINALIZED" | "INVALIDATED";
    isCurrent: boolean;
  }>(
    `WITH ${CURRENT_EFFECTIVE_APPOINTMENTS_CTE}
     SELECT submission.id,
            submission.appointment_id AS "appointmentId",
            submission.student_number AS "studentNumber",
            submission.result_type AS "resultType",
            submission.status,
            EXISTS (
              SELECT 1
                FROM current_effective_appointments current_appointment
               WHERE current_appointment.id=submission.appointment_id
                 AND current_appointment."studentNumber"=submission.student_number
                 AND current_appointment."scheduleType"=submission.result_type
            ) AS "isCurrent"
       FROM student_result_submissions submission
      WHERE submission.id=$1
      FOR UPDATE OF submission`,
    [submissionId],
  );
  const locked = submission.rows[0];
  if (
    !locked
    || locked.appointmentId !== identity.rows[0].appointmentId
    || locked.studentNumber !== identity.rows[0].studentNumber
    || locked.resultType !== identity.rows[0].resultType
    || locked.status !== "FINALIZED"
    || !locked.isCurrent
  ) {
    return { type: "conflict" as const };
  }
  const activeDraft = await client.query<DraftRow>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType", status,
            based_on_submission_id::text AS "basedOnSubmissionId",
            last_activity_at AS "lastActivityAt"
       FROM student_result_submissions
      WHERE appointment_id=$1 AND student_number=$2
        AND status='DRAFT' AND discarded_at IS NULL
      FOR UPDATE`,
    [locked.appointmentId, locked.studentNumber],
  );
  const activeDraftFiles = activeDraft.rowCount
    ? await listResultFilesForCleanupForUpdate(client, activeDraft.rows[0].id)
    : [];
  const files = await client.query<{ id: string; storageKey: string }>(
    `SELECT id, storage_key AS "storageKey"
       FROM student_result_files
      WHERE submission_id=$1 AND deleted_at IS NULL
      FOR UPDATE`,
    [submissionId],
  );
  return {
    type: "ready" as const,
    submission: {
      id: locked.id,
      appointmentId: locked.appointmentId,
      studentNumber: locked.studentNumber,
      resultType: locked.resultType,
      files: files.rows,
    },
    editDraft: activeDraft.rows[0]?.basedOnSubmissionId === locked.id
      ? { ...activeDraft.rows[0], files: activeDraftFiles }
      : null,
  };
}

export async function invalidateFinalizedSubmissionMetadata(
  client: PoolClient,
  submission: { id: string; appointmentId: string; resultType: string },
  actorUserId: string,
  reason: string,
) {
  await client.query(
    `UPDATE student_result_submissions
        SET status='INVALIDATED', invalidated_at=NOW(), invalidated_by=$2,
            invalidation_reason=$3
      WHERE id=$1 AND status='FINALIZED'`,
    [submission.id, actorUserId, reason],
  );
  await client.query(
    `UPDATE student_result_files SET storage_delete_pending=TRUE
      WHERE submission_id=$1 AND deleted_at IS NULL`,
    [submission.id],
  );
  const resultTable = submission.resultType === "LABORATORY" ? "laboratory_results" : "exam_results";
  await client.query(
    `UPDATE ${resultTable}
        SET result_status='PENDING_UPLOAD', completed_at=NULL, encoded_by=NULL
      WHERE appointment_id=$1`,
    [submission.appointmentId],
  );
}

export async function recordResultFileDeletion(
  fileId: string,
  outcome: { success: true } | { success: false; error: string },
) {
  if (outcome.success) {
    await query(
      `UPDATE student_result_files
          SET deleted_at=NOW(), storage_delete_pending=FALSE, delete_error=NULL
        WHERE id=$1`,
      [fileId],
    );
  } else {
    await query(
      `UPDATE student_result_files
          SET storage_delete_pending=TRUE, delete_error=$2
        WHERE id=$1`,
      [fileId, outcome.error.slice(0, 2000)],
    );
  }
}
