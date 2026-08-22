"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { AdminEmailDelivery, EmailDeliveryState } from "@/server/repositories/admin-email-deliveries.repository";

type SafeAppointment = {
  scheduleType: "LABORATORY" | "PHYSICAL_EXAM";
  status: string;
  date: string | null;
  affectedDate: string | null;
  location: string;
};
type SafeCurrentState = {
  studentNumber: string;
  laboratory: SafeAppointment | null;
  physicalExam: SafeAppointment | null;
  manualResolutionOpen: boolean;
};

type ApiError = {
  code?: string;
  message?: string;
  details?: { guidance?: string; currentState?: SafeCurrentState | null };
};

export function EmailDeliveryMonitor({ initialItems }: { initialItems: AdminEmailDelivery[] }) {
  const [items, setItems] = useState(initialItems);
  const [scope, setScope] = useState<"actionable" | "history">("actionable");
  const [state, setState] = useState<"" | EmailDeliveryState>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, ApiError>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});

  async function load(nextScope: "actionable" | "history", nextState = state) {
    const params = new URLSearchParams({ scope: nextScope });
    if (nextState) params.set("state", nextState);
    const response = await fetch(`/api/admin/email-deliveries?${params}`, { cache: "no-store" });
    const payload = await response.json();
    if (response.ok) setItems(payload.data.items);
  }

  async function mutate(item: AdminEmailDelivery, action: "retry" | "queue-current") {
    setBusyId(item.id);
    setErrors((current) => ({ ...current, [item.id]: {} }));
    setMessages((current) => ({ ...current, [item.id]: "" }));
    try {
      const response = await fetch(`/api/admin/email-deliveries/${item.id}/${action}`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setErrors((current) => ({ ...current, [item.id]: payload.error ?? {} }));
        return;
      }
      if (action === "retry") {
        setItems((current) => current.map((candidate) => candidate.id === item.id ? payload.data : candidate));
        setMessages((current) => ({ ...current, [item.id]: "Delivery queued for retry." }));
      } else {
        setMessages((current) => ({ ...current, [item.id]: "Current schedule queued." }));
      }
    } finally {
      setBusyId(null);
    }
  }

  function appointmentLine(appointment: SafeAppointment | null) {
    if (!appointment) return null;
    const label = appointment.scheduleType === "LABORATORY" ? "Laboratory" : "Physical Examination";
    const timing = appointment.date
      ? `${appointment.date} at ${appointment.location}`
      : `Awaiting reschedule at ${appointment.location}`;
    return <li key={appointment.scheduleType}><span className="font-semibold">{label}:</span> {timing}</li>;
  }

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap gap-4">
        <label className="grid gap-1 text-sm font-semibold text-ink">
          View
          <select
            aria-label="View"
            className="h-10 rounded-xl border border-line bg-surface px-3"
            value={scope}
            onChange={(event) => {
              const next = event.target.value as "actionable" | "history";
              setScope(next);
              void load(next);
            }}
          >
            <option value="actionable">Actionable failures</option>
            <option value="history">Audit and history</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-ink">
          State
          <select
            aria-label="State"
            className="h-10 rounded-xl border border-line bg-surface px-3"
            value={state}
            onChange={(event) => {
              const next = event.target.value as "" | EmailDeliveryState;
              setState(next);
              void load(scope, next);
            }}
          >
            <option value="">All states</option>
            {(["Pending", "Sent", "Retrying", "Failed"] as const).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
      </Card>

      {!items.length ? (
        <Card><p className="text-sm text-muted">{scope === "actionable" ? "No actionable delivery failures." : "No delivery history matches these filters."}</p></Card>
      ) : items.map((item) => {
        const stale = errors[item.id]?.code === "STALE_SCHEDULE_EMAIL"
          ? errors[item.id]?.details?.currentState
          : null;
        return (
          <Card key={item.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-bold text-ink">{item.destination}</p>
                <p className="text-sm text-muted">{item.context.studentNumber ?? "No linked student"} · {item.context.notificationType ?? item.context.messageKind}</p>
              </div>
              <span className="rounded-full bg-cpu-navy-soft px-3 py-1 text-xs font-bold text-cpu-navy">{item.state}</span>
            </div>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="font-semibold text-muted">Attempts</dt><dd>{item.attempts}</dd></div>
              <div><dt className="font-semibold text-muted">Last attempt</dt><dd>{item.lastAttempt ? `${item.lastAttempt.state} · ${item.lastAttempt.at}` : "None"}</dd></div>
            </dl>
            {item.failureReason ? <p className="text-sm text-red-800">{item.failureReason}</p> : null}
            {item.actionable ? (
              <Button size="sm" disabled={busyId === item.id} onClick={() => void mutate(item, "retry")}>Retry delivery</Button>
            ) : null}
            {errors[item.id]?.message ? <p role="alert" className="text-sm text-red-800">{errors[item.id].message}</p> : null}
            {errors[item.id]?.details?.guidance ? <p className="text-sm text-muted-strong">{errors[item.id].details?.guidance}</p> : null}
            {stale ? (
              <div className="rounded-xl border border-cpu-gold/40 bg-cpu-gold-soft/50 p-3 text-sm">
                <p className="font-bold text-ink">Current authoritative schedule</p>
                <ul className="mt-2 space-y-1 text-muted-strong">
                  {appointmentLine(stale.laboratory)}
                  {appointmentLine(stale.physicalExam)}
                  {stale.manualResolutionOpen ? <li>Manual Resolution is open.</li> : null}
                </ul>
                <Button className="mt-3" size="sm" variant="accent" disabled={busyId === item.id} onClick={() => void mutate(item, "queue-current")}>Queue current schedule</Button>
              </div>
            ) : null}
            {messages[item.id] ? <p role="status" className="text-sm font-semibold text-green-800">{messages[item.id]}</p> : null}
          </Card>
        );
      })}
    </div>
  );
}
