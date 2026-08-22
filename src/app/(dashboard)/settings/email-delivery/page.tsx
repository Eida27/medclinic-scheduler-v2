import { forbidden } from "next/navigation";
import { EmailDeliveryMonitor } from "@/components/settings/EmailDeliveryMonitor";
import { PageHeader } from "@/components/ui/PageHeader";
import { AppError } from "@/lib/errors";
import { requireAdministrator } from "@/server/auth/admin-authorization";
import { listAdminEmailDeliveries } from "@/server/services/admin-email-deliveries.service";

export default async function EmailDeliveryPage() {
  try {
    await requireAdministrator();
  } catch (error) {
    if (error instanceof AppError && error.status === 403) forbidden();
    throw error;
  }
  const deliveries = await listAdminEmailDeliveries({});
  return (
    <>
      <PageHeader
        title="Email delivery"
        description="Review actionable delivery failures and audit delivery history without exposing email content or provider details."
      />
      <EmailDeliveryMonitor initialItems={deliveries.items} />
    </>
  );
}
