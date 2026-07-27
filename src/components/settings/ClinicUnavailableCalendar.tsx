"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import type {
  ClinicCalendarCategory,
  ClinicCalendarChange,
  ClinicCalendarIssue,
  ClinicCalendarOperationResult,
  ClinicCalendarPreviewResult,
} from "@/types/clinic-calendar";
import { buildAnnualCalendar, expandUnavailableRanges } from "./clinic-calendar";
import {
  resolveCalendarDateState,
  summarizeCalendarDraft,
  toggleCalendarDraft,
} from "./clinic-calendar-draft";
import { UnsavedCalendarChangesDialog } from "./clinic-calendar/UnsavedCalendarChangesDialog";
import { useUnsavedCalendarNavigation } from "./clinic-calendar/useUnsavedCalendarNavigation";

type Props = {
  unavailableDates: ClinicUnavailableDateRecord[];
  initialYear: number;
  today: string;
  maxYear?: number;
  readOnly?: boolean;
  openManualCaseCount?: number;
};

type ApiError = {
  code?: string;
  message: string;
  details?: { issues?: ClinicCalendarIssue[] };
};

const categories: Array<[ClinicCalendarCategory, string]> = [
  ["HOLIDAY", "Holiday"],
  ["CLOSURE", "Closure"],
  ["EMERGENCY_CLOSURE", "Emergency closure"],
  ["MAINTENANCE", "Maintenance"],
  ["STAFF_UNAVAILABILITY", "Staff unavailability"],
];
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sortedChanges(draft: Map<string, ClinicCalendarChange>) {
  return [...draft.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function dayTone(state: ReturnType<typeof resolveCalendarDateState>, isToday: boolean) {
  if (state.state === "CONFLICT") return "border-red-500 bg-red-50 text-red-800";
  if (state.state === "STAGED_BLOCK") return "border-cpu-navy bg-cpu-navy text-white";
  if (state.state === "STAGED_REOPEN") return "border-amber-500 bg-amber-50 text-amber-900 line-through";
  if (state.state === "SAVED_BLOCKED") {
    return state.record.category === "EMERGENCY_CLOSURE"
      ? "border-red-500 bg-red-100 text-red-900"
      : "border-amber-400 bg-amber-100 text-amber-950";
  }
  return isToday ? "border-cpu-gold bg-cpu-gold/15 text-cpu-navy" : "border-transparent bg-white text-ink";
}

export function ClinicUnavailableCalendar({
  unavailableDates,
  initialYear,
  today,
  maxYear = 2100,
  readOnly = false,
  openManualCaseCount = 0,
}: Props) {
  const currentYear = Number(today.slice(0, 4));
  const [selectedYear, setSelectedYear] = useState(initialYear);
  const [category, setCategory] = useState<ClinicCalendarCategory>("CLOSURE");
  const [reason, setReason] = useState("");
  const [records, setRecords] = useState(unavailableDates);
  const [draft, setDraft] = useState<Map<string, ClinicCalendarChange>>(new Map());
  const [conflicts, setConflicts] = useState<Map<string, string[]>>(new Map());
  const [preview, setPreview] = useState<ClinicCalendarPreviewResult>();
  const [requestId, setRequestId] = useState<string>();
  const [emergencyAcknowledged, setEmergencyAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [success, setSuccess] = useState<ClinicCalendarOperationResult>();
  const submitting = useRef(false);
  const annual = useMemo(() => buildAnnualCalendar(selectedYear), [selectedYear]);
  const persistedByDate = useMemo(() => expandUnavailableRanges(records), [records]);
  const changes = useMemo(() => sortedChanges(draft), [draft]);
  const summary = useMemo(() => summarizeCalendarDraft(draft), [draft]);
  const navigation = useUnsavedCalendarNavigation(draft.size > 0);
  const sameDayEmergency = changes.some((change) =>
    change.action === "BLOCK"
    && change.date === today
    && change.category === "EMERGENCY_CLOSURE");

  function invalidatePreview() {
    setPreview(undefined);
    setRequestId(undefined);
    setEmergencyAcknowledged(false);
    setSuccess(undefined);
  }

  function toggleDate(date: string) {
    if (readOnly || busy) return;
    const persisted = persistedByDate.get(date);
    if (!persisted && reason.trim().length < 3) {
      setError({ message: "Choose a category and enter a reason of at least 3 characters before blocking a date." });
      return;
    }
    setDraft((current) => toggleCalendarDraft(current, {
      persisted,
      date,
      blockTemplate: { category, reason },
    }));
    setConflicts((current) => {
      const next = new Map(current);
      next.delete(date);
      return next;
    });
    setError(undefined);
    invalidatePreview();
  }

  function discard() {
    setDraft(new Map());
    setConflicts(new Map());
    setError(undefined);
    invalidatePreview();
  }

  async function requestPreview() {
    if (!changes.length || busy) return;
    const nextRequestId = globalThis.crypto.randomUUID();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/clinic-unavailable-dates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: nextRequestId,
          changes,
          emergencyAcknowledged: false,
        }),
      });
      const payload = await response.json() as { data?: ClinicCalendarPreviewResult; error?: ApiError };
      if (!response.ok || !payload.data) throw payload.error ?? { message: "Unable to preview calendar impact." };
      setRequestId(nextRequestId);
      setPreview(payload.data);
    } catch (caught) {
      setError(caught as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSave() {
    if (!preview || !requestId || submitting.current) return;
    if (sameDayEmergency && !emergencyAcknowledged) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/clinic-unavailable-dates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, changes, emergencyAcknowledged }),
      });
      const payload = await response.json() as { data?: ClinicCalendarOperationResult; error?: ApiError };
      if (!response.ok || !payload.data) {
        const responseError = payload.error ?? { message: "Unable to save calendar changes." };
        const nextConflicts = new Map<string, string[]>();
        for (const issue of responseError.details?.issues ?? []) {
          nextConflicts.set(issue.date, [...(nextConflicts.get(issue.date) ?? []), issue.message]);
        }
        setConflicts(nextConflicts);
        throw responseError;
      }
      setRecords(payload.data.activeUnavailableDates);
      setDraft(new Map());
      setSuccess(payload.data);
      setPreview(undefined);
      setRequestId(undefined);
      setEmergencyAcknowledged(false);
    } catch (caught) {
      setError(caught as ApiError);
      setPreview(undefined);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Card className="grid min-w-0 gap-5 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Unified annual clinic calendar</CardTitle>
          <p className="mt-1 text-sm text-muted">
            One blocked date applies to both Laboratory and Physical Examination scheduling.
          </p>
        </div>
        <div className="rounded-xl border border-line bg-canvas px-3 py-2 text-sm font-semibold text-ink">
          {openManualCaseCount} open manual {openManualCaseCount === 1 ? "case" : "cases"}
        </div>
      </div>

      {readOnly ? (
        <Alert tone="info">This calendar is read-only for clinic staff.</Alert>
      ) : null}
      {success ? (
        <Alert tone="success">
          Saved {success.blockedDateCount} blocked and {success.reopenedDateCount} reopened dates. {success.manualCaseCount} manual cases created.
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error.message}</Alert> : null}

      <div className="grid gap-4 rounded-2xl border border-line bg-canvas/60 p-4 lg:grid-cols-[auto_1fr]">
        <label className="grid gap-1 text-sm font-semibold text-ink">
          Year
          <Select
            aria-label="Calendar year"
            value={selectedYear}
            onChange={(event) => setSelectedYear(Number(event.target.value))}
          >
            {Array.from({ length: maxYear - currentYear + 1 }, (_, index) => currentYear + index).map((year) => (
              <option key={year} value={year}>{year}</option>
            ))}
          </Select>
        </label>
        {!readOnly ? (
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(12rem,0.35fr)_minmax(14rem,1fr)]">
            <label className="grid gap-1 text-sm font-semibold text-ink">
              Category
              <Select
                aria-label="Closure category"
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value as ClinicCalendarCategory);
                  invalidatePreview();
                }}
              >
                {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </label>
            <label className="grid gap-1 text-sm font-semibold text-ink">
              Reason
              <Input
                aria-label="Closure reason"
                value={reason}
                maxLength={500}
                onChange={(event) => {
                  setReason(event.target.value);
                  invalidatePreview();
                }}
                placeholder="Reason applied to newly blocked dates"
              />
            </label>
          </div>
        ) : null}
      </div>

      <div aria-label="Calendar legend" className="flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold text-muted">
        <span><span className="mr-1 inline-block size-3 rounded bg-white ring-1 ring-line" />Available</span>
        <span><span className="mr-1 inline-block size-3 rounded bg-amber-100 ring-1 ring-amber-400" />Blocked</span>
        <span><span className="mr-1 inline-block size-3 rounded bg-cpu-navy" />Selected to block</span>
        <span><span className="mr-1 inline-block size-3 rounded bg-amber-50 ring-1 ring-amber-500" />Selected to reopen</span>
        <span><span className="mr-1 inline-block size-3 rounded bg-red-50 ring-1 ring-red-500" />Conflict</span>
        <span><span className="mr-1 inline-block size-3 rounded bg-cpu-gold/20 ring-1 ring-cpu-gold" />Today</span>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {annual.map((month) => (
          <section
            key={month.month}
            aria-labelledby={`${month.month}-heading`}
            className="min-w-0 rounded-2xl border border-line bg-white p-3 shadow-sm"
          >
            <h3 id={`${month.month}-heading`} className="mb-2 font-bold text-ink">{month.name}</h3>
            <div className="grid grid-cols-7 gap-1 text-center text-[0.65rem] font-semibold text-muted">
              {weekdays.map((day) => <span key={day}>{day}</span>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {month.cells.map((cell) => {
                if (cell.kind === "blank") return <span key={cell.key} aria-hidden="true" className="aspect-square" />;
                const persisted = persistedByDate.get(cell.date);
                const state = resolveCalendarDateState({
                  date: cell.date,
                  persisted,
                  draft,
                  conflictMessages: conflicts.get(cell.date),
                });
                const isToday = cell.date === today;
                const editableToday = isToday && (Boolean(persisted) || category === "EMERGENCY_CLOSURE");
                const disabled = readOnly
                  || busy
                  || cell.isWeekend
                  || cell.date < today
                  || (isToday && !editableToday);
                const details = state.state === "SAVED_BLOCKED"
                  ? `${state.record.category.replaceAll("_", " ")}: ${state.record.reason}`
                  : state.state === "STAGED_BLOCK"
                    ? `Selected to block: ${state.change.reason}`
                    : state.state === "STAGED_REOPEN"
                      ? `Selected to reopen: ${state.record.reason}`
                      : state.state === "CONFLICT"
                        ? state.messages.join(" ")
                        : cell.isWeekend ? "Weekend" : "Available";
                return (
                  <button
                    key={cell.key}
                    type="button"
                    aria-label={`${month.name} ${cell.dayOfMonth}, ${selectedYear}: ${details}`}
                    aria-pressed={state.state === "STAGED_BLOCK" || state.state === "STAGED_REOPEN"}
                    title={details}
                    disabled={disabled}
                    onClick={() => toggleDate(cell.date)}
                    className={`aspect-square min-w-0 rounded-lg border text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${dayTone(state, isToday)}`}
                  >
                    {cell.dayOfMonth}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {!readOnly ? (
        <div className="grid gap-3 rounded-2xl border border-line bg-canvas/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-ink">{draft.size} unsaved {draft.size === 1 ? "change" : "changes"}</p>
              <p className="text-xs text-muted">{summary.blockedDateCount} to block · {summary.reopenedDateCount} to reopen</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!draft.size || busy} onClick={discard}>Discard</Button>
              <Button disabled={!draft.size || busy} onClick={() => { void requestPreview(); }}>
                {busy ? "Checking impact…" : "Review impact"}
              </Button>
            </div>
          </div>
          <Link href="/settings/clinic-unavailable-dates/manual-resolution" className="text-sm font-semibold text-cpu-navy underline">
            Open Manual Resolution Required queue
          </Link>
        </div>
      ) : null}

      {preview ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="impact-title">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <h2 id="impact-title" className="text-xl font-bold text-ink">Confirm clinic calendar impact</h2>
            <p className="mt-1 text-sm text-muted">The save will recalculate these counts under the scheduling lock.</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-muted">Affected students</dt><dd className="text-lg font-bold">{preview.affectedStudentCount}</dd></div>
              <div><dt className="text-muted">Complete pairs</dt><dd className="text-lg font-bold">{preview.completePairMoveCount}</dd></div>
              <div><dt className="text-muted">Physical only</dt><dd className="text-lg font-bold">{preview.physicalOnlyMoveCount}</dd></div>
              <div><dt className="text-muted">Completed preserved</dt><dd className="text-lg font-bold">{preview.preservedCompletionCount}</dd></div>
              <div><dt className="text-muted">Expected manual cases</dt><dd className="text-lg font-bold">{preview.expectedManualCaseCount}</dd></div>
              <div><dt className="text-muted">Expected restorations</dt><dd className="text-lg font-bold">{preview.expectedRestorationCount}</dd></div>
            </dl>
            {sameDayEmergency ? (
              <label className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                <input
                  type="checkbox"
                  checked={emergencyAcknowledged}
                  onChange={(event) => setEmergencyAcknowledged(event.target.checked)}
                />
                <span>I acknowledge this same-day emergency closure. Completed appointments remain unchanged; unfinished appointments will be rescheduled or sent to manual resolution.</span>
              </label>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => setPreview(undefined)}>Back</Button>
              <Button disabled={busy || (sameDayEmergency && !emergencyAcknowledged)} onClick={() => { void confirmSave(); }}>
                {busy ? "Saving…" : "Confirm and save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <UnsavedCalendarChangesDialog
        open={Boolean(navigation.pendingHref)}
        onContinueEditing={navigation.continueEditing}
        onDiscardAndLeave={() => {
          discard();
          navigation.discardAndLeave();
        }}
      />
    </Card>
  );
}
