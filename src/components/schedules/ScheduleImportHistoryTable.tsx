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

function acceptedAtLabel(value: string) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

export function ScheduleImportHistoryTable({ imports }: { imports: ScheduleImportListItem[] }) {
  if (!imports.length) {
    return <Card><p className="py-8 text-center text-sm text-muted">No schedule CSV files have been imported yet.</p></Card>;
  }
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-cpu-navy-soft/70 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-3">Import</th>
              <th className="px-5 py-3">Category</th>
              <th className="px-5 py-3">Accepted</th>
              <th className="px-5 py-3">Students</th>
              <th className="px-5 py-3">Published pairs</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {imports.map((item) => (
              <tr key={item.importId} className="transition hover:bg-cpu-navy-soft/35">
                <td className="px-5 py-4">
                  <p className="font-bold text-ink">{item.importName}</p>
                  <p className="font-mono text-xs text-muted">{item.sourceFilename}</p>
                </td>
                <td className="px-5 py-4">
                  <p className="font-bold text-ink">{item.studentCategory ?? "Legacy"}</p>
                  <p className="text-xs text-muted">
                    {item.academicYearStart ? `${item.academicYearStart}–${item.academicYearStart + 1}` : "No academic year"}
                  </p>
                </td>
                <td className="px-5 py-4">
                  <p>{acceptedAtLabel(item.acceptedAt)}</p>
                  <p className="text-xs text-muted">{item.createdByName}</p>
                </td>
                <td className="px-5 py-4">
                  <p className="font-bold text-ink">{item.totalRows}</p>
                  <p className="text-xs text-muted">
                    {item.createdStudentCount} inserted · {item.matchedStudentCount} updated · {item.skippedStudentCount} skipped
                  </p>
                </td>
                <td className="px-5 py-4">
                  <p>{Math.min(item.laboratoryItemCount, item.physicalExaminationItemCount)}</p>
                  {item.displacementTotal ? <p className="text-xs text-muted">{item.displacementTotal} displaced</p> : null}
                </td>
                <td className="px-5 py-4"><Badge tone={statusTone(item.status)}>{item.status}</Badge></td>
                <td className="px-5 py-4 text-right">
                  <Link className="font-bold text-cpu-navy hover:underline" href={`/students/schedule-imports/${item.importId}`}>
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
