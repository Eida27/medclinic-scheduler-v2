import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getStudentDetails, listColleges, listPrograms, requireUser } = vi.hoisted(() => ({
  getStudentDetails: vi.fn(),
  listColleges: vi.fn(),
  listPrograms: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/students.service", () => ({ getStudentDetails }));
vi.mock("@/server/repositories/reference-data.repository", () => ({ listColleges, listPrograms }));
vi.mock("@/components/students/StudentForm", () => ({
  StudentForm: ({ readOnly }: { readOnly?: boolean }) => (
    <div>{readOnly ? "Read-only student" : "Editable student"}</div>
  ),
}));
vi.mock("@/components/students/DeactivateStudentButton", () => ({
  DeactivateStudentButton: () => <button>Deactivate</button>,
}));

import StudentDetailsPage from "./page";

const student = {
  studentNumber: "24-0001",
  fullName: "Ana Santos",
  programName: "BSIT",
  appointments: [],
};

describe("StudentDetailsPage permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    getStudentDetails.mockResolvedValue(student);
    listColleges.mockResolvedValue([]);
    listPrograms.mockResolvedValue([]);
  });

  it("keeps the student editor available to administrators", async () => {
    render(await StudentDetailsPage({ params: Promise.resolve({ studentNumber: "24-0001" }) }));

    expect(screen.getByText("Editable student")).toBeVisible();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeVisible();
  });

  it("renders student details read-only for coordinators", async () => {
    requireUser.mockResolvedValue({ userId: "coordinator-1", role: "COORDINATOR" });

    render(await StudentDetailsPage({ params: Promise.resolve({ studentNumber: "24-0001" }) }));

    expect(screen.getByText("Read-only student")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
  });
});
