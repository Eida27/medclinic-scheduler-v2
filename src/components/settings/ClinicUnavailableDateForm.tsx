"use client";

import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";

type ClinicOption = { id: string; name: string };
type Impact = { movedStudentCount: number; movedAppointmentCount: number };
type ApiError = { message: string; fields?: Record<string, string[]> };

export function ClinicUnavailableDateForm({ clinics }: { clinics: ClinicOption[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [impact, setImpact] = useState<Impact>();
  const [error, setError] = useState<ApiError>();

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setImpact(undefined);
    setError(undefined);
    setConfirmOpen(true);
  }

  async function submit() {
    if (!formRef.current || pending) return;
    setPending(true);
    const form = new FormData(formRef.current);
    const body = Object.fromEntries(form.entries());
    try {
      const response = await fetch("/api/clinic-unavailable-dates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      setConfirmOpen(false);
      if (!response.ok) {
        setError(payload.error ?? { message: "Unable to create the clinic block." });
        return;
      }
      setImpact(payload.data);
      formRef.current.reset();
    } catch {
      setConfirmOpen(false);
      setError({ message: "Unable to create the clinic block." });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Card>
        <form ref={formRef} onSubmit={review} className="grid gap-5">
          <div>
            <CardTitle>Add unavailable dates</CardTitle>
            <p className="mt-1 text-sm text-muted">
              Future affected appointments are evaluated and rescheduled atomically.
            </p>
          </div>
          {impact ? (
            <Alert tone="success">
              Clinic block created. {impact.movedStudentCount} students and {impact.movedAppointmentCount} appointments were moved.
            </Alert>
          ) : null}
          {error ? (
            <Alert tone="danger">
              <p>{error.message}</p>
              {error.fields ? (
                <ul className="mt-2 list-disc pl-5 font-normal">
                  {Object.values(error.fields).flat().map((message) => <li key={message}>{message}</li>)}
                </ul>
              ) : null}
            </Alert>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Clinic">
              <Select name="clinicId" required defaultValue="">
                <option value="" disabled>Select clinic</option>
                {clinics.map((clinic) => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
              </Select>
            </Field>
            <Field label="Category">
              <Select name="category" required defaultValue="CLOSURE">
                <option value="HOLIDAY">Holiday</option>
                <option value="CLOSURE">Closure</option>
                <option value="MAINTENANCE">Maintenance</option>
                <option value="STAFF_UNAVAILABILITY">Staff unavailability</option>
              </Select>
            </Field>
            <Field label="Start date"><Input name="startDate" type="date" required /></Field>
            <Field label="End date"><Input name="endDate" type="date" required /></Field>
          </div>
          <Field label="Reason"><Textarea name="reason" required maxLength={500} /></Field>
          <Button type="submit" className="justify-self-start">Review clinic block</Button>
        </form>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        title="Create this clinic block?"
        description="The complete impact will be locked first. Eligible appointments will automatically reschedule; protected appointments will stop and roll back the entire block."
        confirmLabel="Create block"
        pending={pending}
        pendingLabel="Creating block…"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={submit}
      />
    </>
  );
}
