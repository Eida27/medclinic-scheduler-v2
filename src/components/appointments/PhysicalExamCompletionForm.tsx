"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { CertificateDownload } from "@/components/medical-certificates/CertificateDownload";
import { ageOn } from "@/lib/medical-certificate-age";

type Physician = { id: string; version: number; displayName: string; licenseNumber: string; specialty: string | null };
export type PhysicalExamIssue = { certificateId: string; certificateNumber: string };
type Issue = PhysicalExamIssue;
type StudentAcademicSnapshot = {
  studentName: string;
  collegeName: string;
  programName: string;
  yearLevel: number | null;
};
export type PhysicalExamCompletionContext = {
  appointmentId: string; studentName: string; studentNumber: string; appointmentDate: string;
  scheduleCycleStart: number; dateOfBirth: string | null; studentAcademicSnapshot: StudentAcademicSnapshot | null;
  physicians: Physician[]; today?: string; status?: string; automaticNoShowEligible?: boolean;
  laboratoryReady?: boolean; blockers?: string[]; canConfigurePhysicians?: boolean;
};

export function PhysicalExamCompletionForm({ appointmentId, studentName, studentNumber,
  appointmentDate, scheduleCycleStart, dateOfBirth, studentAcademicSnapshot, physicians,
  today, status, blockers = [], canConfigurePhysicians = false, onBusyChange, onCompleted }: PhysicalExamCompletionContext & {
    onBusyChange?: (busy: boolean) => void;
    onCompleted?: (issue: Issue, classification: string) => void;
  }) {
  const router = useRouter();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const busyRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertainPayload, setUncertainPayload] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewKey, setPreviewKey] = useState<string>();
  const [issued, setIssued] = useState<Issue>();
  const [sex, setSex] = useState("");
  const [examinationDate, setExaminationDate] = useState(appointmentDate);
  const [classification, setClassification] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lateReason, setLateReason] = useState("");
  const [physicianId, setPhysicianId] = useState("");
  const [attested, setAttested] = useState(false);
  const age = dateOfBirth && examinationDate ? ageOn(dateOfBirth, examinationDate) : null;
  const validAge = age !== null && Number.isFinite(age) && age >= 0 && age <= 125;
  const identityReady = Boolean(studentAcademicSnapshot && dateOfBirth && validAge);
  const selected = physicians.find((physician) => physician.id === physicianId);
  const lateReasonRequired = Boolean((today && examinationDate < today) || status === "NO_SHOW");
  const payload = { requestId, physicianId, physicianVersion: selected?.version,
    examinationDate, sex: sex.trim(), classification, remarks, lateReason, attested };
  const key = JSON.stringify(payload);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function submit(action: "preview" | "issue", retryPayload?: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/appointments/${appointmentId}/${action === "preview"
        ? "physical-exam-certificate-preview" : "complete-physical-exam"}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: retryPayload ?? key,
      });
      if (!response.ok) {
        const failure = await readApiPayload(response);
        if (action === "issue") { setUncertainPayload(undefined); setRequestId(crypto.randomUUID()); }
        throw new Error(apiErrorMessage(failure, "Unable to process the certificate. Review the details and try again."));
      }
      if (action === "preview") {
        setPreviewUrl(URL.createObjectURL(await response.blob()));
        setPreviewKey(key);
      } else {
        const result = await readApiPayload<Issue>(response);
        if (!result?.data?.certificateId) throw new Error("The certificate response was incomplete. Reload and check its status.");
        setIssued(result.data);
        setUncertainPayload(undefined);
        onCompleted?.(result.data, classification);
        router.refresh();
      }
    } catch (caught) {
      if (action === "issue" && (caught instanceof TypeError || (caught instanceof Error && caught.message.includes("incomplete")))) {
        setUncertainPayload(retryPayload ?? key);
      }
      setError(caught instanceof Error ? caught.message : "Unable to process the certificate.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  if (issued) return <Alert tone="success">
    <p className="mb-3" role="status">Physical Examination completed — Class {classification}. Certificate {issued.certificateNumber} is available.</p>
    <CertificateDownload certificateId={issued.certificateId} audience="staff" />
  </Alert>;

  return <section aria-labelledby="physical-exam-completion-heading" className="grid gap-5">
    <div>
      <h2 id="physical-exam-completion-heading" className="text-lg font-bold">Complete examination and issue certificate</h2>
      <p className="text-sm text-muted">{studentName} · {studentNumber}. Record the physician&apos;s finding exactly as documented.</p>
    </div>
    <div className="rounded-lg border border-line bg-slate-50 p-4" aria-label="Certificate student record">
      <h3 className="font-semibold">Student record for this certificate</h3>
      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-muted">Academic year</dt><dd className="font-medium">{scheduleCycleStart}–{scheduleCycleStart + 1}</dd></div>
        <div><dt className="text-muted">Student number</dt><dd className="font-medium">{studentNumber}</dd></div>
        <div><dt className="text-muted">Name from academic snapshot</dt><dd className="font-medium">{studentAcademicSnapshot?.studentName ?? "Not recorded"}</dd></div>
        <div><dt className="text-muted">College, program, year</dt><dd className="font-medium">{studentAcademicSnapshot
          ? `${studentAcademicSnapshot.collegeName} · ${studentAcademicSnapshot.programName} · Year ${studentAcademicSnapshot.yearLevel ?? "not recorded"}`
          : "Not recorded"}</dd></div>
        <div><dt className="text-muted">Date of birth</dt><dd className="font-medium">{dateOfBirth ?? "Not recorded"}</dd></div>
        <div><dt className="text-muted">Age on examination date</dt><dd className="font-medium">{validAge ? `${age} years` : "Not available"}</dd></div>
      </dl>
    </div>
    {!studentAcademicSnapshot ? <Alert tone="danger">The academic snapshot is missing. Resolve the student record before issuing a certificate.</Alert> : null}
    {!dateOfBirth ? <Alert tone="danger">The date of birth is missing. Resolve the student record before issuing a certificate.</Alert> : null}
    {(!studentAcademicSnapshot || !dateOfBirth) ? <Link className="font-semibold text-cpu-navy underline"
      href={`/students/${encodeURIComponent(studentNumber)}`}>Open student record</Link> : null}
    {dateOfBirth && !validAge ? <Alert tone="danger">The date of birth is invalid for this examination date.</Alert> : null}
    {blockers.length ? <Alert tone="danger"><ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></Alert> : null}
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {!physicians.length ? <Alert tone="warning">An Administrator must configure an active physician and signature first.
      {canConfigurePhysicians ? <Link className="ml-2 font-semibold underline" href="/settings/medical-certificate-physicians">Physician settings</Link> : null}
    </Alert> : null}
    {uncertainPayload ? <Alert tone="warning"><p>The completion outcome is uncertain. Retry the same request or reload this record before changing details.</p>
      <Button type="button" disabled={busy} onClick={() => void submit("issue", uncertainPayload)}>Retry same request</Button>{" "}
      <Button type="button" disabled={busy} onClick={() => router.refresh()}>Reload record</Button></Alert> : null}
    <form ref={formRef} className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit("issue"); }}
      onChange={() => setPreviewKey(undefined)}>
      <fieldset disabled={busy || Boolean(uncertainPayload)} className="grid gap-4">
      <label className="grid gap-1 font-semibold">Actual examination date
        <input type="date" required value={examinationDate} onChange={(event) => setExaminationDate(event.target.value)} className="rounded-lg border border-line p-2" />
      </label>
      <label className="grid gap-1 font-semibold">Sex recorded for this examination
        <input required maxLength={30} value={sex} onChange={(event) => setSex(event.target.value)} className="rounded-lg border border-line p-2" />
      </label>
      <label className="grid gap-1 font-semibold">Physician
        <select required value={physicianId} onChange={(event) => setPhysicianId(event.target.value)} className="rounded-lg border border-line p-2">
          <option value="">Select physician</option>
          {physicians.map((physician) => <option key={physician.id} value={physician.id}>
            {physician.displayName} · {physician.licenseNumber}{physician.specialty ? ` · ${physician.specialty}` : ""}
          </option>)}
        </select>
      </label>
      <fieldset className="grid gap-2 rounded-lg border border-line p-4">
        <legend className="px-1 font-semibold">Physician finding — select one</legend>
        {([
          ["A", "Unrestricted school activities"],
          ["B", "Correctible limitations"],
          ["C", "Restricted activities / follow-up"],
          ["D", "Unfit for school activities"],
        ] as const).map(([code, label]) => <label key={code} className="flex gap-2">
          <input type="radio" name="classification" required checked={classification === code}
            onChange={() => setClassification(code)} /> Class {code}: {label}
        </label>)}
      </fieldset>
      <label className="grid gap-1 font-semibold">Remarks {classification !== "A" ? "(required for B, C, D)" : "(optional)"}
        <textarea maxLength={1000} required={classification !== "A"} rows={4} value={remarks}
          onChange={(event) => setRemarks(event.target.value)} className="rounded-lg border border-line p-2" />
      </label>
      <label className="grid gap-1 font-semibold">Reason for late encoding or no-show correction{lateReasonRequired ? " (required)" : " (if applicable)"}
        <textarea maxLength={1000} rows={2} required={lateReasonRequired} value={lateReason}
          onChange={(event) => setLateReason(event.target.value)} className="rounded-lg border border-line p-2" />
      </label>
      <label className="flex gap-2 font-semibold">
        <input type="checkbox" required checked={attested} onChange={(event) => setAttested(event.target.checked)} />
        I attest that these details match the physician&apos;s recorded finding.
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !physicians.length || !identityReady || blockers.length > 0}>Submit</Button>
        <Button type="button" disabled={busy || !physicians.length || !identityReady || blockers.length > 0}
          onClick={() => { if (formRef.current?.reportValidity()) void submit("preview"); }}>Preview certificate</Button>
      </div>
      {previewUrl && previewKey === key ? <>
        <div className="grid gap-2">
          <p className="font-semibold">Preview — not issued</p>
          {/* The blob URL is created from the private preview response and revoked when replaced. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="Medical certificate preview, visibly marked not issued" className="w-full rounded-lg border border-line" />
        </div>
      </> : null}
      </fieldset>
    </form>
  </section>;
}
