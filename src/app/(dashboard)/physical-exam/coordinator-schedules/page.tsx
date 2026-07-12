import { redirect } from "next/navigation";

export default function PhysicalExamScheduleBatchesPage() {
  redirect("/students?view=schedule-imports");
}
