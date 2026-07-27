import Link from "next/link";
import { ManualResolutionQueue } from "@/components/settings/ManualResolutionQueue";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";

export default async function ManualResolutionPage() {
  await requireUser(["ADMIN"]);
  return (
    <>
      <PageHeader
        title="Manual Resolution Required"
        description="Review completion-aware closure exceptions and assign or approve a safe replacement."
      />
      <Link
        href="/settings/clinic-unavailable-dates"
        className="mb-4 inline-block text-sm font-semibold text-cpu-navy underline"
      >
        Back to clinic calendar
      </Link>
      <ManualResolutionQueue />
    </>
  );
}
