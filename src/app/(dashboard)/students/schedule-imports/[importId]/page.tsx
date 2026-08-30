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
  const isPublished = detail.status === "PUBLISHED";

  return (
    <>
      <PageHeader
        title={detail.importName}
        description={isPublished
          ? "Published paired schedules and compact import outcomes."
          : "Historical import data is read-only and cannot be advanced."}
        actions={<Badge tone={statusTone(detail.status)}>{detail.status}</Badge>}
      />
      <Card>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,1fr)]">
          <div>
            <CardTitle>Import details</CardTitle>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="font-semibold text-muted">Source file</dt><dd className="mt-1 break-all font-medium text-ink">{detail.sourceFilename}</dd></div>
              <div><dt className="font-semibold text-muted">Accepted</dt><dd className="mt-1 text-ink"><time dateTime={detail.acceptedAt}>{acceptedAtLabel(detail.acceptedAt)}</time></dd></div>
              <div><dt className="font-semibold text-muted">Category</dt><dd className="mt-1 text-ink">{detail.importMode === "FIRST_YEAR_OVPSA" ? "First Year" : detail.studentCategory ?? "Legacy"}</dd></div>
              <div><dt className="font-semibold text-muted">Academic year</dt><dd className="mt-1 text-ink">{academicYear}</dd></div>
              <div><dt className="font-semibold text-muted">Generated range</dt><dd className="mt-1 text-ink">{detail.generatedRange ? `${detail.generatedRange.startDate} – ${detail.generatedRange.endDate}` : "No new pair generated"}</dd></div>
              <div>
                <dt className="font-semibold text-muted">Imported by</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 text-ink">
                  <span>{detail.createdBy?.fullName ?? detail.createdByName}</span>
                  {detail.createdBy?.deleted ? <Badge tone="neutral">Deleted</Badge> : null}
                </dd>
              </div>
            </dl>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">Students</dt>
              <dd className="mt-1 text-2xl font-black text-ink">{detail.totalRows}</dd>
              <p className="mt-1 text-xs text-muted">{detail.createdStudentCount} inserted · {detail.matchedStudentCount} updated · {detail.skippedStudentCount} skipped</p>
            </div>
            <div className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4">
              <dt className="text-xs font-semibold text-muted">
                {isPublished ? "Published pairs" : "Planned pairs"}
              </dt>
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
      {detail.firstYearSummary ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>First Year publication</CardTitle>
              <p className="mt-1 text-sm text-muted">
                {detail.firstYearSummary.laboratory.date} at {detail.firstYearSummary.laboratory.locationName}
              </p>
            </div>
            <Badge tone="success">{detail.status}</Badge>
          </div>
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl border border-line p-4">
              <dt className="font-semibold text-muted">First PE candidate</dt>
              <dd className="mt-1 font-bold text-ink">{detail.firstYearSummary.firstPhysicalExamCandidate}</dd>
            </div>
            <div className="rounded-xl border border-line p-4">
              <dt className="font-semibold text-muted">Active PE capacity</dt>
              <dd className="mt-1 font-bold text-ink">{detail.firstYearSummary.physicalExamMaximumCapacity} per day</dd>
            </div>
            <div className="rounded-xl border border-line p-4">
              <dt className="font-semibold text-muted">Publication</dt>
              <dd className="mt-1 font-bold text-ink">{detail.firstYearSummary.appointmentCount} appointments</dd>
            </div>
          </dl>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-bold text-ink">Physical Examination allocations</h3>
              <ul className="mt-2 grid gap-2">
                {detail.firstYearSummary.allocations.map((allocation) => (
                  <li key={allocation.date} className="flex items-center justify-between gap-3 rounded-xl bg-cpu-navy-soft/55 px-4 py-3 text-sm">
                    <time dateTime={allocation.date} className="font-bold text-ink">{allocation.date}</time>
                    <span className="text-muted">{allocation.studentCount} / {allocation.capacity} students</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-bold text-ink">Skipped dates and displacement</h3>
              {detail.firstYearSummary.skippedDates.length ? (
                <ul className="mt-2 grid gap-2">
                  {detail.firstYearSummary.skippedDates.map((skipped) => (
                    <li key={skipped.date} className="rounded-xl bg-cpu-navy-soft/55 px-4 py-3 text-sm text-muted">
                      {`${skipped.date} — ${skipped.reasons.map((reason) => reason.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())).join(", ")}`}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-sm text-muted">No candidate dates were skipped.</p>}
              <p className="mt-3 text-sm text-muted">{detail.firstYearSummary.displacementTotal} Regular appointments displaced and replaced.</p>
            </div>
          </div>
          <p className="mt-5 break-all text-xs text-muted">
            {`OVPSA lineage: ${detail.firstYearSummary.batchId} / ${detail.firstYearSummary.revisionId}`}
          </p>
        </Card>
      ) : null}
      <div className="grid gap-6">
        {detail.childBatches.map((batch) => <ScheduleImportClinicPanel key={String(batch.id)} batch={batch} />)}
      </div>
    </>
  );
}
