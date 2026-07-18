import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";

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
      WHERE submission_id=$1 AND deleted_at IS NULL
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
        AND file.deleted_at IS NULL
      FOR UPDATE OF submission, file`,
    [fileId, appointmentId, studentNumber],
  );
  return result.rows[0] ?? null;
}

export async function deleteStudentResultFileRow(
  client: PoolClient,
  fileId: string,
  submissionId: string,
) {
  await client.query("DELETE FROM student_result_files WHERE id=$1", [fileId]);
  await client.query(
    "UPDATE student_result_submissions SET last_activity_at=NOW() WHERE id=$1",
    [submissionId],
  );
}
