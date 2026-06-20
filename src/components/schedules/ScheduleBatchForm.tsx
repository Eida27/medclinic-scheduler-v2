"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import type { College, PriorityGroup, Program } from "@/server/repositories/reference-data.repository";

type Item = {
  clientId: string;
  studentNumber: string;
  scheduleType: "PHYSICAL_EXAM" | "LABORATORY" | "BOTH";
  priorityGroupId: string;
  mode: "date" | "week";
  targetDate: string;
  targetWeekStart: string;
  targetWeekEnd: string;
  remarks: string;
};

type BatchError = {
  code?: string;
  message: string;
  fields?: Record<string, string[]>;
};

const emptyItem = (): Item => ({
  clientId: crypto.randomUUID(),
  studentNumber: "",
  scheduleType: "BOTH",
  priorityGroupId: "",
  mode: "date",
  targetDate: "",
  targetWeekStart: "",
  targetWeekEnd: "",
  remarks: "",
});

export function ScheduleBatchForm({
  colleges,
  programs,
  priorities,
}: {
  colleges: College[];
  programs: Program[];
  priorities: PriorityGroup[];
}) {
  const router = useRouter();
  const [collegeId, setCollegeId] = useState("");
  const [items, setItems] = useState<Item[]>([emptyItem()]);
  const [error, setError] = useState<BatchError>();
  const [pending, setPending] = useState(false);
  const filteredPrograms = useMemo(
    () => programs.filter((program) => !collegeId || program.collegeId === collegeId),
    [collegeId, programs],
  );

  function update(index: number, patch: Partial<Item>) {
    setItems((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...patch } : item
    )));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const body = {
      batchName: form.get("batchName"),
      collegeId: form.get("collegeId"),
      programId: form.get("programId"),
      submittedByName: form.get("submittedByName"),
      description: form.get("description"),
      items: items.map((item) => ({
        studentNumber: item.studentNumber,
        scheduleType: item.scheduleType,
        priorityGroupId: item.priorityGroupId,
        targetDate: item.mode === "date" ? item.targetDate : null,
        targetWeekStart: item.mode === "week" ? item.targetWeekStart : null,
        targetWeekEnd: item.mode === "week" ? item.targetWeekEnd : null,
        remarks: item.remarks,
      })),
    };
    const response = await fetch("/api/coordinator-schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? { message: "Unable to create batch." });
      setPending(false);
      return;
    }
    router.push(`/coordinator-schedules/${payload.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} aria-labelledby="manual-schedule-heading">
      <Card className="grid gap-6">
        <div>
          <div id="manual-schedule-heading"><CardTitle>Create schedule manually</CardTitle></div>
          <p className="mt-1 text-sm text-muted">
            Enter batch information and individual student requests to create a draft schedule batch.
          </p>
        </div>

        {error ? (
          <Alert tone="danger">
            <p>{error.message}</p>
            {error.code === "SCHEDULE_STUDENTS_NOT_FOUND" ? (
              <p className="mt-2 font-normal">
                <Link
                  href="/students/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline underline-offset-2"
                >
                  Add student
                </Link>{" "}
                in a new tab, then return to this form.
              </p>
            ) : null}
          </Alert>
        ) : null}

        <section className="grid gap-4" aria-labelledby="batch-details-heading">
          <h3 id="batch-details-heading" className="font-bold text-ink">Batch details</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Batch name"><Input name="batchName" required /></Field>
            <Field label="Submitted by"><Input name="submittedByName" /></Field>
            <Field label="College">
              <Select name="collegeId" value={collegeId} onChange={(event) => setCollegeId(event.target.value)}>
                <option value="">Mixed / unspecified</option>
                {colleges.filter((college) => college.isActive).map((college) => (
                  <option key={college.id} value={college.id}>{college.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Program">
              <Select name="programId">
                <option value="">Mixed / unspecified</option>
                {filteredPrograms.filter((program) => program.isActive).map((program) => (
                  <option key={program.id} value={program.id}>{program.name}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Description"><Textarea name="description" /></Field>
        </section>

        <section className="grid gap-4 border-t border-line pt-6" aria-labelledby="schedule-items-heading">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 id="schedule-items-heading" className="font-bold text-ink">Schedule items</h3>
              <p className="text-sm text-muted">Add each coordinator-provided student request.</p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setItems((current) => [...current, emptyItem()])}
            >
              Add row
            </Button>
          </div>

          <div className="grid gap-4">
          {items.map((item, index) => {
            const studentError = error?.fields?.[`items.${index}.studentNumber`]?.[0];
            const studentErrorId = `schedule-item-${item.clientId}-student-error`;
            return (
              <div
                key={item.clientId}
                className="grid gap-3 rounded-2xl border border-line bg-cpu-navy-soft/45 p-4 xl:grid-cols-6"
              >
                <div className="grid gap-1.5">
                  <Input
                    aria-label={`Student number ${index + 1}`}
                    aria-invalid={studentError ? true : undefined}
                    aria-describedby={studentError ? studentErrorId : undefined}
                    placeholder="Student number"
                    value={item.studentNumber}
                    onChange={(event) => update(index, { studentNumber: event.target.value })}
                    required
                    className={studentError ? "border-red-400 focus:border-red-600 focus:ring-red-600/10" : undefined}
                  />
                  {studentError ? (
                    <p id={studentErrorId} className="text-xs font-medium text-red-700">{studentError}</p>
                  ) : null}
                </div>
                <Select
                  aria-label={`Service ${index + 1}`}
                  value={item.scheduleType}
                  onChange={(event) => update(index, { scheduleType: event.target.value as Item["scheduleType"] })}
                >
                  <option value="BOTH">Both services</option>
                  <option value="PHYSICAL_EXAM">Physical exam</option>
                  <option value="LABORATORY">Laboratory</option>
                </Select>
                <Select
                  aria-label={`Priority ${index + 1}`}
                  value={item.priorityGroupId}
                  onChange={(event) => update(index, { priorityGroupId: event.target.value })}
                  required
                >
                  <option value="">Priority</option>
                  {priorities.filter((priority) => priority.isActive).map((priority) => (
                    <option key={priority.id} value={priority.id}>{priority.name}</option>
                  ))}
                </Select>
                <Select
                  aria-label={`Date mode ${index + 1}`}
                  value={item.mode}
                  onChange={(event) => update(index, { mode: event.target.value as Item["mode"] })}
                >
                  <option value="date">Exact date</option>
                  <option value="week">Target week</option>
                </Select>
                {item.mode === "date" ? (
                  <Input
                    aria-label={`Target date ${index + 1}`}
                    type="date"
                    value={item.targetDate}
                    onChange={(event) => update(index, { targetDate: event.target.value })}
                    required
                    className="xl:col-span-2"
                  />
                ) : (
                  <>
                    <Input
                      aria-label={`Week start ${index + 1}`}
                      type="date"
                      value={item.targetWeekStart}
                      onChange={(event) => update(index, { targetWeekStart: event.target.value })}
                      required
                    />
                    <Input
                      aria-label={`Week end ${index + 1}`}
                      type="date"
                      value={item.targetWeekEnd}
                      onChange={(event) => update(index, { targetWeekEnd: event.target.value })}
                      required
                    />
                  </>
                )}
                <Input
                  aria-label={`Remarks ${index + 1}`}
                  placeholder="Remarks"
                  value={item.remarks}
                  onChange={(event) => update(index, { remarks: event.target.value })}
                  className="xl:col-span-5"
                />
                {items.length > 1 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            );
          })}
          </div>
        </section>

        <div className="border-t border-line pt-6">
          <Button type="submit" disabled={pending}>
            {pending ? "Creating batch..." : "Create schedule batch"}
          </Button>
        </div>
      </Card>
    </form>
  );
}
