"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  error?: string;
  confirmLabel: string;
  pending?: boolean;
  pendingLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  error,
  confirmLabel,
  pending = false,
  pendingLabel = "Working...",
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const originRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    originRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    cancelButtonRef.current?.focus();

    return () => {
      originRef.current?.focus();
      originRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, open, pending]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-cpu-navy-dark/70 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={pending}
        aria-labelledby="confirm-dialog-title"
        aria-describedby={error
          ? "confirm-dialog-description confirm-dialog-error"
          : "confirm-dialog-description"}
        className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-2xl"
      >
        <div className="mb-5 h-1.5 w-14 rounded-full bg-cpu-gold" />
        <h2 id="confirm-dialog-title" className="text-xl font-bold text-ink">{title}</h2>
        <p id="confirm-dialog-description" className="mt-2 text-sm leading-6 text-muted">{description}</p>
        {error ? (
          <p
            id="confirm-dialog-error"
            role="alert"
            className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-3">
          <Button ref={cancelButtonRef} variant="secondary" onClick={onCancel} disabled={pending}>Cancel</Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={pending}
            aria-label={pending ? pendingLabel : undefined}
          >
            {pending ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="sm" label={pendingLabel} />
                {pendingLabel}
              </span>
            ) : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
