"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import type { PriorityGroup } from "@/server/repositories/reference-data.repository";

type ImportError = {
  message: string;
  fields?: Record<string, string[]>;
};

type ReviewCheckpoint = {
  importId: string;
  status: string;
  stage: string;
  issue: ImportError & { code: string };
};

const REQUIRED_HEADERS = "Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule";

function fieldLabel(field: string) {
  const rowField = /^rows\.(\d+)\.(.+)$/.exec(field);
  if (rowField) return `Row ${rowField[1]} · ${rowField[2]}`;
  if (field === "file") return "File";
  if (field === "priorityGroupId") return "Priority group";
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toLocaleUpperCase());
}

export function ScheduleImportForm({ priorities }: { priorities: PriorityGroup[] }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [priorityGroupId, setPriorityGroupId] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ImportError>();
  const [checkpoint, setCheckpoint] = useState<ReviewCheckpoint>();

  const selectedPriority = priorities.find((priority) => priority.id === priorityGroupId);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(undefined);
    setCheckpoint(undefined);
    setConfirmOpen(true);
  }

  async function submit() {
    if (pending || !formRef.current) return;

    setPending(true);
    setError(undefined);
    setCheckpoint(undefined);

    try {
      const response = await fetch("/api/schedule-imports", {
        method: "POST",
        body: new FormData(formRef.current),
      });
      const payload = await response.json();

      if (!response.ok) {
        setConfirmOpen(false);
        setError(payload.error ?? { message: "Unable to import the CSV file." });
        return;
      }

      if (payload.data.outcome === "REVIEW_REQUIRED") {
        setConfirmOpen(false);
        setCheckpoint(payload.data as ReviewCheckpoint);
        return;
      }

      router.push(`/students/schedule-imports/${payload.data.importId}`);
      router.refresh();
    } catch {
      setConfirmOpen(false);
      setError({ message: "Unable to import the CSV file." });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <form ref={formRef} onSubmit={review}>
        <Card className="grid gap-5">
          <div>
            <CardTitle>Master student and schedule CSV</CardTitle>
            <p className="mt-1 text-sm text-muted">
              Choose the file and priority, then approve one confirmation to import and publish the complete schedule.
            </p>
          </div>

          <div className="grid gap-3 rounded-xl border border-cpu-navy/10 bg-cpu-navy-soft/55 p-4 text-sm text-muted-strong">
            <div>
              <p className="font-semibold text-ink">Required headers in this exact order</p>
              <code className="mt-1 block overflow-x-auto whitespace-nowrap font-mono text-xs text-cpu-navy">
                {REQUIRED_HEADERS}
              </code>
            </div>
            <ul className="list-disc space-y-1 pl-5">
              <li>Save and upload the file as a UTF-8 CSV.</li>
              <li>Enter schedule dates in MM-DD-YYYY format.</li>
              <li>The file may be up to 1 MB and contain up to 3,000 data rows.</li>
              <li>Each row must include at least one service date.</li>
            </ul>
            <a
              href="/templates/student-schedule-import-template.csv"
              download
              className="w-fit font-bold text-cpu-navy hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cpu-navy"
            >
              Download CSV template
            </a>
          </div>

          {error ? (
            <Alert tone="danger">
              <p>{error.message}</p>
              {error.fields ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 font-normal">
                  {Object.entries(error.fields).flatMap(([field, messages]) => messages.map((message) => (
                    <li key={`${field}:${message}`}>
                      <span className="font-semibold">{fieldLabel(field)}:</span> {message}
                    </li>
                  )))}
                </ul>
              ) : null}
            </Alert>
          ) : null}

          {checkpoint ? (
            <Alert tone="warning">
              <p>{checkpoint.issue.message}</p>
              <p className="mt-1 font-normal">
                The import was saved at {checkpoint.status.toLocaleLowerCase()} for administrator review.
              </p>
              <Link
                href={`/students/schedule-imports/${checkpoint.importId}`}
                className="mt-2 inline-block underline"
              >
                Review saved import
              </Link>
            </Alert>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-1.5 text-sm font-semibold text-muted-strong">
              <label htmlFor="student-schedule-import-file">CSV file</label>
              <div className="flex h-11 min-w-0 items-center gap-3 rounded-xl border border-line bg-surface p-1 pr-3 shadow-sm">
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  disabled={pending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose file
                </Button>
                <span className="min-w-0 flex-1 truncate font-normal text-ink" aria-live="polite">
                  {selectedFileName || "No file chosen"}
                </span>
              </div>
              <input
                ref={fileInputRef}
                id="student-schedule-import-file"
                className="sr-only"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
                disabled={pending}
                onChange={(event) => setSelectedFileName(event.target.files?.[0]?.name ?? "")}
              />
            </div>

            <Field label="Priority group">
              <Select
                name="priorityGroupId"
                required
                value={priorityGroupId}
                disabled={pending}
                onChange={(event) => setPriorityGroupId(event.target.value)}
              >
                <option value="" disabled>Select priority</option>
                {priorities.filter((priority) => priority.isActive).map((priority) => (
                  <option key={priority.id} value={priority.id}>{priority.name}</option>
                ))}
              </Select>
            </Field>
          </div>

          <Button type="submit" disabled={pending} className="justify-self-start">
            Review import
          </Button>
        </Card>
      </form>

      <ConfirmDialog
        open={confirmOpen}
        title="Import and publish this CSV?"
        description={`${selectedFileName} will be imported as ${selectedPriority?.name ?? "the selected"} priority. This will create or match students, then publish their Laboratory and Physical Examination schedules when processing succeeds.`}
        confirmLabel="Agree and import"
        pending={pending}
        pendingLabel="Importing and publishing…"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={submit}
      />
    </>
  );
}
