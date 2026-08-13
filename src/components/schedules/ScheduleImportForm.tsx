"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

type StudentCategory = "REGULAR" | "OJT" | "TOUR" | "SPECIALIZED";
type VisibleCategory = StudentCategory | "FIRST_YEAR";
type ImportError = { message: string; fields?: Record<string, string[]> };
type FirstYearReview = {
  memberCount: number;
  laboratory: { date: string; locationName: string };
  firstPhysicalExamCandidate: string;
  physicalExamMaximumCapacity: number;
  allocations: Array<{ date: string; studentCount: number; capacity: number }>;
  skippedDates: Array<{ date: string; reasons: string[] }>;
  displacementTotal: number;
  blockers: Array<{ code: string; message: string }>;
  canPublish: boolean;
};

const REQUIRED_HEADERS = "Student ID,Surname,First Name,Middle Name,Suffix,College,Course,Year,Date of Birth";
const categoryLabels: Record<VisibleCategory, string> = {
  REGULAR: "Regular",
  FIRST_YEAR: "First Year",
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
  const [visibleCategory, setVisibleCategory] = useState<VisibleCategory>("REGULAR");
  const [academicYearStart, setAcademicYearStart] = useState(String(currentYear));
  const [selectedFileName, setSelectedFileName] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ImportError>();
  const [firstYearReview, setFirstYearReview] = useState<FirstYearReview>();

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(undefined);
    if (visibleCategory !== "FIRST_YEAR") {
      setConfirmOpen(true);
      return;
    }
    if (!formRef.current) return;
    setPending(true);
    setFirstYearReview(undefined);
    try {
      const response = await fetch("/api/schedule-imports/review", {
        method: "POST",
        body: new FormData(formRef.current),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? { message: "Unable to review the First Year import." });
        return;
      }
      const plan = payload.data as FirstYearReview;
      if (!plan.canPublish) {
        setError({
          message: plan.blockers.map((blocker) => blocker.message).join(" ")
            || "The complete First Year import cannot be scheduled.",
        });
        return;
      }
      setFirstYearReview(plan);
      setConfirmOpen(true);
    } catch {
      setError({ message: "Unable to review the First Year import." });
    } finally {
      setPending(false);
    }
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

  const firstYearDescription = firstYearReview
    ? `${selectedFileName}: ${firstYearReview.memberCount} Year-1 students for AY ${academicYearStart}–${Number(academicYearStart) + 1} will receive Laboratory on ${firstYearReview.laboratory.date} at ${firstYearReview.laboratory.locationName}. The first Physical Examination candidate is ${firstYearReview.firstPhysicalExamCandidate}; active CPU Clinic capacity is ${firstYearReview.physicalExamMaximumCapacity} per day across ${firstYearReview.allocations.length} selected dates: ${firstYearReview.allocations.map((allocation) => `${allocation.date}: ${allocation.studentCount} of ${allocation.capacity}`).join("; ")}. ${firstYearReview.skippedDates.length ? `Skipped dates: ${firstYearReview.skippedDates.map((date) => date.date).join(", ")}. ` : ""}Selected service dates become First Year-exclusive. ${firstYearReview.displacementTotal} lower-priority appointments will be displaced and replaced atomically.`
    : "";

  return (
    <>
      <form ref={formRef} onSubmit={review}>
        <input
          type="hidden"
          name="importMode"
          value={visibleCategory === "FIRST_YEAR" ? "FIRST_YEAR_OVPSA" : "STANDARD"}
        />
        <input
          type="hidden"
          name="studentCategory"
          value={visibleCategory === "FIRST_YEAR" ? "REGULAR" : visibleCategory}
        />
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
              <li>Download the Excel template, replace the sample row, and copy that formatted row for additional students.</li>
              <li>Before upload, use Save As to create CSV UTF-8 or Excel CSV (Comma delimited) / Windows-1252.</li>
              <li>Date of Birth must use YYYY-MM-DD.</li>
              <li>The file may be up to 1 MB and contain up to 3,000 data rows.</li>
              <li>Every new schedule receives seven calendar days of preparation notice.</li>
            </ul>
            <a href="/templates/student-schedule-import-template.xlsx" download className="w-fit font-bold text-cpu-navy hover:underline">
              Download Excel template
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
                value={visibleCategory}
                disabled={pending}
                onChange={(event) => {
                  setVisibleCategory(event.target.value as VisibleCategory);
                  setFirstYearReview(undefined);
                }}
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
            {visibleCategory === "FIRST_YEAR" ? (
              <Field label="Laboratory date">
                <div className="grid gap-1.5">
                  <Input
                    aria-label="Laboratory date"
                    name="firstYearLaboratoryDate"
                    type="date"
                    required
                    disabled={pending}
                  />
                  <span className="text-xs font-medium text-muted">Iloilo Mission Hospital</span>
                </div>
              </Field>
            ) : visibleCategory === "REGULAR" ? null : (
              <Field label="Preferred month">
                <Select name="preferredMonth" required defaultValue="" disabled={pending} key={visibleCategory}>
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
        title={visibleCategory === "FIRST_YEAR" ? "Confirm First Year schedule?" : "Import and publish this CSV?"}
        description={visibleCategory === "FIRST_YEAR"
          ? firstYearDescription
          : `${selectedFileName} will be scheduled as ${categoryLabels[visibleCategory]} for ${academicYearStart}–${Number(academicYearStart) + 1}. Both date-only clinic schedules will publish atomically.`}
        confirmLabel={visibleCategory === "FIRST_YEAR" ? "Agree and schedule" : "Agree and import"}
        pending={pending}
        pendingLabel="Importing and publishing…"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={submit}
      />
    </>
  );
}
