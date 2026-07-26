"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
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
  const [confirmed, setConfirmed] = useState(false);

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
    <div className="fixed inset-0 z-50 grid place-items-center bg-cpu-navy-dark/70 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clinic-calendar-save-title"
        aria-busy={confirmed}
        className="w-full max-w-lg rounded-3xl border border-line bg-surface p-6 shadow-2xl"
      >
        <h2 id="clinic-calendar-save-title" className="text-xl font-bold text-ink">Save clinic calendar changes</h2>
        <p className="mt-2 text-sm text-muted">Review these changes before saving them together.</p>
        <div className="mt-4"><CalendarDraftSummary clinics={clinics} changes={changes} /></div>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            ref={cancelButtonRef}
            variant="secondary"
            aria-disabled={confirmed}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={cancel}
          >
            Cancel
          </Button>
          <Button onClick={confirm} disabled={confirmed}>Confirm and save</Button>
        </div>
      </div>
    </div>
  );
}
