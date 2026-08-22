"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

export function EmailVerificationConfirmation({ token }: { token: string | null }) {
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string>();

  async function verify() {
    if (!token) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/student/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await response.json();
      if (!response.ok) setError(payload.error?.message ?? "Unable to verify email.");
      else setSuccess(true);
    } finally {
      setPending(false);
    }
  }

  if (!token) return <Alert tone="danger">This verification link is missing its token.</Alert>;
  if (success) {
    return <p role="status" className="text-sm font-semibold text-success">Email verified successfully. You may return to the MedClinic student portal.</p>;
  }
  return (
    <div className="grid gap-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p className="text-sm text-muted">Press Verify email to confirm ownership. Opening this page alone does not consume the link.</p>
      <Button type="button" onClick={verify} disabled={pending}>
        {pending ? "Verifying..." : "Verify email"}
      </Button>
    </div>
  );
}
