import "server-only";
import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import {
  RESULT_SUBMISSION_MAX_BYTES,
  RESULT_SUBMISSION_MAX_FILES,
  validateResultFile,
} from "@/server/files/result-file-validation";
import { transaction } from "@/server/db/pool";
import {
  deleteStudentResultFileRow,
  getStudentResultSubmissionRow,
  insertStudentResultFile,
  listDraftFilesForUpdate,
  lockOrCreateStudentResultDraft,
  lockOwnedDraftFile,
} from "@/server/repositories/student-result-submissions.repository";
import { localResultStorage } from "@/server/storage/local-result-storage";
import type { ResultStorage } from "@/server/storage/result-storage";

type Upload = { filename: string; declaredMimeType: string; bytes: Buffer };

function draftError(type: "not_found" | "unavailable") {
  if (type === "not_found") {
    return new AppError("RESULT_APPOINTMENT_NOT_FOUND", "Result appointment not found.", 404);
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
  return transaction(async (client) => {
    const file = await lockOwnedDraftFile(client, studentNumber, appointmentId, fileId);
    if (!file) throw new AppError("RESULT_FILE_NOT_FOUND", "Result file not found.", 404);
    await storage.delete(file.storageKey);
    await deleteStudentResultFileRow(client, file.id, file.submissionId);
    return { success: true };
  });
}
