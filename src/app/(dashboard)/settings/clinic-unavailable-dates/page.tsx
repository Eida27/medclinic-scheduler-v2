import { ClinicUnavailableCalendar } from "@/components/settings/ClinicUnavailableCalendar";
import { manilaToday } from "@/components/settings/clinic-calendar";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import {
  listClinicUnavailableDateRecords,
} from "@/server/repositories/clinic-unavailable-dates.repository";
import { listClinicClosureManualCases } from "@/server/services/clinic-calendar.service";

export default async function ClinicUnavailableDatesPage() {
  const actor = await requireUser(["ADMIN", "CLINIC_STAFF"]);
  const [unavailableDates, manualCases] = await Promise.all([
    listClinicUnavailableDateRecords(),
    actor.role === "ADMIN"
      ? listClinicClosureManualCases({ page: 1, pageSize: 1, status: "OPEN" }, actor)
      : Promise.resolve({ total: 0 }),
  ]);
  const today = manilaToday();
  return (
    <>
      <PageHeader
        title="Clinic unavailable dates"
        description="Review the unified annual calendar used by every clinic scheduling workflow."
      />
      <ClinicUnavailableCalendar
        unavailableDates={unavailableDates}
        initialYear={Number(today.slice(0, 4))}
        today={today}
        maxYear={2100}
        readOnly={actor.role !== "ADMIN"}
        openManualCaseCount={manualCases.total}
      />
    </>
  );
}
