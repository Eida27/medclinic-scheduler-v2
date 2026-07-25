"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";

type Props = {
  submissionId: string;
  resultLabel: "Laboratory" | "Physical Exam";
  appointmentDate: string;
  submissionIndex?: number;
};

export function AdminSubmissionActions({
  submissionId,
  resultLabel,
  appointmentDate,
  submissionIndex = 1,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [invalidationReason, setInvalidationReason] = useState("");
  const [pending, setPending] = useState(false);

  function reviewInvalidation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(undefined);
    setInvalidationReason(String(form.get("reason")));
    setConfirmOpen(true);
  }

  async function invalidate() {
    setError(undefined);
    setPending(true);
    try {
      const response = await fetch(`/api/admin/student-result-submissions/${submissionId}/invalidate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: invalidationReason }),
      });
      const payload: { error?: { message?: string } } = await response.json();
      if (!response.ok) {
        setError(payload.error?.message ?? "Unable to invalidate this submission.");
        if (response.status === 409) {
          setConfirmOpen(false);
          router.refresh();
        }
      } else {
        setConfirmOpen(false);
        router.refresh();
      }
    } catch {
      setError("Unable to invalidate this submission.");
    } finally {
      setPending(false);
    }
  }

  function closeConfirmation() {
    setConfirmOpen(false);
    setError(undefined);
  }

  return (
    <section
      aria-label={`${resultLabel} submission actions`}
      className="grid min-w-0 gap-4 rounded-2xl border border-line bg-canvas p-4"
    >
      {error && !confirmOpen ? <Alert tone="danger">{error}</Alert> : null}
      <div className="grid gap-1">
        <h3 className="font-semibold text-ink">Submission actions</h3>
        <p className="text-sm text-muted">
          Download finalized files, or invalidate this submission to let the student upload a replacement.
        </p>
      </div>
      <a
        href={`/api/admin/student-result-submissions/${submissionId}/zip`}
        aria-label={`Download ${resultLabel} ZIP for appointment ${appointmentDate}, submission ${submissionIndex}`}
        className="inline-flex h-11 w-full max-w-full items-center justify-center whitespace-normal rounded-xl bg-cpu-navy px-4 text-center text-sm font-semibold text-white"
      >
        Download all files (ZIP)
      </a>
      <div className="grid gap-3 rounded-xl border border-line p-3">
        <h4 className="font-semibold text-ink">Reopen student upload</h4>
        <form onSubmit={reviewInvalidation} className="grid gap-3">
          <Field label={`${resultLabel} invalidation reason`}>
            <Textarea name="reason" rows={4} minLength={3} maxLength={1000} required />
          </Field>
          <Button
            type="submit"
            variant="danger"
            disabled={pending}
            aria-label={`Invalidate ${resultLabel} and reopen upload`}
            className="h-auto min-h-11 w-full whitespace-normal py-3 text-center leading-snug"
          >
            Invalidate and reopen upload
          </Button>
        </form>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title={`Invalidate ${resultLabel} submission?`}
        description="The student will regain upload access and the finalized files will be revoked."
        error={error}
        confirmLabel={`Invalidate ${resultLabel} submission`}
        pending={pending}
        pendingLabel="Invalidating..."
        danger
        onCancel={closeConfirmation}
        onConfirm={invalidate}
      />
    </section>
  );
}
