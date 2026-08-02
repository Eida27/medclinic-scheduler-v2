import { redirect } from "next/navigation";
import {
  historicalReportRedirectTarget,
  type LegacyReportParams,
} from "@/lib/historical-report-redirect";

type ComplianceSearchParams = LegacyReportParams;

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<ComplianceSearchParams>;
}) {
  redirect(historicalReportRedirectTarget(await searchParams, "compliance"));
}
