"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

type User = { id: string; fullName: string; email: string; role: "ADMIN" | "CLINIC_STAFF"; isActive: boolean };

export function UsersManager({ users }: { users: User[] }) {
  const router = useRouter(); const [error, setError] = useState<string>();
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(undefined); const form = new FormData(event.currentTarget); const response = await fetch("/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form.entries())) }); const payload = await response.json(); if (!response.ok) { setError(payload.error?.message); return; } event.currentTarget.reset(); router.refresh(); }
  async function toggle(user: User) { const response = await fetch("/api/users", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...user, isActive: !user.isActive, password: "" }) }); const payload = await response.json(); if (!response.ok) { setError(payload.error?.message); return; } router.refresh(); }
  return <div className="grid gap-6">{error ? <Alert tone="danger">{error}</Alert> : null}<Card><form onSubmit={create} className="grid gap-3 md:grid-cols-4"><Input name="fullName" placeholder="Full name" required /><Input name="email" type="email" placeholder="Email" required /><Input name="password" type="password" placeholder="Temporary password" minLength={8} required /><Select name="role"><option value="CLINIC_STAFF">Clinic staff</option><option value="ADMIN">Admin</option></Select><Button type="submit" className="md:col-span-4 md:justify-self-start">Add user</Button></form></Card><Card className="overflow-hidden p-0"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-cpu-navy-soft/70"><tr><th className="px-5 py-3">User</th><th className="px-5 py-3">Role</th><th className="px-5 py-3">Status</th><th className="px-5 py-3"></th></tr></thead><tbody className="divide-y divide-line">{users.map((user) => <tr key={user.id} className="transition hover:bg-cpu-navy-soft/35"><td className="px-5 py-4"><p className="font-bold text-ink">{user.fullName}</p><p className="text-xs text-muted">{user.email}</p></td><td className="px-5 py-4">{user.role.replace("_", " ")}</td><td className="px-5 py-4"><Badge tone={user.isActive ? "success" : "neutral"}>{user.isActive ? "Active" : "Inactive"}</Badge></td><td className="px-5 py-4 text-right"><Button size="sm" variant="secondary" onClick={() => toggle(user)}>{user.isActive ? "Deactivate" : "Activate"}</Button></td></tr>)}</tbody></table></div></Card></div>;
}
