"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export function AdminSubmissionActions({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [invalidationReason, setInvalidationReason] = useState("");
  const [pending, setPending] = useState(false);

  function reviewInvalidation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setInvalidationReason(String(form.get("reason")));
    setConfirmOpen(true);
  }

  async function invalidate() {
    setPending(true);
    const response = await fetch(`/api/admin/student-result-submissions/${submissionId}/invalidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: invalidationReason }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) setError(payload.error?.message ?? "Unable to invalidate this submission.");
    else {
      setConfirmOpen(false);
      router.refresh();
    }
  }
  return (
    <div className="grid gap-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <a
        href={`/api/admin/student-result-submissions/${submissionId}/zip`}
        className="inline-flex h-11 items-center justify-center rounded-xl bg-cpu-navy px-4 text-sm font-semibold text-white"
      >
        Download ZIP
      </a>
      <form onSubmit={reviewInvalidation} className="grid gap-3">
        <Field label="Invalidation reason">
          <Input name="reason" minLength={3} maxLength={1000} required />
        </Field>
        <Button type="submit" variant="danger" disabled={pending}>Invalidate and reopen upload</Button>
      </form>
      <ConfirmDialog
        open={confirmOpen}
        title="Invalidate this submission?"
        description="The student will regain upload access and the finalized files will be revoked."
        confirmLabel="Invalidate submission"
        pending={pending}
        pendingLabel="Invalidating..."
        danger
        onCancel={() => setConfirmOpen(false)}
        onConfirm={invalidate}
      />
    </div>
  );
}
