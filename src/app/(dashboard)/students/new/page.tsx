import { StudentForm } from "@/components/students/StudentForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { listColleges, listPrograms } from "@/server/repositories/reference-data.repository";

export default async function NewStudentPage() {
  const [colleges, programs] = await Promise.all([listColleges(), listPrograms()]);
  return <><PageHeader title="Add student" description="Create a student master record for scheduling." /><StudentForm colleges={colleges} programs={programs} /></>;
}
