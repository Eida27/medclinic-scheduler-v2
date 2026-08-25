"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Textarea } from "@/components/ui/Textarea";
import type { HistoricalStaffActor } from "@/types/roles";

type AppointmentProtectionPanelProps = {
  appointmentId: string;
  status: string;
  isManuallyLocked: boolean;
  lockReason: string | null;
  lockedByName: string | null;
  lockedBy?: HistoricalStaffActor | null;
  lockedAt: string | null;
  updatedAt: string;
  canManage: boolean;
};

function manilaTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

export function AppointmentProtectionPanel({
  appointmentId,
  status,
  isManuallyLocked,
  lockReason,
  lockedByName,
  lockedBy,
  lockedAt,
  updatedAt,
  canManage,
}: AppointmentProtectionPanelProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [pending, setPending] = useState(false);
  const eligibleForNewLock = status === "DRAFT" || status === "PENDING";
  const action = isManuallyLocked ? "UNLOCK" : "LOCK";

  function openConfirmation() {
    setValidationError(undefined);
    setDialogError(undefined);
    if (action === "LOCK" && reason.trim().length < 3) {
      setValidationError("Enter a reason for locking this appointment.");
      return;
    }
    setDialogOpen(true);
  }

  async function confirm() {
    setPending(true);
    setDialogError(undefined);
    try {
      const response = await fetch(`/api/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lockAction: action,
          ...(action === "LOCK" ? { lockReason: reason.trim() } : {}),
          expectedUpdatedAt: updatedAt,
        }),
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) {
        setDialogError(payload.error?.message ?? "Unable to update appointment protection.");
        return;
      }
      setDialogOpen(false);
      router.refresh();
    } catch {
      setDialogError("Unable to update appointment protection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Appointment protection</CardTitle>
          <p className="mt-1 text-sm text-muted">
            {isManuallyLocked
              ? "This appointment is protected from automatic scheduling changes."
              : "This appointment is currently available for automatic scheduling changes."}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${isManuallyLocked
          ? "bg-amber-100 text-amber-950"
          : "bg-slate-100 text-slate-700"}`}
        >
          {isManuallyLocked
            ? (eligibleForNewLock ? "Manually locked" : "Previously locked")
            : "Not protected"}
        </span>
      </div>

      {isManuallyLocked ? (
        <dl className="mt-4 grid gap-3 rounded-xl border border-line bg-canvas/60 p-4 text-sm sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="font-bold text-muted">Reason</dt>
            <dd className="mt-1 text-ink">{lockReason}</dd>
          </div>
          <div>
            <dt className="font-bold text-muted">Protected by</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-ink">
              <span>{lockedBy?.fullName ?? lockedByName ?? "Unknown administrator"}</span>
              {lockedBy?.deleted ? <Badge tone="neutral">Deleted</Badge> : null}
            </dd>
          </div>
          <div>
            <dt className="font-bold text-muted">Protected at</dt>
            <dd className="mt-1 text-ink">{lockedAt ? manilaTimestamp(lockedAt) : "Unknown"}</dd>
          </div>
        </dl>
      ) : null}

      {canManage && !isManuallyLocked && eligibleForNewLock ? (
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-sm font-semibold">
            Lock reason
            <Textarea
              aria-label="Appointment protection reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why should automatic rescheduling be prevented?"
            />
          </label>
          {validationError ? <Alert tone="danger">{validationError}</Alert> : null}
          <Button className="w-fit" onClick={openConfirmation}>Lock appointment</Button>
        </div>
      ) : null}

      {canManage && isManuallyLocked ? (
        <div className="mt-4">
          <Button variant="secondary" onClick={openConfirmation}>Unlock appointment</Button>
        </div>
      ) : null}

      {!canManage ? (
        <p className="mt-4 text-sm text-muted">Only administrators can change appointment protection.</p>
      ) : null}
      {canManage && !isManuallyLocked && !eligibleForNewLock ? (
        <p className="mt-4 text-sm text-muted">This historical status cannot be newly protected.</p>
      ) : null}

      <ConfirmDialog
        open={dialogOpen}
        title={action === "LOCK" ? "Lock this appointment?" : "Unlock this appointment?"}
        description={action === "LOCK"
          ? "Automated closure rescheduling and priority displacement will not move it. Authorized staff may still update its status or manually reschedule it."
          : "Automatic scheduling processes may move it when required by clinic closures or priority displacement."}
        error={dialogError}
        confirmLabel={action === "LOCK" ? "Lock appointment" : "Unlock appointment"}
        pending={pending}
        pendingLabel={action === "LOCK" ? "Protecting" : "Removing protection"}
        danger={action === "UNLOCK"}
        onCancel={() => {
          if (!pending) setDialogOpen(false);
        }}
        onConfirm={() => { void confirm(); }}
      />
    </Card>
  );
}
