"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined); setPending(true); const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/reset-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, newPassword: form.get("newPassword"), confirmPassword: form.get("confirmPassword") }) });
      const payload = await response.json();
      if (!response.ok) { setError(payload.error?.message ?? "Unable to reset the password."); return; }
      router.replace(payload.data?.nextPath ?? "/login"); router.refresh();
    } catch { setError("Unable to reset the password."); }
    finally { setPending(false); }
  }
  return <form onSubmit={submit} className="grid gap-4">{error ? <Alert tone="danger">{error}</Alert> : null}<Field label="New password"><Input name="newPassword" type="password" minLength={8} maxLength={100} autoComplete="new-password" required /></Field><Field label="Confirm new password"><Input name="confirmPassword" type="password" minLength={8} maxLength={100} autoComplete="new-password" required /></Field><Button type="submit" disabled={pending}>{pending ? "Resetting..." : "Reset password"}</Button></form>;
}
