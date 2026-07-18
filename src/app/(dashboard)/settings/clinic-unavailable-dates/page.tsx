import { ClinicUnavailableDateForm } from "@/components/settings/ClinicUnavailableDateForm";
import { Card } from "@/components/ui/Card";
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
  return (
    <>
      <PageHeader
        title="Clinic unavailable dates"
        description="Block future clinic dates and atomically move affected schedules."
      />
      <div className="grid gap-6">
        <ClinicUnavailableDateForm clinics={clinics} />
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cpu-navy-soft/70 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-3">Clinic</th>
                  <th className="px-5 py-3">Dates</th>
                  <th className="px-5 py-3">Category</th>
                  <th className="px-5 py-3">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {unavailableDates.map((block) => (
                  <tr key={block.id}>
                    <td className="px-5 py-4 font-bold text-ink">{block.clinicName}</td>
                    <td className="px-5 py-4">{block.startDate}{block.endDate === block.startDate ? "" : ` – ${block.endDate}`}</td>
                    <td className="px-5 py-4">{block.category.replaceAll("_", " ")}</td>
                    <td className="px-5 py-4">{block.reason}</td>
                  </tr>
                ))}
                {unavailableDates.length === 0 ? (
                  <tr><td colSpan={4} className="px-5 py-8 text-center text-muted">No unavailable dates yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
