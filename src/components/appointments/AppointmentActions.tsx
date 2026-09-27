"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";

type AppointmentActionsProps = {
  id: string;
  status: string;
  canCorrectNoShow?: boolean;
  isManuallyLocked?: boolean;
  updatedAt?: string;
  basePath: "/laboratory" | "/physical-exam";
};

export function AppointmentActions({
  id,
  status,
  isManuallyLocked = false,
  updatedAt,
  basePath,
}: AppointmentActionsProps) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  async function update(body: Record<string, unknown>, navigateToReplacement = false) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    const fallback = "Unable to update the appointment. Check your connection and try again.";
    try {
      const response = await fetch(`/api/appointments/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readApiPayload<{ id?: string }>(response);
      if (!response.ok) {
        setError(apiErrorMessage(payload, fallback));
        return;
      }
      if (navigateToReplacement && payload?.data?.id) {
        router.push(`${basePath}/${payload.data.id}`);
      } else if (navigateToReplacement) {
        setError(fallback);
      } else {
        router.refresh();
      }
    } catch {
      setError(fallback);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
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
          <input type="hidden" name="status" value="CANCELLED" />
          <Input name="notes" placeholder="Status note" />
          <Button type="submit" disabled={pending}>Cancel appointment</Button>
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
