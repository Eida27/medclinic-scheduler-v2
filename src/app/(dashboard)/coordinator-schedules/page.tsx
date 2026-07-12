import { redirect } from "next/navigation";

export default function ScheduleBatchesPage() {
  redirect("/students?view=schedule-imports");
}
