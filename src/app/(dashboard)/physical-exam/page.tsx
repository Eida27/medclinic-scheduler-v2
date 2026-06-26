import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { assertClinicAccess } from "@/server/clinic-access";
import { clinicConfigs } from "@/server/clinics";
import { dashboardMetrics } from "@/server/repositories/tracking.repository";

const clinic = clinicConfigs.CPU_CLINIC;

export default async function PhysicalExamDashboardPage() {
  const user = await requireUser();
  assertClinicAccess(user, clinic.code);
  const metrics = await dashboardMetrics({ clinicCode: clinic.code });
  return (
    <>
      <PageHeader title={clinic.dashboardTitle} description={clinic.dashboardDescription} />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Pending appointments", metrics.pendingAppointments],
          ["Physical exams complete", metrics.completedPhysicalExams],
          ["No-shows", metrics.noShows],
          ["Unpublished batches", metrics.unpublishedBatches],
        ].map(([label, value]) => (
          <Card key={label} className="relative overflow-hidden">
            <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-cpu-gold" />
            <p className="text-sm font-semibold text-muted">{label}</p>
            <p className="mt-2 text-3xl font-black tracking-tight text-ink">{value}</p>
          </Card>
        ))}
      </section>
      <Card>
        <CardTitle>CPU Clinic workspace</CardTitle>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link className="rounded-xl bg-cpu-navy px-4 py-2.5 text-sm font-bold text-white transition hover:bg-cpu-navy-light" href="/physical-exam/coordinator-schedules">Coordinator schedules</Link>
          <Link className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-bold text-ink transition hover:bg-cpu-navy-soft" href="/physical-exam/appointments">Appointments</Link>
        </div>
      </Card>
    </>
  );
}
