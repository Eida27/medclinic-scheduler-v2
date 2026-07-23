import Link from "next/link";
import { RESULT_SUBMISSION_PAGE_SIZE } from "./student-result-submission-pagination";

type StudentResultSubmissionPaginationProps = {
  page: number;
  total: number;
};

function pageHref(page: number) {
  return `/settings/student-result-submissions?page=${page}`;
}

export function StudentResultSubmissionPagination({
  page,
  total,
}: StudentResultSubmissionPaginationProps) {
  if (total === 0) return null;
  const totalPages = Math.max(1, Math.ceil(total / RESULT_SUBMISSION_PAGE_SIZE));

  return (
    <nav
      aria-label="Student result submission pagination"
      className="flex items-center justify-between border-t border-line px-5 py-4 text-sm"
    >
      {page > 1 ? (
        <Link
          aria-label="Previous page"
          href={pageHref(page - 1)}
          className="font-bold text-cpu-navy hover:underline"
        >
          Previous
        </Link>
      ) : <span />}
      <span className="text-muted">Page {page} of {totalPages}</span>
      {page < totalPages ? (
        <Link
          aria-label="Next page"
          href={pageHref(page + 1)}
          className="font-bold text-cpu-navy hover:underline"
        >
          Next
        </Link>
      ) : <span />}
    </nav>
  );
}
