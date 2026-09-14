"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function DeactivateStudentButton({ studentNumber }: { studentNumber: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const pendingRef = useRef(false);
  async function deactivate() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    const fallback = "Unable to deactivate student. Check your connection and try again.";
    try {
      const response = await fetch(`/api/students/${encodeURIComponent(studentNumber)}`, { method: "DELETE" });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        setError(apiErrorMessage(payload, fallback));
        return;
      }
      setOpen(false);
      router.push("/students");
      router.refresh();
    } catch {
      setError(fallback);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <>
      <Button variant="danger" onClick={() => { setError(undefined); setOpen(true); }} disabled={pending}>Deactivate</Button>
      <ConfirmDialog
        open={open}
        title="Deactivate this student?"
        description="The student will no longer be eligible for new schedules. Existing appointment and result history will be preserved."
        error={error}
        confirmLabel="Deactivate student"
        pending={pending}
        danger
        onCancel={() => setOpen(false)}
        onConfirm={deactivate}
      />
    </>
  );
}
