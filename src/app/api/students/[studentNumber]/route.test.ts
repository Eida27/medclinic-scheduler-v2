// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deactivateStudent, getStudentDetails, requireUser, updateStudent } = vi.hoisted(() => ({
  deactivateStudent: vi.fn(),
  getStudentDetails: vi.fn(),
  requireUser: vi.fn(),
  updateStudent: vi.fn(),
}));

vi.mock("@/server/auth/current-user", () => ({ requireUser }));
vi.mock("@/server/services/students.service", () => ({
  deactivateStudent,
  getStudentDetails,
  updateStudent,
}));

import { DELETE, GET, PATCH } from "./route";

const context = { params: Promise.resolve({ studentNumber: "24-0001" }) };

describe("/api/students/[studentNumber] permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    getStudentDetails.mockResolvedValue({ studentNumber: "24-0001" });
    updateStudent.mockResolvedValue({ studentNumber: "24-0001" });
  });

  it("allows every authenticated role to read a student", async () => {
    await GET(new Request("http://localhost/api/students/24-0001"), context);

    expect(requireUser).toHaveBeenCalledWith();
  });

  it("limits updates and deactivation to administrators and clinic staff", async () => {
    await PATCH(new Request("http://localhost/api/students/24-0001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Updated" }),
    }), context);
    await DELETE(new Request("http://localhost/api/students/24-0001", { method: "DELETE" }), context);

    expect(requireUser.mock.calls).toEqual([
      [["ADMIN", "CLINIC_STAFF"]],
      [["ADMIN", "CLINIC_STAFF"]],
    ]);
  });
});
