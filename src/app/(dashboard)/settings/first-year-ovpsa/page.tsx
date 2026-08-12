import { notFound } from "next/navigation";

import { OvpsaFirstYearManager } from "@/components/settings/OvpsaFirstYearManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { listOvpsaFirstYearBatches } from "@/server/ovpsa/ovpsa-first-year.service";
import { listColleges } from "@/server/repositories/reference-data.repository";
import { listAcademicYears } from "@/server/services/academic-years.service";

export default async function FirstYearOvpsaPage() {
  try {
    await requireUser(["ADMIN"]);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) notFound();
    throw error;
  }
  const [batchResult, colleges, years] = await Promise.all([
    listOvpsaFirstYearBatches(),
    listColleges(),
    listAcademicYears(),
  ]);
  return (
    <>
      <PageHeader title="First Year OVPSA scheduling" description="Preview, publish, and maintain college-wide First Year Laboratory and Physical Examination priorities." />
      <OvpsaFirstYearManager
        batches={batchResult.items}
        colleges={colleges.filter((college) => college.isActive)}
        academicYears={years.filter((year) => year.state !== "CLOSED").map((year) => ({
          startYear: year.startYear,
          label: year.label,
        }))}
      />
    </>
  );
}
