import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { listScheduleBatches } from "@/server/repositories/coordinator-schedules.repository";

export default async function ScheduleBatchesPage() {
  const batches = await listScheduleBatches();
  return <><PageHeader title="Coordinator schedules" description="Validate and generate appointments from coordinator submissions." actions={<Link href="/coordinator-schedules/new" className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-bold text-white">New batch</Link>} /><Card className="overflow-hidden p-0"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50"><tr><th className="px-5 py-3">Batch</th><th className="px-5 py-3">Items</th><th className="px-5 py-3">Validation</th><th className="px-5 py-3">Status</th><th className="px-5 py-3"></th></tr></thead><tbody className="divide-y divide-slate-100">{batches.map((batch) => <tr key={batch.id}><td className="px-5 py-4"><p className="font-bold">{batch.batchName}</p><p className="text-xs text-slate-500">{batch.programName ?? batch.collegeName ?? "Mixed groups"}</p></td><td className="px-5 py-4">{batch.itemCount}</td><td className="px-5 py-4"><span className="text-red-700">{batch.conflictCount} conflicts</span> · <span className="text-amber-700">{batch.warningCount} warnings</span></td><td className="px-5 py-4"><Badge tone={batch.status === "PUBLISHED" ? "success" : batch.status === "GENERATED" ? "info" : "neutral"}>{batch.status}</Badge></td><td className="px-5 py-4 text-right"><Link className="font-bold text-teal-700" href={`/coordinator-schedules/${batch.id}`}>Open</Link></td></tr>)}</tbody></table></div></Card></>;
}
