import { redirect } from "next/navigation";
import {
  historicalReportRedirectTarget,
  type LegacyReportParams,
} from "@/lib/historical-report-redirect";

type AppointmentsSearchParams = LegacyReportParams;

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<AppointmentsSearchParams>;
}) {
  redirect(historicalReportRedirectTarget(await searchParams, "appointments"));
}
