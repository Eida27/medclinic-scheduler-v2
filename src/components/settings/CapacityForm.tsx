"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";

type Setting = { clinicCode: string; clinicName: string; scheduleType: string; safeDailyCapacity: number; maxDailyCapacity: number };
export function CapacityForm({ settings }: { settings: Setting[] }) { const router = useRouter(); const [error, setError] = useState<string>(); async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const response = await fetch("/api/settings/capacity", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ clinicCode: form.get("clinicCode"), scheduleType: form.get("scheduleType"), safeDailyCapacity: Number(form.get("safeDailyCapacity")), maxDailyCapacity: Number(form.get("maxDailyCapacity")) }) }); const payload = await response.json(); if (!response.ok) setError(payload.error?.message); else router.refresh(); } return <div className="grid gap-4">{error ? <Alert tone="danger">{error}</Alert> : null}{settings.map((setting) => <Card key={`${setting.clinicCode}:${setting.scheduleType}`}><form onSubmit={submit} className="grid items-end gap-4 sm:grid-cols-4"><input type="hidden" name="clinicCode" value={setting.clinicCode} /><input type="hidden" name="scheduleType" value={setting.scheduleType} /><div><p className="font-bold text-ink">{setting.clinicName}</p><p className="text-xs text-muted">{setting.scheduleType.replaceAll("_", " ")} daily limit</p></div><label className="text-sm font-semibold text-muted-strong">Recommended<Input name="safeDailyCapacity" type="number" min="1" defaultValue={setting.safeDailyCapacity} /></label><label className="text-sm font-semibold text-muted-strong">Maximum<Input name="maxDailyCapacity" type="number" min="1" defaultValue={setting.maxDailyCapacity} /></label><Button type="submit">Save</Button></form></Card>)}</div>; }
