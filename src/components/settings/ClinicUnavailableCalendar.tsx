"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import type { ClinicUnavailableDateRecord } from "@/server/repositories/clinic-unavailable-dates.repository";
import { buildMonthGrid, expandUnavailableRanges, shiftMonth } from "./clinic-calendar";

type ClinicUnavailableCalendarProps = {
  clinics: Array<{ id: string; name: string }>;
  unavailableDates: ClinicUnavailableDateRecord[];
  initialMonth: string;
  today: string;
};

type Category = ClinicUnavailableDateRecord["category"];
type Impact = { movedStudentCount: number; movedAppointmentCount: number };
type ApiError = { message: string; fields?: Record<string, string[]> };

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const categoryLabels: Record<Category, string> = {
  HOLIDAY: "Holiday",
  CLOSURE: "Closure",
  MAINTENANCE: "Maintenance",
  STAFF_UNAVAILABILITY: "Staff unavailability",
};

function formatMonth(month: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00.000Z`));
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

export function ClinicUnavailableCalendar({
  clinics,
  unavailableDates,
  initialMonth,
  today,
}: ClinicUnavailableCalendarProps) {
  const [selectedClinicId, setSelectedClinicId] = useState(clinics[0]?.id ?? "");
  const [category, setCategory] = useState<Category>("CLOSURE");
  const [reason, setReason] = useState("");
  const [month, setMonth] = useState(initialMonth);
  const [pendingDate, setPendingDate] = useState<string>();
  const [records, setRecords] = useState(unavailableDates);
  const [success, setSuccess] = useState<Impact>();
  const [error, setError] = useState<ApiError>();
  const [selectedUnavailableDate, setSelectedUnavailableDate] = useState<string>();
  const submitting = useRef(false);
  const unavailableDetailsId = useId();

  const days = useMemo(() => buildMonthGrid(month), [month]);
  const recordsForClinic = useMemo(
    () => records.filter((record) => record.clinicId === selectedClinicId),
    [records, selectedClinicId],
  );
  const unavailableByDate = useMemo(
    () => expandUnavailableRanges(recordsForClinic),
    [recordsForClinic],
  );
  const selectedUnavailable = selectedUnavailableDate
    ? unavailableByDate.get(selectedUnavailableDate)
    : undefined;
  const trimmedReason = reason.trim();
  const formIsValid = Boolean(selectedClinicId) && trimmedReason.length >= 3 && trimmedReason.length <= 500;

  async function markUnavailable(date: string) {
    if (!formIsValid || pendingDate || submitting.current || unavailableByDate.has(date)) return;

    submitting.current = true;
    setPendingDate(date);
    setSuccess(undefined);
    setError(undefined);
    const selectedClinic = clinics.find((clinic) => clinic.id === selectedClinicId);

    try {
      const response = await fetch("/api/clinic-unavailable-dates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clinicId: selectedClinicId,
          startDate: date,
          endDate: date,
          category,
          reason: trimmedReason,
        }),
      });
      const payload = await response.json() as {
        data?: { id: string } & Impact;
        error?: ApiError;
      };

      if (!response.ok || !payload.data) {
        setError(payload.error ?? { message: "Unable to create the clinic block." });
        return;
      }

      setRecords((current) => [
        ...current,
        {
          id: payload.data!.id,
          clinicId: selectedClinicId,
          clinicCode: "",
          clinicName: selectedClinic?.name ?? "",
          startDate: date,
          endDate: date,
          category,
          reason: trimmedReason,
          createdByName: "",
          createdAt: new Date().toISOString(),
        },
      ]);
      setSuccess({
        movedStudentCount: payload.data.movedStudentCount,
        movedAppointmentCount: payload.data.movedAppointmentCount,
      });
    } catch {
      setError({ message: "Unable to create the clinic block." });
    } finally {
      submitting.current = false;
      setPendingDate(undefined);
    }
  }

  return (
    <Card className="grid gap-5">
      <div>
        <CardTitle>Unavailable-date calendar</CardTitle>
        <p className="mt-1 text-sm text-muted">
          Choose a clinic and reason, then select a future weekday to block it and reschedule affected appointments.
        </p>
      </div>

      {success ? (
        <Alert tone="success">
          Clinic date marked unavailable. {success.movedStudentCount} students and {success.movedAppointmentCount} appointments were moved.
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
        <Field label="Clinic">
          <Select
            value={selectedClinicId}
            disabled={Boolean(pendingDate)}
            onChange={(event) => {
              setSelectedClinicId(event.target.value);
              setSelectedUnavailableDate(undefined);
              setSuccess(undefined);
              setError(undefined);
            }}
          >
            {clinics.length === 0 ? <option value="">No clinics available</option> : null}
            {clinics.map((clinic) => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
          </Select>
        </Field>
        <Field label="Category">
          <Select
            value={category}
            disabled={Boolean(pendingDate)}
            onChange={(event) => setCategory(event.target.value as Category)}
          >
            {Object.entries(categoryLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Reason">
          <Textarea
            value={reason}
            required
            minLength={3}
            maxLength={500}
            disabled={Boolean(pendingDate)}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="secondary"
          size="sm"
          aria-label="Previous month"
          disabled={Boolean(pendingDate)}
          onClick={() => {
            setSelectedUnavailableDate(undefined);
            setMonth((current) => shiftMonth(current, -1));
          }}
        >
          Previous
        </Button>
        <h2 className="text-lg font-bold text-ink">{formatMonth(month)}</h2>
        <Button
          variant="secondary"
          size="sm"
          aria-label="Next month"
          disabled={Boolean(pendingDate)}
          onClick={() => {
            setSelectedUnavailableDate(undefined);
            setMonth((current) => shiftMonth(current, 1));
          }}
        >
          Next
        </Button>
      </div>

      <div className="overflow-x-auto">
        <section aria-label={`${formatMonth(month)} clinic availability`} className="min-w-[42rem]">
          <div className="grid grid-cols-7 gap-1">
            {weekdays.map((weekday) => (
              <div key={weekday} className="px-2 py-1 text-center text-xs font-bold text-muted">
                {weekday}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {days.map((day) => {
              const unavailable = unavailableByDate.get(day.date);
              const dateLabel = formatDate(day.date);
              const isToday = day.date === today;
              const isPast = day.date < today;
              const isSaving = pendingDate === day.date;
              const isOutsideMonth = !day.inCurrentMonth;
              let stateLabel = "available";
              if (unavailable) {
                stateLabel = `unavailable: ${categoryLabels[unavailable.category]}, ${unavailable.reason}`;
              } else if (isSaving) {
                stateLabel = "saving";
              } else if (isToday) {
                stateLabel = "today";
              } else if (isPast) {
                stateLabel = "past";
              } else if (day.isWeekend) {
                stateLabel = "weekend";
              } else if (isOutsideMonth) {
                stateLabel = "outside current month";
              }
              const genuinelyNonActionable = Boolean(
                isToday
                || isPast
                || day.isWeekend
                || isOutsideMonth,
              );
              const disabled = Boolean(
                genuinelyNonActionable
                || pendingDate
                || (!unavailable && !formIsValid),
              );
              const isSelectedUnavailable = Boolean(
                unavailable && selectedUnavailableDate === day.date,
              );

              return (
                <button
                  key={day.date}
                  type="button"
                  aria-label={`${dateLabel} — ${stateLabel}`}
                  aria-disabled={unavailable ? true : undefined}
                  aria-pressed={unavailable ? isSelectedUnavailable : undefined}
                  aria-controls={unavailable ? unavailableDetailsId : undefined}
                  aria-describedby={isSelectedUnavailable ? unavailableDetailsId : undefined}
                  disabled={disabled}
                  onClick={() => {
                    if (unavailable) {
                      setSelectedUnavailableDate(day.date);
                      return;
                    }
                    void markUnavailable(day.date);
                  }}
                  className="flex min-h-20 flex-col items-center justify-center gap-1 rounded-xl border border-line bg-surface px-2 py-3 text-sm font-semibold text-ink transition hover:border-cpu-navy/30 hover:bg-cpu-navy-soft aria-disabled:bg-canvas aria-disabled:text-muted aria-pressed:border-cpu-navy aria-pressed:ring-2 aria-pressed:ring-cpu-navy/20 disabled:cursor-not-allowed disabled:bg-canvas disabled:text-muted"
                >
                  <span>{day.dayOfMonth}</span>
                  {isSaving ? <Spinner size="sm" label={`Saving ${dateLabel}`} /> : null}
                  {unavailable ? <span className="text-[0.65rem] font-bold uppercase tracking-wide">Unavailable</span> : null}
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {selectedUnavailable ? (
        <section
          id={unavailableDetailsId}
          role="region"
          aria-labelledby={`${unavailableDetailsId}-title`}
          className="rounded-xl border border-line bg-canvas/60 p-4"
        >
          <h3 id={`${unavailableDetailsId}-title`} className="font-bold text-ink">
            Unavailable date details
          </h3>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-semibold text-muted">Clinic</dt>
              <dd className="text-ink">{selectedUnavailable.clinicName}</dd>
            </div>
            <div>
              <dt className="font-semibold text-muted">Category</dt>
              <dd className="text-ink">{categoryLabels[selectedUnavailable.category]}</dd>
            </div>
            <div>
              <dt className="font-semibold text-muted">Reason</dt>
              <dd className="text-ink">{selectedUnavailable.reason}</dd>
            </div>
            <div>
              <dt className="font-semibold text-muted">Original date range</dt>
              <dd className="text-ink">
                {formatDate(selectedUnavailable.startDate)} to {formatDate(selectedUnavailable.endDate)}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
    </Card>
  );
}
