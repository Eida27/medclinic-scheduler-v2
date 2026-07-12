import { ClinicPublishedSchedule } from "@/components/appointments/ClinicPublishedSchedule";
import { requireUser } from "@/server/auth/current-user";
import { assertClinicAccess } from "@/server/clinic-access";
import { clinicConfigs } from "@/server/clinics";
import { listAppointments } from "@/server/repositories/appointments.repository";

const clinic = clinicConfigs.KABALAKA_CLINIC;

export default async function LaboratoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  assertClinicAccess(user, clinic.code);
  const params = await searchParams;
  const result = await listAppointments({
    clinicCode: "KABALAKA_CLINIC",
    appointmentDate: params.appointmentDate,
    scheduleType: "LABORATORY",
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
      title="Published laboratory schedule"
      description={`${result.total} published KABALAKA Clinic laboratory appointment${singular ? "" : "s"} ${singular ? "matches" : "match"} the current filters.`}
      emptyMessage="No published laboratory appointments match these filters."
      filters={params}
      appointments={result.items}
    />
  );
}
