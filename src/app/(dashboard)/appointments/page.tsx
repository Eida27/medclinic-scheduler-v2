import { redirect } from "next/navigation";
import { historicalReportRedirectTarget } from "@/lib/historical-report-redirect";

type AppointmentsSearchParams = Record<string, string | undefined>;

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<AppointmentsSearchParams>;
}) {
  redirect(historicalReportRedirectTarget(await searchParams, "appointments"));
}
