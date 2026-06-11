import { CapacityForm } from "@/components/settings/CapacityForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { getCapacitySettings } from "@/server/repositories/appointments.repository";
export default async function CapacityPage() { await requireUser(["ADMIN"]); return <><PageHeader title="Daily capacity" description="Configure warning and maximum limits independently per clinic service." /><CapacityForm settings={await getCapacitySettings() as Array<{ scheduleType: string; safeDailyCapacity: number; maxDailyCapacity: number }>} /></>; }
