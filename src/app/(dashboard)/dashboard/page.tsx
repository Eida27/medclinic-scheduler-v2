import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { dashboardMetrics } from "@/server/repositories/tracking.repository";

export default async function DashboardPage() {
  const metrics = await dashboardMetrics();
  const cards = [
    ["Students", metrics.totalStudents, "Active master records"],
    ["Pending appointments", metrics.pendingAppointments, "Published appointments awaiting completion"],
    ["Physical exams complete", metrics.completedPhysicalExams, "Recorded completed results"],
    ["Laboratory complete", metrics.completedLaboratory, "Recorded completed results"],
    ["No-shows", metrics.noShows, "Appointments requiring follow-up"],
    ["Rescheduled", metrics.rescheduled, "Original appointments replaced"],
    ["Capacity warnings", metrics.overCapacityWarnings, "Service dates above recommended capacity"],
  ];
  return (
    <>
      <PageHeader title="Clinic dashboard" description="A concise view of scheduling and compliance operations." />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value, description]) => (
          <Card key={label} className="relative overflow-hidden">
            <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-cpu-gold" />
            <p className="text-sm font-semibold text-muted">{label}</p>
            <p className="mt-2 text-3xl font-black tracking-tight text-ink">{value}</p>
            <p className="mt-2 text-xs leading-5 text-muted">{description}</p>
          </Card>
        ))}
      </section>
      <Card>
        <CardTitle>Core workflow</CardTitle>
        <ol className="mt-4 grid gap-3 text-sm text-muted-strong sm:grid-cols-3">
          {[
            "Open Students & Schedules",
            "Choose the CSV and required priority group",
            "Review one confirmation and agree to import",
            "The system validates, generates, and publishes automatically",
            "Administrators resolve any saved review checkpoint",
            "Track published schedules, results, and compliance",
          ].map((step, index) => (
            <li key={step} className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/65 p-4"><span className="mr-2 font-black text-cpu-navy">{index + 1}.</span>{step}</li>
          ))}
        </ol>
      </Card>
    </>
  );
}
