"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { manilaCalendarDate } from "@/lib/academic-year";
import { cn } from "@/lib/cn";

type AcademicYearItem = {
  startYear: number;
  label: string;
  closingDate: string;
  state: "OPEN" | "CLOSING_SOON" | "CLOSED";
  linkedSnapshotCount: number;
};

type Feedback = { tone: "success" | "danger"; message: string };

function july31(startYear: number) {
  return `${startYear + 1}-07-31`;
}

function apiMessage(payload: unknown, fallback: string) {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return fallback;
  const error = payload.error;
  return typeof error === "object" && error !== null && "message" in error
    && typeof error.message === "string"
    ? error.message
    : fallback;
}

const stateTone = {
  OPEN: "bg-emerald-100 text-emerald-900",
  CLOSING_SOON: "bg-amber-100 text-amber-950",
  CLOSED: "bg-slate-200 text-slate-800",
} as const;

export function AcademicYearsManager({ years }: { years: AcademicYearItem[] }) {
  const router = useRouter();
  const nextStartYear = years.length
    ? Math.max(...years.map((year) => year.startYear)) + 1
    : Number(manilaCalendarDate(new Date()).slice(0, 4));
  const [startYear, setStartYear] = useState(nextStartYear);
  const [newClosingDate, setNewClosingDate] = useState(july31(nextStartYear));
  const [closingDates, setClosingDates] = useState<Record<number, string>>(() => (
    Object.fromEntries(years.map((year) => [year.startYear, year.closingDate]))
  ));
  const [pending, setPending] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<AcademicYearItem>();
  const [feedback, setFeedback] = useState<Feedback>();

  async function send(
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    setPending(`${method}:${body.startYear}`);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/settings/academic-years", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        setFeedback({
          tone: "danger",
          message: apiMessage(payload, "The academic year could not be saved."),
        });
        return false;
      }
      setFeedback({ tone: "success", message: successMessage });
      router.refresh();
      return true;
    } catch {
      setFeedback({ tone: "danger", message: "The academic year could not be saved." });
      return false;
    } finally {
      setPending(undefined);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await send("POST", { startYear, closingDate: newClosingDate }, "Academic year created.");
  }

  async function update(year: AcademicYearItem) {
    await send(
      "PATCH",
      { startYear: year.startYear, closingDate: closingDates[year.startYear] },
      "Closing date updated.",
    );
  }

  async function remove() {
    if (!deleteTarget) return;
    const deleted = await send(
      "DELETE",
      { startYear: deleteTarget.startYear },
      "Academic year deleted.",
    );
    setDeleteTarget(undefined);
    if (!deleted) return;
  }

  return (
    <div className="grid gap-6">
      {feedback ? <Alert tone={feedback.tone}>{feedback.message}</Alert> : null}
      <Card>
        <CardTitle>Add academic year</CardTitle>
        <form onSubmit={create} className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <label className="grid gap-1.5 text-sm font-semibold text-ink">
            Academic-year start year
            <Input
              aria-label="Academic-year start year"
              type="number"
              min={2020}
              max={2100}
              value={startYear}
              onChange={(event) => {
                const value = Number(event.target.value);
                setStartYear(value);
                if (Number.isInteger(value)) setNewClosingDate(july31(value));
              }}
              required
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-ink">
            Closing date
            <Input
              aria-label="New academic-year closing date"
              type="date"
              value={newClosingDate}
              onChange={(event) => setNewClosingDate(event.target.value)}
              required
            />
          </label>
          <Button type="submit" disabled={Boolean(pending)}>Add academic year</Button>
        </form>
      </Card>

      <Card>
        <CardTitle>Configured academic years</CardTitle>
        {years.length ? (
          <div role="list" aria-label="Academic years" className="mt-4 divide-y divide-line">
            {years.map((year) => (
              <div key={year.startYear} role="listitem" className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(13rem,0.8fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold text-ink">{year.label}</p>
                    <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", stateTone[year.state])}>
                      {year.state}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {year.linkedSnapshotCount} linked historical {year.linkedSnapshotCount === 1 ? "record" : "records"}
                  </p>
                </div>
                <label className="grid gap-1.5 text-sm font-semibold text-ink">
                  Closing date
                  <Input
                    aria-label={`Closing date for ${year.label}`}
                    type="date"
                    value={closingDates[year.startYear] ?? year.closingDate}
                    onChange={(event) => setClosingDates((current) => ({
                      ...current,
                      [year.startYear]: event.target.value,
                    }))}
                  />
                </label>
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={Boolean(pending)}
                    onClick={() => update(year)}
                  >
                    <span className="sr-only">Save {year.label} closing date</span>
                    <span aria-hidden="true">Save</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Delete ${year.label}`}
                    title={year.linkedSnapshotCount > 0
                      ? "Academic years with linked historical records cannot be deleted."
                      : `Delete ${year.label}`}
                    disabled={Boolean(pending) || year.linkedSnapshotCount > 0}
                    onClick={() => setDeleteTarget(year)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="mt-4 text-sm text-muted">No academic years are configured.</p>}
      </Card>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.label ?? "academic year"}?`}
        description="Delete this academic year? This action cannot be undone."
        confirmLabel="Delete academic year"
        pendingLabel="Deleting..."
        pending={pending?.startsWith("DELETE:")}
        danger
        onCancel={() => setDeleteTarget(undefined)}
        onConfirm={remove}
      />
    </div>
  );
}
