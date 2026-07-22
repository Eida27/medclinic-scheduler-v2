import { notFound } from "next/navigation";
import { AppointmentActions } from "@/components/appointments/AppointmentActions";
import { CompletedStatusCorrection } from "@/components/appointments/CompletedStatusCorrection";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { isAutomaticNoShowLog } from "@/server/appointments/automatic-no-show";
import { requireUser } from "@/server/auth/current-user";
import { getPublishedAppointment } from "@/server/repositories/appointments.repository";

type Log = {
  id: string;
  oldStatus: string | null;
  newStatus: string;
  notes: string | null;
  changedById: string | null;
  changedByName: string | null;
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
          <Badge tone={appointment.status === "COMPLETED" ? "success" : "warning"}>
            {String(appointment.status)}
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
        </div>
      </Card>
      <Card>
        <CardTitle>Update appointment</CardTitle>
        <div className="mt-4">
          <AppointmentActions
            id={String(appointment.id)}
            status={String(appointment.status)}
            canCorrectNoShow={canCorrectNoShow}
          />
          {appointment.status === "COMPLETED" ? (
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
              <p className="font-bold text-ink">{log.oldStatus ?? "Created"} → {log.newStatus}</p>
              <p className="text-muted">
                {log.changedByName ?? "System"} · {statusLogTimestamp(log.createdAt)}
              </p>
              {log.notes ? <p className="mt-2">{log.notes}</p> : null}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
