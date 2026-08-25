import { redirect } from "next/navigation";
import { OnboardingPanel } from "@/components/account/OnboardingPanel";
import { requireAuthenticatedStaff } from "@/server/auth/current-user";
import { getStaffOnboardingState } from "@/server/services/staff-account-security.service";

export default async function AccountOnboardingPage() {
  const user = await requireAuthenticatedStaff();
  if (!user.onboardingRequired) redirect("/dashboard");
  return <OnboardingPanel initialState={await getStaffOnboardingState(user.userId)} />;
}
