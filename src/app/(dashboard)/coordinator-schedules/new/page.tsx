import { ScheduleBatchForm } from "@/components/schedules/ScheduleBatchForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { listColleges, listPriorityGroups, listPrograms } from "@/server/repositories/reference-data.repository";

export default async function NewScheduleBatchPage() {
  const [colleges, programs, priorities] = await Promise.all([listColleges(), listPrograms(), listPriorityGroups()]);
  return <><PageHeader title="New coordinator schedule" description="Encode the exact dates or target weeks supplied by an academic coordinator." /><ScheduleBatchForm colleges={colleges} programs={programs} priorities={priorities} /></>;
}
