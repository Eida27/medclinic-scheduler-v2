export const RESULT_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const RESULT_SUBMISSION_MAX_BYTES = 50 * 1024 * 1024;
export const RESULT_SUBMISSION_MAX_FILES = 10;

export const RESULT_FILE_ALLOWED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png"] as const;
export const RESULT_FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

const RESULT_FILE_MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
} as const;

export function isAllowedResultFileName(name: string): boolean {
  const extensionStart = name.lastIndexOf(".");
  if (extensionStart <= 0) return false;
  const extension = name.slice(extensionStart + 1).toLowerCase();
  return RESULT_FILE_ALLOWED_EXTENSIONS.includes(
    extension as (typeof RESULT_FILE_ALLOWED_EXTENSIONS)[number],
  );
}

export function getAllowedResultFileMimeType(name: string): string | null {
  if (!isAllowedResultFileName(name)) return null;
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return RESULT_FILE_MIME_BY_EXTENSION[
    extension as keyof typeof RESULT_FILE_MIME_BY_EXTENSION
  ] ?? null;
}

export function hasMatchingResultFileMimeType(name: string, mimeType: string): boolean {
  const allowedMimeType = getAllowedResultFileMimeType(name);
  return allowedMimeType !== null && mimeType.trim().toLowerCase() === allowedMimeType;
}
