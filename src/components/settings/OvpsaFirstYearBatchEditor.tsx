"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";

type Preview = {
  optimisticToken: string;
  memberCount: number;
  members: Array<{
    studentNumber: string;
    studentName: string;
    programName: string;
  }>;
  laboratory: { date: string; locationName: string };
  physicalExam: {
    date: string;
    defaultDate: string;
    requiredCapacity: number;
    maximumCapacity: number;
    isException: boolean;
  };
  protectedConflicts: Array<{ studentNumber: string; message: string }>;
  displacements: Array<{
    studentNumber: string;
    category: string;
    oldLaboratoryDate: string | null;
    oldPhysicalExamDate: string | null;
  }>;
  proposedReplacements: Array<{
    studentNumber: string;
    laboratoryDate: string | null;
    physicalExamDate: string;
  }>;
  blockers: Array<{ code: string; message: string }>;
  canPublish: boolean;
};

export type OvpsaFirstYearBatchDetail = {
  batchId: string;
  scheduleCycleStart: number;
  collegeName: string;
  status: "DRAFT" | "PUBLISHED" | "RESCHEDULE_REQUIRED" | "CANCELLED";
  optimisticToken: string;
  revisionId: string;
  revisionNumber: number;
  revisionStatus: string;
  laboratoryDate: string;
  physicalExamDate: string;
  physicalExamExceptionReason: string | null;
  cancellationReason: string | null;
  memberCount: number;
  members: Preview["members"];
  appointments: Array<{
    id: string;
    studentNumber: string;
    scheduleType: string;
    appointmentDate: string;
    status: string;
    locationName: string;
    displayStatus: string;
  }>;
  revisions: Array<{
    id: string;
    revisionNumber: number;
    status: string;
    laboratoryDate: string;
    physicalExamDate: string;
  }>;
  reservations: Array<{
    id: string;
    scheduleType: string;
    reservationDate: string;
    status: string;
  }>;
  history: Array<{
    action: string;
    actorName: string | null;
    createdAt: string;
    metadata: Record<string, unknown>;
  }>;
};

async function requestJson(url: string, body: unknown, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      payload.error?.message ?? "The request could not be completed.",
    );
  return payload.data;
}

export function OvpsaFirstYearBatchEditor({
  initial,
}: {
  initial: OvpsaFirstYearBatchDetail;
}) {
  const router = useRouter();
  const [token, setToken] = useState(initial.optimisticToken);
  const [laboratoryDate, setLaboratoryDate] = useState(initial.laboratoryDate);
  const defaultPe = new Date(`${initial.laboratoryDate}T00:00:00.000Z`);
  defaultPe.setUTCDate(defaultPe.getUTCDate() + 7);
  const [physicalExamDateOverride, setPhysicalExamDateOverride] = useState(
    initial.physicalExamDate === defaultPe.toISOString().slice(0, 10)
      ? ""
      : initial.physicalExamDate,
  );
  const [exceptionReason, setExceptionReason] = useState(
    initial.physicalExamExceptionReason ?? "",
  );
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pendingAction, setPendingAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const visibleMembers = preview?.members ?? initial.members;

  async function run(
    label: string,
    operation: () => Promise<unknown>,
    success: string,
    refresh = true,
  ) {
    setPendingAction(label);
    setError("");
    setMessage("");
    try {
      await operation();
      setMessage(success);
      if (refresh) router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The request could not be completed.",
      );
    } finally {
      setPendingAction("");
    }
  }

  const dateBody = {
    laboratoryDate,
    physicalExamDateOverride: physicalExamDateOverride || null,
    physicalExamExceptionReason: exceptionReason || null,
  };

  async function saveDraft() {
    await run(
      "save",
      async () => {
        const result = await requestJson(
          `/api/ovpsa-first-year-batches/${initial.batchId}`,
          {
            optimisticToken: token,
            ...dateBody,
          },
          "PATCH",
        );
        setToken(result.optimisticToken);
        setPreview(null);
      },
      "Draft saved.",
    );
  }

  async function validateDraft() {
    await run(
      "validate",
      async () => {
        const saved = await requestJson(
          `/api/ovpsa-first-year-batches/${initial.batchId}`,
          {
            optimisticToken: token,
            ...dateBody,
          },
          "PATCH",
        );
        const result = await requestJson(
          `/api/ovpsa-first-year-batches/${initial.batchId}/validate`,
          {
            optimisticToken: saved.optimisticToken,
          },
        );
        setToken(result.optimisticToken);
        setPreview(result);
      },
      "Authoritative preview is ready.",
      false,
    );
  }

  async function publish() {
    await run(
      "publish",
      async () => {
        const result = await requestJson(
          `/api/ovpsa-first-year-batches/${initial.batchId}/publish`,
          {
            optimisticToken: token,
          },
        );
        setToken(result.optimisticToken);
      },
      "Batch published.",
    );
  }

  async function reschedule() {
    await run(
      "reschedule",
      async () => {
        const result = await requestJson(
          `/api/ovpsa-first-year-batches/${initial.batchId}/reschedule`,
          {
            optimisticToken: token,
            ...dateBody,
            reason: lifecycleReason,
          },
        );
        setToken(result.optimisticToken);
      },
      "Replacement revision published.",
    );
  }

  async function cancel() {
    await run(
      "cancel",
      async () => {
        const result = await requestJson(
          `/api/ovpsa-first-year-batches/${initial.batchId}/cancel`,
          {
            optimisticToken: token,
            reason: lifecycleReason,
          },
        );
        setToken(result.optimisticToken);
      },
      "Batch cancelled.",
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          className="text-sm font-semibold text-cpu-navy underline-offset-4 hover:underline"
          href="/settings/first-year-ovpsa"
        >
          ← All First Year batches
        </Link>
        <span className="rounded-full bg-cpu-navy-soft px-3 py-1.5 text-xs font-bold text-cpu-navy">
          {initial.status.replaceAll("_", " ")}
        </span>
      </div>
      <div aria-live="polite" className="space-y-2">
        {message ? <Alert tone="success">{message}</Alert> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card>
            <CardTitle>Schedule</CardTitle>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-bold uppercase tracking-wide text-muted">
                  Laboratory
                </dt>
                <dd className="mt-1 font-semibold text-ink">
                  {initial.laboratoryDate}
                </dd>
                <dd className="text-sm text-muted">Iloilo Mission Hospital</dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wide text-muted">
                  Physical Examination
                </dt>
                <dd className="mt-1 font-semibold text-ink">
                  {initial.physicalExamDate}
                </dd>
                <dd className="text-sm text-muted">CPU Clinic</dd>
              </div>
            </dl>
          </Card>
          {preview && initial.status === "DRAFT" ? (
            <Card aria-labelledby="ovpsa-preview-heading">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <CardTitle>Authoritative preview</CardTitle>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${preview.canPublish ? "bg-emerald-100 text-emerald-900" : "bg-red-100 text-red-900"}`}
                >
                  {preview.canPublish ? "Ready to publish" : "Blocked"}
                </span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-canvas p-3">
                  <p className="text-xs text-muted">Eligible students</p>
                  <p className="text-xl font-bold text-ink">
                    {preview.memberCount}
                  </p>
                </div>
                <div className="rounded-xl bg-canvas p-3">
                  <p className="text-xs text-muted">PE capacity</p>
                  <p className="text-xl font-bold text-ink">
                    {preview.physicalExam.requiredCapacity}/
                    {preview.physicalExam.maximumCapacity}
                  </p>
                </div>
                <div className="rounded-xl bg-canvas p-3">
                  <p className="text-xs text-muted">Displacements</p>
                  <p className="text-xl font-bold text-ink">
                    {preview.displacements.length}
                  </p>
                </div>
              </div>
              {preview.blockers.length ? (
                <div className="mt-4">
                  <h3 className="text-sm font-bold text-red-900">
                    Publication blockers
                  </h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-800">
                    {preview.blockers.map((blocker) => (
                      <li key={`${blocker.code}:${blocker.message}`}>
                        {blocker.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.displacements.length ? (
                <div className="mt-5 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <caption className="mb-2 text-left font-bold text-ink">
                      Displacement replacements
                    </caption>
                    <thead>
                      <tr className="border-b border-line text-xs uppercase text-muted">
                        <th className="py-2 pr-4">Student</th>
                        <th className="py-2 pr-4">Category</th>
                        <th className="py-2">Replacement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.displacements.map((item, index) => (
                        <tr
                          className="border-b border-line/70"
                          key={item.studentNumber}
                        >
                          <td className="py-2 pr-4">{item.studentNumber}</td>
                          <td className="py-2 pr-4">{item.category}</td>
                          <td className="py-2">
                            {preview.proposedReplacements[index]
                              ?.laboratoryDate ?? "Lab retained"}{" "}
                            /{" "}
                            {
                              preview.proposedReplacements[index]
                                ?.physicalExamDate
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <Button
                className="mt-5"
                disabled={!preview.canPublish || pendingAction === "publish"}
                onClick={publish}
              >
                {pendingAction === "publish"
                  ? "Publishing…"
                  : "Publish complete batch"}
              </Button>
            </Card>
          ) : null}
          <Card>
            <CardTitle>Eligible students</CardTitle>
            <p className="mt-1 text-sm text-muted">
              {preview
                ? "Authoritative current membership"
                : `Immutable membership for revision ${initial.revisionNumber}`}
              : {visibleMembers.length}{" "}
              {visibleMembers.length === 1 ? "student" : "students"}.
            </p>
            <div className="mt-4 max-h-[32rem] overflow-auto rounded-xl border border-line">
              <table className="min-w-full text-left text-sm">
                <thead className="sticky top-0 bg-canvas">
                  <tr>
                    <th className="px-3 py-2">Student</th>
                    <th className="px-3 py-2">Program</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMembers.map((member) => (
                    <tr
                      className="border-t border-line"
                      key={member.studentNumber}
                    >
                      <td className="px-3 py-2">
                        <span className="font-semibold text-ink">
                          {member.studentName}
                        </span>
                        <br />
                        <span className="text-xs text-muted">
                          {member.studentNumber}
                        </span>
                      </td>
                      <td className="px-3 py-2">{member.programName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card>
            <CardTitle>Appointment state</CardTitle>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {initial.appointments
                .filter((appointment) => appointment.status !== "RESCHEDULED")
                .map((appointment) => (
                  <div
                    className="rounded-xl border border-line p-3"
                    key={appointment.id}
                  >
                    <p className="font-semibold text-ink">
                      {appointment.studentNumber} ·{" "}
                      {appointment.scheduleType === "LABORATORY"
                        ? "Laboratory"
                        : "Physical Examination"}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {appointment.appointmentDate} · {appointment.locationName}
                    </p>
                    <p className="mt-2 text-xs font-bold uppercase text-cpu-navy">
                      {appointment.displayStatus.replaceAll("_", " ")}
                    </p>
                  </div>
                ))}
            </div>
          </Card>
        </div>
        <aside className="space-y-6">
          {initial.status === "DRAFT" ? (
            <Card>
              <CardTitle>Draft controls</CardTitle>
              <div className="mt-4 space-y-4">
                <Field label="Laboratory date">
                  <Input
                    type="date"
                    value={laboratoryDate}
                    onInput={(event) => setLaboratoryDate(event.currentTarget.value)}
                    onChange={(event) => setLaboratoryDate(event.target.value)}
                  />
                </Field>
                <Field label="Later PE exception date">
                  <Input
                    type="date"
                    value={physicalExamDateOverride}
                    onInput={(event) =>
                      setPhysicalExamDateOverride(event.currentTarget.value)
                    }
                    onChange={(event) =>
                      setPhysicalExamDateOverride(event.target.value)
                    }
                  />
                </Field>
                <Field label="Exception reason">
                  <Textarea
                    value={exceptionReason}
                    onChange={(event) => setExceptionReason(event.target.value)}
                    placeholder="Required only for a later PE date"
                  />
                </Field>
                <div className="grid gap-2">
                  <Button
                    variant="secondary"
                    disabled={Boolean(pendingAction)}
                    onClick={saveDraft}
                  >
                    {pendingAction === "save" ? "Saving…" : "Save draft"}
                  </Button>
                  <Button
                    disabled={Boolean(pendingAction)}
                    onClick={validateDraft}
                  >
                    {pendingAction === "validate"
                      ? "Checking…"
                      : "Preview and validate"}
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
          {initial.status === "RESCHEDULE_REQUIRED" ? (
            <Card>
              <CardTitle>Replacement revision</CardTitle>
              <p className="mt-1 text-sm text-muted">
                Move only the affected unfinished services. Moving Laboratory
                recalculates PE.
              </p>
              <div className="mt-4 space-y-4">
                <Field label="Laboratory date">
                  <Input
                    type="date"
                    value={laboratoryDate}
                    onInput={(event) => setLaboratoryDate(event.currentTarget.value)}
                    onChange={(event) => setLaboratoryDate(event.target.value)}
                  />
                </Field>
                <Field label="PE date or exception">
                  <Input
                    type="date"
                    value={physicalExamDateOverride}
                    onInput={(event) =>
                      setPhysicalExamDateOverride(event.currentTarget.value)
                    }
                    onChange={(event) =>
                      setPhysicalExamDateOverride(event.target.value)
                    }
                  />
                </Field>
                <Field label="Exception reason">
                  <Textarea
                    value={exceptionReason}
                    onChange={(event) => setExceptionReason(event.target.value)}
                  />
                </Field>
                <Field label="Reschedule reason">
                  <Textarea
                    required
                    value={lifecycleReason}
                    onChange={(event) => setLifecycleReason(event.target.value)}
                  />
                </Field>
                <Button
                  className="w-full"
                  disabled={
                    Boolean(pendingAction) || lifecycleReason.trim().length < 3
                  }
                  onClick={reschedule}
                >
                  {pendingAction === "reschedule"
                    ? "Publishing…"
                    : "Publish replacement"}
                </Button>
              </div>
            </Card>
          ) : null}
          {["PUBLISHED", "RESCHEDULE_REQUIRED"].includes(initial.status) ? (
            <Card>
              <CardTitle>Cancel batch</CardTitle>
              <p className="mt-1 text-sm text-muted">
                Completed history is preserved. Unfinished appointments are
                cancelled and safe displaced schedules are restored.
              </p>
              <div className="mt-4 space-y-3">
                <Field label="Cancellation reason">
                  <Textarea
                    value={lifecycleReason}
                    onChange={(event) => setLifecycleReason(event.target.value)}
                  />
                </Field>
                <Button
                  className="w-full"
                  variant="danger"
                  disabled={
                    Boolean(pendingAction) || lifecycleReason.trim().length < 3
                  }
                  onClick={cancel}
                >
                  {pendingAction === "cancel"
                    ? "Cancelling…"
                    : "Cancel unfinished schedule"}
                </Button>
              </div>
            </Card>
          ) : null}
          <Card>
            <CardTitle>History</CardTitle>
            <ol className="mt-4 space-y-4">
              {initial.history.map((entry, index) => (
                <li
                  className="border-l-2 border-cpu-gold pl-3"
                  key={`${entry.createdAt}:${index}`}
                >
                  <p className="text-sm font-semibold text-ink">
                    {entry.action.replaceAll("_", " ")}
                  </p>
                  <p className="text-xs text-muted">
                    {new Date(entry.createdAt).toLocaleString()} ·{" "}
                    {entry.actorName ?? "System"}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>
    </div>
  );
}
