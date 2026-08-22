"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

type RequestPayload = {
  data?: { expiresAt?: string; resendAvailableAt?: string };
  error?: { message?: string; details?: { retryAfterSeconds?: number } };
};

export function EmailVerificationForm({ verifiedEmail }: { verifiedEmail: string | null }) {
  const router = useRouter();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (verifiedEmail) return;
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch("/api/student/email/status", { cache: "no-store" });
        const payload = await response.json();
        if (active && response.ok && payload.data?.verified) {
          router.replace("/student");
          router.refresh();
        }
      } catch {
        // The next five-second poll retries transient connectivity failures.
      }
    };
    const interval = window.setInterval(poll, 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [router, verifiedEmail]);

  async function requestVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/student/email/request-verification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email") }),
      });
      const payload = await response.json() as RequestPayload;
      if (!response.ok) {
        const retry = payload.error?.details?.retryAfterSeconds;
        setError(`${payload.error?.message ?? "Unable to request verification."}${retry ? ` Try again in ${retry} seconds.` : ""}`);
      } else {
        const resend = payload.data?.resendAvailableAt
          ? new Date(payload.data.resendAvailableAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
          : "one minute";
        setMessage(`Check that email for a verification link. It expires in 30 minutes. Resend available at ${resend}.`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-5">
      {verifiedEmail ? <Alert tone="success">Verified email: {verifiedEmail}</Alert> : (
        <Alert tone="warning">Email verification is required before you can use the student portal.</Alert>
      )}
      {message ? <p role="status" className="text-sm text-success">{message}</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form onSubmit={requestVerification} className="grid gap-4">
        <Field label={verifiedEmail ? "Replacement email" : "Email address"}>
          <Input type="email" name="email" required />
        </Field>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Sending..." : "Send verification link"}
        </Button>
      </form>
      <p className="text-sm text-muted">
        {verifiedEmail
          ? "Your current verified address remains active until the replacement is verified."
          : "Keep this page open. It checks your verification status every five seconds."}
      </p>
    </div>
  );
}
