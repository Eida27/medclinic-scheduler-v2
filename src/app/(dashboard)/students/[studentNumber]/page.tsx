import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { DeactivateStudentButton } from "@/components/students/DeactivateStudentButton";
import { StudentForm } from "@/components/students/StudentForm";
import { listColleges, listPrograms } from "@/server/repositories/reference-data.repository";
import { getStudentDetails } from "@/server/services/students.service";
import type { AppointmentHistory } from "@/server/repositories/students.repository";

export default async function StudentDetailsPage({ params }: { params: Promise<{ studentNumber: string }> }) {
  const studentNumber = decodeURIComponent((await params).studentNumber);
  const [student, colleges, programs] = await Promise.all([getStudentDetails(studentNumber), listColleges(), listPrograms()]);
  return (
    <>
      <PageHeader title={student.fullName} description={`${student.studentNumber} · ${student.programName}`} actions={<DeactivateStudentButton studentNumber={student.studentNumber} />} />
      <StudentForm colleges={colleges} programs={programs} student={student} />
      <Card><CardTitle>Appointment history</CardTitle><div className="mt-4 grid gap-3">{student.appointments.map((appointment: AppointmentHistory) => <div key={appointment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4"><div><p className="font-bold text-ink">{appointment.schedule_type.replaceAll("_", " ")}</p><p className="text-sm text-muted">{appointment.appointment_date}</p></div><Badge tone={appointment.status === "COMPLETED" ? "success" : appointment.status === "NO_SHOW" ? "danger" : "neutral"}>{appointment.status}</Badge></div>)}{student.appointments.length === 0 ? <p className="text-sm text-muted">No appointments yet.</p> : null}</div></Card>
    </>
  );
}
