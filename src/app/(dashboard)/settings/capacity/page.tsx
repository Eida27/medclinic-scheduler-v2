import { CapacityForm } from "@/components/settings/CapacityForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { getCapacitySettings } from "@/server/repositories/appointments.repository";

export default async function CapacityPage() {
  await requireUser(["ADMIN"]);

  return (
    <>
      <PageHeader
        title="Daily capacity"
        description="Configure the maximum number of students each clinic service can handle per day."
      />
      <CapacityForm
        settings={await getCapacitySettings() as Array<{
          clinicCode: string;
          clinicName: string;
          scheduleType: string;
          maxDailyCapacity: number;
        }>}
      />
    </>
  );
}
