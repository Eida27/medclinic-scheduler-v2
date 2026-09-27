"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type SelectedReplacement = { id: string; expectedUpdatedAt: string };
type Preview = {
  rows: Array<{ id: string; studentNumber: string | null; originalDate: string | null;
    pairedDate: string | null; retainedTests: string[]; isManuallyLocked: boolean;
    issues: Array<{ code: string; message: string }> }>;
  capacity: { used: number; maximum: number; incoming: number; resulting: number } | null;
  service: string | null; academicYearStart: number | null; previewToken: string | null;
};

function errorMessage(payload: unknown) {
  if (payload && typeof payload === "object" && "error" in payload
    && payload.error && typeof payload.error === "object" && "message" in payload.error
    && typeof payload.error.message === "string") return payload.error.message;
  return "The replacement could not be saved. Review the selection and try again.";
}

export function BulkReplacementDialog({ selected, onRemove, onDone }: {
  selected: SelectedReplacement[];
  onRemove: (id: string) => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [requestId, setRequestId] = useState("");
  const hasConflicts = preview?.rows.some((row) => row.issues.length > 0) ?? false;
  async function send(url: string, body: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(errorMessage(payload));
    return payload.data;
  }
  const payload = { appointments: selected, replacementDate: date, reason: reason.trim() };
  async function loadPreview() {
    setBusy(true); setError(""); setSuccess(""); setPreview(null);
    try {
      setPreview(await send("/api/appointments/bulk-replacements/preview", payload) as Preview);
      setRequestId(crypto.randomUUID());
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Preview failed."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview?.previewToken || hasConflicts || busy) return;
    setBusy(true); setError("");
    try {
      const result = await send("/api/appointments/bulk-replacements", {
        ...payload, previewToken: preview.previewToken, requestId,
      }) as { count: number };
      setSuccess(`${result.count} replacement appointment${result.count === 1 ? "" : "s"} saved.`);
      setPreview(null); onDone(); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Save failed."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Bulk replacement" className="rounded-2xl border border-line bg-surface p-5">
    <h2 className="text-lg font-bold">Replace selected appointments</h2>
    <p className="mt-1 text-sm text-muted">{selected.length} selected · One service, clinic, academic year and destination date per save.</p>
    {selected.length ? <ul className="mt-3 max-h-32 overflow-auto text-xs">
      {selected.map((item) => <li key={item.id} className="flex items-center justify-between gap-3 py-1">
        <span className="font-mono">{item.id}</span>
        <button type="button" className="text-cpu-navy underline" onClick={() => { setPreview(null); onRemove(item.id); }}>Remove</button>
      </li>)}
    </ul> : null}
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-semibold">Replacement date
        <input type="date" value={date} onChange={(event) => { setDate(event.target.value); setPreview(null); }}
          className="rounded-xl border border-line p-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">Reason
        <input value={reason} onChange={(event) => { setReason(event.target.value); setPreview(null); }}
          maxLength={1000} className="rounded-xl border border-line p-3" /></label>
    </div>
    <button type="button" disabled={busy || !selected.length || !date || reason.trim().length < 3}
      className="mt-4 rounded-xl bg-cpu-navy px-4 py-3 font-semibold text-white disabled:opacity-50"
      onClick={() => void loadPreview()}>Preview conflicts and capacity</button>
    {error ? <p role="alert" className="mt-3 text-sm text-red-800">{error}</p> : null}
    {success ? <p role="status" className="mt-3 text-sm text-green-800">{success}</p> : null}
    {preview ? <div className="mt-4 space-y-3 rounded-xl border border-line p-4">
      <h3 className="font-bold">Review {preview.service?.replaceAll("_", " ") ?? "selection"}{preview.academicYearStart ? ` · Academic year ${preview.academicYearStart}` : ""}</h3>
      {preview.capacity ? <p className="text-sm">Destination capacity: {preview.capacity.used} used + {preview.capacity.incoming} incoming = {preview.capacity.resulting} / {preview.capacity.maximum}</p>
        : <p className="text-sm">Destination capacity is unavailable for this selection.</p>}
      <ul className="space-y-2 text-sm">{preview.rows.map((row) => <li key={row.id}>
        <strong>{row.studentNumber ?? row.id}</strong>: {row.originalDate ?? "Source unavailable"} → {date}
        {row.pairedDate ? ` · Paired date ${row.pairedDate}` : ""}
        {row.retainedTests.length ? ` · Preserved tests: ${row.retainedTests.join(", ")}` : ""}
        {row.isManuallyLocked ? " · Manual protection carries forward" : ""}
        <button type="button" className="ml-2 text-cpu-navy underline"
          onClick={() => { setPreview(null); onRemove(row.id); }}>Remove</button>
        {row.issues.length ? <ul className="ml-4 list-disc text-red-800">{row.issues.map((issue) =>
          <li key={issue.code}>{issue.message}</li>)}</ul> : null}
      </li>)}</ul>
      <p className="text-xs text-muted">Preview does not reserve capacity. Save rechecks every row.</p>
      {hasConflicts ? <p className="text-sm text-red-800">Remove conflicting students or choose another date, then preview again.</p> : null}
      <button type="button" disabled={busy || hasConflicts || !preview.previewToken} className="rounded-xl bg-cpu-navy px-4 py-3 font-semibold text-white disabled:opacity-50"
        onClick={() => void save()}>Save all replacements</button>
    </div> : null}
  </section>;
}
