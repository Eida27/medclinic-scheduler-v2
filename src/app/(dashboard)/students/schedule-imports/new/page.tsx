import { ScheduleImportForm } from "@/components/schedules/ScheduleImportForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { listPriorityGroups } from "@/server/repositories/reference-data.repository";

export default async function NewScheduleImportPage() {
  await requireUser(["ADMIN", "COORDINATOR"]);
  const priorities = await listPriorityGroups();

  return (
    <>
      <PageHeader
        title="Import schedule CSV"
        description="Choose the master student file and priority, then approve one confirmation to import and publish."
      />
      <ScheduleImportForm priorities={priorities} />
    </>
  );
}
