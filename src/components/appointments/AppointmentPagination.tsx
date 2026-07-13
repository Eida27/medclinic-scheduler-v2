import Link from "next/link";
import { APPOINTMENT_PAGE_SIZE } from "@/components/appointments/appointment-pagination";

type AppointmentPaginationFilters = {
  studentNumber?: string;
  appointmentDate?: string;
  scheduleType?: string;
  status?: string;
};

type AppointmentPaginationProps = {
  basePath: string;
  page: number;
  total: number;
  filters: AppointmentPaginationFilters;
};

const filterNames = ["studentNumber", "appointmentDate", "scheduleType", "status"] as const;

function pageHref(basePath: string, filters: AppointmentPaginationFilters, page: number) {
  const query = new URLSearchParams();
  for (const name of filterNames) {
    if (filters[name]) query.set(name, filters[name]);
  }
  query.set("page", String(page));
  return `${basePath}?${query.toString()}`;
}

export function AppointmentPagination({
  basePath,
  page,
  total,
  filters,
}: AppointmentPaginationProps) {
  if (total === 0) return null;
  const totalPages = Math.max(1, Math.ceil(total / APPOINTMENT_PAGE_SIZE));

  return (
    <nav
      aria-label="Appointment pagination"
      className="flex items-center justify-between border-t border-line px-5 py-4 text-sm"
    >
      {page > 1 ? (
        <Link
          aria-label="Previous page"
          href={pageHref(basePath, filters, page - 1)}
          className="font-bold text-cpu-navy hover:underline"
        >
          Previous
        </Link>
      ) : <span />}
      <span className="text-muted">Page {page} of {totalPages}</span>
      {page < totalPages ? (
        <Link
          aria-label="Next page"
          href={pageHref(basePath, filters, page + 1)}
          className="font-bold text-cpu-navy hover:underline"
        >
          Next
        </Link>
      ) : <span />}
    </nav>
  );
}
