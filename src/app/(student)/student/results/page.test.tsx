import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireStudentPage: vi.fn(),
  getCurrentEffectiveAppointmentsForStudent: vi.fn(),
  studentCertificateHistory: vi.fn(),
  listCurrentLaboratoryDocuments: vi.fn(),
  listHistoricalLaboratoryDocuments: vi.fn(),
}));

vi.mock("@/server/auth/student-page", () => ({ requireStudentPage: dependencies.requireStudentPage }));
vi.mock("@/server/auth/verified-student-page", () => ({
  requireVerifiedStudentPage: () => { throw new Error("Results reads must not require verification"); },
}));
vi.mock("@/server/repositories/current-effective-appointments.repository", () => ({
  getCurrentEffectiveAppointmentsForStudent: dependencies.getCurrentEffectiveAppointmentsForStudent,
}));
vi.mock("@/server/medical-certificates/certificate.service", () => ({
  studentCertificateHistory: dependencies.studentCertificateHistory,
}));
vi.mock("@/server/repositories/student-result-submissions.repository", () => ({
  listCurrentLaboratoryDocuments: dependencies.listCurrentLaboratoryDocuments,
  listHistoricalLaboratoryDocuments: dependencies.listHistoricalLaboratoryDocuments,
}));
// Expose the page's prefetch policy at the Link boundary; no browser navigation is needed here.
vi.mock("next/link", () => ({ default: ({ prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) =>
  <a {...props} data-prefetch={String(prefetch)} /> }));

import StudentResultsPage from "./page";

const appointmentId = "a0000000-0000-4000-8000-000000000001";
const laboratory = {
  id: appointmentId, studentNumber: "24-0001", scheduleType: "LABORATORY",
  appointmentDate: "2026-09-29", status: "COMPLETED", createdAt: new Date(), scheduleCycleStart: 2026,
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.requireStudentPage.mockResolvedValue({ studentNumber: "24-0001", email: null, emailVerifiedAt: null });
  dependencies.getCurrentEffectiveAppointmentsForStudent.mockResolvedValue({ laboratory, physicalExam: null });
  dependencies.listCurrentLaboratoryDocuments.mockResolvedValue([]);
  dependencies.listHistoricalLaboratoryDocuments.mockResolvedValue([]);
  dependencies.studentCertificateHistory.mockResolvedValue([]);
});

describe("StudentResultsPage", () => {
  it.each([null, "pending@student.test", "unverified@student.test"])(
    "lets students with email %s download official current and historical documents and certificates", async (email) => {
      dependencies.requireStudentPage.mockResolvedValue({ studentNumber: "24-0001", email, emailVerifiedAt: null });
      dependencies.listCurrentLaboratoryDocuments.mockResolvedValue([{ submissionId: "official", fileId: "current-file",
        academicYearStart: 2026, appointmentDate: "2026-09-29", originalFilename: "current.pdf" }]);
      dependencies.listHistoricalLaboratoryDocuments.mockResolvedValue([{ submissionId: "old-official", fileId: "past-file",
        academicYearStart: 2025, appointmentDate: "2026-06-01", originalFilename: "past.pdf" }]);
      dependencies.studentCertificateHistory.mockResolvedValue([
        { certificateId: "current-certificate", academicYearStart: 2026, examinationDate: "2026-09-30",
          classification: "B", status: "ISSUED", academicYearEnded: false },
        { certificateId: "past-certificate", academicYearStart: 2025, examinationDate: "2026-06-02",
          classification: "A", status: "ISSUED", academicYearEnded: true },
        { certificateId: "revoked", academicYearStart: 2025, examinationDate: "2026-06-03",
          classification: "B", status: "REVOKED", academicYearEnded: true },
      ]);

      render(await StudentResultsPage());

      expect(screen.getByRole("link", { name: "Download current.pdf" })).toHaveAttribute("href", "/api/student/result-files/current-file");
      expect(screen.getByRole("link", { name: "Download past.pdf" })).toHaveAttribute("href", "/api/student/result-files/past-file");
      expect(screen.getAllByRole("link", { name: /Download.*certificate/i }).map((link) => link.getAttribute("href")))
        .toEqual(["/api/student/medical-certificates/current-certificate/download", "/api/student/medical-certificates/past-certificate/download"]);
      const past = screen.getByRole("region", { name: "Previous academic years · Physical Examination certificates" });
      expect(within(past).getByText("This certificate has been revoked.")).toBeInTheDocument();
      expect(screen.getByText("You can view and download your results. Verify your email before uploading or updating Laboratory documents.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Upload|Submit|Start editing/i })).not.toBeInTheDocument();
    },
  );

  it("offers safe verification continuation for an eligible unverified student", async () => {
    render(await StudentResultsPage());
    expect(screen.getByRole("link", { name: "Verify email to upload or update" })).toHaveAttribute("href",
      `/student/email-verification?returnTo=%2Fstudent%2Fresults%2F${appointmentId}`);
    expect(screen.getByRole("link", { name: "Verify your email" })).toHaveAttribute("href",
      "/student/email-verification?returnTo=%2Fstudent%2Fresults");
    expect(screen.queryByRole("link", { name: "Manage Laboratory documents" })).not.toBeInTheDocument();
  });

  it("offers deliberate workspace entry to verified students, including pending replacement email", async () => {
    dependencies.requireStudentPage.mockResolvedValue({ studentNumber: "24-0001", email: "verified@student.test",
      emailVerifiedAt: new Date(), pendingEmail: "replacement@student.test" });
    render(await StudentResultsPage());
    const manage = screen.getByRole("link", { name: "Manage Laboratory documents" });
    expect(manage).toHaveAttribute("href", `/student/results/${appointmentId}`);
    expect(manage).toHaveAttribute("data-prefetch", "false");
    expect(screen.queryByText(/You can view and download your results/)).not.toBeInTheDocument();
  });

  it.each([null, { ...laboratory, status: "PENDING" }])("does not offer management without current completed eligibility: %s", async (appointment) => {
    dependencies.getCurrentEffectiveAppointmentsForStudent.mockResolvedValue({ laboratory: appointment, physicalExam: null });
    render(await StudentResultsPage());
    expect(screen.queryByRole("link", { name: "Verify email to upload or update" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage Laboratory documents" })).not.toBeInTheDocument();
    expect(screen.getByText("No current Laboratory documents are available yet.")).toBeInTheDocument();
    expect(screen.getByText("No completed Laboratory appointment is ready for document upload.")).toBeInTheDocument();
    expect(screen.getByText("No previous Laboratory documents.")).toBeInTheDocument();
    expect(screen.getByText("No current certificate is available yet.")).toBeInTheDocument();
    expect(screen.getByText("No previous Physical Examination certificates.")).toBeInTheDocument();
  });
});
