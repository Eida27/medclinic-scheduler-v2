import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { OnboardingPanel } from "@/components/account/OnboardingPanel";
import { requireAuthenticatedStaff } from "@/server/auth/current-user";
import { getStaffOnboardingState } from "@/server/services/staff-account-security.service";

export default async function AccountOnboardingPage() {
  let user: Awaited<ReturnType<typeof requireAuthenticatedStaff>>;
  try {
    user = await requireAuthenticatedStaff();
  } catch (error) {
    if (
      error instanceof AppError
      && error.status === 401
      && ["SESSION_EXPIRED", "UNAUTHENTICATED"].includes(error.code)
    ) {
      redirect("/login");
    }
    throw error;
  }
  if (!user.onboardingRequired) redirect("/dashboard");
  return <OnboardingPanel initialState={await getStaffOnboardingState(user.userId)} />;
}
