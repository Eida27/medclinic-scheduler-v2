import { notFound } from "next/navigation";

import { OvpsaFirstYearBatchEditor, type OvpsaFirstYearBatchDetail } from "@/components/settings/OvpsaFirstYearBatchEditor";
import { PageHeader } from "@/components/ui/PageHeader";
import { AppError } from "@/lib/errors";
import { requireUser } from "@/server/auth/current-user";
import { getOvpsaFirstYearBatch } from "@/server/ovpsa/ovpsa-first-year.service";

export default async function FirstYearOvpsaBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  try {
    await requireUser(["ADMIN"]);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) notFound();
    throw error;
  }
  const detail = await getOvpsaFirstYearBatch((await params).batchId);
  return (
    <>
      <PageHeader title={`${detail.collegeName} First Year batch`} description={`AY ${detail.scheduleCycleStart}–${detail.scheduleCycleStart + 1} · Revision ${detail.revisionNumber}`} />
      <OvpsaFirstYearBatchEditor initial={detail as OvpsaFirstYearBatchDetail} />
    </>
  );
}
