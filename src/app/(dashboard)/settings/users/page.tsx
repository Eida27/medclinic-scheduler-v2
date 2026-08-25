import { UsersManager } from "@/components/settings/UsersManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { listStaffUsers } from "@/server/services/staff-administration.service";

export default async function UsersPage() {
  const user = await requireUser(["ADMIN"]);
  return <><PageHeader title="Clinic users" description="Manage secure onboarding, credentials, email verification, and permanent account deletion." /><UsersManager users={await listStaffUsers()} currentUserId={user.userId} /></>;
}
