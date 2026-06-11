"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";

export function PublishButton({ batchId }: { batchId: string }) {
  const router = useRouter(); const [pending, setPending] = useState(false);
  async function publish() { if (!window.confirm("Publish every draft appointment in this batch to students?")) return; setPending(true); const response = await fetch("/api/appointments/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId, confirm: true }) }); if (response.ok) router.refresh(); else setPending(false); }
  return <Button onClick={publish} disabled={pending}>{pending ? "Publishing..." : "Publish batch"}</Button>;
}
