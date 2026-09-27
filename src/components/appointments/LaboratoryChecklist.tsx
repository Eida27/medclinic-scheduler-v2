"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Item = {
  testCode: "CBC" | "URINE" | "STOOL" | "XRAY";
  verifiedAt: string | Date | null;
  verifiedBy: string | null;
  verificationSource: "INTERNAL" | "EXTERNAL" | null;
};
export type ChecklistView = {
  checklistId: string;
  appointmentId: string;
  version: number;
  appointmentStatus: string;
  verifiedCount: number;
  totalCount: number;
  items: Item[];
};

type Props = {
  appointmentId: string;
  initial?: ChecklistView;
  readOnly?: boolean;
  compact?: boolean;
};

function messageFrom(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload
      && payload.error && typeof payload.error === "object" && "message" in payload.error
      && typeof payload.error.message === "string") return payload.error.message;
  return fallback;
}

export function LaboratoryChecklist({ appointmentId, initial, readOnly = false, compact = false }: Props) {
  const router = useRouter();
  const [checklist, setChecklist] = useState<ChecklistView | null>(initial ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [reasonItem, setReasonItem] = useState<{ item: Item; checked: boolean } | null>(null);
  const [reasonText, setReasonText] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    if (initial) return;
    const abort = new AbortController();
    void fetch(`/api/appointments/${appointmentId}/laboratory-checklist`, {
      cache: "no-store", signal: abort.signal,
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(messageFrom(payload, "Unable to load Laboratory checklist."));
      if (!abort.signal.aborted) setChecklist(payload.data as ChecklistView);
    }).catch((caught) => {
      if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "Unable to load Laboratory checklist.");
    });
    return () => abort.abort();
  }, [appointmentId, initial]);

  function change(item: Item) {
    if (!checklist || pending || inFlight.current || readOnly) return;
    const checked = item.verifiedAt === null;
    if (!checked || checklist.appointmentStatus === "NO_SHOW") {
      setReasonItem({ item, checked });
      setReasonText("");
      setError("");
      return;
    }
    void submitChange(item, checked);
  }

  async function submitChange(item: Item, checked: boolean, reason?: string) {
    if (!checklist || pending || inFlight.current || readOnly) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/appointments/${appointmentId}/laboratory-checklist`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ testCode: item.testCode, checked, expectedVersion: checklist.version, ...(reason ? { reason } : {}) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(messageFrom(payload, "Unable to save Laboratory verification."));
      const confirmed = payload.data as ChecklistView;
      setChecklist(confirmed);
      setReasonItem(null);
      setReasonText("");
      setAnnouncement(`${confirmed.verifiedCount} of ${confirmed.totalCount} Laboratory tests verified.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save Laboratory verification.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (!checklist) return <p className="text-sm text-muted" role="status">{error || "Loading Laboratory checklist…"}</p>;
  const xray = checklist.items.find((item) => item.testCode === "XRAY");
  return (
    <fieldset className={compact ? "min-w-56" : "space-y-3"} disabled={pending || readOnly}>
      <legend className="font-semibold text-ink">Laboratory tests</legend>
      <p className="text-sm text-muted">{checklist.verifiedCount}/{checklist.totalCount} verified
        {checklist.verifiedCount > 0 && checklist.verifiedCount < checklist.totalCount ? " · In progress" : ""}</p>
      <div className={compact ? "flex flex-wrap gap-x-3 gap-y-1" : "grid gap-2 sm:grid-cols-2"}>
        {checklist.items.map((item) => (
          <label key={item.testCode} className="inline-flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={item.verifiedAt !== null}
              onChange={() => { void change(item); }} disabled={pending || readOnly}
              className="h-4 w-4 accent-cpu-navy" />
            {item.testCode === "XRAY" ? "X-ray" : item.testCode === "URINE" ? "Urine" : item.testCode === "STOOL" ? "Stool" : "CBC"}
          </label>
        ))}
        {!xray && !compact ? <span className="text-sm text-muted">X-ray: Not required</span> : null}
      </div>
      {reasonItem ? <div className="mt-2 space-y-2 rounded-lg border border-border bg-white p-3">
        <label className="block text-sm font-medium text-ink" htmlFor={`checklist-reason-${appointmentId}`}>
          {reasonItem.checked ? "Reason for correcting the automatic no-show" : `Reason for unchecking ${reasonItem.item.testCode}`}
        </label>
        <input id={`checklist-reason-${appointmentId}`} type="text" required maxLength={500}
          value={reasonText} onChange={(event) => setReasonText(event.target.value)}
          className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
        <div className="flex gap-2">
          <button type="button" disabled={!reasonText.trim() || pending}
            onClick={() => { void submitChange(reasonItem.item, reasonItem.checked, reasonText.trim()); }}
            className="rounded-lg bg-cpu-navy px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Save checklist change</button>
          <button type="button" onClick={() => { setReasonItem(null); setReasonText(""); }}
            className="rounded-lg border border-border px-3 py-2 text-sm">Cancel</button>
        </div>
      </div> : null}
      {pending ? <p className="text-sm text-muted" role="status">Saving verification…</p> : null}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </fieldset>
  );
}
