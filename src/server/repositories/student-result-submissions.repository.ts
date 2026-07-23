import "server-only";
import type { PoolClient } from "pg";
import { query } from "@/server/db/pool";
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
  const submissions = await client.query<{ id: string; status: string }>(
    `SELECT id, status
       FROM student_result_submissions
      WHERE appointment_id=$1
      FOR UPDATE`,
    [appointment.id],
  );
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
  submissionStatus: "FINALIZED" | "INVALIDATED" | null;
  submissionFinalizedAt: Date | null;
  submissionInvalidatedAt: Date | null;
  submissionInvalidationReason: string | null;
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
        AND submission.status IN ('FINALIZED','INVALIDATED')
       LEFT JOIN appointments submission_appointment
         ON submission_appointment.id=submission.appointment_id
       LEFT JOIN student_result_files file ON file.submission_id=submission.id
      WHERE student.student_number=$1
      ORDER BY GREATEST(
                 COALESCE(submission.invalidated_at, '-infinity'::timestamptz),
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
        submission: {
          id: row.submissionId,
          appointmentId: row.submissionAppointmentId,
          appointmentDate: row.submissionAppointmentDate,
          resultType: row.submissionResultType,
          status: row.submissionStatus,
          finalizedAt: row.submissionFinalizedAt,
          invalidatedAt: row.submissionInvalidatedAt,
          invalidationReason: row.submissionInvalidationReason,
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
      const exposeFile = current.submission.status === "FINALIZED"
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

  const submissions = [...grouped.values()]
    .sort((left, right) => (
      activityTime(right.submission) - activityTime(left.submission)
      || right.createdAt.getTime() - left.createdAt.getTime()
      || right.submission.id.localeCompare(left.submission.id)
    ))
    .map(({ submission }) => submission);
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
      ? submissions
        .filter((submission) => submission.appointmentId === appointmentId)
        .sort((left, right) => activityTime(right) - activityTime(left))[0] ?? null
      : null
  );
  const laboratorySubmission = currentSubmission(laboratoryAppointment?.id);
  const physicalExamSubmission = currentSubmission(physicalExamAppointment?.id);
  const laboratoryState = currentSubmissionState(laboratorySubmission);
  const physicalExamState = currentSubmissionState(physicalExamSubmission);
  const currentIds = new Set(
    [laboratorySubmission?.id, physicalExamSubmission?.id].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const history = submissions
    .filter((submission) => !currentIds.has(submission.id))
    .sort((left, right) => activityTime(right) - activityTime(left));

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
    },
    physicalExam: {
      resultType: "PHYSICAL_EXAM",
      appointment: physicalExamAppointment,
      state: physicalExamState,
      submission: physicalExamSubmission,
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
  if (!submission.rowCount) return { type: "not_found" as const };
  const locked = submission.rows[0];
  if (locked.status !== "FINALIZED" || !locked.isCurrent) {
    return { type: "conflict" as const };
  }
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
