"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import type { ClinicCalendarBatchChange } from "@/types/clinic-calendar";
import { CalendarDraftSummary } from "./CalendarDraftSummary";

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
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    previousFocusRef.current = returnFocusRef?.current ?? document.activeElement as HTMLElement | null;
    cancelButtonRef.current?.focus();
  }, [returnFocusRef]);

  const restoreFocus = useCallback(() => {
    (returnFocusRef?.current ?? previousFocusRef.current)?.focus();
  }, [returnFocusRef]);

  function cancel() {
    onCancel();
    restoreFocus();
  }

  function confirm() {
    if (confirmed) return;
    setConfirmed(true);
    onConfirm();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-cpu-navy-dark/70 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clinic-calendar-save-title"
        aria-busy={confirmed}
        onKeyDown={handleKeyDown}
        className="w-full max-w-lg rounded-3xl border border-line bg-surface p-6 shadow-2xl"
      >
        <h2 id="clinic-calendar-save-title" className="text-xl font-bold text-ink">Save clinic calendar changes</h2>
        <p className="mt-2 text-sm text-muted">Review these changes before saving them together.</p>
        <div className="mt-4"><CalendarDraftSummary clinics={clinics} changes={changes} /></div>
        <div className="mt-6 flex justify-end gap-3">
          <Button ref={cancelButtonRef} variant="secondary" onClick={cancel}>Cancel</Button>
          <Button onClick={confirm} disabled={confirmed}>Confirm and save</Button>
        </div>
      </div>
    </div>
  );
}
