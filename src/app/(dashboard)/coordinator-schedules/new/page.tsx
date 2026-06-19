import { ScheduleBatchForm } from "@/components/schedules/ScheduleBatchForm";
import { ScheduleCsvImportForm } from "@/components/schedules/ScheduleCsvImportForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { listColleges, listPriorityGroups, listPrograms } from "@/server/repositories/reference-data.repository";

export default async function NewScheduleBatchPage() {
  const [colleges, programs, priorities] = await Promise.all([listColleges(), listPrograms(), listPriorityGroups()]);
  return <><PageHeader title="New coordinator schedule" description="Import the official coordinator CSV or manually encode exact dates and target weeks." /><div className="grid gap-6"><ScheduleCsvImportForm priorities={priorities} /><ScheduleBatchForm colleges={colleges} programs={programs} priorities={priorities} /></div></>;
}
