"use client";

import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export function EmailVerificationForm({ verifiedEmail }: { verifiedEmail: string | null }) {
  const searchParams = useSearchParams();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const token = searchParams.get("token");

  async function requestVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/student/email/request-verification", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email") }),
    });
    const payload = await response.json();
    if (!response.ok) setError(payload.error?.message ?? "Unable to request verification.");
    else setMessage("Check that email for a verification link. It expires in 30 minutes.");
  }

  async function verify() {
    if (!token) return;
    setError(undefined);
    const response = await fetch("/api/student/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json();
    if (!response.ok) setError(payload.error?.message ?? "Unable to verify email.");
    else setMessage(`Verified ${payload.data.email}.`);
  }

  return (
    <div className="grid gap-5">
      {verifiedEmail ? <Alert tone="success">Verified email: {verifiedEmail}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {token ? <Button onClick={verify}>Verify this email</Button> : null}
      <form onSubmit={requestVerification} className="grid gap-4">
        <Field label={verifiedEmail ? "Replacement email" : "Email address"}>
          <Input type="email" name="email" required />
        </Field>
        <Button type="submit">Send verification link</Button>
      </form>
      <p className="text-sm text-muted">
        Email is optional. Your current verified address stays active until a replacement is verified.
      </p>
    </div>
  );
}
