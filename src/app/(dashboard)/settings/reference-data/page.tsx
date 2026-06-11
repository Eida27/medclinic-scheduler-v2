import { ReferenceDataManager } from "@/components/settings/ReferenceDataManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { listColleges, listPriorityGroups, listPrograms } from "@/server/repositories/reference-data.repository";

export default async function ReferenceDataPage() {
  const [colleges, programs, priorities] = await Promise.all([listColleges(), listPrograms(), listPriorityGroups()]);
  return <><PageHeader title="Reference data" description="Manage colleges, programs, and coordinator priority groups." /><ReferenceDataManager colleges={colleges} programs={programs} priorities={priorities} /></>;
}
