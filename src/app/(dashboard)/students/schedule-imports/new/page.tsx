import { ScheduleImportForm } from "@/components/schedules/ScheduleImportForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { listPriorityGroups } from "@/server/repositories/reference-data.repository";

export default async function NewScheduleImportPage() {
  await requireUser(["ADMIN"]);
  const priorities = await listPriorityGroups();

  return (
    <>
      <PageHeader
        title="Import schedule CSV"
        description="Upload the master student file and create one grouped clinic schedule import."
      />
      <ScheduleImportForm priorities={priorities} />
    </>
  );
}
