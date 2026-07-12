import { redirect } from "next/navigation";

export default function LaboratoryScheduleBatchesPage() {
  redirect("/students?view=schedule-imports");
}
