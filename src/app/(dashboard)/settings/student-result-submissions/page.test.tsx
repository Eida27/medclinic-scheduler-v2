import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAdminStudentResultProfiles, requireUser } = vi.hoisted(() => ({
  listAdminStudentResultProfiles: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  listAdminStudentResultProfiles,
}));

import AdminStudentResultSubmissionsPage from "./page";

const admin = {
  userId: "admin-id",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};

const listItem = {
  studentNumber: "23-8200-01",
  studentName: "Abad, Aaron",
  collegeName: "College of Computer Studies",
  programName: "BS Computer Science",
  progress: "PARTIALLY_SUBMITTED" as const,
  latestActivityAt: new Date("2026-08-19T16:00:00.000Z"),
  laboratory: { state: "FINALIZED" as const, fileCount: 2 },
  physicalExam: { state: "NOT_SUBMITTED" as const, fileCount: 0 },
};

describe("AdminStudentResultSubmissionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    listAdminStudentResultProfiles.mockResolvedValue({ items: [], total: 0 });
  });

  it("renders one grouped card link per student with both service states and pagination", async () => {
    listAdminStudentResultProfiles.mockResolvedValue({ items: [listItem], total: 101 });

    render(await AdminStudentResultSubmissionsPage({
      searchParams: Promise.resolve({ page: "2" }),
    }));

    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listAdminStudentResultProfiles).toHaveBeenCalledWith(admin, {
      page: 2,
      limit: 50,
      offset: 50,
    });
    expect(screen.getAllByRole("link", { name: /Abad, Aaron/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Abad, Aaron/ })).toHaveAttribute(
      "href",
      "/settings/student-result-submissions/students/23-8200-01",
    );
    expect(screen.getByText("Laboratory: Finalized · 2 files")).toBeVisible();
    expect(screen.getByText("Physical Exam: Not submitted yet")).toBeVisible();
    expect(screen.getAllByText("Partially submitted")).toHaveLength(1);
    expect(screen.getByText("Latest activity: Aug 20, 2026, 12:00 AM")).toBeVisible();
    expect(screen.getByRole("navigation", {
      name: "Student result submission pagination",
    })).toBeVisible();
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/settings/student-result-submissions?page=1",
    );
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/settings/student-result-submissions?page=3",
    );
  });

  it("encodes the student number in the canonical student profile URL", async () => {
    listAdminStudentResultProfiles.mockResolvedValue({
      items: [{ ...listItem, studentNumber: "23/8200 01" }],
      total: 1,
    });

    render(await AdminStudentResultSubmissionsPage({
      searchParams: Promise.resolve({}),
    }));

    expect(screen.getByRole("link", { name: /Abad, Aaron/ })).toHaveAttribute(
      "href",
      "/settings/student-result-submissions/students/23%2F8200%2001",
    );
  });

  it.each(["0", "-2", "1.5", "1e3", "Infinity", " 2 "])(
    "normalizes malformed page %s",
    async (page) => {
      render(await AdminStudentResultSubmissionsPage({
        searchParams: Promise.resolve({ page }),
      }));

      expect(listAdminStudentResultProfiles).toHaveBeenCalledWith(admin, {
        page: 1,
        limit: 50,
        offset: 0,
      });
    },
  );

  it("renders an empty grouped state without pagination", async () => {
    render(await AdminStudentResultSubmissionsPage({
      searchParams: Promise.resolve({}),
    }));

    expect(screen.getByText("No student result submissions yet.")).toBeVisible();
    expect(screen.queryByRole("navigation", {
      name: "Student result submission pagination",
    })).not.toBeInTheDocument();
  });
});
