import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { requireUser } from "@/server/auth/current-user";
import { assertClinicAccess } from "@/server/clinic-access";
import { clinicConfigs } from "@/server/clinics";
import { listAppointments } from "@/server/repositories/appointments.repository";

const clinic = clinicConfigs.KABALAKA_CLINIC;
type Appointment = { id: string; studentNumber: string; studentName: string; scheduleType: string; appointmentDate: string; status: string; isPublished: boolean };

export default async function LaboratoryAppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser(); assertClinicAccess(user, clinic.code); const params = await searchParams;
  const result = await listAppointments({ clinicCode: clinic.code, appointmentDate: params.appointmentDate, scheduleType: clinic.scheduleType, status: params.status, studentNumber: params.studentNumber, isPublished: params.isPublished === undefined ? undefined : params.isPublished === "true", page: 1, limit: 100, offset: 0 });
  return <><PageHeader title="Laboratory appointments" description={`${result.total} KABALAKA Clinic laboratory appointments match the current filters.`} /><Card><form className="grid gap-3 md:grid-cols-4"><Input name="studentNumber" defaultValue={params.studentNumber} placeholder="Student number" /><Input name="appointmentDate" type="date" defaultValue={params.appointmentDate} /><Select name="status" defaultValue={params.status}><option value="">All statuses</option>{["DRAFT","PENDING","COMPLETED","NO_SHOW","RESCHEDULED","CANCELLED"].map((status) => <option key={status}>{status}</option>)}</Select><button className="rounded-xl border border-line bg-surface font-bold text-ink transition hover:border-cpu-navy/25 hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy">Filter</button></form></Card><Card className="overflow-hidden p-0"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-cpu-navy-soft/70"><tr><th className="px-5 py-3">Student</th><th className="px-5 py-3">Service</th><th className="px-5 py-3">Date</th><th className="px-5 py-3">Status</th><th className="px-5 py-3"></th></tr></thead><tbody className="divide-y divide-line">{(result.items as Appointment[]).map((appointment) => <tr key={appointment.id} className="transition hover:bg-cpu-navy-soft/35"><td className="px-5 py-4"><p className="font-bold text-ink">{appointment.studentName}</p><p className="font-mono text-xs text-muted">{appointment.studentNumber}</p></td><td className="px-5 py-4">{appointment.scheduleType.replaceAll("_", " ")}</td><td className="px-5 py-4">{appointment.appointmentDate}</td><td className="px-5 py-4"><Badge tone={appointment.status === "COMPLETED" ? "success" : appointment.status === "NO_SHOW" ? "danger" : appointment.status === "DRAFT" ? "neutral" : "warning"}>{appointment.status}</Badge>{appointment.isPublished ? <span className="ml-2 text-xs text-emerald-700">Published</span> : null}</td><td className="px-5 py-4 text-right"><Link className="font-bold text-cpu-navy hover:underline" href={`/appointments/${appointment.id}`}>Open</Link></td></tr>)}</tbody></table></div></Card></>;
}
