import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type {
  ScheduleImportListItem,
  ScheduleImportStatus,
} from "@/server/repositories/schedule-imports.repository";

function statusTone(status: ScheduleImportStatus) {
  if (status === "PUBLISHED") return "success" as const;
  if (status === "GENERATED") return "info" as const;
  if (status === "VALIDATED") return "warning" as const;
  if (status === "CANCELLED" || status === "NEEDS_REVIEW") return "danger" as const;
  return "neutral" as const;
}

function importedAtLabel(value: string) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

export function ScheduleImportHistoryTable({ imports }: { imports: ScheduleImportListItem[] }) {
  if (imports.length === 0) {
    return (
      <Card>
        <p className="py-8 text-center text-sm text-muted">
          No schedule CSV files have been imported yet.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-cpu-navy-soft/70 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-3">Import</th>
              <th className="px-5 py-3">Imported</th>
              <th className="px-5 py-3">Student rows</th>
              <th className="px-5 py-3">Laboratory</th>
              <th className="px-5 py-3">Physical exam</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {imports.map((scheduleImport) => (
              <tr key={scheduleImport.importId} className="transition hover:bg-cpu-navy-soft/35">
                <td className="px-5 py-4">
                  <p className="font-bold text-ink">{scheduleImport.importName}</p>
                  <p className="font-mono text-xs text-muted">{scheduleImport.sourceFilename}</p>
                </td>
                <td className="px-5 py-4">
                  <p>{importedAtLabel(scheduleImport.createdAt)}</p>
                  <p className="text-xs text-muted">{scheduleImport.createdByName}</p>
                </td>
                <td className="px-5 py-4">
                  <p className="font-bold text-ink">{scheduleImport.totalRows}</p>
                  <p className="text-xs text-muted">
                    {scheduleImport.matchedStudentCount} matched · {scheduleImport.createdStudentCount} created
                  </p>
                </td>
                <td className="px-5 py-4">{scheduleImport.laboratoryItemCount}</td>
                <td className="px-5 py-4">{scheduleImport.physicalExaminationItemCount}</td>
                <td className="px-5 py-4">
                  <Badge tone={statusTone(scheduleImport.status)}>{scheduleImport.status}</Badge>
                </td>
                <td className="px-5 py-4 text-right">
                  <Link
                    className="font-bold text-cpu-navy hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
                    href={`/students/schedule-imports/${scheduleImport.importId}`}
                  >
                    View details
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
