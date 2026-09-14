import { AppError } from "@/lib/errors";
import { dataResponse, errorResponse } from "@/lib/api-response";
import { requireVerifiedStudent } from "@/server/auth/current-student";
import { addStudentResultFiles } from "@/server/services/student-result-submissions.service";
import { toStudentResultDraftView } from "@/server/student-results/student-result-draft-view";
import {
  RESULT_FILE_MAX_BYTES,
  RESULT_SUBMISSION_MAX_BYTES,
  RESULT_SUBMISSION_MAX_FILES,
  hasMatchingResultFileMimeType,
} from "@/shared/student-result-file-rules";
import { z } from "zod";

type Context = { params: Promise<{ appointmentId: string }> };

const submissionIdSchema = z.string().uuid();
const RESULT_MULTIPART_MAX_BYTES = 51 * 1024 * 1024;

function requestTooLarge() {
  return new AppError(
    "RESULT_UPLOAD_REQUEST_TOO_LARGE",
    "The result upload request may contain at most 51 MB.",
    413,
  );
}

async function boundedFormData(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESULT_MULTIPART_MAX_BYTES) {
    throw requestTooLarge();
  }
  if (!request.body) return request.formData();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > RESULT_MULTIPART_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw requestTooLarge();
    }
    chunks.push(value);
  }

  return new Response(Buffer.concat(chunks, totalBytes), {
    headers: request.headers,
  }).formData();
}

function validateFileMetadata(files: File[]) {
  if (files.length > RESULT_SUBMISSION_MAX_FILES) {
    throw new AppError(
      "RESULT_FILE_COUNT_LIMIT",
      "A result submission may contain at most 10 files.",
      422,
    );
  }
  let aggregateBytes = 0;
  for (const file of files) {
    if (file.size > RESULT_FILE_MAX_BYTES) {
      throw new AppError(
        "RESULT_FILE_TOO_LARGE",
        "Each result file must be 20 MB or smaller.",
        422,
      );
    }
    if (!hasMatchingResultFileMimeType(file.name, file.type)) {
      throw new AppError(
        "RESULT_FILE_TYPE_NOT_ALLOWED",
        "Upload a PDF, JPG, JPEG, or PNG file.",
        422,
      );
    }
    aggregateBytes += file.size;
  }
  if (aggregateBytes > RESULT_SUBMISSION_MAX_BYTES) {
    throw new AppError(
      "RESULT_TOTAL_SIZE_LIMIT",
      "A result submission may contain at most 50 MB.",
      422,
    );
  }
}

function parseSubmissionId(value: FormDataEntryValue | null) {
  const parsed = submissionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "RESULT_SUBMISSION_ID_INVALID",
      "A valid result submission ID is required.",
      400,
    );
  }
  return parsed.data;
}

export async function POST(request: Request, context: Context) {
  try {
    const student = await requireVerifiedStudent();
    const form = await boundedFormData(request);
    const submissionId = parseSubmissionId(form.get("submissionId"));
    const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
    if (!files.length) {
      throw new AppError("RESULT_FILES_REQUIRED", "Select at least one result file to upload.", 400);
    }
    validateFileMetadata(files);
    const uploads: Array<{
      filename: string;
      declaredMimeType: string;
      bytes: Buffer;
    }> = [];
    for (const file of files) {
      uploads.push({
        filename: file.name,
        declaredMimeType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
    }
    const submission = await addStudentResultFiles(
      student.studentNumber,
      (await context.params).appointmentId,
      submissionId,
      uploads,
    );
    return dataResponse(toStudentResultDraftView(submission));
  } catch (error) {
    return errorResponse(error);
  }
}
