"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { operationalStatusLabel } from "@/components/appointments/status-labels";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { OvpsaClosureBatchRecoveryPreview } from "@/types/clinic-calendar";

type AppointmentSummary = {
  id: string;
  date: string | null;
  status: string | null;
  affected: boolean;
};

type ManualCase = {
  id: string;
  studentNumber: string;
  studentName: string;
  closureGroupId: string;
  groupStartDate: string;
  groupEndDate: string;
  category: string;
  closureReason: string;
  reasonCode: string;
  reasonMessage: string;
  status: string;
  optimisticToken: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionAction: string | null;
  resolutionDetails: unknown;
  ovpsaBatchId: string | null;
  ovpsaBatchOptimisticToken: string | null;
  laboratory: AppointmentSummary | null;
  physicalExam: AppointmentSummary | null;
  currentAssignmentBlock: {
    code:
      | "DRAFT_RESULT_FILES_EXIST"
      | "PROTECTED_RESULTS_EXIST"
      | "APPOINTMENT_MANUALLY_LOCKED";
    message: string;
  } | null;
};

type ManualCasePage = {
  page: number;
  pageSize: number;
  total: number;
  items: ManualCase[];
};

type Filters = {
  search: string;
  reasonCode: string;
  closureGroupId: string;
  date: string;
  service: string;
  status: string;
};

const initialFilters: Filters = {
  search: "",
  reasonCode: "",
  closureGroupId: "",
  date: "",
  service: "",
  status: "OPEN",
};

const reasonOptions = [
  "EMERGENCY_CLOSURE",
  "NOTICE_PERIOD_PROTECTED",
  "OVPSA_LABORATORY_PROTECTED",
  "ADMIN_CHOSE_MANUAL_RECOVERY",
  "PHYSICAL_COMPLETED_BEFORE_LABORATORY",
  "APPOINTMENT_MANUALLY_LOCKED",
  "DRAFT_RESULT_FILES_EXIST",
  "PROTECTED_RESULTS_EXIST",
  "PAIR_MISSING_OR_INCONSISTENT",
  "NO_REPLACEMENT_CAPACITY",
  "CONCURRENT_APPOINTMENT_CHANGE",
  "UNSAFE_RESTORATION",
] as const;

function label(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function AppointmentLine({ service, appointment }: {
  service: string;
  appointment: AppointmentSummary | null;
}) {
  if (!appointment) return <p>{service}: not present</p>;
  return (
    <p className="grid gap-0.5 sm:grid-cols-[auto_1fr] sm:items-baseline sm:gap-2">
      <span className={`w-fit rounded-full px-2 py-0.5 text-xs font-bold ${
        appointment.affected
          ? "bg-red-100 text-red-900"
          : "bg-slate-100 text-slate-700"
      }`}>
        {appointment.affected ? "Affected" : "Related / currently unaffected"}
      </span>
      <span>{service}: {appointment.date ?? "no current date"} - {operationalStatusLabel(appointment.status ?? "")}</span>
    </p>
  );
}

function CaseResolutionCard({ manualCase, onResolved }: {
  manualCase: ManualCase;
  onResolved(message: string): Promise<void>;
}) {
  const [laboratoryDate, setLaboratoryDate] = useState("");
  const [physicalExamDate, setPhysicalExamDate] = useState("");
  const [laboratoryDecision, setLaboratoryDecision] = useState<"" | "PRESERVE" | "REPLACE">("");
  const [physicalExamDecision, setPhysicalExamDecision] = useState<"" | "PRESERVE" | "REPLACE">("");
  const [assignmentReason, setAssignmentReason] = useState("");
  const [keepReason, setKeepReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function resolve(body: Record<string, unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/clinic-unavailable-dates/manual-cases/${manualCase.id}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Unable to resolve this manual case.");
      await onResolved(`Resolved ${manualCase.studentNumber} with ${label(String(body.action))}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to resolve this manual case.");
    } finally {
      setBusy(false);
    }
  }

  const serviceReady = (
    appointment: AppointmentSummary | null,
    date: string,
    decision: "" | "PRESERVE" | "REPLACE",
  ) => !appointment
    || (appointment.affected ? Boolean(date) : decision === "PRESERVE" || (decision === "REPLACE" && Boolean(date)));
  const assignmentReady = assignmentReason.trim().length >= 3
    && serviceReady(manualCase.laboratory, laboratoryDate, laboratoryDecision)
    && serviceReady(manualCase.physicalExam, physicalExamDate, physicalExamDecision);
  const resolutionBlocked = Boolean(manualCase.currentAssignmentBlock);

  return (
    <Card className="grid gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-ink">{manualCase.studentName}</h3>
          <p className="font-mono text-sm font-semibold text-muted">{manualCase.studentNumber}</p>
        </div>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">
          {label(manualCase.reasonCode)}
        </span>
      </div>

      <div className="grid gap-2 rounded-xl border border-line bg-canvas/60 p-3 text-sm">
        <p><span className="font-semibold">Closure:</span> {manualCase.groupStartDate} to {manualCase.groupEndDate}</p>
        <p><span className="font-semibold">Category:</span> {label(manualCase.category)}</p>
        <p><span className="font-semibold">Reason:</span> {manualCase.closureReason}</p>
        <p>{manualCase.reasonMessage}</p>
        <AppointmentLine service="Laboratory" appointment={manualCase.laboratory} />
        <AppointmentLine service="Physical Examination" appointment={manualCase.physicalExam} />
        <p className="text-xs text-muted">
          Opened {manualCase.createdAt.slice(0, 10)}
          {manualCase.resolvedAt ? ` - resolved ${manualCase.resolvedAt.slice(0, 10)} by ${label(manualCase.resolutionAction ?? "")}` : " - awaiting administrator resolution"}
        </p>
      </div>

      {manualCase.currentAssignmentBlock ? (
        <Alert tone="warning">
          <div className="grid gap-2">
            <p>{manualCase.currentAssignmentBlock.message}</p>
            <Link
              className="w-fit font-bold underline underline-offset-2"
              href={`/settings/student-result-submissions/students/${encodeURIComponent(manualCase.studentNumber)}`}
            >
              Review student results
            </Link>
          </div>
        </Alert>
      ) : null}

      {manualCase.status === "OPEN" ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <section className="grid content-start gap-3 rounded-xl border border-line p-3">
            <h4 className="font-bold text-ink">Assign replacement</h4>
            <p className="text-xs text-muted">Dates are revalidated for closures, service capacity, and required-service order when submitted.</p>
            {manualCase.laboratory?.affected ? (
              <label className="grid gap-1 text-sm font-semibold">
                Laboratory date
                <Input
                  aria-label={`Laboratory replacement date for ${manualCase.studentNumber}`}
                  type="date"
                  value={laboratoryDate}
                  disabled={resolutionBlocked}
                  onInput={(event) => setLaboratoryDate(event.currentTarget.value)}
                />
              </label>
            ) : manualCase.laboratory ? (
              <fieldset className="grid gap-2 rounded-lg border border-line p-3 text-sm">
                <legend className="px-1 font-semibold">Related Laboratory decision</legend>
                <label className="flex gap-2"><input type="radio" name={`laboratory-${manualCase.id}`} checked={laboratoryDecision === "PRESERVE"} onChange={() => { setLaboratoryDecision("PRESERVE"); setLaboratoryDate(""); }} />Preserve current Laboratory</label>
                <label className="flex gap-2"><input type="radio" name={`laboratory-${manualCase.id}`} checked={laboratoryDecision === "REPLACE"} onChange={() => setLaboratoryDecision("REPLACE")} />Replace Laboratory</label>
                {laboratoryDecision === "REPLACE" ? <Input aria-label={`Laboratory replacement date for ${manualCase.studentNumber}`} type="date" value={laboratoryDate} disabled={resolutionBlocked} onInput={(event) => setLaboratoryDate(event.currentTarget.value)} /> : null}
              </fieldset>
            ) : null}
            {manualCase.physicalExam?.affected ? (
              <label className="grid gap-1 text-sm font-semibold">
                Physical Examination date
                <Input
                  aria-label={`Physical Examination replacement date for ${manualCase.studentNumber}`}
                  type="date"
                  value={physicalExamDate}
                  disabled={resolutionBlocked}
                  onInput={(event) => setPhysicalExamDate(event.currentTarget.value)}
                />
              </label>
            ) : manualCase.physicalExam ? (
              <fieldset className="grid gap-2 rounded-lg border border-line p-3 text-sm">
                <legend className="px-1 font-semibold">Related Physical Examination decision</legend>
                <label className="flex gap-2"><input type="radio" name={`physical-${manualCase.id}`} checked={physicalExamDecision === "PRESERVE"} onChange={() => { setPhysicalExamDecision("PRESERVE"); setPhysicalExamDate(""); }} />Preserve current Physical Examination</label>
                <label className="flex gap-2"><input type="radio" name={`physical-${manualCase.id}`} checked={physicalExamDecision === "REPLACE"} onChange={() => setPhysicalExamDecision("REPLACE")} />Replace Physical Examination</label>
                {physicalExamDecision === "REPLACE" ? <Input aria-label={`Physical Examination replacement date for ${manualCase.studentNumber}`} type="date" value={physicalExamDate} disabled={resolutionBlocked} onInput={(event) => setPhysicalExamDate(event.currentTarget.value)} /> : null}
              </fieldset>
            ) : null}
            <label className="grid gap-1 text-sm font-semibold">
              Resolution reason
              <Input
                aria-label={`Assignment reason for ${manualCase.studentNumber}`}
                value={assignmentReason}
                disabled={resolutionBlocked}
                onChange={(event) => setAssignmentReason(event.target.value)}
              />
            </label>
            <Button
              disabled={busy || resolutionBlocked || !assignmentReady}
              onClick={() => { void resolve({
                action: "ASSIGN_REPLACEMENT",
                expectedOptimisticToken: manualCase.optimisticToken,
                ...(laboratoryDate ? { laboratoryDate } : {}),
                ...(physicalExamDate ? { physicalExamDate } : {}),
                ...(laboratoryDecision === "PRESERVE" ? { preserveLaboratory: true } : {}),
                ...(physicalExamDecision === "PRESERVE" ? { preservePhysicalExam: true } : {}),
                reason: assignmentReason,
              }); }}
              aria-label={`Assign replacement for ${manualCase.studentNumber}`}
            >
              Assign replacement
            </Button>
          </section>

          <section className="grid content-start gap-3 rounded-xl border border-line p-3">
            <h4 className="font-bold text-ink">Keep current replacement</h4>
            <p className="text-xs text-muted">Use only after confirming that the existing published replacement remains safe.</p>
            <label className="grid gap-1 text-sm font-semibold">
              Approval reason
              <Input
                aria-label={`Keep-current reason for ${manualCase.studentNumber}`}
                value={keepReason}
                disabled={resolutionBlocked}
                onChange={(event) => setKeepReason(event.target.value)}
              />
            </label>
            <Button
              variant="secondary"
              disabled={busy || resolutionBlocked || keepReason.trim().length < 3}
              onClick={() => { void resolve({
                action: "KEEP_CURRENT_REPLACEMENT",
                expectedOptimisticToken: manualCase.optimisticToken,
                reason: keepReason,
              }); }}
              aria-label={`Keep current replacement for ${manualCase.studentNumber}`}
            >
              Keep current replacement
            </Button>
          </section>
        </div>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}

function OvpsaBatchRecoveryCard({ cases, onResolved }: {
  cases: ManualCase[];
  onResolved(message: string): Promise<void>;
}) {
  const batchId = cases[0].ovpsaBatchId!;
  const optimisticToken = cases[0].ovpsaBatchOptimisticToken!;
  const [laboratoryDate, setLaboratoryDate] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<OvpsaClosureBatchRecoveryPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function previewBatch() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/clinic-unavailable-dates/manual-cases/ovpsa-batches/${batchId}/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ optimisticToken, replacementLaboratoryDate: laboratoryDate }),
        },
      );
      const payload = await response.json() as { data?: OvpsaClosureBatchRecoveryPreview; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Unable to preview OVPSA recovery.");
      setPreview(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to preview OVPSA recovery.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmBatch() {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/clinic-unavailable-dates/manual-cases/ovpsa-batches/${batchId}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            optimisticToken,
            replacementLaboratoryDate: laboratoryDate,
            caseTokens: cases.map((item) => ({
              caseId: item.id,
              expectedOptimisticToken: item.optimisticToken,
            })),
            reason,
          }),
        },
      );
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Unable to confirm OVPSA recovery.");
      await onResolved(`Recovered ${cases.length} linked OVPSA cases atomically.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to confirm OVPSA recovery.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="grid gap-4 border-cpu-gold/50 p-5">
      <div>
        <h3 className="text-lg font-bold text-ink">Coordinated OVPSA batch recovery</h3>
        <p className="text-sm text-muted">{cases.length} linked students · Mission Hospital Laboratory coordination required</p>
      </div>
      <div className="grid gap-1 text-sm">
        {cases.map((item) => <p key={item.id}>{item.studentNumber} · {item.studentName}</p>)}
      </div>
      <label className="grid gap-1 text-sm font-semibold">
        Replacement Mission Hospital Laboratory date
        <Input
          aria-label="Replacement Mission Hospital Laboratory date"
          type="date"
          value={laboratoryDate}
          onInput={(event) => { setLaboratoryDate(event.currentTarget.value); setPreview(undefined); }}
        />
      </label>
      <Button disabled={busy || !laboratoryDate} onClick={() => { void previewBatch(); }} aria-label="Preview OVPSA batch recovery">
        {busy ? "Checking…" : "Preview coordinated recovery"}
      </Button>
      {preview ? (
        <div className="grid gap-3 rounded-xl border border-line bg-canvas/60 p-3 text-sm">
          <p>{preview.preservedPhysicalExamCount} Physical Examination preserved; {preview.movedPhysicalExamCount} moved.</p>
          <label className="grid gap-1 font-semibold">
            Confirmation reason
            <Input aria-label="OVPSA batch recovery reason" value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <Button disabled={busy || reason.trim().length < 3} onClick={() => { void confirmBatch(); }} aria-label="Confirm OVPSA batch recovery">
            Confirm and publish revision
          </Button>
        </div>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}

export function ManualResolutionQueue() {
  const [draftFilters, setDraftFilters] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ManualCasePage>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      const response = await fetch(`/api/clinic-unavailable-dates/manual-cases?${params}`, { cache: "no-store" });
      const payload = await response.json() as { data?: ManualCasePage; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Unable to load manual cases.");
      setData(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load manual cases.");
    } finally {
      setBusy(false);
    }
  }, [filters, page]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setFilters(draftFilters);
    setMessage(undefined);
  }

  const ovpsaGroups = new Map<string, ManualCase[]>();
  for (const item of data?.items ?? []) {
    if (!item.ovpsaBatchId || item.status !== "OPEN") continue;
    ovpsaGroups.set(item.ovpsaBatchId, [
      ...(ovpsaGroups.get(item.ovpsaBatchId) ?? []),
      item,
    ]);
  }
  const individualCases = (data?.items ?? []).filter((item) =>
    !item.ovpsaBatchId || item.status !== "OPEN");

  return (
    <div className="grid gap-5">
      <Card className="p-5">
        <form onSubmit={applyFilters} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="grid gap-1 text-sm font-semibold">
            Search
            <Input
              aria-label="Search manual cases"
              value={draftFilters.search}
              onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
              placeholder="Student number or name"
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Closure group
            <Input
              aria-label="Closure group filter"
              value={draftFilters.closureGroupId}
              onChange={(event) => setDraftFilters((current) => ({ ...current, closureGroupId: event.target.value }))}
              placeholder="Closure group ID"
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Date
            <Input
              aria-label="Date filter"
              type="date"
              value={draftFilters.date}
              onChange={(event) => setDraftFilters((current) => ({ ...current, date: event.target.value }))}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Service
            <Select
              aria-label="Service filter"
              value={draftFilters.service}
              onChange={(event) => setDraftFilters((current) => ({ ...current, service: event.target.value }))}
            >
              <option value="">All services</option>
              <option value="LABORATORY">Laboratory</option>
              <option value="PHYSICAL_EXAM">Physical Examination</option>
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Manual reason
            <Select
              aria-label="Manual reason filter"
              value={draftFilters.reasonCode}
              onChange={(event) => setDraftFilters((current) => ({ ...current, reasonCode: event.target.value }))}
            >
              <option value="">All reasons</option>
              {reasonOptions.map((reason) => <option key={reason} value={reason}>{label(reason)}</option>)}
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Status
            <Select
              aria-label="Case status filter"
              value={draftFilters.status}
              onChange={(event) => setDraftFilters((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="OPEN">Open</option>
              <option value="RESOLVED">Resolved</option>
              <option value="">All statuses</option>
            </Select>
          </label>
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>Apply filters</Button>
          </div>
        </form>
      </Card>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {busy && !data ? <Card className="p-5 text-sm text-muted">Loading manual cases...</Card> : null}
      {!busy && data?.items.length === 0 ? <Card className="p-5 text-sm text-muted">No manual cases match these filters.</Card> : null}
      {[...ovpsaGroups.entries()].map(([batchId, cases]) => (
        <OvpsaBatchRecoveryCard
          key={batchId}
          cases={cases}
          onResolved={async (nextMessage) => {
            setMessage(nextMessage);
            await load();
          }}
        />
      ))}
      {individualCases.map((manualCase) => (
        <CaseResolutionCard
          key={manualCase.id}
          manualCase={manualCase}
          onResolved={async (nextMessage) => {
            setMessage(nextMessage);
            await load();
          }}
        />
      ))}

      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-between gap-3">
          <Button variant="secondary" disabled={busy || page === 1} onClick={() => setPage((current) => current - 1)}>Previous</Button>
          <span className="text-sm font-semibold">Page {page} of {Math.ceil(data.total / data.pageSize)}</span>
          <Button variant="secondary" disabled={busy || page >= Math.ceil(data.total / data.pageSize)} onClick={() => setPage((current) => current + 1)}>Next</Button>
        </div>
      ) : null}
    </div>
  );
}
