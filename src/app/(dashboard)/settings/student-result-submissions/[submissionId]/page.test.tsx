import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminSubmissionStudentNumber, notFound, redirect, requireUser } = vi.hoisted(() => ({
  getAdminSubmissionStudentNumber: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  requireUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  getAdminSubmissionStudentNumber,
}));

import AdminStudentResultSubmissionPage from "./page";

const admin = {
  userId: "admin-id",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};

describe("AdminStudentResultSubmissionPage compatibility redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
    getAdminSubmissionStudentNumber.mockResolvedValue("23/8200 01");
  });

  it("redirects an existing submission to the exact encoded canonical student target", async () => {
    await expect(AdminStudentResultSubmissionPage({
      params: Promise.resolve({ submissionId: "submission-1" }),
    })).rejects.toThrow("NEXT_REDIRECT");

    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(getAdminSubmissionStudentNumber).toHaveBeenCalledWith("submission-1", admin);
    expect(redirect).toHaveBeenCalledWith(
      "/settings/student-result-submissions/students/23%2F8200%2001",
    );
  });

  it("calls notFound for an unknown submission", async () => {
    getAdminSubmissionStudentNumber.mockResolvedValue(null);

    await expect(AdminStudentResultSubmissionPage({
      params: Promise.resolve({ submissionId: "missing" }),
    })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFound).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });
});
