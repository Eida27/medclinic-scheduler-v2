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

function acceptedAtLabel(value: string) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

export default async function ScheduleImportDetailPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const actor = await requireUser(["ADMIN", "COORDINATOR"]);
  const { importId } = await params;
  const detail = await getScheduleImport(importId, actor);
  const academicYear = detail.academicYearStart
    ? `${detail.academicYearStart}–${detail.academicYearStart + 1}`
    : "Legacy import";

  return (
    <>
      <PageHeader
        title={detail.importName}
        description="Published paired schedules and compact import outcomes."
        actions={<Badge tone={statusTone(detail.status)}>{detail.status}</Badge>}
      />
      <Card>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,1fr)]">
          <div>
            <CardTitle>Import details</CardTitle>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="font-semibold text-muted">Source file</dt><dd className="mt-1 break-all font-medium text-ink">{detail.sourceFilename}</dd></div>
              <div><dt className="font-semibold text-muted">Accepted</dt><dd className="mt-1 text-ink"><time dateTime={detail.acceptedAt}>{acceptedAtLabel(detail.acceptedAt)}</time></dd></div>
              <div><dt className="font-semibold text-muted">Category</dt><dd className="mt-1 text-ink">{detail.studentCategory ?? "Legacy"}</dd></div>
              <div><dt className="font-semibold text-muted">Academic year</dt><dd className="mt-1 text-ink">{academicYear}</dd></div>
              <div><dt className="font-semibold text-muted">Generated range</dt><dd className="mt-1 text-ink">{detail.generatedRange ? `${detail.generatedRange.startDate} – ${detail.generatedRange.endDate}` : "No new pair generated"}</dd></div>
              <div><dt className="font-semibold text-muted">Imported by</dt><dd className="mt-1 text-ink">{detail.createdByName}</dd></div>
            </dl>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Students</dt>
              <dd className="mt-1 text-2xl font-black text-ink">{detail.totalRows}</dd>
              <p className="mt-1 text-xs text-muted">{detail.createdStudentCount} inserted · {detail.matchedStudentCount} updated · {detail.skippedStudentCount} skipped</p>
            </div>
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Published pairs</dt>
              <dd className="mt-1 text-2xl font-black text-ink">{Math.min(detail.laboratoryItemCount, detail.physicalExaminationItemCount)}</dd>
            </div>
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Overflow</dt>
              <dd className="mt-1 text-2xl font-black text-ink">{detail.overflow.pairCountBeyondPreferredWindow}</dd>
            </div>
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Displaced Regular</dt>
              <dd className="mt-1 text-2xl font-black text-ink">{detail.displacementTotal}</dd>
            </div>
          </dl>
        </div>
      </Card>
      {detail.status === "DRAFT" || detail.status === "VALIDATED" || detail.status === "GENERATED" ? (
        <Card>
          <CardTitle>Historical import actions</CardTitle>
          <p className="my-3 text-sm text-muted">Lifecycle actions remain available for imports saved before automatic publication.</p>
          <ScheduleImportActions importId={detail.importId} status={detail.status} actorRole={actor.role} />
        </Card>
      ) : null}
      <div className="grid gap-6">
        {detail.childBatches.map((batch) => <ScheduleImportClinicPanel key={String(batch.id)} batch={batch} />)}
      </div>
    </>
  );
}
