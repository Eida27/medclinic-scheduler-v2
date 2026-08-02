import { redirect } from "next/navigation";
import { historicalReportRedirectTarget } from "@/lib/historical-report-redirect";

type ComplianceSearchParams = Record<string, string | undefined>;

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<ComplianceSearchParams>;
}) {
  redirect(historicalReportRedirectTarget(await searchParams, "compliance"));
}
