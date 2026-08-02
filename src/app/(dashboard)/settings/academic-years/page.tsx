import { AcademicYearsManager } from "@/components/settings/AcademicYearsManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { listAcademicYears } from "@/server/services/academic-years.service";

export default async function AcademicYearsPage() {
  await requireUser(["ADMIN"]);
  const years = await listAcademicYears();
  const items = years.map((year) => ({
    startYear: year.startYear,
    label: year.label,
    closingDate: year.closingDate,
    state: year.state,
    linkedSnapshotCount: year.linkedSnapshotCount,
  }));
  return (
    <>
      <PageHeader
        title="Academic years"
        description="Configure reporting cycles and the dates when historical compliance closes."
      />
      <AcademicYearsManager
        key={items.map((year) => (
          `${year.startYear}:${year.closingDate}:${year.linkedSnapshotCount}`
        )).join("|")}
        years={items}
      />
    </>
  );
}
