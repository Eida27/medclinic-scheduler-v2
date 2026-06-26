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

function fieldLabel(field: string) {
  const rowField = /^rows\.(\d+)\.(.+)$/.exec(field);
  if (rowField) return `Row ${rowField[1]} · ${rowField[2]}`;
  if (field === "file") return "File";
  if (field === "priorityGroupId") return "Priority group";
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toLocaleUpperCase());
}

export function ScheduleCsvImportForm({
  priorities,
  clinicCode,
  redirectBase = "/coordinator-schedules",
}: {
  priorities: PriorityGroup[];
  clinicCode?: "KABALAKA_CLINIC" | "CPU_CLINIC";
  redirectBase?: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [batchName, setBatchName] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ImportError>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const response = await fetch("/api/coordinator-schedules/import", {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? { message: "Unable to import the CSV file." });
      setPending(false);
      return;
    }
    router.push(`${redirectBase}/${payload.data.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit}>
      <Card className="grid gap-4">
        <div>
          <CardTitle>Import coordinator CSV</CardTitle>
          <p className="mt-1 text-sm text-muted">
            Upload the official seven-column coordinator template to create a draft schedule batch.
          </p>
        </div>
        {error ? (
          <Alert tone="danger">
            <p>{error.message}</p>
            {error.fields ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 font-normal">
                {Object.entries(error.fields).flatMap(([field, messages]) => messages.map((message) => (
                  <li key={`${field}:${message}`}><span className="font-semibold">{fieldLabel(field)}:</span> {message}</li>
                )))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
        {clinicCode ? <input type="hidden" name="clinicCode" value={clinicCode} /> : null}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5 text-sm font-semibold text-muted-strong">
            <label htmlFor="coordinator-csv-file">CSV file</label>
            <div className="flex h-11 min-w-0 items-center gap-3 rounded-xl border border-line bg-surface p-1 pr-3 shadow-sm">
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                onClick={() => fileInputRef.current?.click()}
              >
                Upload
              </Button>
              <span className="min-w-0 flex-1 truncate font-normal text-ink" aria-live="polite">
                {selectedFileName || "No file chosen"}
              </span>
            </div>
            <input
              ref={fileInputRef}
              id="coordinator-csv-file"
              className="sr-only"
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
              onChange={(event) => {
                const file = event.target.files?.[0];
                setSelectedFileName(file?.name ?? "");
                if (file && !batchName) setBatchName(file.name.replace(/\.csv$/i, ""));
              }}
            />
          </div>
          <Field label="Batch name">
            <Input name="batchName" value={batchName} onChange={(event) => setBatchName(event.target.value)} required />
          </Field>
          <Field label="Priority group">
            <Select name="priorityGroupId" required defaultValue="">
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
