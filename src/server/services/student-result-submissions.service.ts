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
  deleteRetiredStudentResultDraftIfClean,
  finalizeStudentResultDraft,
  getAccessibleStudentResultFileRow,
  getAdminStudentResultProfileRow,
  getAdminStudentResultSubmissionRow,
  getFinalizedSubmissionFileRows,
  getStudentNumberForSubmission,
  getStudentResultSubmissionRow,
  invalidateFinalizedSubmissionMetadata,
  insertStudentResultFiles,
  listAdminStudentResultProfileRows,
  listAdminStudentResultSubmissionRows,
  listDraftFilesForUpdate,
  listResultFilesForCleanupForUpdate,
  lockCurrentFinalizedSubmissionForInvalidation,
  lockExpectedStudentResultDraft,
  lockOrCreateStudentResultDraft,
  lockOrCreateStudentResultEditDraft,
  markStudentResultFileForDeletion,
  promoteStudentResultEditDraft,
  recordResultFileDeletion,
  retireStudentResultDraft,
} from "@/server/repositories/student-result-submissions.repository";
import {
  claimStudentResultStorageCleanupIntentForEagerDeletion,
  completeStudentResultStorageCleanupIntent,
  createStudentResultStorageCleanupIntents,
  deleteUnclaimedStudentResultStorageCleanupIntent,
  disarmStudentResultStorageCleanupIntents,
  failStudentResultStorageCleanupIntent,
  lockStudentResultStorageCleanupIntentsForWrite,
  RESULT_STORAGE_CLEANUP_INTENT_DELAY_MS,
} from "@/server/repositories/student-result-storage-cleanup-intents.repository";
import { localResultStorage } from "@/server/storage/local-result-storage";
import type { ResultStorage } from "@/server/storage/result-storage";
import { createStudentNotification } from "@/server/services/student-notifications.service";
import { writeAudit } from "@/server/repositories/audit.repository";
import type { SessionUser } from "@/types/roles";

type Upload = { filename: string; declaredMimeType: string; bytes: Buffer };
type CopiedResultFile = {
  submissionId: string;
  storageKey: string;
  originalFilename: string;
  detectedMimeType: string;
  extension: string;
  byteSize: number;
  checksumSha256: string;
};
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

function expectedDraftError(type: "not_found" | "unavailable" | "stale") {
  if (type === "not_found" || type === "unavailable") return draftError(type);
  return new AppError(
    "RESULT_EDIT_STALE",
    "This result draft changed. Refresh and try again.",
    409,
  );
}

function beginEditError(type: "not_found" | "unavailable" | "no_official" | "conflict") {
  if (type === "not_found" || type === "unavailable") return draftError(type);
  if (type === "no_official") {
    return new AppError(
      "RESULT_EDIT_NOT_AVAILABLE",
      "Only a finalized result submission can be edited.",
      409,
    );
  }
  return expectedDraftError("stale");
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

export async function beginStudentResultEdit(
  studentNumber: string,
  appointmentId: string,
  storage: ResultStorage = localResultStorage,
) {
  const candidateDraftId = randomUUID();
  const armedStorageKeys = Array.from(
    { length: RESULT_SUBMISSION_MAX_FILES },
    () => `${candidateDraftId}/${randomUUID()}.copy`,
  );
  const attemptedStorageKeys = new Set<string>();
  try {
    await createStudentResultStorageCleanupIntents(
      armedStorageKeys,
      new Date(Date.now() + RESULT_STORAGE_CLEANUP_INTENT_DELAY_MS),
    );
    return await transaction(async (client) => {
      const outcome = await lockOrCreateStudentResultEditDraft(
        client,
        studentNumber,
        appointmentId,
        candidateDraftId,
      );
      if (outcome.type !== "edit") throw beginEditError(outcome.type);
      await lockStudentResultStorageCleanupIntentsForWrite(client, armedStorageKeys);
      if (outcome.created) {
        const copiedFiles: CopiedResultFile[] = [];
        for (const officialFile of outcome.officialFiles) {
          let bytes: Buffer;
          try {
            bytes = await storage.read(officialFile.storageKey);
          } catch {
            throw new AppError(
              "RESULT_FILE_INTEGRITY_ERROR",
              "A submitted result file failed its integrity check.",
              500,
            );
          }
          const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
          if (checksumSha256 !== officialFile.checksumSha256) {
            throw new AppError(
              "RESULT_FILE_INTEGRITY_ERROR",
              "A submitted result file failed its integrity check.",
              500,
            );
          }
          const storageKey = armedStorageKeys[copiedFiles.length];
          const copiedFile = {
            submissionId: outcome.draft.id,
            storageKey,
            originalFilename: officialFile.originalFilename,
            detectedMimeType: officialFile.detectedMimeType,
            extension: officialFile.extension,
            byteSize: officialFile.byteSize,
            checksumSha256: officialFile.checksumSha256,
          };
          attemptedStorageKeys.add(storageKey);
          await storage.write(storageKey, bytes);
          copiedFiles.push(copiedFile);
        }
        if (copiedFiles.length) await insertStudentResultFiles(client, copiedFiles);
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
           VALUES (NULL,'STUDENT_RESULT_EDIT_STARTED','student_result_submission',$1,
                   jsonb_build_object(
                     'appointmentId',$2::text,
                     'basedOnSubmissionId',$3::text,
                     'resultType',$4::text,
                     'fileCount',$5::int,
                     'totalBytes',$6::bigint
                   ))`,
          [
            outcome.draft.id,
            outcome.draft.appointmentId,
            outcome.official.id,
            outcome.draft.resultType,
            copiedFiles.length,
            copiedFiles.reduce((sum, file) => sum + file.byteSize, 0),
          ],
        );
      }
      const refreshed = await getStudentResultSubmissionRow(studentNumber, appointmentId, client);
      if (!refreshed || refreshed.id !== outcome.draft.id) {
        throw new Error("Result edit draft disappeared during creation.");
      }
      await disarmStudentResultStorageCleanupIntents(client, armedStorageKeys);
      return refreshed;
    });
  } catch (error) {
    for (const storageKey of armedStorageKeys) {
      if (!attemptedStorageKeys.has(storageKey)) {
        await deleteUnclaimedStudentResultStorageCleanupIntent(storageKey)
          .catch(() => undefined);
        continue;
      }
      const claim = await claimStudentResultStorageCleanupIntentForEagerDeletion(storageKey)
        .catch(() => null);
      if (!claim) continue;
      try {
        await storage.delete(storageKey);
        await completeStudentResultStorageCleanupIntent(storageKey, claim.claimToken);
      } catch (cleanupError) {
        await failStudentResultStorageCleanupIntent(
          storageKey,
          claim.claimToken,
          cleanupError instanceof Error
            ? cleanupError.message
            : "Unknown rollback deletion error",
          new Date(),
        ).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function cleanupRetiredStudentResultDraft(
  submissionId: string,
  files: Array<{ id: string; storageKey: string }>,
  storage: ResultStorage,
) {
  for (const file of files) {
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
  await deleteRetiredStudentResultDraftIfClean(submissionId);
}

export async function cancelStudentResultEdit(
  studentNumber: string,
  appointmentId: string,
  submissionId: string,
  storage: ResultStorage = localResultStorage,
) {
  const retired = await transaction(async (client) => {
    const outcome = await lockExpectedStudentResultDraft(
      client,
      studentNumber,
      appointmentId,
      submissionId,
    );
    if (outcome.type !== "draft") throw expectedDraftError(outcome.type);
    if (
      !outcome.currentOfficial
      || outcome.draft.basedOnSubmissionId !== outcome.currentOfficial.id
    ) {
      throw expectedDraftError("stale");
    }
    const files = await listResultFilesForCleanupForUpdate(client, outcome.draft.id);
    if (!await retireStudentResultDraft(client, outcome.draft.id)) {
      throw expectedDraftError("stale");
    }
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES (NULL,'STUDENT_RESULT_EDIT_CANCELLED','student_result_submission',$1,
               jsonb_build_object(
                 'appointmentId',$2::text,
                 'basedOnSubmissionId',$3::text,
                 'resultType',$4::text,
                 'fileCount',$5::int,
                 'totalBytes',$6::bigint
               ))`,
      [
        outcome.draft.id,
        outcome.draft.appointmentId,
        outcome.draft.basedOnSubmissionId,
        outcome.draft.resultType,
        files.length,
        files.reduce((sum, file) => sum + file.byteSize, 0),
      ],
    );
    return { id: outcome.draft.id, files };
  });
  await cleanupRetiredStudentResultDraft(retired.id, retired.files, storage);
  return { success: true };
}

export async function addStudentResultFiles(
  studentNumber: string,
  appointmentId: string,
  submissionId: string,
  uploads: Upload[],
  storage: ResultStorage = localResultStorage,
) {
  if (!uploads.length) {
    throw new AppError("RESULT_FILES_REQUIRED", "Select at least one result file to upload.", 400);
  }
  const generatedStorageKeys: string[] = [];
  try {
    return await transaction(async (client) => {
      const outcome = await lockExpectedStudentResultDraft(
        client,
        studentNumber,
        appointmentId,
        submissionId,
      );
      if (outcome.type !== "draft") throw expectedDraftError(outcome.type);
      const existingFiles = await listDraftFilesForUpdate(client, outcome.draft.id);
      const validatedUploads = uploads.map((upload) => ({
        upload,
        validated: validateResultFile(upload),
      }));
      if (existingFiles.length + validatedUploads.length > RESULT_SUBMISSION_MAX_FILES) {
        throw new AppError("RESULT_FILE_COUNT_LIMIT", "A result submission may contain at most 10 files.", 422);
      }
      const currentBytes = existingFiles.reduce((sum, file) => sum + file.byteSize, 0);
      const uploadedBytes = validatedUploads.reduce(
        (sum, input) => sum + input.validated.byteSize,
        0,
      );
      if (currentBytes + uploadedBytes > RESULT_SUBMISSION_MAX_BYTES) {
        throw new AppError("RESULT_TOTAL_SIZE_LIMIT", "A result submission may contain at most 50 MB.", 422);
      }
      const pendingFiles = validatedUploads.map(({ upload, validated }) => ({
        submissionId: outcome.draft.id,
        storageKey: `${outcome.draft.id}/${randomUUID()}.${validated.extension}`,
        originalFilename: upload.filename,
        bytes: upload.bytes,
        ...validated,
      }));
      generatedStorageKeys.push(...pendingFiles.map((file) => file.storageKey));
      for (const pending of pendingFiles) {
        await storage.write(pending.storageKey, pending.bytes);
      }
      await insertStudentResultFiles(client, pendingFiles);
      const refreshed = await getStudentResultSubmissionRow(studentNumber, appointmentId, client);
      if (!refreshed || refreshed.id !== submissionId) {
        throw new Error("Result draft disappeared during batch upload.");
      }
      return refreshed;
    });
  } catch (error) {
    await Promise.allSettled(generatedStorageKeys.map((storageKey) => storage.delete(storageKey)));
    throw error;
  }
}

export async function removeStudentResultFile(
  studentNumber: string,
  appointmentId: string,
  submissionId: string,
  fileId: string,
  storage: ResultStorage = localResultStorage,
) {
  const file = await transaction(async (client) => {
    const outcome = await lockExpectedStudentResultDraft(
      client,
      studentNumber,
      appointmentId,
      submissionId,
    );
    if (outcome.type !== "draft") throw expectedDraftError(outcome.type);
    const files = await listDraftFilesForUpdate(client, outcome.draft.id);
    const file = files.find((candidate) => candidate.id === fileId);
    if (!file) throw new AppError("RESULT_FILE_NOT_FOUND", "Result file not found.", 404);
    await markStudentResultFileForDeletion(client, file.id, submissionId);
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
  submissionId: string,
  storage: ResultStorage = localResultStorage,
) {
  await transaction(async (client) => {
    const outcome = await lockExpectedStudentResultDraft(
      client,
      studentNumber,
      appointmentId,
      submissionId,
    );
    if (outcome.type !== "draft") throw expectedDraftError(outcome.type);
    const draft = outcome.draft;
    if (draft.basedOnSubmissionId) throw expectedDraftError("stale");
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

export async function submitStudentResultChanges(
  studentNumber: string,
  appointmentId: string,
  submissionId: string,
  storage: ResultStorage = localResultStorage,
) {
  return transaction(async (client) => {
    const outcome = await lockExpectedStudentResultDraft(
      client,
      studentNumber,
      appointmentId,
      submissionId,
    );
    if (outcome.type !== "draft") throw expectedDraftError(outcome.type);
    if (
      !outcome.currentOfficial
      || outcome.draft.basedOnSubmissionId !== outcome.currentOfficial.id
    ) {
      throw expectedDraftError("stale");
    }
    const files = await listDraftFilesForUpdate(client, outcome.draft.id);
    if (!files.length) {
      throw new AppError(
        "RESULT_FILES_REQUIRED",
        "Add at least one file before submitting changes.",
        422,
      );
    }
    const totalBytes = files.reduce((sum, file) => sum + file.byteSize, 0);
    if (files.length > RESULT_SUBMISSION_MAX_FILES || totalBytes > RESULT_SUBMISSION_MAX_BYTES) {
      throw new AppError(
        "RESULT_DRAFT_LIMIT_INVALID",
        "This draft exceeds the result upload limits.",
        422,
      );
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
          throw new Error("Stored edit file metadata changed.");
        }
      } catch {
        throw new AppError(
          "RESULT_FILE_INTEGRITY_ERROR",
          "A stored edit file failed validation. Remove it and upload the file again.",
          500,
        );
      }
    }
    await promoteStudentResultEditDraft(
      client,
      outcome.draft,
      outcome.currentOfficial.id,
      files.length,
      totalBytes,
    );
    const refreshed = await getStudentResultSubmissionRow(studentNumber, appointmentId, client);
    if (!refreshed || refreshed.id !== outcome.draft.id || refreshed.status !== "FINALIZED") {
      throw new Error("Promoted result submission disappeared before commit.");
    }
    return refreshed;
  });
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
    const { submission, editDraft } = lock;
    if (editDraft && !await retireStudentResultDraft(client, editDraft.id)) {
      throw new AppError(
        "RESULT_SUBMISSION_CONFLICT",
        "This result submission changed while it was being invalidated. Refresh the student profile and try again.",
        409,
      );
    }
    if (editDraft) {
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1,'STUDENT_RESULT_EDIT_CANCELLED_BY_INVALIDATION','student_result_submission',$2,
                 jsonb_build_object(
                   'appointmentId',$3::text,
                   'basedOnSubmissionId',$4::text,
                   'resultType',$5::text,
                   'fileCount',$6::int,
                   'totalBytes',$7::bigint
                 ))`,
        [
          actor.userId,
          editDraft.id,
          editDraft.appointmentId,
          editDraft.basedOnSubmissionId,
          editDraft.resultType,
          editDraft.files.length,
          editDraft.files.reduce((sum, file) => sum + file.byteSize, 0),
        ],
      );
    }
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
                jsonb_build_object('appointmentId',$3::text,'fileCount',$4::int))`,
      [actor.userId, submissionId, submission.appointmentId, submission.files.length],
    );
    return { submission, editDraft };
  });
  for (const file of invalidated.submission.files) {
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
  if (invalidated.editDraft) {
    await cleanupRetiredStudentResultDraft(
      invalidated.editDraft.id,
      invalidated.editDraft.files,
      storage,
    );
  }
  return {
    id: submissionId,
    status: "INVALIDATED" as const,
    studentNumber: invalidated.submission.studentNumber,
  };
}
