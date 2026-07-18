import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";

export default async function StudentSchedulePage() {
  const student = await requireStudent().catch(() => redirect("/student/login"));
  const portal = await getStudentPortalSchedule(student.studentNumber);
  if (!portal) redirect("/student/login");
  return (
    <section>
      <p className="text-sm font-semibold text-muted">{portal.studentNumber}</p>
      <h1 className="mt-1 text-3xl font-bold">{portal.studentName}</h1>
      <h2 className="mt-8 text-xl font-bold">Schedule and history</h2>
      <div className="mt-4 grid gap-3">
        {portal.appointments.length ? portal.appointments.map((appointment) => (
          <Card key={appointment.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <p className="font-bold">{appointment.scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination"}</p>
              <p className="text-sm text-muted">{appointment.appointmentDate}</p>
            </div>
            <span className="text-sm font-semibold">{appointment.status.replaceAll("_", " ")}</span>
          </Card>
        )) : <Card className="p-5 text-sm text-muted">No published appointments yet.</Card>}
      </div>
    </section>
  );
}
