"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const fallback = "Unable to sign in. Check your connection and try again.";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const payload = await readApiPayload<{ nextPath?: string }>(response);
      if (!response.ok) {
        setError(apiErrorMessage(payload, fallback));
        return;
      }
      router.replace(payload?.data?.nextPath ?? "/dashboard");
      router.refresh();
    } catch {
      setError(fallback);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Field label="Email address"><Input name="email" type="email" autoComplete="username" required /></Field>
      <Field label="Password"><Input name="password" type="password" autoComplete="current-password" required /></Field>
      <Button type="submit" className="mt-1 w-full" disabled={pending}>{pending ? "Signing in..." : "Sign in"}</Button>
    </form>
  );
}
