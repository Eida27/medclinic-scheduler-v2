"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import type { UserRole } from "@/types/roles";

type AccountSummary = { id: string; fullName: string; email: string; role: UserRole; clinicName: string | null; emailVerified: boolean; status: "PENDING_VERIFICATION" | "PASSWORD_CHANGE_REQUIRED" | "ACTIVE" };
function roleLabel(role: UserRole) { return role === "ADMIN" ? "Administrator" : role === "COORDINATOR" ? "Coordinator" : "Clinic staff"; }
export function AccountSecurityPanel({ account }: { account: AccountSummary }) {
  const router = useRouter(); const [error, setError] = useState<string>(); const [success, setSuccess] = useState<string>(); const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined); setSuccess(undefined); setPending(true); const formElement = event.currentTarget; const form = new FormData(formElement);
    try {
      const response = await fetch("/api/account/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form.entries())) }); const payload = await response.json();
      if (!response.ok) { setError(payload.error?.message ?? "Unable to change the password."); return; }
      formElement.reset(); setSuccess("Password changed. This browser remains signed in; other sessions were revoked."); router.refresh();
    } catch { setError("Unable to change the password."); }
    finally { setPending(false); }
  }
  return <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"><Card><div className="flex items-center justify-between gap-4"><CardTitle>Account identity</CardTitle><Badge tone="success">Active</Badge></div><dl className="mt-5 grid gap-4 text-sm"><div><dt className="text-muted">Full name</dt><dd className="mt-1 font-bold text-ink">{account.fullName}</dd></div><div><dt className="text-muted">Email</dt><dd className="mt-1 font-bold text-ink">{account.email}</dd></div><div><dt className="text-muted">Role</dt><dd className="mt-1 font-bold text-ink">{roleLabel(account.role)}</dd></div><div><dt className="text-muted">Clinic scope</dt><dd className="mt-1 font-bold text-ink">{account.clinicName ?? "Global"}</dd></div><div><dt className="text-muted">Email verification</dt><dd className="mt-1 font-bold text-emerald-700">Verified</dd></div></dl></Card><Card><CardTitle>Change password</CardTitle><p className="mt-2 text-sm leading-6 text-muted">Use 8–100 characters and choose a password different from the current one.</p><form onSubmit={submit} className="mt-5 grid gap-4">{error ? <Alert tone="danger">{error}</Alert> : null}{success ? <Alert tone="success">{success}</Alert> : null}<Field label="Current password"><Input name="currentPassword" type="password" autoComplete="current-password" required /></Field><Field label="New password"><Input name="newPassword" type="password" minLength={8} maxLength={100} autoComplete="new-password" required /></Field><Field label="Confirm new password"><Input name="confirmPassword" type="password" minLength={8} maxLength={100} autoComplete="new-password" required /></Field><Button type="submit" disabled={pending}>{pending ? "Changing..." : "Change password"}</Button></form></Card></div>;
}
