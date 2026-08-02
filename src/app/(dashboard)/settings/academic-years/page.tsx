import { notFound } from "next/navigation";
import { AcademicYearsManager } from "@/components/settings/AcademicYearsManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { listAcademicYears } from "@/server/services/academic-years.service";

export default async function AcademicYearsPage() {
  try {
    await requireUser(["ADMIN"]);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) notFound();
    throw error;
  }
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
