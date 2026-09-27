import { PhysicianProfiles } from "@/components/settings/PhysicianProfiles";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireUser } from "@/server/auth/current-user";
import { listPhysicians } from "@/server/medical-certificates/physician.service";

export default async function MedicalCertificatePhysiciansPage() {
  const actor = await requireUser(["ADMIN"]);
  return <>
    <PageHeader title="Certificate physicians" description="Configure authorized physician identities and signatures before issuing medical certificates." />
    <PhysicianProfiles profiles={await listPhysicians(actor, true)} />
  </>;
}
