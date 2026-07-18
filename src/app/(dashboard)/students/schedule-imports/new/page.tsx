import { ScheduleImportForm } from "@/components/schedules/ScheduleImportForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";

export default async function NewScheduleImportPage() {
  await requireUser(["ADMIN", "COORDINATOR"]);
  return (
    <>
      <PageHeader
        title="Import schedule CSV"
        description="Choose the academic year and student category, then publish paired date-only schedules atomically."
      />
      <ScheduleImportForm />
    </>
  );
}
