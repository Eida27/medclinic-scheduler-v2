"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";

type Lookup = { studentNumber: string; studentName: string; appointments: Array<{ scheduleType: string; appointmentDate: string; appointmentTime: string | null; status: string }>; compliance: { physicalExam: string; laboratory: string } };

export function StudentLookupForm() {
  const [result, setResult] = useState<Lookup>(); const [error, setError] = useState<string>(); const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setError(undefined); setResult(undefined); const form = new FormData(event.currentTarget); const response = await fetch(`/api/student-lookup?studentNumber=${encodeURIComponent(String(form.get("studentNumber")))}`); const payload = await response.json(); if (!response.ok) setError(payload.error?.message); else setResult(payload.data); setPending(false); }
  return <div className="grid gap-5"><Card><form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row"><Input name="studentNumber" placeholder="e.g. 23-1212-97" required /><Button type="submit" disabled={pending}>{pending ? "Searching..." : "Find schedule"}</Button></form></Card>{error ? <Alert tone="danger">{error}</Alert> : null}{result ? <Card><h2 className="text-xl font-bold">{result.studentName}</h2><p className="font-mono text-sm text-slate-500">{result.studentNumber}</p><div className="mt-5 grid gap-3">{result.appointments.map((appointment, index) => <div key={`${appointment.scheduleType}-${index}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-4"><div><p className="font-bold">{appointment.scheduleType.replaceAll("_", " ")}</p><p className="text-sm text-slate-600">{appointment.appointmentDate}{appointment.appointmentTime ? ` at ${appointment.appointmentTime}` : ""}</p></div><Badge tone="warning">{appointment.status}</Badge></div>)}{result.appointments.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No published appointment is available yet.</p> : null}</div><div className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-bold uppercase text-slate-500">Physical exam</p><p className="mt-2 font-bold">{result.compliance.physicalExam}</p></div><div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-bold uppercase text-slate-500">Laboratory</p><p className="mt-2 font-bold">{result.compliance.laboratory}</p></div></div></Card> : null}</div>;
}
