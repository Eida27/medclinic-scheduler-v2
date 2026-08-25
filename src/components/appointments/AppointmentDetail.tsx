import { notFound, redirect } from "next/navigation";
import { AppointmentActions } from "@/components/appointments/AppointmentActions";
import { AppointmentProtectionPanel } from "@/components/appointments/AppointmentProtectionPanel";
import { CompletedStatusCorrection } from "@/components/appointments/CompletedStatusCorrection";
import { ExternalLaboratoryVerificationPanel } from "@/components/appointments/ExternalLaboratoryVerificationPanel";
import { operationalStatusLabel, statusTone } from "@/components/appointments/status-labels";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { requireUser } from "@/server/auth/current-user";
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
  source: "APPOINTMENTS" | "LABORATORY" | "PHYSICAL_EXAM";
};

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
  const user = await requireUser(["ADMIN", "CLINIC_STAFF"]);
  const appointment = await getPublishedAppointment(appointmentId);
  if (!appointment) notFound();
  if (expectedScheduleType && appointment.scheduleType !== expectedScheduleType) notFound();
  if (user.role === "CLINIC_STAFF" && user.clinicId !== appointment.clinicId) notFound();
  if (source === "APPOINTMENTS") {
    redirect(
      appointment.scheduleType === "LABORATORY"
        ? `/laboratory/${appointment.id}`
        : `/physical-exam/${appointment.id}`,
    );
  }
  const statusLogs = appointment.statusLogs as Log[];
  const canCorrectNoShow = appointment.status === "NO_SHOW"
    && (user.role === "ADMIN" || user.clinicId === appointment.clinicId)
    && isAutomaticNoShowLog(statusLogs[0]);

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
      {appointment.isOvpsaFirstYear && appointment.scheduleType === "PHYSICAL_EXAM"
        && appointment.linkedOvpsaLaboratoryAppointmentId ? (
          <ExternalLaboratoryVerificationPanel
            laboratoryAppointmentId={appointment.linkedOvpsaLaboratoryAppointmentId}
            verified={Boolean(appointment.linkedOvpsaLaboratoryVerified)}
          />
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
        canManage={user.role === "ADMIN"}
      />
      <Card>
        <CardTitle>Update appointment</CardTitle>
        <div className="mt-4">
          {appointment.isOvpsaFirstYear && appointment.scheduleType === "LABORATORY" ? (
            <Alert tone={appointment.status === "COMPLETED" ? "success" : "info"}>
              {String(appointment.displayStatus)}. This Mission Hospital appointment is updated only through the linked Physical Examination verification panel.
            </Alert>
          ) : <AppointmentActions
              id={String(appointment.id)}
              status={String(appointment.status)}
              canCorrectNoShow={canCorrectNoShow}
              isManuallyLocked={Boolean(appointment.isManuallyLocked)}
              basePath={source === "LABORATORY" ? "/laboratory" : "/physical-exam"}
            />}
          {appointment.status === "COMPLETED" && !(appointment.isOvpsaFirstYear && appointment.scheduleType === "LABORATORY") ? (
            <div className="mt-5">
              <CompletedStatusCorrection
                appointmentId={String(appointment.id)}
                appointmentDate={String(appointment.appointmentDate)}
                source={source}
              />
            </div>
          ) : null}
        </div>
      </Card>
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
