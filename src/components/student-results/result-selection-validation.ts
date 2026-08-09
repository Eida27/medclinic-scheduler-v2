import {
  RESULT_FILE_MAX_BYTES,
  RESULT_SUBMISSION_MAX_BYTES,
  RESULT_SUBMISSION_MAX_FILES,
  isAllowedResultFileName,
} from "@/shared/student-result-file-rules";

export type ResultFileSelectionRow = {
  file: File;
  filename: string;
  byteSize: number;
  valid: boolean;
  error: string | null;
};

export type ResultFileSelectionValidation = {
  rows: ResultFileSelectionRow[];
  canUpload: boolean;
  batchError: string | null;
};

export function validateResultFileSelection(
  files: Iterable<File>,
  current: { currentFileCount: number; currentTotalBytes: number },
): ResultFileSelectionValidation {
  const rows = Array.from(files, (file): ResultFileSelectionRow => {
    const errors: string[] = [];
    if (!isAllowedResultFileName(file.name)) {
      errors.push("Upload a PDF, JPG, JPEG, or PNG file.");
    }
    if (file.size > RESULT_FILE_MAX_BYTES) {
      errors.push("Each result file must be 20 MB or smaller.");
    }
    return {
      file,
      filename: file.name,
      byteSize: file.size,
      valid: errors.length === 0,
      error: errors.length > 0 ? errors.join(" ") : null,
    };
  });

  const resultingFileCount = current.currentFileCount + rows.length;
  const resultingTotalBytes = current.currentTotalBytes
    + rows.reduce((total, row) => total + row.byteSize, 0);
  const batchErrors: string[] = [];
  if (resultingFileCount > RESULT_SUBMISSION_MAX_FILES) {
    batchErrors.push("A result submission may contain at most 10 files.");
  }
  if (resultingTotalBytes > RESULT_SUBMISSION_MAX_BYTES) {
    batchErrors.push("A result submission may contain at most 50 MB.");
  }
  const batchError = batchErrors.length > 0 ? batchErrors.join(" ") : null;

  return {
    rows,
    canUpload: rows.length > 0 && rows.every((row) => row.valid) && batchError === null,
    batchError,
  };
}
