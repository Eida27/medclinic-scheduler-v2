import { ClinicUnavailableCalendar } from "@/components/settings/ClinicUnavailableCalendar";
import { manilaToday } from "@/components/settings/clinic-calendar";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import {
  listClinicOptions,
  listClinicUnavailableDateRecords,
} from "@/server/repositories/clinic-unavailable-dates.repository";

export default async function ClinicUnavailableDatesPage() {
  await requireUser(["ADMIN"]);
  const [clinics, unavailableDates] = await Promise.all([
    listClinicOptions(),
    listClinicUnavailableDateRecords(),
  ]);
  const today = manilaToday();
  return (
    <>
      <PageHeader
        title="Clinic unavailable dates"
        description="Block future clinic dates and atomically move affected schedules."
      />
      <ClinicUnavailableCalendar
        clinics={clinics}
        unavailableDates={unavailableDates}
        initialMonth={today.slice(0, 7)}
        today={today}
      />
    </>
  );
}
