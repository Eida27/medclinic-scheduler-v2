"use client";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export function ForgotPasswordForm() {
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true);
    const form = new FormData(event.currentTarget);
    try { await fetch("/api/auth/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.get("email") }) }); }
    finally { setMessage("If an eligible account exists for that email, a password reset message has been sent."); setPending(false); }
  }
  return <form onSubmit={submit} className="grid gap-4">{message ? <Alert tone="success">{message}</Alert> : null}<Field label="Email address"><Input name="email" type="email" autoComplete="email" required /></Field><Button type="submit" disabled={pending}>{pending ? "Sending..." : "Send reset link"}</Button></form>;
}
