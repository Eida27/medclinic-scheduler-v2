import { ClinicPublishedSchedule } from "@/components/appointments/ClinicPublishedSchedule";
import { ClinicAccessRestricted } from "@/components/clinic/ClinicAccessRestricted";
import {
  APPOINTMENT_PAGE_SIZE,
  parseAppointmentPage,
} from "@/components/appointments/appointment-pagination";
import { parseAppointmentListSort } from "@/components/appointments/appointment-list-sort";
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
  if (user.role === "CLINIC_STAFF" && user.clinicCode === "KABALAKA_CLINIC") {
    return (
      <ClinicAccessRestricted
        title="Physical Exam access restricted"
        message="This account is assigned to KABALAKA Clinic. You can only access the Laboratory tab."
      />
    );
  }
  assertClinicAccess(user, clinic.code);
  const params = await searchParams;
  const page = parseAppointmentPage(params.page);
  const sort = parseAppointmentListSort(params.sort);
  const result = await listAppointments({
    clinicCode: "CPU_CLINIC",
    appointmentDate: params.appointmentDate,
    scheduleType: "PHYSICAL_EXAM",
    status: params.status,
    studentNumber: params.studentNumber,
    sort,
    isPublished: true,
    includeLaboratoryStatus: true,
    page,
    limit: APPOINTMENT_PAGE_SIZE,
    offset: (page - 1) * APPOINTMENT_PAGE_SIZE,
  });
  const singular = result.total === 1;

  return (
    <ClinicPublishedSchedule
      basePath="/physical-exam"
      title="Published physical examination schedule"
      description={`${result.total} published CPU Clinic physical examination appointment${singular ? "" : "s"} ${singular ? "matches" : "match"} the current filters.`}
      emptyMessage="No published physical examination appointments match these filters."
      page={page}
      total={result.total}
      filters={{ ...params, sort }}
      appointments={result.items}
      showLaboratoryStatus
    />
  );
}
