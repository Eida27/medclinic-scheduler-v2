"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { UserRole } from "@/types/roles";

type User = {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  clinicCode?: string | null;
  clinicName?: string | null;
  isActive: boolean;
};

function roleLabel(role: UserRole) {
  if (role === "ADMIN") return "Administrator";
  if (role === "COORDINATOR") return "Coordinator";
  return "Clinic staff";
}

export function UsersManager({ users }: { users: User[] }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [role, setRole] = useState<UserRole>("CLINIC_STAFF");
  const [clinicCode, setClinicCode] = useState("KABALAKA_CLINIC");
  const isGlobalRole = role === "ADMIN" || role === "COORDINATOR";

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const response = await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message);
      return;
    }
    formElement.reset();
    setRole("CLINIC_STAFF");
    setClinicCode("KABALAKA_CLINIC");
    router.refresh();
  }

  async function toggle(user: User) {
    const response = await fetch("/api/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...user, isActive: !user.isActive, password: "" }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message);
      return;
    }
    router.refresh();
  }

  function selectRole(nextRole: UserRole) {
    setRole(nextRole);
    setClinicCode(nextRole === "CLINIC_STAFF" ? "KABALAKA_CLINIC" : "");
  }

  return (
    <div className="grid gap-6">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card>
        <form onSubmit={create} className="grid gap-3 md:grid-cols-5">
          <Field label="Full name">
            <Input name="fullName" required />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" required />
          </Field>
          <Field label="Temporary password">
            <Input name="password" type="password" minLength={8} required />
          </Field>
          <Field label="Role">
            <Select
              name="role"
              value={role}
              onChange={(event) => selectRole(event.target.value as UserRole)}
            >
              <option value="CLINIC_STAFF">Clinic staff</option>
              <option value="COORDINATOR">Coordinator</option>
              <option value="ADMIN">Administrator</option>
            </Select>
          </Field>
          <Field label="Clinic">
            <Select
              name="clinicCode"
              value={clinicCode}
              disabled={isGlobalRole}
              onChange={(event) => setClinicCode(event.target.value)}
            >
              <option value="KABALAKA_CLINIC">KABALAKA Clinic</option>
              <option value="CPU_CLINIC">CPU Clinic</option>
              <option value="">Global</option>
            </Select>
          </Field>
          {isGlobalRole ? <input type="hidden" name="clinicCode" value="" /> : null}
          <Button type="submit" className="md:col-span-5 md:justify-self-start">Add user</Button>
        </form>
      </Card>
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cpu-navy-soft/70">
              <tr>
                <th className="px-5 py-3">User</th>
                <th className="px-5 py-3">Role</th>
                <th className="px-5 py-3">Clinic</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((user) => (
                <tr key={user.id} className="transition hover:bg-cpu-navy-soft/35">
                  <td className="px-5 py-4">
                    <p className="font-bold text-ink">{user.fullName}</p>
                    <p className="text-xs text-muted">{user.email}</p>
                  </td>
                  <td className="px-5 py-4">{roleLabel(user.role)}</td>
                  <td className="px-5 py-4">{user.clinicName ?? "Global"}</td>
                  <td className="px-5 py-4">
                    <Badge tone={user.isActive ? "success" : "neutral"}>
                      {user.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <Button size="sm" variant="secondary" onClick={() => toggle(user)}>
                      {user.isActive ? "Deactivate" : "Activate"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
