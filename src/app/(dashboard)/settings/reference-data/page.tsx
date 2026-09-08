import { connection } from "next/server";
import { ReferenceDataManager } from "@/components/settings/ReferenceDataManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { listColleges, listPrograms } from "@/server/repositories/reference-data.repository";

export default async function ReferenceDataPage() {
  await connection();
  await requireUser(["ADMIN"]);
  const [colleges, programs] = await Promise.all([listColleges(), listPrograms()]);
  return <><PageHeader title="Reference data" description="Manage colleges and academic programs used for student imports." /><ReferenceDataManager colleges={colleges} programs={programs} /></>;
}
