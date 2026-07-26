"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import type { ClinicCalendarBatchChange, ClinicCalendarCategory } from "@/types/clinic-calendar";

type CalendarSaveConfirmationDialogProps = {
  open: boolean;
  changes: ClinicCalendarBatchChange[];
  clinics: Array<{ id: string; name: string }>;
  onCancel(): void;
  onConfirm(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
}

const categoryLabels: Record<ClinicCalendarCategory, string> = {
  HOLIDAY: "Holiday",
  CLOSURE: "Closure",
  MAINTENANCE: "Maintenance",
  STAFF_UNAVAILABILITY: "Staff unavailability",
};

const reviewDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatReviewDate(date: string) {
  return reviewDateFormatter.format(new Date(`${date}T00:00:00.000Z`));
}

export function CalendarSaveConfirmationDialog({
  open,
  changes,
  clinics,
  onCancel,
  onConfirm,
  returnFocusRef,
}: CalendarSaveConfirmationDialogProps) {
  if (!open) return null;

  return (
    <CalendarSaveConfirmationDialogContent
      changes={changes}
      clinics={clinics}
      onCancel={onCancel}
      onConfirm={onConfirm}
      returnFocusRef={returnFocusRef}
    />
  );
}

type CalendarSaveConfirmationDialogContentProps = Omit<CalendarSaveConfirmationDialogProps, "open">;

function CalendarSaveConfirmationDialogContent({
  changes,
  clinics,
  onCancel,
  onConfirm,
  returnFocusRef,
}: CalendarSaveConfirmationDialogContentProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const groupedChanges = clinics.flatMap((clinic) => {
    const clinicChanges = changes.filter((change) => change.clinicId === clinic.id);
    if (clinicChanges.length === 0) return [];
    return [{
      clinic,
      blocks: clinicChanges.filter((change) => change.action === "BLOCK"),
      unblocks: clinicChanges.filter((change) => change.action === "UNBLOCK"),
    }];
  });

  useEffect(() => {
    const returnFocusTarget = returnFocusRef?.current ?? document.activeElement as HTMLElement | null;
    cancelButtonRef.current?.focus();
    return () => returnFocusTarget?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (confirmed) return;
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) return;

      event.preventDefault();
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = activeIndex === -1
        ? event.shiftKey ? focusable.length - 1 : 0
        : (activeIndex + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
      focusable[nextIndex].focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [confirmed, onCancel]);

  function cancel() {
    if (confirmed) return;
    onCancel();
  }

  function confirm() {
    if (confirmed) return;
    setConfirmed(true);
    onConfirm();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-cpu-navy-dark/70 p-3 backdrop-blur-sm sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clinic-calendar-save-title"
        aria-busy={confirmed}
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-2xl sm:max-h-[calc(100dvh-2rem)]"
      >
        <div className="shrink-0 border-b border-line px-5 py-4 sm:px-6">
          <h2 id="clinic-calendar-save-title" className="text-xl font-bold text-ink">Save clinic calendar changes</h2>
          <p className="mt-1 text-sm text-muted">Review these changes before saving them together.</p>
          <p className="mt-2 text-sm font-semibold text-ink">
            {groupedChanges.length} {groupedChanges.length === 1 ? "clinic" : "clinics"} · {changes.length} {changes.length === 1 ? "date" : "dates"}
          </p>
        </div>

        <div className="grid min-h-0 gap-4 overflow-y-auto px-5 py-4 sm:px-6">
          {groupedChanges.map(({ clinic, blocks, unblocks }, clinicIndex) => {
            const headingId = `clinic-calendar-review-clinic-${clinicIndex}`;
            return (
              <section
                key={clinic.id}
                aria-labelledby={headingId}
                className="min-w-0 rounded-2xl border border-line bg-canvas/50 p-4"
              >
                <h3 id={headingId} className="font-bold text-ink">{clinic.name}</h3>
                <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2">
                  {blocks.length ? (
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-ink">Dates to block</h4>
                      <ul className="mt-2 grid gap-2">
                        {blocks.map((change) => (
                          <li key={change.date} className="min-w-0 rounded-xl bg-surface p-3 text-sm">
                            <time dateTime={change.date} className="font-semibold text-ink">{formatReviewDate(change.date)}</time>
                            <p className="mt-1 text-muted">{categoryLabels[change.category]}</p>
                            <p className="mt-1 break-words text-ink">{change.reason}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {unblocks.length ? (
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-ink">Dates to unblock</h4>
                      <ul className="mt-2 grid gap-2">
                        {unblocks.map((change) => (
                          <li key={change.date} className="min-w-0 rounded-xl bg-surface p-3 text-sm">
                            <time dateTime={change.date} className="font-semibold text-ink">{formatReviewDate(change.date)}</time>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })}
          <p className="rounded-xl border border-cpu-gold/30 bg-cpu-gold/10 p-3 text-sm text-ink">
            Blocking dates may reschedule appointments. Unblocking dates may restore eligible appointments.
          </p>
        </div>

        <div className="flex shrink-0 flex-col-reverse gap-3 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <Button
            ref={cancelButtonRef}
            variant="secondary"
            aria-disabled={confirmed}
            className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50 sm:w-auto"
            onClick={cancel}
          >
            Cancel
          </Button>
          <Button className="w-full sm:w-auto" onClick={confirm} disabled={confirmed}>Confirm and save</Button>
        </div>
      </div>
    </div>
  );
}
