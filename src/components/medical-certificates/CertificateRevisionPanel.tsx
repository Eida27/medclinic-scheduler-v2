"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiErrorMessage, readApiPayload } from "@/components/api-response";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { CertificateDownload } from "./CertificateDownload";

type Physician = { id: string; version: number; displayName: string };
type Certificate = { certificateId: string; revisionId: string; classification: string;
  remarks: string | null; sex: string; examinationDate: string; physicianId: string; physicianVersion: number };

export function CertificateRevisionPanel({ certificate, physicians, canRevoke, canCorrect = true }: {
  certificate: Certificate;
  physicians: Physician[];
  canRevoke: boolean;
  canCorrect?: boolean;
}) {
  const router = useRouter();
  const [correctionRequestId] = useState(() => crypto.randomUUID());
  const [revocationRequestId] = useState(() => crypto.randomUUID());
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewKey, setPreviewKey] = useState<string>();
  const [classification, setClassification] = useState(certificate.classification);
  const [remarks, setRemarks] = useState(certificate.remarks ?? "");
  const [sex, setSex] = useState(certificate.sex);
  const [date, setDate] = useState(certificate.examinationDate);
  const [physicianId, setPhysicianId] = useState(certificate.physicianId);
  const [reason, setReason] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const physician = physicians.find((row) => row.id === physicianId);
  const body = { requestId: correctionRequestId, expectedRevisionId: certificate.revisionId,
    physicianId, physicianVersion: physician?.version, examinationDate: date, sex,
    classification, remarks, reason, attested: true };
  const key = JSON.stringify(body);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function act(action: "preview" | "correct" | "revoke") {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const path = `/api/medical-certificates/${certificate.certificateId}`;
      const endpoint = action === "revoke" ? `${path}/revoke`
        : action === "preview" ? `${path}/revisions/preview` : `${path}/revisions`;
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: action === "revoke" ? JSON.stringify({ requestId: revocationRequestId,
          expectedRevisionId: certificate.revisionId, reason: revokeReason }) : key });
      if (!response.ok) throw new Error(apiErrorMessage(await readApiPayload(response), "Unable to update the certificate."));
      if (action === "preview") {
        setPreviewUrl(URL.createObjectURL(await response.blob()));
        setPreviewKey(key);
      } else router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update the certificate.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return <div className="grid gap-5">
    <p>Issued finding: Class {certificate.classification}</p>
    <CertificateDownload certificateId={certificate.certificateId} audience="staff" />
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {canCorrect ? <details className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer font-semibold">Correct certificate details</summary>
      <form className="mt-4 grid gap-4" onChange={() => setPreviewKey(undefined)}
        onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void act("preview"); }}>
        <label className="grid gap-1">Examination date
          <input type="date" required value={date} onChange={(event) => setDate(event.target.value)} className="rounded-lg border border-line p-2" />
        </label>
        <label className="grid gap-1">Sex
          <input required maxLength={30} value={sex} onChange={(event) => setSex(event.target.value)} className="rounded-lg border border-line p-2" />
        </label>
        <label className="grid gap-1">Physician
          <select required value={physicianId} onChange={(event) => setPhysicianId(event.target.value)} className="rounded-lg border border-line p-2">
            <option value="">Select physician</option>
            {physicians.map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}
          </select>
        </label>
        <fieldset className="rounded-lg border border-line p-3">
          <legend className="font-semibold">Corrected finding</legend>
          {(["A", "B", "C", "D"] as const).map((code) => <label key={code} className="mr-5 inline-flex gap-2">
            <input type="radio" name="classification" required checked={classification === code} onChange={() => setClassification(code)} />
            Class {code}
          </label>)}
        </fieldset>
        <label className="grid gap-1">Remarks
          <textarea maxLength={1000} required={classification !== "A"} value={remarks} onChange={(event) => setRemarks(event.target.value)} className="rounded-lg border border-line p-2" />
        </label>
        <label className="grid gap-1">Correction reason
          <textarea maxLength={1000} required value={reason} onChange={(event) => setReason(event.target.value)} className="rounded-lg border border-line p-2" />
        </label>
        <Button type="submit" disabled={busy}>Preview corrected certificate</Button>
        {previewUrl && previewKey === key ? <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="Corrected certificate preview marked not issued" className="w-full rounded-lg border border-line" />
          <Button type="button" disabled={busy} onClick={() => void act("correct")}>Save corrected revision</Button>
        </> : null}
      </form>
    </details> : null}
    {canRevoke ? <details className="rounded-xl border border-red-300 p-4">
      <summary className="cursor-pointer font-semibold text-red-800">Revoke issued certificate</summary>
      <label className="mt-4 grid gap-1">Revocation reason
        <textarea maxLength={1000} required value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} className="rounded-lg border border-line p-2" />
      </label>
      <Button type="button" disabled={busy || revokeReason.trim().length < 3} onClick={() => void act("revoke")}>Revoke certificate</Button>
    </details> : null}
  </div>;
}
