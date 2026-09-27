import { ScheduleImportForm } from "@/components/schedules/ScheduleImportForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { manilaCalendarDate } from "@/lib/academic-year";
import { requireUser } from "@/server/auth/current-user";
import { listImportAcademicYears } from "@/server/services/academic-years.service";

export default async function NewScheduleImportPage() {
  const user = await requireUser(["ADMIN", "COORDINATOR"]);
  const now = new Date();
  let academicYears: Awaited<ReturnType<typeof listImportAcademicYears>> = [];
  let catalogUnavailable = false;
  try { academicYears = await listImportAcademicYears(now); }
  catch { catalogUnavailable = true; }
  return (
    <>
      <PageHeader
        title="Import schedule CSV"
        description="Choose the academic year and student category, then publish paired date-only schedules atomically."
      />
      <ScheduleImportForm initialAcademicYears={academicYears} initialManilaToday={manilaCalendarDate(now)}
        role={user.role as "ADMIN" | "COORDINATOR"} initialCatalogUnavailable={catalogUnavailable} />
    </>
  );
}
