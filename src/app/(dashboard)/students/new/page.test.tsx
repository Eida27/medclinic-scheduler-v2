import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listColleges, listPrograms, requireUser } = vi.hoisted(() => ({
  listColleges: vi.fn(),
  listPrograms: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/repositories/reference-data.repository", () => ({ listColleges, listPrograms }));
vi.mock("@/components/students/StudentForm", () => ({ StudentForm: () => <div>Student editor</div> }));

import NewStudentPage from "./page";

describe("NewStudentPage permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    listColleges.mockResolvedValue([]);
    listPrograms.mockResolvedValue([]);
  });

  it("requires a student-mutating role before loading the editor", async () => {
    render(await NewStudentPage());

    expect(requireUser).toHaveBeenCalledWith(["ADMIN", "CLINIC_STAFF"]);
    expect(screen.getByText("Student editor")).toBeVisible();
  });
});
