"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";

export type CompletedStatusCorrectionProps = {
  appointmentId: string;
  appointmentDate: string;
  source: "APPOINTMENTS" | "LABORATORY" | "PHYSICAL_EXAM";
};

type CorrectionTarget = "PENDING" | "NO_SHOW";

function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function CompletedStatusCorrection({
  appointmentId,
  appointmentDate,
  source,
}: CompletedStatusCorrectionProps) {
  const router = useRouter();
  const [target, setTarget] = useState<CorrectionTarget>("PENDING");
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const noShowDisabled = appointmentDate >= manilaToday();

  function reviewCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (reason.trim().length < 3) {
      setError("Enter a reason for correcting this completed appointment.");
      return;
    }
    setError(undefined);
    setConfirmOpen(true);
  }

  async function correctStatus() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: target,
          correctionReason: reason.trim(),
          source,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error?.message ?? "Unable to correct the appointment status.");
        setConfirmOpen(false);
        setPending(false);
        return;
      }
      setConfirmOpen(false);
      router.refresh();
      setPending(false);
    } catch {
      setError("Unable to correct the appointment status.");
      setConfirmOpen(false);
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="completed-status-correction-title"
      className="rounded-2xl border border-amber-300 bg-amber-50/70 p-4"
    >
      <h3 id="completed-status-correction-title" className="font-bold text-amber-950">
        Correct completed status
      </h3>
      <p className="mt-1 text-sm text-amber-900">
        Use only when this appointment was marked completed incorrectly.
      </p>
      {error ? <div className="mt-3"><Alert tone="danger">{error}</Alert></div> : null}
      <form onSubmit={reviewCorrection} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold text-ink">
          Correct status to
          <Select
            value={target}
            onChange={(event) => setTarget(event.target.value as CorrectionTarget)}
            disabled={pending}
          >
            <option value="PENDING">Pending</option>
            <option value="NO_SHOW" disabled={noShowDisabled}>No-show</option>
          </Select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-ink sm:col-span-2">
          Correction reason
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            minLength={3}
            disabled={pending}
            placeholder="Explain why the completed status is incorrect"
          />
        </label>
        {noShowDisabled ? (
          <p className="text-sm text-amber-900 sm:col-span-2">
            No-show corrections are available only after the appointment date.
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <Button type="submit" variant="secondary" disabled={pending}>Review correction</Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmOpen}
        title="Confirm status correction?"
        description={`This will change the completed appointment to ${target === "PENDING" ? "Pending" : "No-show"} and record your reason in its history.`}
        confirmLabel="Confirm correction"
        pending={pending}
        pendingLabel="Saving correction"
        danger
        onCancel={() => setConfirmOpen(false)}
        onConfirm={correctStatus}
      />
    </section>
  );
}
