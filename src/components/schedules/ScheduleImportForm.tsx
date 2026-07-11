"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import type { PriorityGroup } from "@/server/repositories/reference-data.repository";

type ImportError = {
  message: string;
  fields?: Record<string, string[]>;
};

const REQUIRED_HEADERS = "Student ID,Name,College,Course,Year,Laboratory Schedule,Physical Examination Schedule";

function fieldLabel(field: string) {
  const rowField = /^rows\.(\d+)\.(.+)$/.exec(field);
  if (rowField) return `Row ${rowField[1]} · ${rowField[2]}`;
  if (field === "file") return "File";
  if (field === "importName") return "Import name";
  if (field === "priorityGroupId") return "Priority group";
  if (field === "submittedByName") return "Submitted by";
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toLocaleUpperCase());
}

export function ScheduleImportForm({ priorities }: { priorities: PriorityGroup[] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importName, setImportName] = useState("");
  const [priorityGroupId, setPriorityGroupId] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ImportError>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(undefined);

    try {
      const response = await fetch("/api/schedule-imports", {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? { message: "Unable to import the CSV file." });
        return;
      }

      router.push(`/students/schedule-imports/${payload.data.importId}`);
      router.refresh();
    } catch {
      setError({ message: "Unable to import the CSV file." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Card className="grid gap-5">
        <div>
          <CardTitle>Master student and schedule CSV</CardTitle>
          <p className="mt-1 text-sm text-muted">
            Upload one file to create the grouped Laboratory and Physical Examination schedule import.
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
            <li>The file may be up to 1 MB and contain up to 500 data rows.</li>
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

        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5 text-sm font-semibold text-muted-strong">
            <label htmlFor="student-schedule-import-file">CSV file</label>
            <div className="flex h-11 min-w-0 items-center gap-3 rounded-xl border border-line bg-surface p-1 pr-3 shadow-sm">
              <Button
                type="button"
                size="sm"
                className="shrink-0"
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
              onChange={(event) => {
                const file = event.target.files?.[0];
                setSelectedFileName(file?.name ?? "");
                if (file && importName.trim() === "") {
                  setImportName(file.name.replace(/\.csv$/i, ""));
                }
              }}
            />
          </div>

          <Field label="Import name">
            <Input
              name="importName"
              value={importName}
              onChange={(event) => setImportName(event.target.value)}
              required
            />
          </Field>

          <Field label="Priority group">
            <Select
              name="priorityGroupId"
              required
              value={priorityGroupId}
              onChange={(event) => setPriorityGroupId(event.target.value)}
            >
              <option value="" disabled>Select priority</option>
              {priorities.filter((priority) => priority.isActive).map((priority) => (
                <option key={priority.id} value={priority.id}>{priority.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="Submitted by">
            <Input name="submittedByName" />
          </Field>
        </div>

        <Field label="Description">
          <Textarea name="description" />
        </Field>

        <Button type="submit" disabled={pending} className="justify-self-start">
          {pending ? "Importing..." : "Import CSV"}
        </Button>
      </Card>
    </form>
  );
}
