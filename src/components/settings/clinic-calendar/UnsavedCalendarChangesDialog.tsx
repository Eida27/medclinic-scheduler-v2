"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";

type UnsavedCalendarChangesDialogProps = {
  open: boolean;
  onContinueEditing(): void;
  onDiscardAndLeave(): void;
};

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  ));
}

export function UnsavedCalendarChangesDialog({
  open,
  onContinueEditing,
  onDiscardAndLeave,
}: UnsavedCalendarChangesDialogProps) {
  if (!open) return null;
  return (
    <UnsavedCalendarChangesDialogContent
      onContinueEditing={onContinueEditing}
      onDiscardAndLeave={onDiscardAndLeave}
    />
  );
}

function UnsavedCalendarChangesDialogContent({
  onContinueEditing,
  onDiscardAndLeave,
}: Omit<UnsavedCalendarChangesDialogProps, "open">) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    continueButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onContinueEditing();
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
  }, [onContinueEditing]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-cpu-navy-dark/70 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-clinic-calendar-title"
        className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-2xl"
      >
        <h2 id="unsaved-clinic-calendar-title" className="text-xl font-bold text-ink">
          Unsaved calendar changes
        </h2>
        <p className="mt-2 text-sm text-muted">
          Your staged clinic calendar changes have not been saved. Discard them before leaving?
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button ref={continueButtonRef} variant="secondary" onClick={onContinueEditing}>
            Continue editing
          </Button>
          <Button variant="danger" onClick={onDiscardAndLeave}>Discard and leave</Button>
        </div>
      </div>
    </div>
  );
}
