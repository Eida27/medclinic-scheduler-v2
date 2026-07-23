export const RESULT_SUBMISSION_PAGE_SIZE = 50;

export function parseStudentResultSubmissionPage(value?: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : 1;
}
