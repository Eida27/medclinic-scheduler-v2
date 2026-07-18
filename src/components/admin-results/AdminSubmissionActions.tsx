"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export function AdminSubmissionActions({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  async function invalidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("Invalidate this submission and reopen student uploads?")) return;
    const form = new FormData(event.currentTarget);
    const response = await fetch(`/api/admin/student-result-submissions/${submissionId}/invalidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: form.get("reason") }),
    });
    const payload = await response.json();
    if (!response.ok) setError(payload.error?.message ?? "Unable to invalidate this submission.");
    else router.refresh();
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
      <form onSubmit={invalidate} className="grid gap-3">
        <Field label="Invalidation reason">
          <Input name="reason" minLength={3} maxLength={1000} required />
        </Field>
        <Button type="submit" variant="danger">Invalidate and reopen upload</Button>
      </form>
    </div>
  );
}
