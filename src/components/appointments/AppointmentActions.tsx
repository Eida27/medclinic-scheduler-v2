"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { operationalStatusLabel } from "@/components/appointments/status-labels";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";

type AppointmentActionsProps = {
  id: string;
  status: string;
  canCorrectNoShow?: boolean;
  isManuallyLocked?: boolean;
  updatedAt?: string;
  basePath?: "/appointments" | "/laboratory" | "/physical-exam";
};

export function AppointmentActions({
  id,
  status,
  canCorrectNoShow = false,
  isManuallyLocked = false,
  updatedAt,
  basePath = "/appointments",
}: AppointmentActionsProps) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function update(body: Record<string, unknown>, navigateToReplacement = false) {
    setPending(true);
    setError(undefined);
    const response = await fetch(`/api/appointments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as {
      data?: { id?: string };
      error?: { message?: string };
    };
    if (!response.ok) {
      setError(payload.error?.message);
      setPending(false);
      return;
    }
    if (navigateToReplacement && payload.data?.id) {
      router.push(`${basePath}/${payload.data.id}`);
    } else {
      router.refresh();
    }
    setPending(false);
  }

  function statusSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void update({ status: form.get("status"), notes: form.get("notes") });
  }

  function rescheduleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void update({
      appointmentDate: form.get("appointmentDate"),
      notes: form.get("notes"),
      ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}),
    }, true);
  }

  return (
    <div className="grid gap-5">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {["DRAFT", "PENDING"].includes(status) ? (
        <form onSubmit={statusSubmit} className="grid gap-3 sm:grid-cols-3">
          <Select name="status" defaultValue={status}>
            {status === "DRAFT" ? (
              <option value="CANCELLED">{operationalStatusLabel("CANCELLED")}</option>
            ) : (
              <>
                <option value="COMPLETED">{operationalStatusLabel("COMPLETED")}</option>
                <option value="CANCELLED">{operationalStatusLabel("CANCELLED")}</option>
              </>
            )}
          </Select>
          <Input name="notes" placeholder="Status note" />
          <Button type="submit" disabled={pending}>Update status</Button>
        </form>
      ) : null}
      {status === "NO_SHOW" && canCorrectNoShow ? (
        <form onSubmit={statusSubmit} className="grid gap-3 sm:grid-cols-3">
          <input type="hidden" name="status" value="COMPLETED" />
          <Textarea
            name="notes"
            aria-label="Correction reason"
            placeholder="Reason for correcting this automatic no-show"
            required
            className="sm:col-span-2"
          />
          <Button type="submit" disabled={pending}>Correct to completed</Button>
        </form>
      ) : null}
      {["PENDING", "NO_SHOW"].includes(status) ? (
        <form onSubmit={rescheduleSubmit} className="grid gap-3 sm:grid-cols-2">
          {isManuallyLocked ? (
            <div className="sm:col-span-2">
              <Alert tone="warning">
                This appointment is manually locked. Its protection will transfer to the replacement appointment.
              </Alert>
            </div>
          ) : null}
          <Input name="appointmentDate" aria-label="Replacement appointment date" type="date" required />
          <Button type="submit" variant="secondary" disabled={pending}>Create replacement</Button>
          <Textarea
            name="notes"
            aria-label="Reason for rescheduling"
            placeholder="Reason for rescheduling"
            required
            className="sm:col-span-3"
          />
        </form>
      ) : null}
    </div>
  );
}
