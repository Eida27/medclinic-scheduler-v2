"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

type BatchListItem = {
  batchId: string;
  scheduleCycleStart: number;
  collegeName: string;
  status: string;
  revisionNumber: number;
  laboratoryDate: string;
  physicalExamDate: string;
  memberCount: number;
};

async function readResponse(response: Response) {
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error?.message ??
        body.message ??
        "The request could not be completed.",
    );
  return body.data ?? body;
}

export function OvpsaFirstYearManager(props: {
  batches: BatchListItem[];
  colleges: Array<{ id: string; code: string; name: string }>;
  academicYears: Array<{ startYear: number; label: string }>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [collegeId, setCollegeId] = useState(props.colleges[0]?.id ?? "");
  const [cycle, setCycle] = useState(
    String(props.academicYears[0]?.startYear ?? ""),
  );
  const [laboratoryDate, setLaboratoryDate] = useState("");

  async function createBatch(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const created = await readResponse(
        await fetch("/api/ovpsa-first-year-batches", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scheduleCycleStart: Number(cycle),
            collegeId,
            laboratoryDate,
            physicalExamDateOverride: null,
            physicalExamExceptionReason: null,
          }),
        }),
      );
      router.push(`/settings/first-year-ovpsa/${created.batchId}`);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The batch could not be created.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="ovpsa-batches-heading" className="space-y-4">
        <h2 id="ovpsa-batches-heading" className="text-lg font-bold text-ink">
          Batches
        </h2>
        {props.batches.length ? (
          props.batches.map((batch) => (
            <Card
              key={batch.batchId}
              className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{batch.collegeName}</CardTitle>
                  <span className="rounded-full bg-cpu-navy-soft px-2.5 py-1 text-xs font-bold text-cpu-navy">
                    {batch.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted">
                  AY {batch.scheduleCycleStart}–{batch.scheduleCycleStart + 1} ·
                  Revision {batch.revisionNumber} · {batch.memberCount} students
                </p>
                <p className="mt-1 text-sm text-ink">
                  Mission Hospital {batch.laboratoryDate} · CPU Clinic{" "}
                  {batch.physicalExamDate}
                </p>
              </div>
              <Link
                className="rounded-xl border border-line px-4 py-2 text-center text-sm font-semibold text-cpu-navy hover:bg-cpu-navy-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                href={`/settings/first-year-ovpsa/${batch.batchId}`}
              >
                Open batch
              </Link>
            </Card>
          ))
        ) : (
          <Card>
            <p className="text-sm text-muted">
              No First Year OVPSA batches have been created.
            </p>
          </Card>
        )}
      </section>
      <Card className="h-fit xl:sticky xl:top-6">
        <CardTitle>Create batch</CardTitle>
        <p className="mt-1 text-sm text-muted">
          Membership is the complete active Year 1 population of the selected
          college.
        </p>
        <form className="mt-5 space-y-4" onSubmit={createBatch}>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Field label="Academic year">
            <Select
              id="ovpsa-cycle"
              value={cycle}
              onChange={(event) => setCycle(event.target.value)}
              required
            >
              {props.academicYears.map((year) => (
                <option key={year.startYear} value={year.startYear}>
                  {year.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="College">
            <Select
              id="ovpsa-college"
              value={collegeId}
              onChange={(event) => setCollegeId(event.target.value)}
              required
            >
              {props.colleges.map((college) => (
                <option key={college.id} value={college.id}>
                  {college.code} — {college.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Laboratory date">
            <Input
              id="ovpsa-lab-date"
              aria-describedby="ovpsa-lab-hint"
            type="date"
            value={laboratoryDate}
            onInput={(event) => setLaboratoryDate(event.currentTarget.value)}
            onChange={(event) => setLaboratoryDate(event.target.value)}
              required
            />
            <span
              id="ovpsa-lab-hint"
              className="text-xs font-normal text-muted"
            >
              Weekends are allowed. Location is fixed at Iloilo Mission
              Hospital.
            </span>
          </Field>
          <Button
            className="w-full"
            type="submit"
            disabled={pending || !collegeId || !cycle}
          >
            {pending ? "Creating…" : "Create draft"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
