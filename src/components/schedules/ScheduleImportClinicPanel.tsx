import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

type ValidationIssue = {
  severity: string;
  message: string;
};

type CapacityResult = {
  clinicId: string;
  date: string;
  scheduleType: string;
  count: number;
  maxCapacity: number;
  status: string;
  message: string;
};

type ValidationSummary = {
  totalItems: number;
  validCount: number;
  conflictCount: number;
  capacityResults?: CapacityResult[];
};

type ScheduleRequest = {
  id: string;
  studentNumber: string;
  studentName: string;
  scheduleType: string;
  priorityGroupName: string;
  targetDate: string | null;
  targetWeekStart: string | null;
  targetWeekEnd: string | null;
  status: string;
  validationIssues?: ValidationIssue[];
};

type GeneratedAppointment = {
  id: string;
  batchId: string;
  studentNumber: string;
  studentName: string;
  scheduleType: string;
  priorityGroupName: string | null;
  appointmentDate: string;
  status: string;
  isPublished: boolean;
  notes: string | null;
};

export type ScheduleImportClinicBatchView = {
  id: string;
  clinicCode: string;
  clinicName: string;
  status: string;
  validationSummary: ValidationSummary | null;
  items: ScheduleRequest[];
  appointments: GeneratedAppointment[];
};

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (["PUBLISHED", "VALID"].includes(status)) return "success";
  if (status === "VALIDATED") return "warning";
  if (["CONFLICT", "CANCELLED"].includes(status)) return "danger";
  if (status === "GENERATED") return "info";
  return "neutral";
}

function serviceLabel(clinicCode: string) {
  return clinicCode === "KABALAKA_CLINIC" ? "Laboratory" : "Physical examination";
}

export function ScheduleImportClinicPanel({ batch }: { batch: ScheduleImportClinicBatchView }) {
  const service = serviceLabel(batch.clinicCode);
  const summary = batch.validationSummary;
  const exceptionItems = batch.items.filter((item) => item.validationIssues?.length);
  const exceptionCount = exceptionItems.reduce(
    (count, item) => count + (item.validationIssues?.length ?? 0),
    0,
  );

  return (
    <Card role="region" aria-label={`${service} schedule review`} className="overflow-hidden p-0">
      <div className="flex flex-col gap-3 border-b border-line p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-ink">{service}</h2>
          <p className="text-sm text-muted">{batch.clinicName}</p>
        </div>
        <Badge tone={statusTone(batch.status)}>{batch.status}</Badge>
      </div>

      <div className="grid gap-6 p-5">
        <section aria-labelledby={`${batch.id}-validation-heading`}>
          <h3 id={`${batch.id}-validation-heading`} className="font-bold text-ink">Validation</h3>
          {summary ? (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  ["Total", summary.totalItems],
                  ["Valid", summary.validCount],
                  ["Conflicts", summary.conflictCount],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-3">
                    <dt className="text-xs font-semibold text-muted">{label}</dt>
                    <dd className="mt-1 text-xl font-black text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge tone={summary.conflictCount ? "danger" : "success"}>
                  {summary.conflictCount} {summary.conflictCount === 1 ? "conflict" : "conflicts"}
                </Badge>
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Validate the import to see validation totals and capacity results.
            </p>
          )}
        </section>

        {summary?.capacityResults?.length ? (
          <section aria-labelledby={`${batch.id}-capacity-heading`}>
            <h3 id={`${batch.id}-capacity-heading`} className="font-bold text-ink">Capacity results</h3>
            <div className="mt-3 grid gap-3">
              {summary.capacityResults.map((capacity) => (
                <div key={`${capacity.scheduleType}-${capacity.date}`} className="rounded-xl border border-line bg-canvas p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-bold text-ink">{capacity.date}</p>
                    <Badge tone={statusTone(capacity.status)}>{capacity.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-strong">
                    {capacity.count} scheduled / {capacity.maxCapacity} maximum
                  </p>
                  <p className="mt-1 text-sm text-muted">{capacity.message}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {exceptionCount ? (
          <details className="rounded-xl border border-line bg-canvas">
            <summary className="cursor-pointer px-4 py-3 font-bold text-ink">
              Review exceptions ({exceptionCount} {exceptionCount === 1 ? "issue" : "issues"})
            </summary>
            <div className="divide-y divide-line border-t border-line">
              {exceptionItems.map((item) => (
                <div key={item.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-ink">{item.studentName}</p>
                      <p className="font-mono text-xs text-muted">{item.studentNumber}</p>
                      <p className="mt-1 text-xs text-muted-strong">Priority: {item.priorityGroupName}</p>
                    </div>
                    <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                  </div>
                  {item.validationIssues?.map((issue, index) => (
                    <p
                      key={`${issue.message}-${index}`}
                      className={`mt-2 text-sm ${issue.severity === "CONFLICT" ? "text-red-700" : "text-amber-700"}`}
                    >
                      {issue.message}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </details>
        ) : null}

        <section aria-labelledby={`${batch.id}-appointments-heading`}>
          <h3 id={`${batch.id}-appointments-heading`} className="font-bold text-ink">Generated appointments</h3>
          {batch.appointments.length ? (
            <div className="mt-3 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-sm">
                <thead className="bg-cpu-navy-soft/70">
                  <tr>
                    <th className="px-4 py-3">Student</th>
                    <th className="px-4 py-3">Priority</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Publication</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {batch.appointments.map((appointment) => (
                    <tr key={appointment.id}>
                      <td className="px-4 py-3">
                        <p className="font-bold text-ink">{appointment.studentName}</p>
                        <p className="font-mono text-xs text-muted">{appointment.studentNumber}</p>
                      </td>
                      <td className="px-4 py-3">{appointment.priorityGroupName ?? "Not available"}</td>
                      <td className="px-4 py-3">{appointment.appointmentDate}</td>
                      <td className="px-4 py-3">
                        <Badge tone={appointment.isPublished ? "success" : "neutral"}>
                          {appointment.isPublished ? "Published" : "Draft — not published"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Draft appointments will appear here after this import is generated.
            </p>
          )}
        </section>
      </div>
    </Card>
  );
}
