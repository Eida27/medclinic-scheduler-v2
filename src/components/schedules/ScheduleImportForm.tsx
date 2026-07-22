"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";

type StudentCategory = "REGULAR" | "OJT" | "TOUR" | "SPECIALIZED";
type ImportError = { message: string; fields?: Record<string, string[]> };

const REQUIRED_HEADERS = "Student ID,Surname,First Name,MI,Suffix,College,Course,Year,Date of Birth";
const categoryLabels: Record<StudentCategory, string> = {
  REGULAR: "Regular",
  OJT: "OJT",
  TOUR: "Tour",
  SPECIALIZED: "Specialized",
};

function currentManilaYear() {
  return Number(new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(new Date()));
}

function fieldLabel(field: string) {
  const rowField = /^rows\.(\d+)\.(.+)$/.exec(field);
  if (rowField) return `Row ${rowField[1]} · ${rowField[2]}`;
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

export function ScheduleImportForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentYear = currentManilaYear();
  const academicYears = Array.from({ length: 7 }, (_, index) => currentYear - 1 + index);
  const [studentCategory, setStudentCategory] = useState<StudentCategory>("REGULAR");
  const [academicYearStart, setAcademicYearStart] = useState(String(currentYear));
  const [selectedFileName, setSelectedFileName] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ImportError>();

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(undefined);
    setConfirmOpen(true);
  }

  async function submit() {
    if (!formRef.current || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/schedule-imports", {
        method: "POST",
        body: new FormData(formRef.current),
      });
      const payload = await response.json();
      if (!response.ok) {
        setConfirmOpen(false);
        setError(payload.error ?? { message: "Unable to import the CSV file." });
        setPending(false);
        return;
      }
      router.push(`/students/schedule-imports/${payload.data.importId}`);
      router.refresh();
    } catch {
      setConfirmOpen(false);
      setError({ message: "Unable to import the CSV file." });
      setPending(false);
    }
  }

  return (
    <>
      <form ref={formRef} onSubmit={review}>
        <Card className="grid gap-5">
          <div>
            <CardTitle>Academic-year student CSV</CardTitle>
            <p className="mt-1 text-sm text-muted">
              Upload student demographics and publish paired Laboratory and Physical Examination dates automatically.
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
              <li>Upload the approved workbook as CSV UTF-8 or Excel CSV (Comma delimited) / Windows-1252.</li>
              <li>Date of Birth must use MM-DD-YYYY.</li>
              <li>The file may be up to 1 MB and contain up to 3,000 data rows.</li>
              <li>Every new schedule receives seven calendar days of preparation notice.</li>
            </ul>
            <a href="/templates/student-schedule-import-template.csv" download className="w-fit font-bold text-cpu-navy hover:underline">
              Download CSV template
            </a>
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

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-1.5 text-sm font-semibold text-muted-strong">
              <label htmlFor="student-schedule-import-file">CSV file</label>
              <div className="flex h-11 min-w-0 items-center gap-3 rounded-xl border border-line bg-surface p-1 pr-3 shadow-sm">
                <Button type="button" size="sm" disabled={pending} onClick={() => fileInputRef.current?.click()}>
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
            <Field label="Student category">
              <Select
                name="studentCategory"
                value={studentCategory}
                disabled={pending}
                onChange={(event) => setStudentCategory(event.target.value as StudentCategory)}
              >
                {Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
            <Field label="Academic year">
              <Select
                name="academicYearStart"
                value={academicYearStart}
                required
                disabled={pending}
                onChange={(event) => setAcademicYearStart(event.target.value)}
              >
                {academicYears.map((year) => <option key={year} value={year}>{year}–{year + 1}</option>)}
              </Select>
            </Field>
            {studentCategory === "REGULAR" ? null : (
              <Field label="Preferred month">
                <Select name="preferredMonth" required defaultValue="" disabled={pending} key={studentCategory}>
                  <option value="" disabled>Select preferred month</option>
                  {Array.from({ length: 12 }, (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      {new Intl.DateTimeFormat("en-PH", { month: "long" }).format(new Date(2026, index, 1))}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          <Button type="submit" disabled={pending} className="justify-self-start">Review import</Button>
        </Card>
      </form>
      <ConfirmDialog
        open={confirmOpen}
        title="Import and publish this CSV?"
        description={`${selectedFileName} will be scheduled as ${categoryLabels[studentCategory]} for ${academicYearStart}–${Number(academicYearStart) + 1}. Both date-only clinic schedules will publish atomically.`}
        confirmLabel="Agree and import"
        pending={pending}
        pendingLabel="Importing and publishing…"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={submit}
      />
    </>
  );
}
