import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

type ValidationSummary = {
  totalItems: number;
  validCount: number;
  conflictCount: number;
};

type GeneratedAppointment = {
  id: string;
  batchId: string;
  studentNumber: string;
  studentName: string;
  scheduleType: string;
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
  appointments: GeneratedAppointment[];
};

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "PUBLISHED") return "success";
  if (status === "CANCELLED" || status === "NEEDS_REVIEW") return "danger";
  return "neutral";
}

function serviceLabel(clinicCode: string) {
  return clinicCode === "KABALAKA_CLINIC" ? "Laboratory" : "Physical examination";
}

export function ScheduleImportClinicPanel({ batch }: { batch: ScheduleImportClinicBatchView }) {
  const service = serviceLabel(batch.clinicCode);
  const summary = batch.validationSummary;

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
              Validation totals are not available for this historical import.
            </p>
          )}
        </section>

        <section aria-labelledby={`${batch.id}-appointments-heading`}>
          <h3 id={`${batch.id}-appointments-heading`} className="font-bold text-ink">Generated appointments</h3>
          {batch.appointments.length ? (
            <div className="mt-3 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-sm">
                <thead className="bg-cpu-navy-soft/70">
                  <tr>
                    <th className="px-4 py-3">Student</th>
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
              No appointments are recorded for this clinic batch.
            </p>
          )}
        </section>
      </div>
    </Card>
  );
}
