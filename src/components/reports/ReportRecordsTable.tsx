import Link from "next/link";
import { operationalStatusLabel, statusTone } from "@/components/appointments/status-labels";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import {
  historicalComplianceLabel,
  historicalDataQualityLabel,
} from "@/lib/historical-compliance-report";
import type { HistoricalComplianceReportItem } from "@/server/repositories/historical-compliance-report.repository";

function dateLabel(value: string | null) {
  if (!value) return "No published appointment";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function overallTone(status: HistoricalComplianceReportItem["overallStatus"]) {
  if (status === "COMPLIED") return "success" as const;
  if (status === "PENDING_COMPLIANCE") return "warning" as const;
  return "danger" as const;
}

export function ReportRecordsTable({ items }: { items: HistoricalComplianceReportItem[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="px-5 pt-5"><CardTitle>Detailed records</CardTitle></div>
      <div className="overflow-x-auto">
        <table className="mt-3 w-full min-w-[72rem] text-left text-sm" aria-label="Detailed historical compliance records">
          <thead className="bg-cpu-navy-soft/70">
            <tr>
              <th className="px-5 py-3">Student</th>
              <th className="px-5 py-3">Historical college</th>
              <th className="px-5 py-3">Historical program</th>
              <th className="px-5 py-3">Year</th>
              <th className="px-5 py-3">Laboratory</th>
              <th className="px-5 py-3">Physical Examination</th>
              <th className="px-5 py-3">Overall</th>
              <th className="px-5 py-3">Data quality</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((item) => (
              <tr key={item.studentNumber} className="align-top transition hover:bg-cpu-navy-soft/35">
                <td className="px-5 py-4">
                  <Link
                    href={`/students/${encodeURIComponent(item.studentNumber)}`}
                    className="font-bold text-cpu-navy hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
                  >
                    {item.studentName}
                  </Link>
                  <p className="font-mono text-xs text-muted">{item.studentNumber}</p>
                </td>
                <td className="px-5 py-4">{item.collegeName}</td>
                <td className="px-5 py-4">{item.programCode ? `${item.programCode} — ` : ""}{item.programName}</td>
                <td className="px-5 py-4">{item.yearLevel ?? "Not recorded"}</td>
                <td className="px-5 py-4">
                  <Badge tone={statusTone(item.laboratoryStatus)}>{operationalStatusLabel(item.laboratoryStatus)}</Badge>
                  <p className="mt-1 text-xs text-muted">{dateLabel(item.laboratoryAppointmentDate)}</p>
                </td>
                <td className="px-5 py-4">
                  <Badge tone={statusTone(item.physicalExamStatus)}>{operationalStatusLabel(item.physicalExamStatus)}</Badge>
                  <p className="mt-1 text-xs text-muted">{dateLabel(item.physicalExamAppointmentDate)}</p>
                </td>
                <td className="px-5 py-4">
                  <Badge tone={overallTone(item.overallStatus)}>{historicalComplianceLabel(item.overallStatus)}</Badge>
                </td>
                <td className="px-5 py-4">
                  <Badge tone={item.dataQuality === "MIGRATED_INCOMPLETE" ? "warning" : "info"}>
                    {historicalDataQualityLabel(item.dataQuality)}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
