import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { CertificateDownload } from "@/components/medical-certificates/CertificateDownload";
import { requireStudentPage } from "@/server/auth/student-page";
import { studentVerificationHref } from "@/lib/student-verification-return";
import { studentCertificateHistory } from "@/server/medical-certificates/certificate.service";
import {
  getCurrentEffectiveAppointmentsForStudent,
  type CurrentEffectiveAppointment,
} from "@/server/repositories/current-effective-appointments.repository";
import { listCurrentLaboratoryDocuments, listHistoricalLaboratoryDocuments } from "@/server/repositories/student-result-submissions.repository";

type StudentCertificate = Awaited<ReturnType<typeof studentCertificateHistory>>[number];

function CertificateCard({ certificate }: { certificate: StudentCertificate }) {
  return <Card className="p-5">
    <p className="font-bold">Academic year {certificate.academicYearStart}–{certificate.academicYearStart + 1}</p>
    <p className="text-sm text-muted">Examination {certificate.examinationDate} · Class {certificate.classification}</p>
    {certificate.status === "ISSUED" ? <div className="mt-3">
      <CertificateDownload certificateId={certificate.certificateId} audience="student" />
    </div> : <p className="mt-2 font-semibold text-red-800">This certificate has been revoked.</p>}
  </Card>;
}

export default async function StudentResultsPage() {
  const student = await requireStudentPage();
  const verified = Boolean(student.email && student.emailVerifiedAt);
  const current = await getCurrentEffectiveAppointmentsForStudent(student.studentNumber);
  const completed = [current.laboratory].filter(
    (appointment): appointment is CurrentEffectiveAppointment => appointment?.status === "COMPLETED",
  );
  const certificates = await studentCertificateHistory(student.studentNumber);
  const currentCertificates = certificates.filter((certificate) => !certificate.academicYearEnded);
  const historicalCertificates = certificates.filter((certificate) => certificate.academicYearEnded);
  const historicalDocuments = await listHistoricalLaboratoryDocuments(student.studentNumber);
  const currentDocuments = await listCurrentLaboratoryDocuments(student.studentNumber);
  return (
    <section>
      <h1 className="text-3xl font-bold">Results</h1>
      <p className="mt-2 text-sm text-muted">Laboratory documents and issued Physical Examination certificates appear here.</p>
      {!verified && <Card className="mt-4 p-5 text-sm">
        <p>You can view and download your results. Verify your email before uploading or updating Laboratory documents.</p>
        <Link className="mt-2 inline-block font-semibold text-cpu-navy underline"
          href={studentVerificationHref("/student/results")}>Verify your email</Link>
      </Card>}
      <h2 className="mt-6 text-xl font-bold">Laboratory documents</h2>
      <div className="mt-3 grid gap-3">
        {currentDocuments.length ? currentDocuments.map((document) => <Card key={document.fileId} className="p-5">
          <p className="font-semibold">Academic year {document.academicYearStart}–{document.academicYearStart + 1} · {document.appointmentDate}</p>
          <a className="mt-2 inline-block break-words font-semibold text-cpu-navy underline"
            href={`/api/student/result-files/${document.fileId}`}>Download {document.originalFilename}</a>
        </Card>) : <Card className="p-5 text-sm text-muted">No current Laboratory documents are available yet.</Card>}
      </div>
      <div className="mt-3 grid gap-3">
        {completed.length ? completed.map((appointment) => (
            <Card key={appointment.id} className="p-5">
              <p className="font-bold">Laboratory</p>
              <p className="text-sm text-muted">Completed appointment: {appointment.appointmentDate}</p>
              <Link className="mt-2 inline-block font-semibold text-cpu-navy underline" prefetch={false}
                href={verified ? `/student/results/${appointment.id}` : studentVerificationHref(`/student/results/${appointment.id}`)}>
                {verified ? "Manage Laboratory documents" : "Verify email to upload or update"}
              </Link>
            </Card>
        )) : <Card className="p-5 text-sm text-muted">No completed Laboratory appointment is ready for document upload.</Card>}
      </div>
      <h2 className="mt-8 text-xl font-bold">Physical Examination certificates</h2>
      <div className="mt-3 grid gap-3">
        {currentCertificates.length ? currentCertificates.map((certificate) =>
          <CertificateCard key={certificate.certificateId} certificate={certificate} />)
          : <Card className="p-5 text-sm text-muted">No current certificate is available yet.</Card>}
      </div>
      <section className="mt-8" aria-label="Previous academic years · Physical Examination certificates">
        <h2 className="text-xl font-bold">Previous academic years · Physical Examination certificates</h2>
        <div className="mt-3 grid gap-3">
          {historicalCertificates.length ? historicalCertificates.map((certificate) =>
            <CertificateCard key={certificate.certificateId} certificate={certificate} />)
            : <Card className="p-5 text-sm text-muted">No previous Physical Examination certificates.</Card>}
        </div>
      </section>
      <h2 className="mt-8 text-xl font-bold">Previous academic years · Laboratory documents</h2>
      <div className="mt-3 grid gap-3">
        {historicalDocuments.length ? historicalDocuments.map((document) => <Card key={document.fileId} className="p-5">
          <p className="font-semibold">Academic year {document.academicYearStart}–{document.academicYearStart + 1} · {document.appointmentDate}</p>
          <a className="mt-2 inline-block break-words font-semibold text-cpu-navy underline"
            href={`/api/student/result-files/${document.fileId}`}>Download {document.originalFilename}</a>
        </Card>) : <Card className="p-5 text-sm text-muted">No previous Laboratory documents.</Card>}
      </div>
    </section>
  );
}
