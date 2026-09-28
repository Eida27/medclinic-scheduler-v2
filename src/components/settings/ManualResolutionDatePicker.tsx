"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Input } from "@/components/ui/Input";
import { manilaCalendarDate } from "@/lib/academic-year";
import type { ManualAvailability, ManualCaseToken, ManualService } from "@/types/manual-resolution-batch";

const stateLabel = { AVAILABLE: "Available", FULL: "Full", INSUFFICIENT: "Insufficient seats", UNAVAILABLE: "Unavailable" };
const tone = { AVAILABLE: "border-green-600 bg-green-50 text-green-950", FULL: "border-red-600 bg-red-50 text-red-950", INSUFFICIENT: "border-amber-600 bg-amber-50 text-amber-950", UNAVAILABLE: "border-slate-400 bg-slate-50 text-slate-700" };

export function ManualResolutionDatePicker({ service, cases, replaceRelatedServices, value, onChange, initialMonth } : {
  service: ManualService;
  cases: ManualCaseToken[];
  replaceRelatedServices: boolean;
  value: string;
  onChange(value: string): void;
  initialMonth?: string;
}) {
  const [month, setMonth] = useState(initialMonth ?? manilaCalendarDate(new Date()).slice(0, 7));
  const [availability, setAvailability] = useState<{ key: string; data: ManualAvailability }>();
  const [error, setError] = useState<string>();
  const requestKey = JSON.stringify({ cases, replaceRelatedServices, month, service });
  const currentAvailability = availability?.key === requestKey ? availability.data : undefined;
  useEffect(() => {
    let active = true;
    void fetch("/api/clinic-unavailable-dates/manual-cases/availability", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cases, replaceRelatedServices, month, service }),
    }).then(async (response) => {
      const payload = await response.json() as { data?: ManualAvailability; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Unable to load month availability.");
      if (active) { setAvailability({ key: requestKey, data: payload.data }); setError(undefined); }
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Unable to load month availability."); });
    return () => { active = false; };
  }, [cases, replaceRelatedServices, month, service, requestKey]);
  return <section className="grid gap-2">
    <label className="grid gap-1 text-sm font-semibold">
      {service === "LABORATORY" ? "Laboratory" : "Physical Examination"} month
      <Input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setError(undefined); onChange(""); }} />
    </label>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {!currentAvailability && !error ? <p className="text-sm text-muted">Loading dates…</p> : null}
    {currentAvailability ? <>
      <p className="text-sm">{currentAvailability.required} seats required. Choose an available date; pair rules are checked in preview.</p>
      <div className="grid max-h-64 grid-cols-2 gap-2 overflow-auto sm:grid-cols-4">
        {currentAvailability.days.map((day) => {
          const counts = day.capacity.map((capacity) => `${capacity.used} used, ${capacity.maximum ?? "unconfigured"} maximum, ${capacity.available} available, ${capacity.required} seats required`).join("; ");
          const description = day.issues.map((issue) => issue.message).join("; ");
          return <button key={day.date} type="button" disabled={day.state !== "AVAILABLE"}
            aria-pressed={value === day.date} onClick={() => onChange(day.date)}
            aria-label={`${day.date}: ${stateLabel[day.state]}; ${counts}${description ? `; ${description}` : ""}`}
            className={`rounded-lg border p-2 text-left text-xs disabled:opacity-70 ${tone[day.state]} ${value === day.date ? "ring-2 ring-cpu-navy" : ""}`}>
            <span className="block font-bold">{day.date}</span>
            <span>{stateLabel[day.state]}</span>
            <span className="block">{counts}</span>
            {description ? <span className="block">{description}</span> : null}
          </button>;
        })}
      </div>
    </> : null}
  </section>;
}
