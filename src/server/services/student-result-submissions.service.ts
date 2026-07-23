import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import {
  RESULT_SUBMISSION_MAX_BYTES,
  RESULT_SUBMISSION_MAX_FILES,
  validateResultFile,
} from "@/server/files/result-file-validation";
import { transaction } from "@/server/db/pool";
import {
  finalizeStudentResultDraft,
  getAccessibleStudentResultFileRow,
  getAdminStudentResultProfileRow,
  getAdminStudentResultSubmissionRow,
  getFinalizedSubmissionFileRows,
  getStudentNumberForSubmission,
  getStudentResultSubmissionRow,
  invalidateFinalizedSubmissionMetadata,
  insertStudentResultFile,
  listAdminStudentResultProfileRows,
  listAdminStudentResultSubmissionRows,
  listDraftFilesForUpdate,
  lockCurrentFinalizedSubmissionForInvalidation,
  lockOrCreateStudentResultDraft,
  lockOwnedDraftForFinalization,
  lockOwnedDraftFile,
  markStudentResultFileForDeletion,
  recordResultFileDeletion,
} from "@/server/repositories/student-result-submissions.repository";
import { localResultStorage } from "@/server/storage/local-result-storage";
import type { ResultStorage } from "@/server/storage/result-storage";
import { createStudentNotification } from "@/server/services/student-notifications.service";
import { writeAudit } from "@/server/repositories/audit.repository";
import type { SessionUser } from "@/types/roles";

type Upload = { filename: string; declaredMimeType: string; bytes: Buffer };

function draftError(type: "not_found" | "unavailable" | "finalized") {
  if (type === "not_found") {
    return new AppError("RESULT_APPOINTMENT_NOT_FOUND", "Result appointment not found.", 404);
  }
  if (type === "finalized") {
    return new AppError("RESULT_SUBMISSION_FINALIZED", "This result submission is already finalized.", 409);
  }
  return new AppError(
    "RESULT_UPLOAD_NOT_AVAILABLE",
    "Result upload becomes available after clinic staff completes this appointment.",
    409,
  );
}

export async function getStudentResultSubmission(studentNumber: string, appointmentId: string) {
  const existing = await getStudentResultSubmissionRow(studentNumber, appointmentId);
  if (existing) return existing;
  const outcome = await transaction((client) => (
    lockOrCreateStudentResultDraft(client, studentNumber, appointmentId)
  ));
  if (outcome.type !== "draft") throw draftError(outcome.type);
  return (await getStudentResultSubmissionRow(studentNumber, appointmentId))!;
}

export async function addStudentResultFile(
  studentNumber: string,
  appointmentId: string,
  upload: Upload,
  storage: ResultStorage = localResultStorage,
) {
  const validated = validateResultFile(upload);
  let storageKey: string | null = null;
  try {
    return await transaction(async (client) => {
      const outcome = await lockOrCreateStudentResultDraft(client, studentNumber, appointmentId);
      if (outcome.type !== "draft") throw draftError(outcome.type);
      const existingFiles = await listDraftFilesForUpdate(client, outcome.draft.id);
      if (existingFiles.length >= RESULT_SUBMISSION_MAX_FILES) {
        throw new AppError("RESULT_FILE_COUNT_LIMIT", "A result submission may contain at most 10 files.", 422);
      }
      const currentBytes = existingFiles.reduce((sum, file) => sum + file.byteSize, 0);
      if (currentBytes + validated.byteSize > RESULT_SUBMISSION_MAX_BYTES) {
        throw new AppError("RESULT_TOTAL_SIZE_LIMIT", "A result submission may contain at most 50 MB.", 422);
      }
      storageKey = `${outcome.draft.id}/${randomUUID()}.${validated.extension}`;
      const inserted = await insertStudentResultFile(client, {
        submissionId: outcome.draft.id,
        storageKey,
        originalFilename: upload.filename,
        ...validated,
      });
      await storage.write(storageKey, upload.bytes);
      return inserted;
    });
  } catch (error) {
    if (storageKey) await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function removeStudentResultFile(
  studentNumber: string,
  appointmentId: string,
  fileId: string,
  storage: ResultStorage = localResultStorage,
) {
  const file = await transaction(async (client) => {
    const file = await lockOwnedDraftFile(client, studentNumber, appointmentId, fileId);
    if (!file) throw new AppError("RESULT_FILE_NOT_FOUND", "Result file not found.", 404);
    await markStudentResultFileForDeletion(client, file.id, file.submissionId);
    return file;
  });
  try {
    await storage.delete(file.storageKey);
    await recordResultFileDeletion(file.id, { success: true });
  } catch (error) {
    await recordResultFileDeletion(file.id, {
      success: false,
      error: error instanceof Error ? error.message : "Unknown file deletion error",
    });
  }
  return { success: true };
}

export async function finalizeStudentResultSubmission(
  studentNumber: string,
  appointmentId: string,
  storage: ResultStorage = localResultStorage,
) {
  await transaction(async (client) => {
    const draft = await lockOwnedDraftForFinalization(client, studentNumber, appointmentId);
    if (!draft) {
      const existing = await getStudentResultSubmissionRow(studentNumber, appointmentId);
      if (existing?.status === "FINALIZED") {
        throw new AppError("RESULT_SUBMISSION_FINALIZED", "This result submission is already finalized.", 409);
      }
      throw new AppError("RESULT_DRAFT_NOT_FOUND", "Result draft not found.", 404);
    }
    const files = await listDraftFilesForUpdate(client, draft.id);
    if (!files.length) throw new AppError("RESULT_FILES_REQUIRED", "Add at least one file before final submission.", 422);
    const totalBytes = files.reduce((sum, file) => sum + file.byteSize, 0);
    if (files.length > RESULT_SUBMISSION_MAX_FILES || totalBytes > RESULT_SUBMISSION_MAX_BYTES) {
      throw new AppError("RESULT_DRAFT_LIMIT_INVALID", "This draft exceeds the result upload limits.", 422);
    }
    for (const file of files) {
      try {
        const bytes = await storage.read(file.storageKey);
        const validated = validateResultFile({
          filename: file.originalFilename,
          declaredMimeType: file.detectedMimeType,
          bytes,
        });
        if (
          validated.detectedMimeType !== file.detectedMimeType
          || validated.extension !== file.extension
          || validated.byteSize !== file.byteSize
          || validated.checksumSha256 !== file.checksumSha256
        ) {
          throw new Error("Stored file metadata changed after upload.");
        }
      } catch {
        throw new AppError(
          "RESULT_FILE_INTEGRITY_ERROR",
          "A stored result file failed validation. Remove it and upload the file again.",
          500,
        );
      }
    }
    await finalizeStudentResultDraft(client, draft, files.length, totalBytes);
  });
  return (await getStudentResultSubmissionRow(studentNumber, appointmentId))!;
}

async function readVerifiedResultFile(
  metadata: Awaited<ReturnType<typeof getAccessibleStudentResultFileRow>>,
  storage: ResultStorage,
) {
  if (!metadata) throw new AppError("RESULT_FILE_NOT_FOUND", "Result file not found.", 404);
  const bytes = await storage.read(metadata.storageKey);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== metadata.checksumSha256) {
    throw new AppError("RESULT_FILE_INTEGRITY_ERROR", "The stored result file failed its integrity check.", 500);
  }
  return { filename: metadata.originalFilename, mimeType: metadata.detectedMimeType, bytes };
}

export async function getStudentResultFile(
  studentNumber: string,
  fileId: string,
  storage: ResultStorage = localResultStorage,
) {
  return readVerifiedResultFile(
    await getAccessibleStudentResultFileRow(fileId, studentNumber),
    storage,
  );
}

function assertAdmin(actor: SessionUser) {
  if (actor.role !== "ADMIN") {
    throw new AppError("FORBIDDEN", "Only administrators can access student result documents.", 403);
  }
}

export async function listAdminStudentResultProfiles(
  actor: SessionUser,
  input: { page: number; limit: number; offset: number },
) {
  assertAdmin(actor);
  return listAdminStudentResultProfileRows({ limit: input.limit, offset: input.offset });
}

export async function getAdminStudentResultProfile(
  studentNumber: string,
  actor: SessionUser,
) {
  assertAdmin(actor);
  return getAdminStudentResultProfileRow(studentNumber);
}

export async function getAdminSubmissionStudentNumber(
  submissionId: string,
  actor: SessionUser,
) {
  assertAdmin(actor);
  return getStudentNumberForSubmission(submissionId);
}

export async function getAdminStudentResultFile(
  fileId: string,
  actor: SessionUser,
  storage: ResultStorage = localResultStorage,
) {
  assertAdmin(actor);
  const file = await readVerifiedResultFile(await getAccessibleStudentResultFileRow(fileId), storage);
  await writeAudit(actor.userId, "ADMIN_RESULT_FILE_DOWNLOADED", "student_result_file", fileId);
  return file;
}

export async function getAdminSubmissionResultFile(
  submissionId: string,
  fileId: string,
  actor: SessionUser,
  storage: ResultStorage = localResultStorage,
) {
  assertAdmin(actor);
  const file = await readVerifiedResultFile(
    await getAccessibleStudentResultFileRow(fileId, undefined, submissionId),
    storage,
  );
  await writeAudit(actor.userId, "ADMIN_RESULT_FILE_DOWNLOADED", "student_result_file", fileId, {
    submissionId,
  });
  return file;
}

export async function listAdminStudentResultSubmissions(actor: SessionUser) {
  assertAdmin(actor);
  return listAdminStudentResultSubmissionRows();
}

export async function getAdminStudentResultSubmission(submissionId: string, actor: SessionUser) {
  assertAdmin(actor);
  const submission = await getAdminStudentResultSubmissionRow(submissionId);
  if (!submission) throw new AppError("RESULT_SUBMISSION_NOT_FOUND", "Result submission not found.", 404);
  return submission;
}

export async function createAdminSubmissionZip(
  submissionId: string,
  actor: SessionUser,
  storage: ResultStorage = localResultStorage,
) {
  assertAdmin(actor);
  const files = await getFinalizedSubmissionFileRows(submissionId);
  if (!files.length) throw new AppError("RESULT_SUBMISSION_NOT_FOUND", "Finalized result submission not found.", 404);
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.on("end", () => resolve(Buffer.concat(chunks)));
    output.on("error", reject);
  });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (error) => output.destroy(error));
  archive.pipe(output);
  for (const [index, file] of files.entries()) {
    const bytes = await storage.read(file.storageKey);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (checksum !== file.checksumSha256) {
      archive.abort();
      throw new AppError("RESULT_FILE_INTEGRITY_ERROR", "A stored result file failed its integrity check.", 500);
    }
    const safeName = basename(file.originalFilename).replace(/[^a-zA-Z0-9._-]/g, "_");
    archive.append(bytes, { name: `${String(index + 1).padStart(2, "0")}-${safeName}` });
  }
  await archive.finalize();
  const zip = await completed;
  await writeAudit(actor.userId, "ADMIN_RESULT_ZIP_DOWNLOADED", "student_result_submission", submissionId, {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.byteSize, 0),
  });
  return zip;
}

export async function createAdminSubmissionZipStream(
  submissionId: string,
  actor: SessionUser,
  storage: ResultStorage = localResultStorage,
) {
  assertAdmin(actor);
  const files = await getFinalizedSubmissionFileRows(submissionId);
  if (!files.length) {
    throw new AppError("RESULT_SUBMISSION_NOT_FOUND", "Finalized result submission not found.", 404);
  }
  const output = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (error) => output.destroy(error));
  archive.pipe(output);
  void (async () => {
    try {
      for (const [index, file] of files.entries()) {
        const bytes = await storage.read(file.storageKey);
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum !== file.checksumSha256) {
          throw new AppError(
            "RESULT_FILE_INTEGRITY_ERROR",
            "A stored result file failed its integrity check.",
            500,
          );
        }
        const safeName = basename(file.originalFilename).replace(/[^a-zA-Z0-9._-]/g, "_");
        archive.append(bytes, { name: `${String(index + 1).padStart(2, "0")}-${safeName}` });
      }
      await archive.finalize();
      await writeAudit(
        actor.userId,
        "ADMIN_RESULT_ZIP_DOWNLOADED",
        "student_result_submission",
        submissionId,
        {
          fileCount: files.length,
          totalBytes: files.reduce((sum, file) => sum + file.byteSize, 0),
        },
      );
    } catch (error) {
      archive.abort();
      output.destroy(error instanceof Error ? error : new Error("Result ZIP streaming failed."));
    }
  })();
  return output;
}

const invalidationReasonSchema = z.string().trim().min(3).max(1000);

export async function invalidateStudentResultSubmission(
  submissionId: string,
  rawReason: string,
  actor: SessionUser,
  storage: ResultStorage = localResultStorage,
) {
  assertAdmin(actor);
  const reason = invalidationReasonSchema.parse(rawReason);
  const invalidated = await transaction(async (client) => {
    const lock = await lockCurrentFinalizedSubmissionForInvalidation(client, submissionId);
    if (lock.type === "not_found") {
      throw new AppError("RESULT_SUBMISSION_NOT_FOUND", "Finalized result submission not found.", 404);
    }
    if (lock.type === "conflict") {
      throw new AppError(
        "RESULT_SUBMISSION_CONFLICT",
        "This result submission is stale and can no longer be invalidated. Refresh the student profile and try again.",
        409,
      );
    }
    const { submission } = lock;
    await invalidateFinalizedSubmissionMetadata(client, submission, actor.userId, reason);
    await createStudentNotification(client, {
      studentNumber: submission.studentNumber,
      notificationType: "RESULT_INVALIDATED",
      title: "Result submission needs replacement",
      message: "An administrator invalidated your result submission. Review the reason and upload replacement files.",
      metadata: { submissionId, appointmentId: submission.appointmentId, reason },
    });
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1,'STUDENT_RESULT_SUBMISSION_INVALIDATED','student_result_submission',$2,
               jsonb_build_object('appointmentId',$3::text,'reason',$4::text,'fileCount',$5::int))`,
      [actor.userId, submissionId, submission.appointmentId, reason, submission.files.length],
    );
    return submission;
  });
  for (const file of invalidated.files) {
    try {
      await storage.delete(file.storageKey);
      await recordResultFileDeletion(file.id, { success: true });
    } catch (error) {
      await recordResultFileDeletion(file.id, {
        success: false,
        error: error instanceof Error ? error.message : "Unknown file deletion error",
      });
    }
  }
  return {
    id: submissionId,
    status: "INVALIDATED" as const,
    studentNumber: invalidated.studentNumber,
  };
}
