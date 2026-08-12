import { redirect } from "next/navigation";
import { operationalStatusLabel } from "@/components/appointments/status-labels";
import { Card } from "@/components/ui/Card";
import { EmailVerificationReminder } from "@/components/student/EmailVerificationReminder";
import { requireStudent } from "@/server/auth/current-student";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";

export default async function StudentSchedulePage() {
  const student = await requireStudent().catch(() => redirect("/student/login"));
  const portal = await getStudentPortalSchedule(student.studentNumber);
  if (!portal) redirect("/student/login");
  return (
    <section>
      {!portal.emailVerifiedAt ? <EmailVerificationReminder /> : null}
      <p className="text-sm font-semibold text-muted">{portal.studentNumber}</p>
      <h1 className="mt-1 text-3xl font-bold">{portal.studentName}</h1>
      <h2 className="mt-8 text-xl font-bold">Current schedule</h2>
      <div className="mt-4 grid gap-3">
        {portal.appointments.length ? portal.appointments.map((appointment) => (
          <Card key={appointment.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <p className="font-bold">{appointment.scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination"}</p>
              <p className="text-sm text-muted">
                {appointment.appointmentDate ?? "No current date assigned"}
                {appointment.locationName ? ` · ${appointment.locationName}` : ""}
              </p>
            </div>
            <span className="text-sm font-semibold">
              {appointment.displayStatus && appointment.displayStatus !== appointment.status
                ? appointment.displayStatus
                : operationalStatusLabel(appointment.status)}
            </span>
          </Card>
        )) : <Card className="p-5 text-sm text-muted">No published appointments yet.</Card>}
      </div>
      <h2 className="mt-8 text-xl font-bold">Schedule history</h2>
      <div className="mt-4 grid gap-3">
        {portal.history.length ? portal.history.map((appointment) => (
          <Card key={`${appointment.id}-${appointment.originalDate}`} className="p-5">
            <p className="font-bold">
              {appointment.scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination"}
            </p>
            <p className="text-sm text-muted">Original date: {appointment.originalDate}</p>
            {appointment.closureReason ? (
              <p className="mt-1 text-sm text-muted">Closure: {appointment.closureReason}</p>
            ) : null}
          </Card>
        )) : <Card className="p-5 text-sm text-muted">No schedule changes yet.</Card>}
      </div>
    </section>
  );
}
