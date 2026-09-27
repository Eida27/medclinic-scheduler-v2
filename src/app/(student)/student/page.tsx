import { redirect } from "next/navigation";
import { operationalStatusLabel } from "@/components/appointments/status-labels";
import { Card } from "@/components/ui/Card";
import { SCHEDULE_NOTICE } from "@/lib/schedule-notice";
import { requireVerifiedStudentPage } from "@/server/auth/verified-student-page";
import { getStudentPortalSchedule } from "@/server/repositories/student-portal.repository";

export default async function StudentSchedulePage() {
  const student = await requireVerifiedStudentPage();
  const portal = await getStudentPortalSchedule(student.studentNumber);
  if (!portal) redirect("/student/login");
  const currentHistory = portal.history.filter((appointment) => !appointment.isEndedAcademicYear);
  const previousHistory = portal.history.filter((appointment) => appointment.isEndedAcademicYear);
  return (
    <section>
      <p className="text-sm font-semibold text-muted">{portal.studentNumber}</p>
      <h1 className="mt-1 text-3xl font-bold">{portal.studentName}</h1>
      <Card className="mt-6 border-cpu-gold/40 p-5 text-sm leading-6">
        {SCHEDULE_NOTICE}
      </Card>
      <h2 className="mt-8 text-xl font-bold">Current schedule</h2>
      <div className="mt-4 grid gap-3">
        {portal.appointments.length ? portal.appointments.map((appointment) => (
          <Card key={appointment.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <p className="text-sm font-semibold text-muted">
                Academic year {appointment.academicYearStart}–{appointment.academicYearStart + 1}
                {appointment.isFutureAcademicYear ? " · Upcoming" : ""}
              </p>
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
      <section aria-labelledby="schedule-history-heading">
        <h2 id="schedule-history-heading" className="mt-8 text-xl font-bold">Schedule history</h2>
        <div className="mt-4 grid gap-3">
        {currentHistory.length ? currentHistory.map((appointment) => (
          <Card key={`${appointment.id}-${appointment.originalDate}`} className="p-5">
            <p className="text-sm font-semibold text-muted">
              Academic year {appointment.academicYearStart}–{appointment.academicYearStart + 1}
              {appointment.isFutureAcademicYear ? " · Upcoming" : ""}
            </p>
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
      <section aria-labelledby="previous-years-heading">
        <h2 id="previous-years-heading" className="mt-8 text-xl font-bold">Previous academic years</h2>
        <div className="mt-4 grid gap-3">
        {portal.previousAcademicYears?.map((appointment) => (
          <Card key={appointment.id} className="p-5">
            <p className="font-bold">Academic year {appointment.academicYearStart}–{appointment.academicYearStart + 1} · {appointment.scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination"}</p>
            <p className="text-sm text-muted">{appointment.appointmentDate ?? "No assigned date"} · {appointment.locationName} · {operationalStatusLabel(appointment.status)}</p>
          </Card>
        ))}
        {previousHistory.map((appointment) => (
          <Card key={`${appointment.id}-${appointment.originalDate}`} className="p-5">
            <p className="font-bold">
              Academic year {appointment.academicYearStart}–{appointment.academicYearStart + 1} · {appointment.scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination"} schedule change
            </p>
            <p className="text-sm text-muted">Original date: {appointment.originalDate}</p>
            {appointment.closureReason ? (
              <p className="mt-1 text-sm text-muted">Closure: {appointment.closureReason}</p>
            ) : null}
          </Card>
        ))}
        {!portal.previousAcademicYears?.length && !previousHistory.length ? (
          <Card className="p-5 text-sm text-muted">No previous academic year appointments.</Card>
        ) : null}
        </div>
      </section>
    </section>
  );
}
