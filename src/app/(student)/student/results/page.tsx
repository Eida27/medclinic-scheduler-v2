import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";

export default async function StudentResultsPage() {
  const student = await requireStudent().catch(() => redirect("/student/login"));
  const portal = await getStudentPortalSchedule(student.studentNumber);
  const completed = portal?.appointments.filter((appointment) => appointment.status === "COMPLETED") ?? [];
  return (
    <section>
      <h1 className="text-3xl font-bold">Results</h1>
      <p className="mt-2 text-sm text-muted">Uploads open after clinic staff completes the matching appointment.</p>
      <div className="mt-6 grid gap-3">
        {completed.length ? completed.map((appointment) => (
          <Link key={appointment.id} href={`/student/results/${appointment.id}`}>
            <Card className="p-5 transition hover:border-cpu-navy/40">
              <p className="font-bold">{appointment.scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination"}</p>
              <p className="text-sm text-muted">Completed appointment: {appointment.appointmentDate}</p>
            </Card>
          </Link>
        )) : <Card className="p-5 text-sm text-muted">No completed appointments are ready for upload.</Card>}
      </div>
    </section>
  );
}
