import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminStudentResultProfile, notFound, requireUser } = vi.hoisted(() => ({
  getAdminStudentResultProfile: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  requireUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  getAdminStudentResultProfile,
}));

import AdminStudentResultProfilePage from "./page";

const admin = {
  userId: "admin-id",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};

const laboratorySubmission = {
  id: "lab-submission",
  appointmentId: "lab-appointment",
  appointmentDate: "2026-08-18",
  resultType: "LABORATORY" as const,
  status: "FINALIZED" as const,
  finalizedAt: new Date("2026-08-18T16:00:00.000Z"),
  invalidatedAt: null,
  invalidationReason: null,
  lastActivityAt: new Date("2026-08-18T16:00:00.000Z"),
  fileCount: 1,
  totalBytes: 2048,
  files: [{
    id: "lab-file",
    originalFilename: "laboratory.pdf",
    detectedMimeType: "application/pdf",
    byteSize: 2048,
  }],
};

const baseProfile = {
  studentNumber: "23/8200 01",
  studentName: "Abad, Aaron",
  collegeName: "College of Computer Studies",
  programName: "BS Computer Science",
  progress: "PARTIALLY_SUBMITTED" as const,
  latestActivityAt: new Date("2026-08-18T16:00:00.000Z"),
  laboratory: {
    resultType: "LABORATORY" as const,
    appointment: {
      id: "lab-appointment",
      appointmentDate: "2026-08-18",
      status: "COMPLETED" as const,
    },
    state: "FINALIZED" as const,
    submission: laboratorySubmission,
  },
  physicalExam: {
    resultType: "PHYSICAL_EXAM" as const,
    appointment: null,
    state: "NOT_SUBMITTED" as const,
    submission: null,
  },
  history: [],
};

describe("AdminStudentResultProfilePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    getAdminStudentResultProfile.mockResolvedValue(baseProfile);
  });

  it("loads one decoded, administrator-authorized profile and renders surname-first identity", async () => {
    render(await AdminStudentResultProfilePage({
      params: Promise.resolve({ studentNumber: "23%2F8200%2001" }),
    }));

    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(getAdminStudentResultProfile).toHaveBeenCalledWith("23/8200 01", admin);
    expect(screen.getByRole("heading", { name: "Abad, Aaron", level: 1 })).toBeVisible();
    expect(screen.getByText("23/8200 01")).toBeVisible();
    expect(screen.getByText("College of Computer Studies · BS Computer Science")).toBeVisible();
    expect(screen.getByText("Partially submitted")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to student result submissions" })).toHaveAttribute(
      "href",
      "/settings/student-result-submissions",
    );
  });

  it("renders finalized Laboratory files and controls with submission-addressed URLs", async () => {
    render(await AdminStudentResultProfilePage({
      params: Promise.resolve({ studentNumber: "23%2F8200%2001" }),
    }));

    const section = screen.getByRole("region", { name: "Laboratory results" });
    expect(within(section).getByText("Appointment: Completed · 2026-08-18")).toBeVisible();
    expect(within(section).getByText("Finalized: Aug 19, 2026, 12:00 AM")).toBeVisible();
    expect(within(section).getByText("1 file · 2 KB")).toBeVisible();
    expect(within(section).getByRole("link", { name: "Download laboratory.pdf" })).toHaveAttribute(
      "href",
      "/api/admin/student-result-submissions/lab-submission/files/lab-file",
    );
    expect(within(section).getByRole("link", { name: "Download Laboratory ZIP" })).toHaveAttribute(
      "href",
      "/api/admin/student-result-submissions/lab-submission/zip",
    );
    expect(within(section).getByLabelText("Laboratory invalidation reason")).toBeVisible();
  });

  it("renders an unscheduled, not-submitted Physical Exam without file or mutation controls", async () => {
    render(await AdminStudentResultProfilePage({
      params: Promise.resolve({ studentNumber: "23%2F8200%2001" }),
    }));

    const section = screen.getByRole("region", { name: "Physical Exam results" });
    expect(within(section).getByText("Appointment: Unscheduled")).toBeVisible();
    expect(within(section).getByText("Not submitted yet")).toBeVisible();
    expect(within(section).queryByRole("link")).not.toBeInTheDocument();
    expect(within(section).queryByLabelText("Physical Exam invalidation reason")).not.toBeInTheDocument();
  });

  it("renders invalidated current metadata without exposing revoked file or ZIP links", async () => {
    getAdminStudentResultProfile.mockResolvedValue({
      ...baseProfile,
      progress: "AWAITING_RESUBMISSION",
      physicalExam: {
        resultType: "PHYSICAL_EXAM",
        appointment: {
          id: "exam-appointment",
          appointmentDate: "2026-08-19",
          status: "COMPLETED",
        },
        state: "INVALIDATED",
        submission: {
          id: "exam-invalidated",
          appointmentId: "exam-appointment",
          appointmentDate: "2026-08-19",
          resultType: "PHYSICAL_EXAM",
          status: "INVALIDATED",
          finalizedAt: new Date("2026-08-19T16:00:00.000Z"),
          invalidatedAt: new Date("2026-08-20T16:00:00.000Z"),
          invalidationReason: "Incorrect patient document",
          lastActivityAt: new Date("2026-08-20T16:00:00.000Z"),
          fileCount: 2,
          totalBytes: 3072,
          files: [],
        },
      },
    });

    render(await AdminStudentResultProfilePage({
      params: Promise.resolve({ studentNumber: "23%2F8200%2001" }),
    }));

    const section = screen.getByRole("region", { name: "Physical Exam results" });
    expect(within(section).getByText("Invalidated: Aug 21, 2026, 12:00 AM")).toBeVisible();
    expect(within(section).getByText("Reason: Incorrect patient document")).toBeVisible();
    expect(within(section).getByText("2 files · 3 KB")).toBeVisible();
    expect(within(section).queryByRole("link", { name: /download/i })).not.toBeInTheDocument();
    expect(within(section).queryByLabelText("Physical Exam invalidation reason")).not.toBeInTheDocument();
  });

  it("renders finalized and invalidated history with status-appropriate download access", async () => {
    getAdminStudentResultProfile.mockResolvedValue({
      ...baseProfile,
      history: [
        {
          id: "older-lab-finalized",
          appointmentId: "older-lab-appointment",
          appointmentDate: "2026-07-18",
          resultType: "LABORATORY",
          status: "FINALIZED",
          finalizedAt: new Date("2026-07-18T16:00:00.000Z"),
          invalidatedAt: null,
          invalidationReason: null,
          lastActivityAt: new Date("2026-07-18T16:00:00.000Z"),
          fileCount: 1,
          totalBytes: 1024,
          files: [{
            id: "older-lab-file",
            originalFilename: "older-lab.pdf",
            detectedMimeType: "application/pdf",
            byteSize: 1024,
          }],
        },
        {
          id: "older-exam-invalidated",
          appointmentId: "older-exam-appointment",
          appointmentDate: "2026-06-18",
          resultType: "PHYSICAL_EXAM",
          status: "INVALIDATED",
          finalizedAt: new Date("2026-06-18T16:00:00.000Z"),
          invalidatedAt: new Date("2026-06-19T16:00:00.000Z"),
          invalidationReason: "Superseded scan",
          lastActivityAt: new Date("2026-06-19T16:00:00.000Z"),
          fileCount: 3,
          totalBytes: 4096,
          files: [],
        },
      ],
    });

    render(await AdminStudentResultProfilePage({
      params: Promise.resolve({ studentNumber: "23%2F8200%2001" }),
    }));

    const history = screen.getByRole("region", { name: "Submission history" });
    expect(within(history).getByText("Laboratory · 2026-07-18")).toBeVisible();
    expect(within(history).getByText("Physical Exam · 2026-06-18")).toBeVisible();
    expect(within(history).getByText("Finalized: Jul 19, 2026, 12:00 AM")).toBeVisible();
    expect(within(history).getByText("Invalidated: Jun 20, 2026, 12:00 AM")).toBeVisible();
    expect(within(history).getByText("Reason: Superseded scan")).toBeVisible();
    expect(within(history).getByText("3 files · 4 KB")).toBeVisible();
    expect(within(history).getByRole("link", { name: "Download older-lab.pdf" })).toHaveAttribute(
      "href",
      "/api/admin/student-result-submissions/older-lab-finalized/files/older-lab-file",
    );
    expect(within(history).getByRole("link", { name: "Download Laboratory ZIP" })).toHaveAttribute(
      "href",
      "/api/admin/student-result-submissions/older-lab-finalized/zip",
    );
    expect(within(history).queryByLabelText("Laboratory invalidation reason")).not.toBeInTheDocument();
    expect(within(history).queryByRole("link", { name: /older-exam|Physical Exam ZIP/i })).not.toBeInTheDocument();
  });

  it("renders the history empty state", async () => {
    render(await AdminStudentResultProfilePage({
      params: Promise.resolve({ studentNumber: "23%2F8200%2001" }),
    }));

    expect(screen.getByText("No older submissions yet.")).toBeVisible();
  });

  it("calls notFound for an unknown student", async () => {
    getAdminStudentResultProfile.mockResolvedValue(null);

    await expect(AdminStudentResultProfilePage({
      params: Promise.resolve({ studentNumber: "missing" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
