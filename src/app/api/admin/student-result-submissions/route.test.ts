import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const { listAdminStudentResultProfiles, requireUser } = vi.hoisted(() => ({
  listAdminStudentResultProfiles: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/student-result-submissions.service", () => ({
  listAdminStudentResultProfiles,
}));

import { GET } from "./route";

const admin = {
  userId: "admin-id",
  fullName: "System Admin",
  email: "admin@medclinic.local",
  role: "ADMIN" as const,
};

describe("GET /api/admin/student-result-submissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(admin);
  });

  it("returns the grouped report and passes the parsed page input to the service", async () => {
    const report = { items: [], total: 75 };
    listAdminStudentResultProfiles.mockResolvedValue(report);

    const response = await GET(new Request(
      "http://localhost/api/admin/student-result-submissions?page=2",
    ));

    expect(requireUser).toHaveBeenCalledWith(["ADMIN"]);
    expect(listAdminStudentResultProfiles).toHaveBeenCalledWith(admin, {
      page: 2,
      limit: 50,
      offset: 50,
    });
    await expect(response.json()).resolves.toEqual({ data: report });
  });

  it("returns authorization failures in the existing API error format", async () => {
    requireUser.mockRejectedValue(new AppError(
      "FORBIDDEN",
      "Only administrators may access this resource.",
      403,
    ));

    const response = await GET(new Request(
      "http://localhost/api/admin/student-result-submissions?page=2",
    ));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Only administrators may access this resource.",
      },
    });
    expect(listAdminStudentResultProfiles).not.toHaveBeenCalled();
  });
});
