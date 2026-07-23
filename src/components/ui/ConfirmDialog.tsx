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
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) onCancel();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, open, pending]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-cpu-navy-dark/70 p-4 backdrop-blur-sm">
      <div
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
