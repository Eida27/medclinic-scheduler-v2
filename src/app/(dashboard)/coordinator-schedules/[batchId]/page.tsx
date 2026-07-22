import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { getScheduleBatch } from "@/server/repositories/coordinator-schedules.repository";

type BatchItem = {
  id: string;
  studentNumber: string;
  studentName: string;
  scheduleType: string;
  priorityGroupName: string;
  targetDate: string | null;
  targetWeekStart: string | null;
  targetWeekEnd: string | null;
  status: string;
  validationIssues: Array<{ message: string; severity: string }>;
};

function statusTone(status: string) {
  if (status === "PUBLISHED" || status === "VALID") return "success" as const;
  if (status === "GENERATED") return "info" as const;
  if (status === "VALIDATED") return "warning" as const;
  if (status === "CONFLICT" || status === "CANCELLED") return "danger" as const;
  return "neutral" as const;
}

export default async function BatchDetailsPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const user = await requireUser();
  const batch = await getScheduleBatch((await params).batchId);
  if (!batch) return notFound();
  if (batch.importGroupId) {
    return redirect(user.role === "ADMIN"
      ? `/students/schedule-imports/${batch.importGroupId}`
      : "/students");
  }

  const items = batch.items as BatchItem[];
  return (
    <>
      <PageHeader
        title={String(batch.batchName)}
        description={`${batch.clinicName} · ${items.length} requests`}
        actions={<Badge tone={statusTone(String(batch.status))}>{String(batch.status)}</Badge>}
      />
      <Card>
        <CardTitle>Read-only historical batch</CardTitle>
        <p className="mt-2 text-sm text-muted">
          This ungrouped batch is retained for historical reference. New schedules are managed through Students &amp; Schedules.
        </p>
      </Card>
      {batch.validationSummary ? (
        <Card>
          <CardTitle>Validation summary</CardTitle>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(batch.validationSummary as Record<string, unknown>)
              .filter(([key]) => key.endsWith("Count") || key === "totalItems")
              .map(([key, value]) => (
                <div key={key} className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/60 p-4">
                  <p className="text-2xl font-black text-ink">{String(value)}</p>
                  <p className="text-xs text-muted">{key.replace(/([A-Z])/g, " $1")}</p>
                </div>
              ))}
          </div>
        </Card>
      ) : null}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cpu-navy-soft/70">
              <tr>
                <th className="px-5 py-3">Student</th>
                <th className="px-5 py-3">Service</th>
                <th className="px-5 py-3">Target</th>
                <th className="px-5 py-3">Priority</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="px-5 py-4">
                    <p className="font-bold text-ink">{item.studentName}</p>
                    <p className="font-mono text-xs text-muted">{item.studentNumber}</p>
                    {item.validationIssues?.map((issue, index) => (
                      <p
                        key={`${issue.message}-${index}`}
                        className={`mt-1 text-xs ${issue.severity === "CONFLICT" ? "text-red-700" : "text-amber-700"}`}
                      >
                        {issue.message}
                      </p>
                    ))}
                  </td>
                  <td className="px-5 py-4">{item.scheduleType.replaceAll("_", " ")}</td>
                  <td className="px-5 py-4">
                    {item.targetDate ?? `${item.targetWeekStart} to ${item.targetWeekEnd}`}
                  </td>
                  <td className="px-5 py-4">{item.priorityGroupName}</td>
                  <td className="px-5 py-4">
                    <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
