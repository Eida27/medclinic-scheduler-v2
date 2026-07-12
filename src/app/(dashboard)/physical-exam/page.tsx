import { ClinicPublishedSchedule } from "@/components/appointments/ClinicPublishedSchedule";
import { requireUser } from "@/server/auth/current-user";
import { assertClinicAccess } from "@/server/clinic-access";
import { clinicConfigs } from "@/server/clinics";
import { listAppointments } from "@/server/repositories/appointments.repository";

const clinic = clinicConfigs.CPU_CLINIC;

export default async function PhysicalExamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  assertClinicAccess(user, clinic.code);
  const params = await searchParams;
  const result = await listAppointments({
    clinicCode: "CPU_CLINIC",
    appointmentDate: params.appointmentDate,
    scheduleType: "PHYSICAL_EXAM",
    status: params.status,
    studentNumber: params.studentNumber,
    isPublished: true,
    page: 1,
    limit: 100,
    offset: 0,
  });
  const singular = result.total === 1;

  return (
    <ClinicPublishedSchedule
      title="Published physical examination schedule"
      description={`${result.total} published CPU Clinic physical examination appointment${singular ? "" : "s"} ${singular ? "matches" : "match"} the current filters.`}
      emptyMessage="No published physical examination appointments match these filters."
      filters={params}
      appointments={result.items}
    />
  );
}
