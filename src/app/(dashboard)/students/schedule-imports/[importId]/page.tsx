import { ScheduleImportActions } from "@/components/schedules/ScheduleImportActions";
import { ScheduleImportClinicPanel } from "@/components/schedules/ScheduleImportClinicPanel";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { getScheduleImport } from "@/server/services/schedule-imports.service";

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "PUBLISHED") return "success";
  if (status === "GENERATED") return "info";
  if (status === "VALIDATED") return "warning";
  if (status === "CANCELLED" || status === "NEEDS_REVIEW") return "danger";
  return "neutral";
}

function importedAtLabel(value: string) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

function requestLabel(count: number, service: string) {
  return `${count} ${service} ${count === 1 ? "request" : "requests"}`;
}

export default async function ScheduleImportDetailPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const user = await requireUser(["ADMIN", "COORDINATOR"]);
  const { importId } = await params;
  const detail = await getScheduleImport(importId, user);

  return (
    <>
      <PageHeader
        title={detail.importName}
        description="Review both clinic schedules as one grouped import."
        actions={<Badge tone={statusTone(detail.status)}>{detail.status}</Badge>}
      />

      <Card>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,1fr)]">
          <div>
            <CardTitle>Import details</CardTitle>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-muted">Source file</dt>
                <dd className="mt-1 break-all font-medium text-ink">{detail.sourceFilename}</dd>
              </div>
              <div>
                <dt className="font-semibold text-muted">Imported</dt>
                <dd className="mt-1 text-ink">
                  <time dateTime={detail.createdAt}>{importedAtLabel(detail.createdAt)}</time>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-muted">Account</dt>
                <dd className="mt-1 text-ink">Imported by {detail.createdByName}</dd>
              </div>
              <div>
                <dt className="font-semibold text-muted">Submitted by</dt>
                <dd className="mt-1 text-ink">
                  {detail.submittedByName ? `Submitted by ${detail.submittedByName}` : "Not provided"}
                </dd>
              </div>
            </dl>
            {detail.description ? <p className="mt-4 text-sm leading-6 text-muted">{detail.description}</p> : null}
          </div>

          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Total students</dt>
              <dd className="mt-1 text-2xl font-black text-ink">{detail.totalRows}</dd>
              <p className="mt-1 text-xs text-muted">
                {detail.matchedStudentCount} matched · {detail.createdStudentCount} created
              </p>
            </div>
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Combined status</dt>
              <dd className="mt-2"><Badge tone={statusTone(detail.status)}>{detail.status}</Badge></dd>
            </div>
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Laboratory</dt>
              <dd className="mt-1 text-sm font-bold text-ink">
                {requestLabel(detail.laboratoryItemCount, "Laboratory")}
              </dd>
            </div>
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Physical examination</dt>
              <dd className="mt-1 text-sm font-bold text-ink">
                {requestLabel(detail.physicalExaminationItemCount, "Physical examination")}
              </dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card>
        <CardTitle>Import actions</CardTitle>
        <p className="my-3 text-sm text-muted">
          Lifecycle actions apply atomically to every clinic section in this import.
        </p>
        <ScheduleImportActions importId={detail.importId} status={detail.status} actorRole={user.role} />
      </Card>

      <div className="grid gap-6">
        {detail.childBatches.map((batch) => (
          <ScheduleImportClinicPanel key={String(batch.id)} batch={batch} />
        ))}
      </div>
    </>
  );
}
