import { UsersManager } from "@/components/settings/UsersManager";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { listUsers } from "@/server/services/users.service";

export default async function UsersPage() {
  await requireUser(["ADMIN"]);
  return <><PageHeader title="Clinic users" description="Manage administrator and clinic staff access." /><UsersManager users={await listUsers()} /></>;
}
