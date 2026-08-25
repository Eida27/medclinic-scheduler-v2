"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

type OnboardingState = { emailMasked: string; emailVerified: boolean; mustChangePassword: boolean; status: "PENDING_VERIFICATION" | "PASSWORD_CHANGE_REQUIRED" | "ACTIVE"; resendAvailableAt: string; retryAfterSeconds: number };
export function OnboardingPanel({ initialState }: { initialState: OnboardingState }) {
  const router = useRouter(); const [state, setState] = useState(initialState); const [error, setError] = useState<string>(); const [message, setMessage] = useState<string>(); const [pending, setPending] = useState(false);
  const cooldownActive = !state.emailVerified && state.retryAfterSeconds > 0;
  useEffect(() => {
    if (!cooldownActive) return;
    const timer = window.setInterval(() => {
      setState((current) => ({
        ...current,
        retryAfterSeconds: Math.max(0, current.retryAfterSeconds - 1),
      }));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [cooldownActive]);
  async function resend() {
    setPending(true); setError(undefined); setMessage(undefined);
    try {
      const response = await fetch("/api/account/onboarding/resend-verification", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) { setError(payload.error?.message ?? "Unable to resend verification."); return; }
      setMessage("A new verification email has been queued.");
      setState((current) => ({ ...current, retryAfterSeconds: 60 }));
    } catch { setError("Unable to resend verification."); }
    finally { setPending(false); }
  }
  async function replacePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(undefined); const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/account/onboarding/replace-temporary-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form.entries())) });
      const payload = await response.json();
      if (!response.ok) { setError(payload.error?.message ?? "Unable to replace the temporary password."); return; }
      router.replace(payload.data?.nextPath ?? "/dashboard"); router.refresh();
    } catch { setError("Unable to replace the temporary password."); }
    finally { setPending(false); }
  }
  return <div className="min-h-screen bg-canvas"><header className="flex min-h-18 items-center justify-between border-b border-line bg-surface px-4 sm:px-8"><p className="font-bold text-cpu-navy">MedClinic account security</p><LogoutButton /></header><main className="mx-auto grid max-w-3xl gap-6 p-4 sm:p-8"><Alert tone="warning"><h1 className="font-bold">Secure your account before continuing.</h1><p className="mt-1">This account is using a temporary password or has an email address that still requires verification. Complete the security steps below before accessing MedClinic.</p></Alert>{error ? <Alert tone="danger">{error}</Alert> : null}{message ? <Alert tone="success">{message}</Alert> : null}<Card><div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-bold text-ink">1. Verify your email</h2><p className="mt-2 text-sm text-muted">Verification messages are sent to {state.emailMasked}.</p></div><Badge tone={state.emailVerified ? "success" : "warning"}>{state.emailVerified ? "Complete" : "Required"}</Badge></div>{!state.emailVerified ? <Button className="mt-5" variant="secondary" onClick={resend} disabled={pending || state.retryAfterSeconds > 0}>Resend verification</Button> : null}</Card><Card><div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-bold text-ink">2. Replace temporary password</h2><p className="mt-2 text-sm text-muted">Available after email verification. Use 8–100 characters and choose a different password.</p></div><Badge tone={!state.mustChangePassword ? "success" : state.emailVerified ? "warning" : "neutral"}>{!state.mustChangePassword ? "Complete" : "Required"}</Badge></div><form onSubmit={replacePassword} className="mt-5 grid gap-4"><Field label="Current temporary password"><Input name="currentPassword" type="password" disabled={!state.emailVerified} autoComplete="current-password" required /></Field><Field label="New password"><Input name="newPassword" type="password" disabled={!state.emailVerified} minLength={8} maxLength={100} autoComplete="new-password" required /></Field><Field label="Confirm new password"><Input name="confirmPassword" type="password" disabled={!state.emailVerified} minLength={8} maxLength={100} autoComplete="new-password" required /></Field><Button type="submit" disabled={!state.emailVerified || pending}>{pending ? "Saving..." : "Replace temporary password"}</Button></form></Card></main></div>;
}
