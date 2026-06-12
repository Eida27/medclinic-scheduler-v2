"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function DeactivateStudentButton({ studentNumber }: { studentNumber: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  async function deactivate() {
    setPending(true);
    const response = await fetch(`/api/students/${encodeURIComponent(studentNumber)}`, { method: "DELETE" });
    if (response.ok) {
      setOpen(false);
      router.push("/students");
      router.refresh();
    } else {
      setPending(false);
    }
  }
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)} disabled={pending}>Deactivate</Button>
      <ConfirmDialog
        open={open}
        title="Deactivate this student?"
        description="The student will no longer be eligible for new schedules. Existing appointment and result history will be preserved."
        confirmLabel="Deactivate student"
        pending={pending}
        danger
        onCancel={() => setOpen(false)}
        onConfirm={deactivate}
      />
    </>
  );
}
