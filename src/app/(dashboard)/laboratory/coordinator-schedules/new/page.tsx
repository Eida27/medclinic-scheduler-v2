import { ScheduleBatchForm } from "@/components/schedules/ScheduleBatchForm";
import { ScheduleCsvImportForm } from "@/components/schedules/ScheduleCsvImportForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { assertClinicAccess } from "@/server/clinic-access";
import { clinicConfigs } from "@/server/clinics";
import { listColleges, listPriorityGroups, listPrograms } from "@/server/repositories/reference-data.repository";

const clinic = clinicConfigs.KABALAKA_CLINIC;

export default async function NewLaboratoryScheduleBatchPage() {
  const user = await requireUser();
  assertClinicAccess(user, clinic.code);
  const [colleges, programs, priorities] = await Promise.all([listColleges(), listPrograms(), listPriorityGroups()]);
  return <><PageHeader title="New laboratory schedule" description="Create KABALAKA Clinic laboratory requests from CSV import or manual encoding." /><div className="grid gap-6"><ScheduleCsvImportForm priorities={priorities} clinicCode={clinic.code} redirectBase="/laboratory/coordinator-schedules" /><ScheduleBatchForm colleges={colleges} programs={programs} priorities={priorities} clinicCode={clinic.code} forcedScheduleType={clinic.scheduleType} redirectBase="/laboratory/coordinator-schedules" /></div></>;
}
