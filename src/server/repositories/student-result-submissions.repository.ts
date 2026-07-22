import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";
import { AppError } from "@/lib/errors";

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
  status: "DRAFT" | "FINALIZED" | "INVALIDATED";
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
  lastActivityAt: Date;
};

export async function getAppointmentResultCorrectionState(
  client: PoolClient,
  appointment: { id: string; scheduleType: string },
): Promise<AppointmentResultCorrectionState> {
  const table = appointment.scheduleType === "LABORATORY"
    ? "laboratory_results" as const
    : "exam_results" as const;
  const result = await client.query<{ id: string; resultStatus: string }>(
    table === "laboratory_results"
      ? `SELECT id, result_status AS "resultStatus"
           FROM laboratory_results
          WHERE appointment_id=$1
          FOR UPDATE`
      : `SELECT id, result_status AS "resultStatus"
           FROM exam_results
          WHERE appointment_id=$1
          FOR UPDATE`,
    [appointment.id],
  );
  const submissions = await client.query<{ id: string; status: string }>(
    `SELECT id, status
       FROM student_result_submissions
      WHERE appointment_id=$1
      FOR UPDATE`,
    [appointment.id],
  );
  const files = await client.query<{ activeFileCount: number }>(
    `SELECT COUNT(file.id)::int AS "activeFileCount"
       FROM student_result_submissions submission
       JOIN student_result_files file ON file.submission_id=submission.id
      WHERE submission.appointment_id=$1 AND file.deleted_at IS NULL`,
    [appointment.id],
  );

  if (submissions.rows.some((submission) => submission.status === "FINALIZED")) {
    return { type: "PROTECTED", reason: "FINALIZED_SUBMISSION" };
  }
  if (files.rows[0].activeFileCount > 0) {
    return { type: "PROTECTED", reason: "UPLOADED_FILES" };
  }
  if (result.rows[0] && result.rows[0].resultStatus !== "PENDING_UPLOAD") {
    return { type: "PROTECTED", reason: "VERIFIED_RESULT" };
  }
  if (result.rows[0]) {
    return { type: "PENDING_PLACEHOLDER", resultId: result.rows[0].id, table };
  }
  return { type: "CLEAR" };
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
  const appointment = await client.query<{
    id: string;
    status: string;
    scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  }>(
    `SELECT id, status, schedule_type AS "scheduleType"
       FROM appointments
      WHERE id=$1 AND student_number=$2 AND is_published=TRUE
      FOR UPDATE`,
    [appointmentId, studentNumber],
  );
  if (!appointment.rowCount) return { type: "not_found" as const };
  if (appointment.rows[0].status !== "COMPLETED") return { type: "unavailable" as const };
  const finalized = await client.query(
    `SELECT id FROM student_result_submissions
      WHERE appointment_id=$1 AND status='FINALIZED' FOR UPDATE`,
    [appointmentId],
  );
  if (finalized.rowCount) return { type: "finalized" as const };
  const resultTable = appointment.rows[0].scheduleType === "LABORATORY"
    ? "laboratory_results"
    : "exam_results";
  const resultStatus = await client.query<{ resultStatus: string }>(
    `SELECT result_status AS "resultStatus" FROM ${resultTable} WHERE appointment_id=$1`,
    [appointmentId],
  );
  if (resultStatus.rowCount && resultStatus.rows[0].resultStatus !== "PENDING_UPLOAD") {
    return { type: "unavailable" as const };
  }
  const existing = await client.query<DraftRow>(
    `SELECT id, appointment_id AS "appointmentId", student_number AS "studentNumber",
            result_type AS "resultType", status, last_activity_at AS "lastActivityAt"
       FROM student_result_submissions
      WHERE appointment_id=$1 AND status='DRAFT'
      FOR UPDATE`,
    [appointmentId],
  );
  if (existing.rowCount) return { type: "draft" as const, draft: existing.rows[0] };
  const inserted = await client.query<DraftRow>(
    `INSERT INTO student_result_submissions (
       appointment_id, student_number, result_type
     ) VALUES ($1,$2,$3)
     RETURNING id, appointment_id AS "appointmentId", student_number AS "studentNumber",
               result_type AS "resultType", status, last_activity_at AS "lastActivityAt"`,
    [appointmentId, studentNumber, appointment.rows[0].scheduleType],
  );
  return { type: "draft" as const, draft: inserted.rows[0] };
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

export async function insertStudentResultFile(
  client: PoolClient,
  input: {
    submissionId: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    extension: string;
    byteSize: number;
    checksumSha256: string;
  },
) {
  const result = await client.query<{
    id: string;
    submissionId: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    extension: string;
    byteSize: string;
    checksumSha256: string;
    uploadedAt: Date;
  }>(
    `INSERT INTO student_result_files (
       submission_id, storage_key, original_filename, detected_mime_type,
       extension, byte_size, checksum_sha256
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, submission_id AS "submissionId", storage_key AS "storageKey",
               original_filename AS "originalFilename", detected_mime_type AS "detectedMimeType",
               extension, byte_size::text AS "byteSize", checksum_sha256 AS "checksumSha256",
               uploaded_at AS "uploadedAt"`,
    [
      input.submissionId,
      input.storageKey,
      input.originalFilename,
      input.detectedMimeType,
      input.extension,
      input.byteSize,
      input.checksumSha256,
    ],
  );
  await client.query(
    "UPDATE student_result_submissions SET last_activity_at=NOW() WHERE id=$1",
    [input.submissionId],
  );
  return { ...result.rows[0], byteSize: Number(result.rows[0].byteSize) };
}

export async function getStudentResultSubmissionRow(studentNumber: string, appointmentId: string) {
  const submission = await query<{
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: "LABORATORY" | "PHYSICAL_EXAM";
    status: "DRAFT" | "FINALIZED" | "INVALIDATED";
    lastActivityAt: Date;
  }>(
    `SELECT submission.id, submission.appointment_id AS "appointmentId",
            submission.student_number AS "studentNumber", submission.result_type AS "resultType",
            submission.status, submission.last_activity_at AS "lastActivityAt"
       FROM student_result_submissions submission
      WHERE submission.appointment_id=$1 AND submission.student_number=$2
        AND submission.status IN ('DRAFT','FINALIZED')
      ORDER BY CASE WHEN submission.status='DRAFT' THEN 0 ELSE 1 END, submission.created_at DESC
      LIMIT 1`,
    [appointmentId, studentNumber],
  );
  if (!submission.rowCount) return null;
  const files = await query<{
    id: string;
    submissionId: string;
    storageKey: string;
    originalFilename: string;
    detectedMimeType: string;
    extension: string;
    byteSize: string;
    checksumSha256: string;
    uploadedAt: Date;
  }>(
    `SELECT id, submission_id AS "submissionId", storage_key AS "storageKey",
            original_filename AS "originalFilename", detected_mime_type AS "detectedMimeType",
            extension, byte_size::text AS "byteSize", checksum_sha256 AS "checksumSha256",
            uploaded_at AS "uploadedAt"
       FROM student_result_files
      WHERE submission_id=$1 AND deleted_at IS NULL AND storage_delete_pending=FALSE
      ORDER BY uploaded_at, id`,
    [submission.rows[0].id],
  );
  const mappedFiles = files.rows.map((file) => ({ ...file, byteSize: Number(file.byteSize) }));
  return {
    ...submission.rows[0],
    files: mappedFiles,
    fileCount: mappedFiles.length,
    totalBytes: mappedFiles.reduce((sum, file) => sum + file.byteSize, 0),
  } satisfies StudentResultSubmission;
}

export async function lockOwnedDraftFile(
  client: PoolClient,
  studentNumber: string,
  appointmentId: string,
  fileId: string,
) {
  const result = await client.query<{ id: string; submissionId: string; storageKey: string }>(
    `SELECT file.id, file.submission_id AS "submissionId", file.storage_key AS "storageKey"
       FROM student_result_files file
       JOIN student_result_submissions submission ON submission.id=file.submission_id
      WHERE file.id=$1 AND submission.appointment_id=$2
        AND submission.student_number=$3 AND submission.status='DRAFT'
        AND file.deleted_at IS NULL AND file.storage_delete_pending=FALSE
      FOR UPDATE OF submission, file`,
    [fileId, appointmentId, studentNumber],
  );
  return result.rows[0] ?? null;
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

export async function lockOwnedDraftForFinalization(
  client: PoolClient,
  studentNumber: string,
  appointmentId: string,
) {
  const result = await client.query<{
    id: string;
    appointmentId: string;
    studentNumber: string;
    resultType: "LABORATORY" | "PHYSICAL_EXAM";
  }>(
    `SELECT submission.id, submission.appointment_id AS "appointmentId",
            submission.student_number AS "studentNumber", submission.result_type AS "resultType"
       FROM student_result_submissions submission
       JOIN appointments appointment ON appointment.id=submission.appointment_id
      WHERE submission.appointment_id=$1 AND submission.student_number=$2
        AND submission.status='DRAFT' AND appointment.status='COMPLETED'
        AND appointment.is_published=TRUE
      FOR UPDATE OF submission, appointment`,
    [appointmentId, studentNumber],
  );
  return result.rows[0] ?? null;
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

export async function getAccessibleStudentResultFileRow(
  fileId: string,
  studentNumber?: string,
  submissionId?: string,
) {
  const values: unknown[] = [fileId];
  const ownerClause = studentNumber ? `AND submission.student_number=$${values.push(studentNumber)}` : "";
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
      WHERE file.id=$1 AND submission.status='FINALIZED'
        AND file.deleted_at IS NULL AND file.storage_delete_pending=FALSE
        ${ownerClause} ${submissionClause}`,
    values,
  );
  const row = result.rows[0];
  return row ? { ...row, byteSize: Number(row.byteSize) } : null;
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
