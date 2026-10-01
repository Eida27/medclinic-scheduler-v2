"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { studentVerificationReturn } from "@/lib/student-verification-return";

type RequestPayload = {
  data?: { expiresAt?: string; resendAvailableAt?: string };
  error?: { message?: string; details?: { retryAfterSeconds?: number } };
};

export function EmailVerificationForm({ verifiedEmail, returnTo = "/student" }: { verifiedEmail: string | null; returnTo?: string }) {
  const router = useRouter();
  const destination = studentVerificationReturn(returnTo);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    if (verifiedEmail || sessionExpired) return;
    let active = true;
    let inFlight = false;
    const stop = () => {
      active = false;
      window.clearInterval(interval);
    };
    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/student/email/status", { cache: "no-store" });
        if (!active) return;
        if (response.status === 401) {
          stop();
          setSessionExpired(true);
          return;
        }
        const payload = await response.json();
        if (active && response.ok && payload.data?.verified) {
          stop();
          router.replace(destination);
          router.refresh();
        }
      } catch {
        // The next five-second poll retries transient connectivity failures.
      } finally {
        inFlight = false;
      }
    };
    const interval = window.setInterval(poll, 5_000);
    return () => {
      stop();
    };
  }, [destination, router, sessionExpired, verifiedEmail]);

  async function requestVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sessionExpired || submitting) return;
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
    } catch {
      setError("Unable to request verification. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-5">
      {verifiedEmail ? <Alert tone="success">Verified email: {verifiedEmail}</Alert> : (
        <Alert tone="warning">Verify your email address before uploading or updating Laboratory documents.</Alert>
      )}
      {sessionExpired ? (
        <Alert tone="warning">Your session expired. <Link href="/student/login">Sign in</Link> to continue.</Alert>
      ) : null}
      {message ? <p role="status" className="text-sm text-success">{message}</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form onSubmit={requestVerification} className="grid gap-4">
        <Field label={verifiedEmail ? "Replacement email" : "Email address"}>
          <Input type="email" name="email" required disabled={sessionExpired} />
        </Field>
        <Button type="submit" disabled={submitting || sessionExpired}>
          {submitting ? "Sending..." : "Send verification link"}
        </Button>
      </form>
      <p className="text-sm text-muted">
        {verifiedEmail
          ? "Your current verified address remains active until the replacement is verified."
          : "Keep this page open. It checks your verification status every five seconds."}
      </p>
      <Link href="/student" className="text-sm font-semibold">Back to schedule</Link>
    </div>
  );
}
