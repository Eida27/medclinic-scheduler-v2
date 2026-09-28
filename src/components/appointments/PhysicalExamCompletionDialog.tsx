"use client";

import { useEffect, useRef, useState } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { PhysicalExamCompletionForm, type PhysicalExamCompletionContext, type PhysicalExamIssue } from "@/components/appointments/PhysicalExamCompletionForm";
import { Alert } from "@/components/ui/Alert";

export function PhysicalExamCompletionDialog({ appointmentId, onClose, onCompleted }: {
  appointmentId: string;
  onClose: () => void;
  onCompleted: (issue: PhysicalExamIssue, classification: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; context: PhysicalExamCompletionContext }>();
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const context = loaded?.id === appointmentId ? loaded.context : undefined;
  const error = failure?.id === appointmentId ? failure.message : undefined;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/appointments/${appointmentId}/physical-exam-completion-context`,
          { cache: "no-store", signal: controller.signal });
        const body = await readApiPayload<PhysicalExamCompletionContext>(response);
        if (!response.ok || !body?.data) throw new Error(apiErrorMessage(body, "Unable to load examination details."));
        if (!controller.signal.aborted) setLoaded({ id: appointmentId, context: body.data });
      } catch (caught) {
        if (!controller.signal.aborted) setFailure({ id: appointmentId,
          message: caught instanceof Error ? caught.message : "Unable to load examination details." });
      }
    })();
    return () => controller.abort();
  }, [appointmentId]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      if (!busy) onClose();
      event.preventDefault();
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
    ) ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3"
    onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Complete Physical Examination"
      onKeyDown={handleKeyDown} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-surface p-5 shadow-xl">
      <div className="mb-4 flex justify-end"><button ref={closeRef} type="button" disabled={busy}
        className="rounded-lg border border-line px-3 py-2 font-semibold" onClick={onClose}>Close</button></div>
      {!context && !error ? <p role="status">Loading examination details…</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {context ? <PhysicalExamCompletionForm key={appointmentId} {...context}
        onBusyChange={setBusy} onCompleted={onCompleted} /> : null}
    </div>
  </div>;
}
