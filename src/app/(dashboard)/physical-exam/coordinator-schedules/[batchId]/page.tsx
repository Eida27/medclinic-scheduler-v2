import { redirect } from "next/navigation";

export default async function PhysicalExamBatchDetailsPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  redirect(`/coordinator-schedules/${encodeURIComponent((await params).batchId)}`);
}
