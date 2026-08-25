import { AccountSecurityPanel } from "@/components/account/AccountSecurityPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { getStaffAccountSummary } from "@/server/services/staff-account-security.service";

export default async function AccountPage() {
  const user = await requireUser();
  return <><PageHeader title="Account" description="Review your staff identity and keep your password secure." /><AccountSecurityPanel account={await getStaffAccountSummary(user.userId)} /></>;
}
