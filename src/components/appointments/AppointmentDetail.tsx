import { notFound } from "next/navigation";
import { AppointmentActions } from "@/components/appointments/AppointmentActions";
import { AppointmentProtectionPanel } from "@/components/appointments/AppointmentProtectionPanel";
import { LaboratoryChecklist } from "@/components/appointments/LaboratoryChecklist";
import { PhysicalExamCompletionForm } from "@/components/appointments/PhysicalExamCompletionForm";
import { CertificateRevisionPanel } from "@/components/medical-certificates/CertificateRevisionPanel";
import { operationalStatusLabel, statusTone } from "@/components/appointments/status-labels";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { transaction } from "@/server/db/pool";
import { loadLaboratoryChecklist } from "@/server/laboratory/laboratory-checklist.repository";
import { certificateHistoryForAppointment, issuedCertificateForAppointment } from "@/server/medical-certificates/certificate.service";
import { loadPhysicalExamCompletionContext } from "@/server/medical-certificates/physical-exam-completion-context.service";
import { listPhysicians } from "@/server/medical-certificates/physician.service";
import { getPublishedAppointment } from "@/server/repositories/appointments.repository";
import type { HistoricalStaffActor } from "@/types/roles";

type Log = {
  id: string;
  oldStatus: string | null;
  newStatus: string;
  notes: string | null;
  changedById: string | null;
  changedByName: string | null;
  changedBy?: HistoricalStaffActor | null;
  createdAt: Date;
};

export type AppointmentDetailProps = {
  appointmentId: string;
  expectedScheduleType?: "LABORATORY" | "PHYSICAL_EXAM";
  source: "LABORATORY" | "PHYSICAL_EXAM";
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function statusLogTimestamp(value: Date) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

export async function AppointmentDetail({
  appointmentId,
  expectedScheduleType,
  source,
}: AppointmentDetailProps) {
  if (!UUID_PATTERN.test(appointmentId)) notFound();
  const user = await requireUser(["ADMIN", "CLINIC_STAFF"]);
  const appointment = await getPublishedAppointment(appointmentId);
  if (!appointment) notFound();
  if (expectedScheduleType && appointment.scheduleType !== expectedScheduleType) notFound();
  if (user.role === "CLINIC_STAFF" && user.clinicId !== appointment.clinicId) notFound();
  const statusLogs = appointment.statusLogs as Log[];
  const [issuedCertificate, physicians, certificateHistory] = appointment.scheduleType === "PHYSICAL_EXAM"
    ? await Promise.all([issuedCertificateForAppointment(appointmentId), listPhysicians(user), certificateHistoryForAppointment(appointmentId, user)])
    : [null, [], []];
  const pairedLaboratoryChecklist = appointment.scheduleType === "PHYSICAL_EXAM" && appointment.pairedLaboratoryAppointmentId
    ? await transaction((client) => loadLaboratoryChecklist(client, appointment.pairedLaboratoryAppointmentId!))
    : null;
  const completionContext = appointment.scheduleType === "PHYSICAL_EXAM" && !issuedCertificate
    && !appointment.academicYearEnded && ["PENDING", "NO_SHOW"].includes(appointment.status)
    ? await loadPhysicalExamCompletionContext(appointmentId, user) : null;

  return (
    <>
      <PageHeader
        title={String(appointment.studentName)}
        description={`${appointment.studentNumber} · ${String(appointment.scheduleType).replaceAll("_", " ")}`}
        actions={(
          <Badge tone={statusTone(String(appointment.status))}>
            {operationalStatusLabel(String(appointment.status))}
          </Badge>
        )}
      />
      {appointment.academicYearEnded ? <Alert tone="info">Academic year ended — historical record. Clinical and scheduling changes are closed.</Alert> : null}
      <Card>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-muted">Appointment date</p>
            <p className="mt-1 font-bold text-ink">{String(appointment.appointmentDate)}</p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-muted">Visibility</p>
            <p className="mt-1 font-bold text-ink">Published</p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-muted">Location</p>
            <p className="mt-1 font-bold text-ink">{String(appointment.locationName)}</p>
          </div>
        </div>
      </Card>
      {appointment.scheduleType === "PHYSICAL_EXAM" && pairedLaboratoryChecklist ? (
          <Card>
            <CardTitle>{appointment.isOvpsaFirstYear ? "External Laboratory verification" : "Laboratory progress"}</CardTitle>
            <p className="mt-1 text-sm text-muted">Laboratory test progress is read-only on this Physical Examination record.</p>
            <div className="mt-4"><LaboratoryChecklist appointmentId={pairedLaboratoryChecklist.appointmentId}
              initial={pairedLaboratoryChecklist}
              readOnly /></div>
          </Card>
        ) : null}
      <AppointmentProtectionPanel
        appointmentId={String(appointment.id)}
        status={String(appointment.status)}
        isManuallyLocked={Boolean(appointment.isManuallyLocked)}
        lockReason={appointment.lockReason ?? null}
        lockedByName={appointment.lockedByName ?? null}
        {...(appointment.lockedBy ? { lockedBy: appointment.lockedBy } : {})}
        lockedAt={appointment.lockedAt?.toISOString() ?? null}
        updatedAt={appointment.updatedAt.toISOString()}
        canManage={user.role === "ADMIN" && !appointment.academicYearEnded}
      />
      {appointment.scheduleType === "PHYSICAL_EXAM" ? <Card>
        <CardTitle>Medical certificate</CardTitle>
        <div className="mt-4">
          {issuedCertificate ? <CertificateRevisionPanel certificate={issuedCertificate}
            physicians={physicians} canRevoke={user.role === "ADMIN"} canCorrect={!appointment.academicYearEnded} />
          : !appointment.academicYearEnded && ["PENDING", "NO_SHOW"].includes(appointment.status) ? (
            <PhysicalExamCompletionForm {...completionContext!} />
          ) : <p className="text-sm text-muted">No issued certificate is available.</p>}
          {certificateHistory.length ? <div className="mt-6 border-t border-line pt-4">
            <h3 className="font-semibold">Certificate history</h3>
            <ul className="mt-2 grid gap-2">
              {certificateHistory.map((revision) => <li key={revision.revisionId} className="text-sm">
                Revision {revision.revisionNumber} · {revision.status.toLowerCase()} · Class {revision.classification}{" "}
                <a className="font-semibold text-cpu-navy underline"
                  href={`/api/medical-certificates/${revision.certificateId}/revisions/${revision.revisionId}/download`}>
                  Download historical JPG
                </a>
              </li>)}
            </ul>
          </div> : null}
        </div>
      </Card> : null}
      {!appointment.academicYearEnded ? <Card>
        <CardTitle>Update appointment</CardTitle>
        <div className="mt-4">
          {appointment.scheduleType === "LABORATORY" && !appointment.isOvpsaFirstYear ? (
            <LaboratoryChecklist appointmentId={String(appointment.id)} />
          ) : appointment.isOvpsaFirstYear && appointment.scheduleType === "LABORATORY" ? (
            <Alert tone={appointment.status === "COMPLETED" ? "success" : "info"}>
              {String(appointment.displayStatus)}. Laboratory tests at Iloilo Mission Hospital will be confirmed when CPU Clinic completes the Physical Examination.
            </Alert>
          ) : null}
          {!(appointment.isOvpsaFirstYear && appointment.scheduleType === "LABORATORY") ? <AppointmentActions
              id={String(appointment.id)}
              status={String(appointment.status)}
              isManuallyLocked={Boolean(appointment.isManuallyLocked)}
              updatedAt={appointment.updatedAt.toISOString()}
              basePath={source === "LABORATORY" ? "/laboratory" : "/physical-exam"}
            /> : null}
        </div>
      </Card> : null}
      <Card>
        <CardTitle>Status history</CardTitle>
        <div className="mt-4 grid gap-3">
          {statusLogs.map((log) => (
            <div key={log.id} className="rounded-xl border border-cpu-navy/8 bg-cpu-navy-soft/55 p-4 text-sm">
              <p className="font-bold text-ink">
                {log.oldStatus ? operationalStatusLabel(log.oldStatus) : "Created"} → {operationalStatusLabel(log.newStatus)}
              </p>
              <p className="text-muted">
                {log.changedBy?.fullName ?? log.changedByName ?? "System"} · {statusLogTimestamp(log.createdAt)}
              </p>
              {log.changedBy?.deleted ? <Badge tone="neutral">Deleted</Badge> : null}
              {log.notes ? <p className="mt-2">{log.notes}</p> : null}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
