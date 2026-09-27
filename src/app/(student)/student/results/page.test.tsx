import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const {
  getCurrentEffectiveAppointmentsForStudent,
  studentCertificateHistory,
  listHistoricalLaboratoryDocuments,
  requireVerifiedStudentPage,
} = vi.hoisted(() => ({
  getCurrentEffectiveAppointmentsForStudent: vi.fn(),
  studentCertificateHistory: vi.fn(),
  listHistoricalLaboratoryDocuments: vi.fn(),
  requireVerifiedStudentPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/verified-student-page", () => ({ requireVerifiedStudentPage }));
vi.mock("@/server/repositories/current-effective-appointments.repository", () => ({
  getCurrentEffectiveAppointmentsForStudent,
}));
vi.mock("@/server/medical-certificates/certificate.service", () => ({ studentCertificateHistory }));
vi.mock("@/server/repositories/student-result-submissions.repository", () => ({ listHistoricalLaboratoryDocuments }));

import StudentResultsPage from "./page";

describe("StudentResultsPage", () => {
  it("links only completed current-effective appointments after replacements become current", async () => {
    requireVerifiedStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    studentCertificateHistory.mockResolvedValue([{certificateId:"certificate-1",academicYearStart:2027,examinationDate:"2027-08-04",classification:"B",status:"ISSUED"}]);
    listHistoricalLaboratoryDocuments.mockResolvedValue([{ fileId: "historical-file", academicYearStart: 2025,
      appointmentDate: "2026-06-01", originalFilename: "laboratory.pdf" }]);
    getCurrentEffectiveAppointmentsForStudent.mockResolvedValue({
      laboratory: {
        id: "current-laboratory",
        scheduleType: "LABORATORY",
        appointmentDate: "2027-08-03",
        status: "COMPLETED",
      },
      physicalExam: {
        id: "current-physical",
        scheduleType: "PHYSICAL_EXAM",
        appointmentDate: "2027-08-04",
        status: "COMPLETED",
      },
    });

    render(await StudentResultsPage());

    expect(screen.getByRole("link", { name: /Laboratory.*2027-08-03/i })).toHaveAttribute(
      "href",
      "/student/results/current-laboratory",
    );
    expect(screen.getByRole("link", { name: /Download.*certificate/i })).toHaveAttribute("href", "/api/student/medical-certificates/certificate-1/download");
    expect(screen.queryByRole("link", { name: /Physical Examination.*2027-08-04/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /2027-08-02/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download laboratory.pdf" })).toHaveAttribute("href", "/api/student/result-files/historical-file");
  });

  it("places ended-year certificates in Previous academic years with an owned download", async () => {
    requireVerifiedStudentPage.mockResolvedValue({ studentNumber: "24-0001" });
    getCurrentEffectiveAppointmentsForStudent.mockResolvedValue({ laboratory: null, physicalExam: null });
    listHistoricalLaboratoryDocuments.mockResolvedValue([]);
    studentCertificateHistory.mockResolvedValue([{ certificateId: "past-certificate",
      academicYearStart: 2026, examinationDate: "2026-09-22", classification: "B",
      status: "ISSUED", academicYearEnded: true }]);

    render(await StudentResultsPage());

    const section = screen.getByRole("region", { name: "Previous academic years · Physical Examination certificates" });
    expect(section).toHaveTextContent("Academic year 2026–2027");
    expect(section).toHaveTextContent("Class B");
    expect(section.querySelector('a[href="/api/student/medical-certificates/past-certificate/download"]')).not.toBeNull();
  });
});
