import "server-only";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { AppError } from "@/lib/errors";

export const RESULT_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const RESULT_SUBMISSION_MAX_BYTES = 50 * 1024 * 1024;
export const RESULT_SUBMISSION_MAX_FILES = 10;

const allowedByExtension = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
} as const;

function detectedMimeType(bytes: Buffer) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

export function validateResultFile(input: {
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
}) {
  if (!input.bytes.byteLength) {
    throw new AppError("RESULT_FILE_EMPTY", "The selected file is empty.", 422);
  }
  if (input.bytes.byteLength > RESULT_FILE_MAX_BYTES) {
    throw new AppError("RESULT_FILE_TOO_LARGE", "Each result file must be 20 MB or smaller.", 422);
  }
  const extension = extname(input.filename).slice(1).toLowerCase();
  const expectedMime = allowedByExtension[extension as keyof typeof allowedByExtension];
  if (!expectedMime) {
    throw new AppError("RESULT_FILE_TYPE_NOT_ALLOWED", "Upload a PDF, JPG, JPEG, or PNG file.", 422);
  }
  const detected = detectedMimeType(input.bytes);
  if (!detected || detected !== expectedMime || input.declaredMimeType.toLowerCase() !== expectedMime) {
    throw new AppError(
      "RESULT_FILE_TYPE_MISMATCH",
      "The file extension, declared MIME type, and file signature do not match.",
      422,
    );
  }
  if (!input.filename.trim() || input.filename.length > 255) {
    throw new AppError("RESULT_FILENAME_INVALID", "The file name is invalid.", 422);
  }
  return {
    extension,
    detectedMimeType: detected,
    byteSize: input.bytes.byteLength,
    checksumSha256: createHash("sha256").update(input.bytes).digest("hex"),
  };
}
