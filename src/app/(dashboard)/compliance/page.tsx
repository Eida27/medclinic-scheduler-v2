import { redirect } from "next/navigation";

type ComplianceSearchParams = Record<string, string | undefined>;

const passthroughFilters = [
  "appointmentStatus",
  "collegeId",
  "programId",
  "priorityGroupId",
  "physicalExamStatus",
  "laboratoryStatus",
  "overallStatus",
  "sort",
  "page",
  "appointmentDate",
] as const;

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<ComplianceSearchParams>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  const studentNumber = params.studentNumber ?? params.search;
  if (studentNumber) query.set("studentNumber", studentNumber);
  for (const name of passthroughFilters) {
    if (params[name]) query.set(name, params[name]);
  }
  redirect(`/appointments${query.size ? `?${query.toString()}` : ""}`);
}
