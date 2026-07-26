"use client";

import { useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import type {
  ClinicCalendarBatchChange,
  ClinicCalendarBatchIssue,
  ClinicCalendarBatchResult,
  ClinicCalendarCategory,
} from "@/types/clinic-calendar";
import { buildMonthGrid, expandUnavailableRanges } from "./clinic-calendar";
import {
  calendarDraftKey,
  resolveCalendarDateState,
  summarizeCalendarDraft,
  toggleCalendarDraft,
} from "./clinic-calendar-draft";
import { BlockConfigurationForm } from "./clinic-calendar/BlockConfigurationForm";
import { CalendarDraftSummary } from "./clinic-calendar/CalendarDraftSummary";
import { CalendarSaveConfirmationDialog } from "./clinic-calendar/CalendarSaveConfirmationDialog";
import { ClinicCalendarToolbar } from "./clinic-calendar/ClinicCalendarToolbar";
import { ClinicMonthGrid } from "./clinic-calendar/ClinicMonthGrid";
import { UnsavedCalendarChangesDialog } from "./clinic-calendar/UnsavedCalendarChangesDialog";
import { useUnsavedCalendarNavigation } from "./clinic-calendar/useUnsavedCalendarNavigation";

type ClinicUnavailableCalendarProps = {
  clinics: Array<{ id: string; name: string }>;
  unavailableDates: ClinicUnavailableDateRecord[];
  initialMonth: string;
  today: string;
  maxYear?: number;
};

type BlockConfiguration = {
  category: ClinicCalendarCategory;
  reason: string;
  valid: boolean;
};

type ApiError = {
  code?: string;
  message: string;
  fields?: Record<string, string[]>;
  details?: { issues?: ClinicCalendarBatchIssue[] };
};

function formatMonth(month: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00.000Z`));
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function sortedChanges(draft: Map<string, ClinicCalendarBatchChange>) {
  return [...draft.values()].sort((left, right) => (
    left.date.localeCompare(right.date) || left.clinicId.localeCompare(right.clinicId)
  ));
}

export function ClinicUnavailableCalendar({
  clinics,
  unavailableDates,
  initialMonth,
  today,
  maxYear = 2100,
}: ClinicUnavailableCalendarProps) {
  const [selectedClinicId, setSelectedClinicId] = useState(clinics[0]?.id ?? "");
  const [month, setMonth] = useState(initialMonth);
  const [configuration, setConfiguration] = useState<BlockConfiguration>({
    category: "CLOSURE",
    reason: "",
    valid: false,
  });
  const [records, setRecords] = useState(unavailableDates);
  const [draft, setDraft] = useState<Map<string, ClinicCalendarBatchChange>>(new Map());
  const [conflicts, setConflicts] = useState<Map<string, string[]>>(new Map());
  const [highlightedKeys, setHighlightedKeys] = useState<Set<string>>(new Set());
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<ClinicCalendarBatchResult>();
  const [error, setError] = useState<ApiError>();
  const submitting = useRef(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  const cells = useMemo(() => buildMonthGrid(month), [month]);
  const persistedByDate = useMemo(
    () => expandUnavailableRanges(records.filter((record) => record.clinicId === selectedClinicId)),
    [records, selectedClinicId],
  );
  const changes = useMemo(() => sortedChanges(draft), [draft]);
  const summary = useMemo(() => summarizeCalendarDraft(draft), [draft]);
  const highlightedDatesForClinic = useMemo(() => new Set(
    [...highlightedKeys]
      .filter((key) => key.startsWith(`${selectedClinicId}:`))
      .map((key) => key.slice(selectedClinicId.length + 1)),
  ), [highlightedKeys, selectedClinicId]);
  const navigation = useUnsavedCalendarNavigation(draft.size > 0);

  function toggleDate(date: string) {
    const persisted = persistedByDate.get(date);
    const key = calendarDraftKey(selectedClinicId, date);
    const existingDraft = draft.get(key);
    if (!existingDraft && !persisted && !configuration.valid) {
      setError({ message: "Choose a category and enter a reason of at least 3 characters before blocking a date." });
      return;
    }

    setDraft((current) => toggleCalendarDraft(current, {
      persisted,
      clinicId: selectedClinicId,
      date,
      blockTemplate: {
        category: configuration.category,
        reason: configuration.reason,
      },
    }));
    setConflicts((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    setHighlightedKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setSuccess(undefined);
    setError(undefined);
  }

  function discardChanges() {
    setDraft(new Map());
    setConflicts(new Map());
    setHighlightedKeys(new Set());
    setConfirmationOpen(false);
    setSuccess(undefined);
    setError(undefined);
  }

  async function confirmSave() {
    if (submitting.current || changes.length === 0) return;
    submitting.current = true;
    setSaving(true);
    setSuccess(undefined);
    setError(undefined);
    const submittedChanges = changes;

    try {
      const response = await fetch("/api/clinic-unavailable-dates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changes: submittedChanges }),
      });
      const payload = await response.json() as { data?: ClinicCalendarBatchResult; error?: ApiError };

      if (!response.ok || !payload.data) {
        const responseError = payload.error ?? { message: "Unable to save the clinic calendar changes." };
        const nextConflicts = new Map<string, string[]>();
        for (const issue of responseError.details?.issues ?? []) {
          const key = calendarDraftKey(issue.clinicId, issue.date);
          nextConflicts.set(key, [...(nextConflicts.get(key) ?? []), issue.message]);
        }
        setConflicts(nextConflicts);
        setHighlightedKeys(new Set(nextConflicts.keys()));
        setError(responseError);
        setConfirmationOpen(false);
        return;
      }

      setRecords(payload.data.activeUnavailableDates);
      setDraft(new Map());
      setConflicts(new Map());
      setHighlightedKeys(new Set(submittedChanges.map((change) => calendarDraftKey(change.clinicId, change.date))));
      setSuccess(payload.data);
      setConfirmationOpen(false);
    } catch {
      setError({ message: "Unable to save the clinic calendar changes." });
      setConfirmationOpen(false);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  const currentYear = Number(today.slice(0, 4));

  return (
    <Card className="grid gap-5">
      <div>
        <CardTitle>Unavailable-date calendar</CardTitle>
        <p className="mt-1 text-sm text-muted">
          Stage changes across clinics and months, review them together, and save once.
        </p>
      </div>

      {success ? (
        <Alert tone="success">
          {plural(success.blockedDateCount, "date")} blocked and {plural(success.unblockedDateCount, "date")} reopened. {" "}
          {plural(success.movedStudentCount, "student")} and {plural(success.movedAppointmentCount, "appointment")} moved. {" "}
          {plural(success.restoredStudentCount, "student")} and {plural(success.restoredAppointmentCount, "appointment")} restored.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger">
          <p>{error.message}</p>
          {error.fields ? (
            <ul className="mt-2 list-disc pl-5 font-normal">
              {Object.values(error.fields).flat().map((message) => <li key={message}>{message}</li>)}
            </ul>
          ) : null}
          {error.details?.issues?.length ? (
            <ul className="mt-2 list-disc pl-5 font-normal">
              {error.details.issues.map((issue) => (
                <li key={`${issue.clinicId}:${issue.date}:${issue.code}`}>{issue.date}: {issue.message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <ClinicCalendarToolbar
        clinics={clinics}
        selectedClinicId={selectedClinicId}
        month={month}
        currentYear={currentYear}
        maxYear={maxYear}
        disabled={saving}
        onClinicChange={setSelectedClinicId}
        onMonthChange={setMonth}
      />

      <BlockConfigurationForm disabled={saving} onChange={setConfiguration} />

      <h2 className="text-lg font-bold text-ink">{formatMonth(month)}</h2>
      <div className="overflow-x-auto">
        <ClinicMonthGrid
          cells={cells}
          getState={(cell) => resolveCalendarDateState({
            clinicId: selectedClinicId,
            date: cell.date,
            persisted: persistedByDate.get(cell.date),
            draft,
            conflictMessages: conflicts.get(calendarDraftKey(selectedClinicId, cell.date)),
          })}
          today={today}
          disabled={saving || !selectedClinicId}
          highlightedDates={highlightedDatesForClinic}
          onToggle={toggleDate}
        />
      </div>

      <div className="grid gap-4 rounded-2xl border border-line bg-canvas/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-semibold text-ink">
            {draft.size === 0 ? "No unsaved changes" : plural(draft.size, "unsaved change")}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" disabled={saving || draft.size === 0} onClick={discardChanges}>
              Discard changes
            </Button>
            <Button
              ref={saveButtonRef}
              disabled={saving || draft.size === 0}
              onClick={() => setConfirmationOpen(true)}
            >
              Save changes
            </Button>
          </div>
        </div>
        {draft.size > 0 ? <CalendarDraftSummary clinics={clinics} changes={changes} /> : null}
        {draft.size > 0 ? (
          <p className="text-xs text-muted">
            {summary.blockedDateCount} to block · {summary.unblockedDateCount} to reopen
          </p>
        ) : null}
      </div>

      <CalendarSaveConfirmationDialog
        open={confirmationOpen}
        changes={changes}
        clinics={clinics}
        onCancel={() => {
          if (!saving) setConfirmationOpen(false);
        }}
        onConfirm={() => { void confirmSave(); }}
        returnFocusRef={saveButtonRef}
      />

      <UnsavedCalendarChangesDialog
        open={Boolean(navigation.pendingHref)}
        onContinueEditing={navigation.continueEditing}
        onDiscardAndLeave={() => {
          discardChanges();
          navigation.discardAndLeave();
        }}
      />
    </Card>
  );
}
