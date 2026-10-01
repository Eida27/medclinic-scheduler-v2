"use client";

import { useState } from "react";
import Link from "next/link";
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
    } catch {
      setError("Unable to verify email. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  if (!token) return <Alert tone="danger">This verification link is missing its token.</Alert>;
  if (success) {
    return (
      <div className="grid gap-4">
        <p role="status" className="text-sm font-semibold text-success">Email verified successfully.</p>
        <p className="text-sm text-muted">You can return to your original tab to continue. If you opened this link in another browser, sign in to read your portal.</p>
        <Link href="/student" className="text-sm font-semibold">Go to student portal</Link>
      </div>
    );
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
