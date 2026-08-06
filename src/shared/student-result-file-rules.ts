export const RESULT_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const RESULT_SUBMISSION_MAX_BYTES = 50 * 1024 * 1024;
export const RESULT_SUBMISSION_MAX_FILES = 10;

export const RESULT_FILE_ALLOWED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png"] as const;
export const RESULT_FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

export function isAllowedResultFileName(name: string): boolean {
  const extensionStart = name.lastIndexOf(".");
  if (extensionStart <= 0) return false;
  const extension = name.slice(extensionStart + 1).toLowerCase();
  return RESULT_FILE_ALLOWED_EXTENSIONS.includes(
    extension as (typeof RESULT_FILE_ALLOWED_EXTENSIONS)[number],
  );
}
