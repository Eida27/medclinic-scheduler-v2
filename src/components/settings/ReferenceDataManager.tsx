"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

type Entry = { id: string; code?: string; name: string; collegeId?: string; collegeName?: string; rankOrder?: number; isActive: boolean };

export function ReferenceDataManager({ colleges, programs, priorities }: { colleges: Entry[]; programs: Entry[]; priorities: Entry[] }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  async function create(event: FormEvent<HTMLFormElement>, endpoint: string) {
    event.preventDefault(); setError(undefined); const form = new FormData(event.currentTarget);
    const body: Record<string, string | number> = Object.fromEntries(form.entries()) as Record<string, string>;
    if (body.rankOrder) body.rankOrder = Number(body.rankOrder);
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json(); if (!response.ok) { setError(payload.error?.message); return; }
    event.currentTarget.reset(); router.refresh();
  }
  return <div className="grid gap-6">{error ? <Alert tone="danger">{error}</Alert> : null}<div className="grid gap-6 xl:grid-cols-3">
    <Card><CardTitle>Colleges</CardTitle><form onSubmit={(event) => create(event, "/api/colleges")} className="mt-4 grid gap-3"><Input name="code" placeholder="Code" required /><Input name="name" placeholder="College name" required /><Button type="submit">Add college</Button></form><List entries={colleges} /></Card>
    <Card><CardTitle>Programs</CardTitle><form onSubmit={(event) => create(event, "/api/programs")} className="mt-4 grid gap-3"><Select name="collegeId" required><option value="">College</option>{colleges.filter((entry) => entry.isActive).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select><Input name="code" placeholder="Code" required /><Input name="name" placeholder="Program name" required /><Button type="submit">Add program</Button></form><List entries={programs} /></Card>
    <Card><CardTitle>Priority groups</CardTitle><form onSubmit={(event) => create(event, "/api/priority-groups")} className="mt-4 grid gap-3"><Input name="name" placeholder="Group name" required /><Input name="rankOrder" type="number" min="1" placeholder="Rank" required /><Button type="submit">Add priority</Button></form><List entries={priorities} /></Card>
  </div></div>;
}

function List({ entries }: { entries: Entry[] }) {
  return <div className="mt-5 divide-y divide-slate-100">{entries.map((entry) => <div key={entry.id} className="py-3 text-sm"><p className="font-bold text-slate-900">{entry.code ? `${entry.code} · ` : ""}{entry.name}</p><p className="text-xs text-slate-500">{entry.collegeName ?? (entry.rankOrder ? `Priority ${entry.rankOrder}` : "")}{!entry.isActive ? " · Inactive" : ""}</p></div>)}</div>;
}
