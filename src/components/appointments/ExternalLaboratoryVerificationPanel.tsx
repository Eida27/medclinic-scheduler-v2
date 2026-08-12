"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";

export function ExternalLaboratoryVerificationPanel(props: {
  laboratoryAppointmentId: string;
  verified: boolean;
}) {
  const router = useRouter();
  const [remarks, setRemarks] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(props.verified);

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/appointments/${props.laboratoryAppointmentId}/external-laboratory-verification`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ remarks: remarks.trim() || null }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "Verification failed.");
      setCompleted(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Verification failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardTitle>External Laboratory result</CardTitle>
      <p className="mt-1 text-sm text-muted">Iloilo Mission Hospital · linked First Year Laboratory appointment</p>
      {completed ? <div className="mt-4"><Alert tone="success">External Laboratory result verified. The Physical Examination may now be completed.</Alert></div> : (
        <form className="mt-4 space-y-4" onSubmit={verify}>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Alert tone="warning">Physical Examination completion remains blocked until this result is verified.</Alert>
          <Field label="Verification remarks">
            <Textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="Optional Mission Hospital result remarks" />
          </Field>
          <Button type="submit" disabled={pending}>{pending ? "Verifying…" : "Verify Mission Hospital result"}</Button>
        </form>
      )}
    </Card>
  );
}
