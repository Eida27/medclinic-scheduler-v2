"use client";

import { useMemo, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ManualResolutionDatePicker } from "./ManualResolutionDatePicker";
import type { ManualBatchPayload, ManualBatchPreview, SelectedManualCase } from "@/types/manual-resolution-batch";

export function ManualResolutionBatchDialog({ cases, onClose, onResolved, initialMonth }: {
  cases: SelectedManualCase[];
  onClose(): void;
  onResolved(message: string): Promise<void>;
  initialMonth?: string;
}) {
  const [replaceRelatedServices, setReplaceRelatedServices] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [laboratoryDate, setLaboratoryDate] = useState("");
  const [physicalExamDate, setPhysicalExamDate] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ManualBatchPreview>();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const tokens = useMemo(() => cases.map(({ caseId, expectedOptimisticToken }) => ({ caseId, expectedOptimisticToken })), [cases]);
  const needsLaboratory = cases.some((item) => item.needsLaboratory || (replaceRelatedServices && item.hasLaboratory));
  const needsPhysicalExam = cases.some((item) => item.needsPhysicalExam || (replaceRelatedServices && item.hasPhysicalExam));
  const hasRelated = cases.some((item) => (item.hasLaboratory && !item.needsLaboratory) || (item.hasPhysicalExam && !item.needsPhysicalExam));
  const payload: ManualBatchPayload = { cases: tokens, replaceRelatedServices, preservationAcknowledged: true,
    ...(needsLaboratory ? { laboratoryDate } : {}), ...(needsPhysicalExam ? { physicalExamDate } : {}), reason: reason.trim() };
  const ready = acknowledged && reason.trim().length >= 3 && (!needsLaboratory || Boolean(laboratoryDate)) && (!needsPhysicalExam || Boolean(physicalExamDate));

  async function submit(path: "preview" | "resolve") {
    setBusy(true); setError(undefined);
    try {
      const response = await fetch(`/api/clinic-unavailable-dates/manual-cases/bulk/${path}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(path === "preview" ? payload : { ...payload, requestId, previewToken: preview?.previewToken }),
      });
      const result = await response.json() as { data?: ManualBatchPreview & { studentCount: number; appointmentCount: number }; error?: { message?: string } };
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? `Unable to ${path} assignments.`);
      if (path === "preview") setPreview(result.data);
      else await onResolved(`Resolved ${result.data.studentCount} students; assigned ${result.data.appointmentCount} replacement appointments on ${[laboratoryDate, physicalExamDate].filter(Boolean).join(" and ")}.`);
    } catch (caught) {
      setPreview(undefined);
      setError(caught instanceof Error ? caught.message : `Unable to ${path} assignments.`);
    } finally { setBusy(false); }
  }

  return <div role="dialog" aria-modal="true" aria-label="Assign schedules to selected cases" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} className="grid gap-4 rounded-xl border border-cpu-navy bg-surface p-5 shadow-lg">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-bold">Assign schedules</h2><p>{cases.length} selected students share the dates below.</p></div><Button variant="secondary" autoFocus onClick={onClose}>Close</Button></div>
    {hasRelated ? <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={replaceRelatedServices} onChange={(event) => { setReplaceRelatedServices(event.target.checked); setLaboratoryDate(""); setPhysicalExamDate(""); setPreview(undefined); setRequestId(crypto.randomUUID()); }} />Move related unaffected services too</label> : null}
    {needsLaboratory ? <ManualResolutionDatePicker service="LABORATORY" cases={tokens} replaceRelatedServices={replaceRelatedServices} value={laboratoryDate} initialMonth={initialMonth} onChange={(date) => { setLaboratoryDate(date); setPreview(undefined); setRequestId(crypto.randomUUID()); }} /> : null}
    {needsPhysicalExam ? <ManualResolutionDatePicker service="PHYSICAL_EXAM" cases={tokens} replaceRelatedServices={replaceRelatedServices} value={physicalExamDate} initialMonth={initialMonth} onChange={(date) => { setPhysicalExamDate(date); setPreview(undefined); setRequestId(crypto.randomUUID()); }} /> : null}
    <label className="grid gap-1 text-sm font-semibold">Batch resolution reason<Input aria-label="Batch resolution reason" value={reason} onChange={(event) => { setReason(event.target.value); setPreview(undefined); setRequestId(crypto.randomUUID()); }} /></label>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => { setAcknowledged(event.target.checked); setPreview(undefined); setRequestId(crypto.randomUUID()); }} />I reviewed any services that will remain on their current dates.</label>
    <Button disabled={busy || !ready} onClick={() => { void submit("preview"); }}>Preview assignments</Button>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {preview ? <section className="grid gap-3 rounded-lg border border-line p-3 text-sm">
      <p className="font-bold">{preview.studentCount} student{preview.studentCount === 1 ? "" : "s"}; {preview.appointmentCount} replacement appointment{preview.appointmentCount === 1 ? "" : "s"}.</p>
      <p>Preview expires {preview.expiresAt}.</p>
      <div className="max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th>Student</th><th>Laboratory</th><th>Physical Examination</th><th>Retained tests</th><th>Conflicts</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.caseId} className="border-t border-line"><td>{row.studentNumber}</td><td>{row.laboratory ? `${row.laboratory.action}: ${row.laboratory.oldDate} → ${row.laboratory.newDate}` : "None"}</td><td>{row.physicalExam ? `${row.physicalExam.action}: ${row.physicalExam.oldDate} → ${row.physicalExam.newDate}` : "None"}</td><td>{row.retainedTests.join(", ") || "None"}</td><td>{row.issues.map((issue) => issue.message).join("; ") || "None"}</td></tr>)}</tbody></table></div>
      <div>{preview.capacity.map((item) => <p key={`${item.clinicId}-${item.service}-${item.date}`}>{item.service} {item.date}: {item.used} used, {item.maximum ?? "unconfigured"} maximum, {item.required} required, {item.projected} projected</p>)}</div>
      <Button disabled={busy || !preview.previewToken || preview.rows.some((row) => row.issues.length > 0)} onClick={() => { void submit("resolve"); }}>Confirm assignments</Button>
    </section> : null}
  </div>;
}
