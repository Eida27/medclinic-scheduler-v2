"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function PublishButton({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function publish() {
    setPending(true);
    const response = await fetch("/api/appointments/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchId, confirm: true }),
    });
    if (response.ok) {
      setOpen(false);
      router.refresh();
    } else {
      setPending(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={pending}>Publish batch</Button>
      <ConfirmDialog
        open={open}
        title="Publish this batch?"
        description="Every draft appointment in this batch will become visible to students in public lookup."
        confirmLabel="Publish appointments"
        pending={pending}
        onCancel={() => setOpen(false)}
        onConfirm={publish}
      />
    </>
  );
}
