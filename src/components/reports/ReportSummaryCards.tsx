import { Card } from "@/components/ui/Card";
import type { AcademicYearState } from "@/lib/academic-year";
import type { HistoricalComplianceSummary } from "@/server/repositories/historical-compliance-report.repository";

export function ReportSummaryCards({
  state,
  summary,
}: {
  state: AcademicYearState;
  summary: HistoricalComplianceSummary;
}) {
  const attention = state === "CLOSED"
    ? ["Did Not Comply", summary.didNotComply]
    : ["Pending Compliance", summary.pendingCompliance];
  const primary = [
    ["Total Students", summary.totalStudents],
    ["Fully Complied", summary.fullyComplied],
    attention,
    ["Compliance Rate", `${summary.complianceRate}%`],
  ];
  const secondary = [
    ["Laboratory incomplete", summary.laboratoryIncomplete],
    ["Physical Examination incomplete", summary.physicalExamIncomplete],
    ["Both incomplete", summary.bothIncomplete],
    ["Migrated or incomplete historical", summary.migratedIncomplete],
  ];

  return (
    <>
      <section aria-label="Primary report metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {primary.map(([label, value]) => (
          <Card key={label} className="relative overflow-hidden">
            <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-cpu-gold" />
            <p className="text-sm font-semibold text-muted">{label}</p>
            <p className="mt-2 text-3xl font-black tracking-tight text-ink">{value}</p>
          </Card>
        ))}
      </section>
      <section aria-label="Secondary report metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {secondary.map(([label, value]) => (
          <Card key={label} className="py-4">
            <p className="text-sm font-semibold text-muted">{label}</p>
            <p className="mt-1 text-2xl font-black text-ink">{value}</p>
          </Card>
        ))}
      </section>
    </>
  );
}
